import { describe, expect, it } from "vitest";
import { AgentModelReplyError, createAgentModelCompleter, parseJsonObject, type AgentModelRequest } from "../agent-model.js";
import {
  CLASSIFY_SYSTEM_PROMPT,
  CURSOR_OVERLAP_MS,
  DIVIDE_SYSTEM_PROMPT,
  MEMORY_PAGE_LIMIT,
  MERGE_SYSTEM_PROMPT,
  RETRY_BASE_MS,
  SUMMARY_SYSTEM_PROMPT,
  advanceOrganizer,
  collectFragments,
  createCollabItemsService,
  isHistoryTurn,
  newItemMarkdown,
  normalizeItemMarkdown,
  parseItemMarkdown,
  readPlan,
  sameMarkdown,
  transcriptChunks,
  type CollabItem,
  type MemoryFragment
} from "../collab-items-service.js";
import { CollabError, type CollabCloudRequest } from "../collab-service.js";

const BASE = Date.parse("2026-10-22T00:00:00.000Z");

function fragment(index: number, at: number, overrides: Partial<MemoryFragment> = {}): MemoryFragment {
  const iso = new Date(at).toISOString();
  return {
    id: `m-${index}`,
    title: `片段 ${index}`,
    content: `内容 ${index}`,
    conversationId: `s-${index % 3}`,
    sessionTitle: "",
    memberName: index % 2 ? "用户C" : "用户B",
    createdAt: iso,
    updatedAt: iso,
    ...overrides
  };
}

function markdown(name: string, latest = "10/20 开始"): string {
  return `# ${name}\n\n**摘要**：${name}的摘要\n\n**现状**：进行中\n\n## 决策\n\n## 经验\n\n## 演变轨迹\n- ${latest}\n`;
}

function item(overrides: Partial<CollabItem> = {}): CollabItem {
  const name = overrides.name ?? "知识库分享";
  return {
    id: "item-a",
    name,
    summary: `${name}的摘要`,
    latest: "10/20 开始",
    status: "AVAILABLE",
    statusMessage: null,
    version: 1,
    markdown: markdown(name),
    sources: [],
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    updatedBy: null,
    ...overrides
  };
}

describe("collectFragments", () => {
  /** Like MemOS search behind the cloud: (after, before], at most a page; `hidden` memories fill pages but are dropped. */
  function windowReader(all: readonly MemoryFragment[], hidden: readonly MemoryFragment[] = []) {
    const calls: Array<[number, number]> = [];
    const read = async (after: number, before: number) => {
      calls.push([after, before]);
      const inWindow = (entry: MemoryFragment) => Date.parse(entry.updatedAt!) > after && Date.parse(entry.updatedAt!) <= before;
      const page = [...all, ...hidden].filter(inWindow).reverse().slice(0, MEMORY_PAGE_LIMIT);
      return { fragments: page.filter((entry) => !hidden.includes(entry)), full: page.length >= MEMORY_PAGE_LIMIT };
    };
    return { read, calls };
  }

  it("splits full windows until every fragment is read", async () => {
    const all = Array.from({ length: 60 }, (_, index) => fragment(index, BASE + index * 60_000));
    const { read, calls } = windowReader(all);
    const result = await collectFragments(read, BASE - 1, BASE + 3_600_000);
    expect(result.fragments.map((entry) => entry.id).sort()).toEqual(all.map((entry) => entry.id).sort());
    expect(result.truncatedWindows).toBe(0);
    expect(calls.length).toBeGreaterThan(1);
  });

  it("splits a window whose search was full even when the item-file memories were dropped from the page", async () => {
    const all = Array.from({ length: 10 }, (_, index) => fragment(index, BASE + index * 60_000));
    const files = Array.from({ length: 20 }, (_, index) => fragment(100 + index, BASE + 30 * 60_000 + index * 1_000, { conversationId: "default_session" }));
    const { read } = windowReader(all, files);
    const result = await collectFragments(read, BASE - 1, BASE + 3_600_000);
    expect(result.fragments.map((entry) => entry.id).sort()).toEqual(all.map((entry) => entry.id).sort());
  });

  it("reports a window it cannot split any further", async () => {
    const all = Array.from({ length: 30 }, (_, index) => fragment(index, BASE));
    const { read } = windowReader(all);
    const result = await collectFragments(read, BASE - 1, BASE + 3_600_000);
    expect(result.truncatedWindows).toBe(1);
    expect(result.fragments).toHaveLength(MEMORY_PAGE_LIMIT);
  });
});

describe("advanceOrganizer", () => {
  it("moves the cursor to the newest fragment and keeps only keys the overlap can reread", () => {
    const old = fragment(1, BASE);
    const recent = fragment(2, BASE + CURSOR_OVERLAP_MS + 60_000);
    const next = advanceOrganizer({ version: 3, cursor: null, seen: [], organizedAt: null }, [old, recent]);
    expect(next.cursor).toBe(recent.updatedAt);
    expect(next.seen).toEqual([`m-2@${recent.updatedAt}`]);
  });

  it("never moves the cursor back", () => {
    const cursor = new Date(BASE + 3_600_000).toISOString();
    expect(advanceOrganizer({ version: 1, cursor, seen: [], organizedAt: null }, [fragment(1, BASE)]).cursor).toBe(cursor);
  });
});

describe("history and transcripts", () => {
  it("counts turns before the boundary as history and a turn without a time as live", () => {
    const boundary = "2026-10-22T10:00:00.000Z";
    expect(isHistoryTurn({ startedAt: "2026-10-22T09:59:59.000Z" }, boundary)).toBe(true);
    expect(isHistoryTurn({ startedAt: boundary }, boundary)).toBe(false);
    expect(isHistoryTurn({ startedAt: "" }, boundary)).toBe(false);
  });

  it("cuts a long transcript at turn boundaries", () => {
    const turns = Array.from({ length: 5 }, (_, index) => ({ question: `问题 ${index} ${"字".repeat(300)}`, reply: "答", steps: ["Bash", "Bash", "Edit"], startedAt: new Date(BASE + index * 60_000).toISOString() }));
    const chunks = transcriptChunks(turns, 700);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n\n").match(/成员：问题/gu)).toHaveLength(5);
    expect(chunks[0]).toContain("步骤：Bash ×2、Edit");
  });
});

describe("item Markdown", () => {
  it("reads the name, summary and latest timeline entry", () => {
    expect(parseItemMarkdown(markdown("知识库分享", "10/23 上线"))).toEqual({ name: "知识库分享", summary: "知识库分享的摘要", latest: "10/23 上线" });
    expect(parseItemMarkdown(newItemMarkdown("新事项", "做什么"))).toEqual({ name: "新事项", summary: "做什么", latest: "" });
  });

  it("strips the fence and preamble and keeps the item's own name", () => {
    const reply = "好的，合并后的文件如下：\n```markdown\n# 改过的名字\n\n**摘要**：x\n\n## 演变轨迹\n- 10/23 上线   \n```";
    expect(normalizeItemMarkdown(reply, "知识库分享")).toBe("# 知识库分享\n\n**摘要**：x\n\n## 演变轨迹\n- 10/23 上线\n");
  });

  it("rejects a reply that is not an item file", () => {
    expect(() => normalizeItemMarkdown("我无法完成这个任务。", "知识库分享")).toThrow(AgentModelReplyError);
  });

  it("treats trailing spaces and blank-line runs as the same file", () => {
    expect(sameMarkdown("# a\n\n\n- x  \n", "# a\n\n- x")).toBe(true);
    expect(sameMarkdown("# a\n- x", "# a\n- y")).toBe(false);
  });
});

describe("readPlan", () => {
  const items = [item(), item({ id: "item-b", name: "接口文档" })];

  it("keeps assignments to existing items and new items, dropping unknown ids and references", () => {
    const plan = readPlan({
      assign: [{ item_id: "item-a", sessions: ["s1", "s3", "s9"] }, { item_id: "made-up", sessions: ["s2"] }],
      creates: [{ name: "  权限 设计 ", summary: "谁能看", sessions: ["s2"] }, { name: "空的", sessions: [] }]
    }, items, 3, "sessions");
    expect(plan).toEqual([
      { item: items[0], name: "知识库分享", summary: "知识库分享的摘要", refs: [0, 2] },
      { item: null, name: "权限 设计", summary: "谁能看", refs: [1] }
    ]);
  });

  it("makes two proposals of one new name one item", () => {
    const plan = readPlan({ creates: [{ name: "权限设计", fragments: ["f1"] }, { name: "权限设计", fragments: ["f2", "f1"] }] }, items, 2, "fragments");
    expect(plan).toEqual([{ item: null, name: "权限设计", summary: "", refs: [0, 1] }]);
  });
});

interface FakeTurn { question: string; reply: string; steps: string[]; startedAt: string }

/** The cloud's collab API, enough of it for one project `p1`. */
function fakeCloud(init: {
  role?: string;
  items?: CollabItem[];
  pending?: Array<{ id: string; title: string; memberName: string; historyBefore: string }>;
  turns?: Record<string, FakeTurn[]>;
  fragments?: MemoryFragment[];
  /** Before the organizer's first save of this item, someone else saves it: the organizer must merge again. */
  editedMeanwhile?: string;
}) {
  const state = {
    items: [...(init.items ?? [])],
    organizer: { version: 0, cursor: null as string | null, seen: [] as string[], organizedAt: null as string | null },
    organized: [] as string[],
    posts: [] as Array<Record<string, unknown>>,
    puts: [] as Array<{ id: string; body: Record<string, unknown> }>,
    organizerPuts: [] as Array<Record<string, unknown>>,
    paths: [] as string[]
  };
  let edited = false;
  const cloud: CollabCloudRequest = async (path, request = {}) => {
    const method = request.method ?? "GET";
    const body = (request.body ?? {}) as Record<string, unknown>;
    state.paths.push(`${method} ${path}`);
    const itemMatch = /^\/projects\/p1\/items\/([^/?]+)$/u.exec(path);
    if (path === "/projects/p1") return { project: { id: "p1", name: "协作测试", role: init.role ?? "owner", createdAt: "2026-10-21T00:00:00.000Z" } };
    if (path === "/projects") return { projects: [{ id: "p1", name: "协作测试", role: init.role ?? "owner" }] };
    if (path === "/projects/p1/items" && method === "GET") {
      return { items: state.items, organizer: state.organizer, role: init.role ?? "owner", canEdit: (init.role ?? "owner") !== "member" };
    }
    if (path === "/projects/p1/items" && method === "POST") {
      state.posts.push(body);
      const created = item({ id: `item-new-${state.posts.length}`, ...parseItemMarkdown(String(body.markdown)), markdown: String(body.markdown), status: "PROCESSING", sources: body.sources as string[] });
      state.items.push(created);
      return { item: created };
    }
    if (itemMatch && method === "GET") return { item: state.items.find((entry) => entry.id === itemMatch[1]) };
    if (itemMatch && method === "PUT") {
      const index = state.items.findIndex((entry) => entry.id === itemMatch[1]);
      if (init.editedMeanwhile === itemMatch[1] && !edited) {
        edited = true;
        state.items[index] = { ...state.items[index]!, version: state.items[index]!.version + 1, markdown: markdown(state.items[index]!.name, "10/22 手动补充") };
      }
      state.puts.push({ id: itemMatch[1]!, body });
      const current = state.items[index]!;
      if (body.baseVersion !== current.version) throw new CollabError("conflict", "事项已被更新，请基于最新内容修改");
      const changed = body.markdown !== current.markdown;
      state.items[index] = { ...current, version: current.version + (changed ? 1 : 0), markdown: String(body.markdown), sources: [...new Set([...current.sources, ...(body.sources as string[] ?? [])])] };
      return { item: state.items[index], changed };
    }
    if (path === "/projects/p1/organizer") {
      state.organizerPuts.push(body);
      state.organizer = { version: state.organizer.version + 1, cursor: body.cursor as string, seen: body.seen as string[], organizedAt: new Date().toISOString() };
      return { version: state.organizer.version };
    }
    if (path === "/projects/p1/history-sessions") {
      return { sessions: (init.pending ?? []).filter((session) => !state.organized.includes(session.id)) };
    }
    if (path === "/projects/p1/history-sessions/organized") {
      state.organized.push(...(body.sessionIds as string[]));
      return { marked: (body.sessionIds as string[]).length };
    }
    const sessionMatch = /^\/sessions\/([^/]+)$/u.exec(path);
    if (sessionMatch) return { session: { id: sessionMatch[1], turns: init.turns?.[sessionMatch[1]!] ?? [] } };
    if (path.startsWith("/projects/p1/memories?")) {
      const query = new URLSearchParams(path.slice(path.indexOf("?") + 1));
      const after = Date.parse(query.get("updatedAfter")!);
      const before = Date.parse(query.get("updatedBefore")!);
      const page = (init.fragments ?? []).filter((entry) => Date.parse(entry.updatedAt!) > after && Date.parse(entry.updatedAt!) <= before);
      return { memories: page, full: false };
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { cloud, state };
}

/** Stands in for the agent model: each step answers by its system prompt; `divide` and `classify` decide the plan. */
function fakeModel(plan: { divide?: Record<string, unknown>; classify?: Record<string, unknown> } = {}) {
  const calls: AgentModelRequest[] = [];
  const complete = async (request: AgentModelRequest): Promise<string | null> => {
    calls.push(request);
    if (request.system === SUMMARY_SYSTEM_PROMPT) return `**目标**：摘要（${/会话：「([^」]*)」/u.exec(request.user)?.[1]}）\n**进展**：\n- 10/21 完成接口`;
    if (request.system === DIVIDE_SYSTEM_PROMPT) return JSON.stringify(plan.divide ?? {});
    if (request.system === CLASSIFY_SYSTEM_PROMPT) return JSON.stringify(plan.classify ?? {});
    if (request.system === MERGE_SYSTEM_PROMPT) {
      const current = /<<<\n([\s\S]*?)\n>>>/u.exec(request.user)![1]!;
      const added = (request.user.match(/^\[[^\]]+\]$/gmu) ?? []).length;
      return `${current}\n- 10/22 合并 ${added} 份材料`;
    }
    throw new Error("unexpected prompt");
  };
  return { complete, calls };
}

const now = () => new Date(BASE + 3_600_000);
const HISTORY_BEFORE = new Date(BASE).toISOString();

function historyTurns(title: string): FakeTurn[] {
  return [
    { question: `${title}：历史`, reply: "答", steps: [], startedAt: new Date(BASE - 3_600_000).toISOString() },
    { question: `${title}：关联后`, reply: "答", steps: [], startedAt: new Date(BASE + 60_000).toISOString() }
  ];
}

describe("createCollabItemsService: history", () => {
  const pending = [
    { id: "s-a", title: "分享弹窗", memberName: "用户B", historyBefore: HISTORY_BEFORE },
    { id: "s-b", title: "分享接口", memberName: "用户C", historyBefore: HISTORY_BEFORE }
  ];

  it("summarizes each session, divides the summaries into items at once, and writes each item as a file", async () => {
    const { cloud, state } = fakeCloud({ pending, turns: { "s-a": historyTurns("弹窗"), "s-b": historyTurns("接口") } });
    const { complete, calls } = fakeModel({ divide: { creates: [{ name: "知识库分享", summary: "成员分享知识库", sessions: ["s1", "s2"] }] } });
    const service = createCollabItemsService({ cloud, complete, now });

    const result = await service.organize("p1");

    expect(result).toMatchObject({ sessions: 2, created: 1, updated: 0 });
    // Only the history reaches the summary; sorting is the one step that reasons first.
    const summaries = calls.filter((call) => call.system === SUMMARY_SYSTEM_PROMPT);
    expect(summaries).toHaveLength(2);
    expect(summaries.every((call) => call.user.includes("历史") && !call.user.includes("关联后") && !call.thinking)).toBe(true);
    expect(calls.find((call) => call.system === DIVIDE_SYSTEM_PROMPT)).toMatchObject({ thinking: true });
    expect(calls.find((call) => call.system === DIVIDE_SYSTEM_PROMPT)!.user).toContain("暂无，请一次性划分");
    const merge = calls.filter((call) => call.system === MERGE_SYSTEM_PROMPT);
    expect(merge).toHaveLength(1);
    expect(merge[0]!.thinking).toBeFalsy();
    expect(merge[0]!.user).toContain("新建的事项");

    expect(state.posts).toHaveLength(1);
    expect(state.posts[0]).toMatchObject({ sources: ["s-a", "s-b"] });
    expect(String(state.posts[0]!.markdown)).toMatch(/^# 知识库分享\n\n\*\*摘要\*\*：成员分享知识库/u);
    expect(state.organized.sort()).toEqual(["s-a", "s-b"]);
  });

  it("files new sessions under existing items and merges again on top of a version saved meanwhile", async () => {
    const existing = item();
    const { cloud, state } = fakeCloud({ items: [existing], pending: [pending[0]!], turns: { "s-a": historyTurns("弹窗") }, editedMeanwhile: "item-a" });
    const { complete, calls } = fakeModel({ divide: { assign: [{ item_id: "item-a", sessions: ["s1"] }] } });
    const service = createCollabItemsService({ cloud, complete, now });

    const result = await service.organize("p1");

    expect(result).toMatchObject({ sessions: 1, created: 0, updated: 1 });
    expect(calls.find((call) => call.system === DIVIDE_SYSTEM_PROMPT)!.user).toContain("\"item_id\":\"item-a\"");
    // The first save lost to the hand edit; the second merge starts from the edited file.
    expect(state.puts.map((put) => put.body.baseVersion)).toEqual([1, 2]);
    const merges = calls.filter((call) => call.system === MERGE_SYSTEM_PROMPT);
    expect(merges).toHaveLength(2);
    expect(merges[1]!.user).toContain("10/22 手动补充");
    expect(state.items[0]).toMatchObject({ version: 3, sources: ["s-a"] });
    expect(state.items[0]!.markdown).toContain("10/22 手动补充");
  });

  it("leaves a session pending when the item it went into could not be saved", async () => {
    const { cloud, state } = fakeCloud({ items: [item()], pending, turns: { "s-a": historyTurns("弹窗"), "s-b": historyTurns("接口") } });
    const failing: CollabCloudRequest = async (path, request) => {
      if (request?.method === "PUT" && path === "/projects/p1/items/item-a") throw new CollabError("memory_layer_unavailable", "云端暂时不可用");
      return cloud(path, request);
    };
    const { complete } = fakeModel({ divide: { assign: [{ item_id: "item-a", sessions: ["s1"] }], creates: [{ name: "接口文档", sessions: ["s2"] }] } });
    const service = createCollabItemsService({ cloud: failing, complete, now });

    await expect(service.organize("p1")).rejects.toThrow("事项「知识库分享」更新失败");
    expect(state.organized).toEqual(["s-b"]);
    expect((await service.listItems("p1")).lastError).toContain("云端暂时不可用");
  });

  it("marks a session with no history left as organized without asking the model", async () => {
    const { cloud, state } = fakeCloud({ pending: [pending[0]!], turns: { "s-a": [historyTurns("弹窗")[1]!] } });
    const { complete, calls } = fakeModel();
    await createCollabItemsService({ cloud, complete, now }).organize("p1");
    expect(calls).toHaveLength(0);
    expect(state.organized).toEqual(["s-a"]);
  });
});

describe("createCollabItemsService: live fragments", () => {
  it("sorts new fragments into items, saves only changed files, and moves the cursor past them", async () => {
    const fragments = [fragment(1, BASE + 60_000, { conversationId: "s-a" }), fragment(2, BASE + 120_000, { conversationId: "s-b" })];
    const { cloud, state } = fakeCloud({ items: [item({ sources: ["s-a"] }), item({ id: "item-b", name: "接口文档" })], fragments });
    const { complete, calls } = fakeModel({ classify: { assign: [{ item_id: "item-a", fragments: ["f1"] }], ignored: ["f2"] } });
    const service = createCollabItemsService({ cloud, complete, now });

    const first = await service.organize("p1");

    expect(first).toMatchObject({ fragments: 2, updated: 1, created: 0 });
    const classify = calls.find((call) => call.system === CLASSIFY_SYSTEM_PROMPT)!;
    expect(classify.thinking).toBe(true);
    // The model sees which items a fragment's session already went into.
    expect(classify.user).toContain("该会话已归入：知识库分享");
    expect(state.puts.map((put) => put.id)).toEqual(["item-a"]);
    expect(state.organizer.cursor).toBe(fragments[1]!.updatedAt);

    calls.length = 0;
    const second = await service.organize("p1");
    expect(second.fragments).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("does not save a file the merge left unchanged", async () => {
    const { cloud, state } = fakeCloud({ items: [item({ sources: ["s-1"] })], fragments: [fragment(1, BASE + 60_000)] });
    const unchanged = async (request: AgentModelRequest) => request.system === CLASSIFY_SYSTEM_PROMPT
      ? JSON.stringify({ assign: [{ item_id: "item-a", fragments: ["f1"] }] })
      : `${markdown("知识库分享")}\n\n`;
    const result = await createCollabItemsService({ cloud, complete: unchanged, now }).organize("p1");
    expect(result.updated).toBe(0);
    expect(state.puts).toHaveLength(0);
  });

  it("halves a batch whose sorting reply is cut off and keeps going", async () => {
    const fragments = Array.from({ length: 6 }, (_, index) => fragment(index, BASE + (index + 1) * 60_000));
    const { cloud, state } = fakeCloud({ items: [item()], fragments });
    const sizes: number[] = [];
    const complete = async (request: AgentModelRequest) => {
      if (request.system !== CLASSIFY_SYSTEM_PROMPT) return null;
      const count = (request.user.match(/^\[f\d+\]/gmu) ?? []).length;
      sizes.push(count);
      if (count > 3) throw new AgentModelReplyError("cut off", true);
      return JSON.stringify({ ignored: [] });
    };
    const result = await createCollabItemsService({ cloud, complete, now }).organize("p1");
    expect(sizes).toEqual([6, 3, 3]);
    expect(result.fragments).toBe(6);
    expect(state.organizer.cursor).toBe(fragments[5]!.updatedAt);
  });
});

describe("createCollabItemsService: who organizes and edits", () => {
  it("leaves organizing to the owner, and skips the after-upload pass for anyone else", async () => {
    const { cloud, state } = fakeCloud({ role: "admin" });
    const { complete } = fakeModel();
    const service = createCollabItemsService({ cloud, complete, now, log: () => undefined });
    await expect(service.organize("p1")).rejects.toMatchObject({ code: "forbidden" });
    await service.organizeAfterUpload("p1");
    expect(state.paths.filter((path) => path.includes("history-sessions"))).toHaveLength(0);
  });

  it("organizes right after the owner's own association", async () => {
    const { cloud, state } = fakeCloud({
      pending: [{ id: "s-a", title: "分享弹窗", memberName: "我", historyBefore: HISTORY_BEFORE }],
      turns: { "s-a": historyTurns("弹窗") }
    });
    const { complete } = fakeModel({ divide: { creates: [{ name: "知识库分享", sessions: ["s1"] }] } });
    await createCollabItemsService({ cloud, complete, now }).organizeAfterUpload("p1");
    expect(state.posts).toHaveLength(1);
    expect(state.organized).toEqual(["s-a"]);
  });

  it("stops without writing when no agent model is set up", async () => {
    const { cloud, state } = fakeCloud({ items: [item()], fragments: [fragment(1, BASE + 60_000)] });
    await expect(createCollabItemsService({ cloud, complete: async () => null, now }).organize("p1")).rejects.toThrow("Agent 模型");
    expect(state.puts).toHaveLength(0);
    expect(state.organizerPuts).toHaveLength(0);
  });

  it("saves a hand edit as an edit on top of the version opened, and reports a newer one as a conflict", async () => {
    const { cloud, state } = fakeCloud({ items: [item()] });
    const service = createCollabItemsService({ cloud, complete: async () => null, now });
    const edited = markdown("知识库分享", "10/23 手动");
    await expect(service.saveItem("p1", "item-a", { markdown: edited, baseVersion: 1 })).resolves.toMatchObject({ changed: true, item: { version: 2 } });
    expect(state.puts[0]!.body).toMatchObject({ kind: "edit", baseVersion: 1 });
    await expect(service.saveItem("p1", "item-a", { markdown: edited, baseVersion: 1 })).rejects.toMatchObject({ code: "conflict" });
    await expect(service.saveItem("p1", "item-a", { markdown: "没有标题", baseVersion: 2 })).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("lists items newest first with what this person may do", async () => {
    const { cloud } = fakeCloud({
      role: "member",
      items: [item(), item({ id: "item-b", name: "接口文档", updatedAt: "2026-10-22T00:00:00.000Z" })],
      pending: [{ id: "s-a", title: "x", memberName: "y", historyBefore: HISTORY_BEFORE }]
    });
    const view = await createCollabItemsService({ cloud, complete: async () => null, now }).listItems("p1");
    expect(view.items.map((entry) => entry.id)).toEqual(["item-b", "item-a"]);
    expect(view).toMatchObject({ role: "member", canEdit: false, canOrganize: false, pendingSessions: 1, lastError: null });
  });
});

describe("createCollabItemsService: periodic pass", () => {
  it("holds the periodic pass back after a failure but not a pass started by hand", async () => {
    let clock = BASE;
    const { cloud } = fakeCloud({ items: [item()], fragments: [fragment(1, BASE - 60_000)] });
    let calls = 0;
    const complete = async () => {
      calls += 1;
      throw new Error("agent model returned HTTP 504");
    };
    const service = createCollabItemsService({ cloud, complete, now: () => new Date(clock), log: () => undefined });
    expect(await service.organizeOwnedProjects()).toEqual({ organized: 0, failed: 1 });
    expect(await service.organizeOwnedProjects()).toEqual({ organized: 0, failed: 0 });
    expect(calls).toBe(1);
    await expect(service.organize("p1")).rejects.toThrow("504");
    expect(calls).toBe(2);
    clock += RETRY_BASE_MS * 2 + 1;
    expect(await service.organizeOwnedProjects()).toEqual({ organized: 0, failed: 1 });
    expect(calls).toBe(3);
  });

  it("shares one pass between concurrent calls", async () => {
    const { cloud, state } = fakeCloud({ items: [item()], fragments: [fragment(1, BASE + 60_000)] });
    const { complete } = fakeModel({ classify: { ignored: ["f1"] } });
    const service = createCollabItemsService({ cloud, complete, now });
    const [first, second] = await Promise.all([service.organize("p1"), service.organize("p1")]);
    expect(first).toBe(second);
    expect(state.organizerPuts).toHaveLength(2);
  });
});

describe("parseJsonObject", () => {
  it("reads an object out of a fenced reply", () => {
    expect(parseJsonObject("好的：\n```json\n{\"assign\":[]}\n```")).toEqual({ assign: [] });
  });

  it("reports a reply that is not usable JSON as a reply error", () => {
    expect(() => parseJsonObject("没有结果")).toThrow(AgentModelReplyError);
    expect(() => parseJsonObject("{\"assign\":[{\"item_id\":\"a\"}")).toThrow(AgentModelReplyError);
  });
});

describe("createAgentModelCompleter", () => {
  const resolver = {
    getAgentTaskModel: () => ({ providerName: "memmy_account", model: "agent_chat", apiBase: "https://models.test.invalid/v1", apiKey: "k" })
  };

  function fetchReturning(body: unknown) {
    const sent: Array<Record<string, unknown>> = [];
    const fetcher = (async (_input: string | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    return { fetcher, sent };
  }

  it("returns the reply text and switches thinking on for the Memmy account model when asked", async () => {
    const { fetcher, sent } = fetchReturning({ choices: [{ finish_reason: "stop", message: { content: "# 事项\n" } }] });
    const complete = createAgentModelCompleter(resolver, fetcher);
    await expect(complete({ system: "s", user: "u", thinking: true, maxTokens: 3_000 })).resolves.toBe("# 事项\n");
    expect(sent[0]).toMatchObject({ model: "agent_chat", enable_thinking: true, max_tokens: 3_000 });
    await complete({ system: "s", user: "u" });
    expect(sent[1]).toMatchObject({ enable_thinking: false });
  });

  it("reports a reply cut off at the output limit", async () => {
    const { fetcher } = fetchReturning({ choices: [{ finish_reason: "length", message: { content: "# 事项" } }] });
    const complete = createAgentModelCompleter(resolver, fetcher);
    await expect(complete({ system: "s", user: "u" })).rejects.toMatchObject({ name: "AgentModelReplyError", truncated: true });
  });
});
