#!/usr/bin/env node
/**
 * Local stand-in for the online-project cloud, so the desktop can be exercised before `/api/collab/**` is
 * deployed. It speaks the same envelope and field names as the real service and keeps its data in
 * ~/.memmy/mock-collab/state.json, so restarting the app keeps the projects.
 *
 * Run: node scripts/mock-collab-cloud.mjs [--port 8787]
 * Then start the desktop with MEMMY_COLLAB_CLOUD_URL=http://127.0.0.1:<port>
 */
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = Number.parseInt(process.argv[process.argv.indexOf("--port") + 1] ?? "", 10) || 8787;
const STATE_FILE = join(process.env.MEMMY_HOME?.trim() || join(homedir(), ".memmy"), "mock-collab", "state.json");
/** Single-member dev cloud: every request is this person. */
const MEMBER = { id: "mock-member-you", name: "我" };

/** @type {{projects: any[], sessions: any[]}} */
let state = { projects: [], sessions: [] };
let saving = Promise.resolve();

async function load() {
  try {
    const raw = JSON.parse(await readFile(STATE_FILE, "utf8"));
    state = {
      projects: Array.isArray(raw.projects) ? raw.projects : [],
      sessions: Array.isArray(raw.sessions) ? raw.sessions : []
    };
  } catch {
    state = { projects: [], sessions: [] };
  }
}

function persist() {
  saving = saving.then(async () => {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }).catch((error) => {
    console.error(`[mock-collab] save failed: ${error.message}`);
  });
  return saving;
}

function send(response, data, status = 200) {
  const payload = JSON.stringify(data);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(payload);
}

function ok(response, data) {
  send(response, { code: 0, message: "", data });
}

function fail(response, status, message) {
  send(response, { code: status, message, data: null }, status);
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

function projectView(project) {
  return {
    id: project.id,
    name: project.name,
    role: "owner",
    memberCount: 1,
    sessionCount: state.sessions.filter((session) => session.projectId === project.id).length,
    createdAt: project.createdAt
  };
}

function sessionView(session) {
  const project = state.projects.find((candidate) => candidate.id === session.projectId);
  return {
    id: session.id,
    projectId: session.projectId,
    projectName: project?.name ?? "",
    title: session.title,
    lastQuestion: session.lastQuestion,
    memberName: session.memberName,
    mine: session.memberId === MEMBER.id,
    source: session.source,
    turnCount: session.turns.length,
    lastActiveAt: session.lastActiveAt
  };
}

/** Keyword match over the fields the real service searches; any keyword is enough, more matches rank first. */
function matches(session, keywords) {
  if (!keywords.length) return 0;
  const project = state.projects.find((candidate) => candidate.id === session.projectId);
  const haystack = [session.title, session.lastQuestion, session.memberName, project?.name ?? ""].join("\n").toLowerCase();
  let hits = 0;
  for (const keyword of keywords) if (haystack.includes(keyword)) hits += 1;
  return hits;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const method = (request.method ?? "GET").toUpperCase();

  // A session share link is meant for an agent's CLI, not for fetching. Say so, so an agent that tries to
  // open it with curl/http learns the right command instead of guessing.
  const shareMatch = /^\/s\/([^/]+)$/.exec(path);
  if (shareMatch && method === "GET") {
    const command = `memmy-memory sessions read "http://127.0.0.1:${PORT}/s/${shareMatch[1]}"`;
    response.writeHead(401, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end([
      "【Memmy 会话链接】",
      "这不是网页，请勿直接抓取本链接，也不要用 curl / 浏览器读取。",
      "在 Agent 中运行下面这条命令，它会下载会话并返回文件路径：",
      command,
      "复制这句给 Agent：「用 memmy-memory 技能读取上面的会话链接」。"
    ].join("\n"));
    return;
  }

  // The desktop signs cloud calls with the person's account; the mock only checks that one was sent.
  if (!String(request.headers.authorization ?? "").startsWith("Bearer ")) {
    return fail(response, 401, "缺少账号凭据");
  }

  if (path === "/api/collab/projects" && method === "GET") {
    return ok(response, { projects: state.projects.map(projectView) });
  }

  if (path === "/api/collab/projects" && method === "POST") {
    const input = await body(request);
    const name = String(input.name ?? "").trim();
    if (!name) return fail(response, 400, "请填写项目名称");
    const project = { id: randomUUID(), name, createdAt: new Date().toISOString() };
    state.projects.unshift(project);
    await persist();
    console.log(`[mock-collab] project created: ${name} (${project.id})`);
    return ok(response, { project: projectView(project) });
  }

  const deleteProjectMatch = /^\/api\/collab\/projects\/([^/]+)$/.exec(path);
  if (deleteProjectMatch && method === "DELETE") {
    const projectId = decodeURIComponent(deleteProjectMatch[1]);
    const before = state.projects.length;
    state.projects = state.projects.filter((project) => project.id !== projectId);
    if (state.projects.length === before) return fail(response, 404, "项目不存在");
    state.sessions = state.sessions.filter((session) => session.projectId !== projectId);
    await persist();
    console.log(`[mock-collab] project deleted: ${projectId}`);
    return ok(response, { ok: true });
  }

  const projectMatch = /^\/api\/collab\/projects\/([^/]+)(\/sessions(?:\/([^/]+))?)?$/.exec(path);
  if (projectMatch) {
    const projectId = decodeURIComponent(projectMatch[1]);
    const project = state.projects.find((candidate) => candidate.id === projectId);
    if (!project) return fail(response, 404, "项目不存在");
    const [, , sessionsPath, sessionId] = projectMatch;

    if (!sessionsPath && method === "GET") {
      return ok(response, { project: projectView(project) });
    }

    if (sessionsPath === "/sessions" && method === "GET") {
      const keywords = String(url.searchParams.get("q") ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
      const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0;
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      const matching = state.sessions
        .filter((session) => session.projectId === projectId)
        .filter((session) => !keywords.length || matches(session, keywords) > 0)
        .sort((left, right) => Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt));
      // `total` counts every match so the board can page through the whole list.
      const page = Number.isFinite(limit) ? matching.slice(offset, offset + limit) : matching.slice(offset);
      return ok(response, { project: projectView(project), sessions: page.map(sessionView), total: matching.length });
    }

    if (sessionsPath === "/sessions" && method === "PUT") {
      const input = await body(request);
      const uploads = Array.isArray(input.sessions) ? input.sessions : [];
      const stored = [];
      for (const upload of uploads) {
        const sourceSessionId = String(upload.sourceSessionId ?? "");
        if (!sourceSessionId) continue;
        const turns = (Array.isArray(upload.turns) ? upload.turns : []).map((turn) => ({
          question: String(turn.question ?? ""),
          reply: String(turn.reply ?? ""),
          steps: Array.isArray(turn.steps) ? turn.steps.map(String) : [],
          startedAt: String(turn.startedAt ?? "")
        }));
        const existing = state.sessions.find((session) => (
          session.projectId === projectId && session.source === upload.source && session.sourceSessionId === sourceSessionId
        ));
        // One cloud session per source session, so a re-upload updates instead of duplicating.
        const next = {
          id: existing?.id ?? randomUUID(),
          projectId,
          source: String(upload.source ?? ""),
          sourceSessionId,
          title: String(upload.title ?? ""),
          lastQuestion: [...turns].reverse().find((turn) => turn.question)?.question ?? "",
          memberId: MEMBER.id,
          memberName: MEMBER.name,
          lastActiveAt: String(upload.lastActiveAt ?? new Date().toISOString()),
          turns
        };
        if (existing) Object.assign(existing, next);
        else state.sessions.push(next);
        stored.push({ id: next.id });
      }
      await persist();
      console.log(`[mock-collab] uploaded ${stored.length} session(s) to ${project.name}`);
      return ok(response, { sessions: stored });
    }

    if (sessionsPath && sessionId && method === "DELETE") {
      const id = decodeURIComponent(sessionId);
      const before = state.sessions.length;
      state.sessions = state.sessions.filter((session) => !(session.id === id && session.projectId === projectId));
      if (state.sessions.length === before) return fail(response, 404, "会话不存在");
      await persist();
      return ok(response, { ok: true });
    }
  }

  // Dev only: a session another member shared, so a single-member mock can still exercise the board's
  // "other members" filter and labelling.
  if (path === "/api/collab/mock/sessions" && method === "POST") {
    const input = await body(request);
    const project = state.projects.find((candidate) => candidate.id === input.projectId);
    if (!project) return fail(response, 404, "项目不存在");
    const memberName = String(input.memberName ?? "").trim();
    if (!memberName) return fail(response, 400, "请提供成员名称");
    const session = {
      id: randomUUID(),
      projectId: project.id,
      source: "memmy",
      sourceSessionId: `mock-${randomUUID()}`,
      title: String(input.title ?? "他人的会话"),
      lastQuestion: String(input.lastQuestion ?? ""),
      memberId: `mock-member-${memberName}`,
      memberName,
      lastActiveAt: String(input.lastActiveAt ?? new Date().toISOString()),
      turns: Array.isArray(input.turns) ? input.turns : []
    };
    state.sessions.push(session);
    await persist();
    console.log(`[mock-collab] seeded a session of ${memberName} in ${project.name}`);
    return ok(response, { session: sessionView(session) });
  }

  if (path === "/api/collab/sessions/candidates" && method === "GET") {
    const keywords = String(url.searchParams.get("q") ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10) || 5;
    const ranked = state.sessions
      .filter((session) => !keywords.length || matches(session, keywords) > 0)
      .sort((left, right) => Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt))
      .slice(0, limit);
    return ok(response, { sessions: ranked.map(sessionView) });
  }

  if (path === "/api/collab/sessions/search" && method === "GET") {
    const keywords = String(url.searchParams.get("q") ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10) || 5;
    const member = url.searchParams.get("member");
    const projectName = url.searchParams.get("project");
    const ranked = state.sessions
      .filter((session) => {
        if (member && session.memberName !== member) return false;
        if (projectName) {
          const project = state.projects.find((candidate) => candidate.id === session.projectId);
          if (!project || !project.name.includes(projectName)) return false;
        }
        // An empty query ranks everything: that is the @ menu before the person types.
        return !keywords.length || matches(session, keywords) > 0;
      })
      .sort((left, right) => Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt))
      .slice(0, limit);
    return ok(response, { sessions: ranked.map(sessionView) });
  }

  const sessionMatch = /^\/api\/collab\/sessions\/([^/]+)$/.exec(path);
  if (sessionMatch && method === "GET") {
    const id = decodeURIComponent(sessionMatch[1]);
    const session = state.sessions.find((candidate) => candidate.id === id);
    if (!session) return fail(response, 404, "会话不存在");
    // The real service nests the turns inside the session view; keep that shape.
    return ok(response, { session: { ...sessionView(session), turns: session.turns } });
  }

  console.log(`[mock-collab] no route: ${method} ${path}`);
  fail(response, 404, `没有 ${method} ${path}`);
});

await load();
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-collab] listening on http://127.0.0.1:${PORT} (state: ${STATE_FILE})`);
  console.log(`[mock-collab] start the desktop with MEMMY_COLLAB_CLOUD_URL=http://127.0.0.1:${PORT}`);
});
