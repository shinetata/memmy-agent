/** Collab member routes: a real Memmy account id is a 19-digit snowflake, so every :userId route must accept it. */
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollabService } from "../../../../services/collab-service.js";
import { registerCollabRoutes } from "../routes/collab.js";

/** What `~/.memmy/config.yaml` holds for a signed-in account. */
const ACCOUNT_ID = "2102247370314383361";
const MEMBER = { userId: ACCOUNT_ID, name: "元气桂花", role: "member", mine: false, joinedAt: null };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function createApp() {
  const calls: string[] = [];
  const stub = {
    approveRequest: vi.fn(async (_projectId: string, userId: string) => {
      calls.push(`approve:${userId}`);
      return { ...MEMBER, userId };
    }),
    rejectRequest: vi.fn(async (_projectId: string, userId: string) => {
      calls.push(`reject:${userId}`);
      return { ok: true };
    }),
    setMemberRole: vi.fn(async (_projectId: string, userId: string, _role: string) => {
      calls.push(`role:${userId}`);
      return { ...MEMBER, userId };
    }),
    removeMember: vi.fn(async (_projectId: string, userId: string) => {
      calls.push(`remove:${userId}`);
      return { ok: true };
    })
  };
  app = Fastify();
  registerCollabRoutes(app, {
    collab: stub as unknown as CollabService,
    authenticateRuntimeToken: async () => undefined
  });
  return calls;
}

describe("collab member routes", () => {
  it("approves a join request from a signed-in account", async () => {
    const calls = createApp();

    const response = await app!.inject({ method: "POST", url: `/api/collab/projects/p-1/requests/${ACCOUNT_ID}/approve` });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([`approve:${ACCOUNT_ID}`]);
  });

  it("rejects, promotes and removes a member by the same account id", async () => {
    const calls = createApp();

    await app!.inject({ method: "DELETE", url: `/api/collab/projects/p-1/requests/${ACCOUNT_ID}` });
    await app!.inject({ method: "PATCH", url: `/api/collab/projects/p-1/members/${ACCOUNT_ID}`, payload: { role: "admin" } });
    await app!.inject({ method: "DELETE", url: `/api/collab/projects/p-1/members/${ACCOUNT_ID}` });

    expect(calls).toEqual([`reject:${ACCOUNT_ID}`, `role:${ACCOUNT_ID}`, `remove:${ACCOUNT_ID}`]);
  });

  it("keeps turning away ids that are not account ids", async () => {
    createApp();

    const response = await app!.inject({ method: "POST", url: "/api/collab/projects/p-1/requests/not-a-member/approve" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "invalid_argument", message: "成员 ID 无效" } });
  });
});
