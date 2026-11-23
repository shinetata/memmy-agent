import type { RuntimeConfig } from "@memmy/local-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listKnowledgeBases } from "../knowledge-bases-client.js";

const config: RuntimeConfig = { baseUrl: "http://127.0.0.1:18100", localToken: "test-token" };
afterEach(() => vi.unstubAllGlobals());

function reply(value: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })));
}

describe("project knowledge candidates", () => {
  it("preserves available sharing metadata and stays compatible with name-only entries", async () => {
    const bases = [{ id: "a", name: "产品" }, { id: "b", name: "团队", shared: true, sharedByMe: false, ownerName: "小林" }];
    reply({ serviceAvailable: true, bases });
    await expect(listKnowledgeBases(config)).resolves.toEqual(bases);
    expect(fetch).toHaveBeenCalledWith(new URL("/api/knowledge/settings", config.baseUrl), expect.objectContaining({ method: "GET", headers: expect.objectContaining({ "x-memmy-local-token": "test-token" }) }));
  });
  it("leaves out bases only visible through a collaboration project", async () => {
    reply({ serviceAvailable: true, bases: [{ id: "a", name: "产品" }, { id: "p", name: "项目资料", shared: true, ownerName: "小林", viaProject: true }] });
    // 项目关联进来的库已经绑定在某个项目里，不能当成本人的库再关联一次。
    await expect(listKnowledgeBases(config)).resolves.toEqual([{ id: "a", name: "产品" }]);
  });
  it("does not expose candidates when the service is unavailable", async () => {
    reply({ serviceAvailable: false, bases: [{ id: "a", name: "产品" }] });
    await expect(listKnowledgeBases(config)).resolves.toEqual([]);
  });
  it("keeps the picker usable when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(listKnowledgeBases(config)).resolves.toEqual([]);
  });
});
