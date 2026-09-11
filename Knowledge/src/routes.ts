import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ManagedKnowledgeClient,
  parseSettings,
  type ManagedKnowledgeOptions,
} from "./client.js";
import { KnowledgeError, MAX_UPLOAD_BYTES, record, text } from "./types.js";

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  options: ManagedKnowledgeOptions & {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<unknown>;
  },
): void {
  const client = new ManagedKnowledgeClient(options);
  app.register(
    async (scoped) => {
      scoped.addHook("preHandler", options.authenticate);
      scoped.addHook("onSend", async (_request, reply, payload) => {
        reply.header("Cache-Control", "no-store");
        return payload;
      });
      scoped.setErrorHandler((error, _request, reply) => {
        const status =
          error instanceof KnowledgeError
            ? error.statusCode
            : Number(record(error).statusCode) || 500;
        void reply
          .code(status >= 400 && status <= 599 ? status : 500)
          .send({
            error:
              error instanceof KnowledgeError
                ? error.message
                : "知识库操作失败，请重试",
          });
      });
      scoped.get("/settings", () => client.settings());
      scoped.put("/settings", async (request) => {
        const body = record(request.body);
        if (
          Object.keys(body).some(
            (key) => !["enabled", "selectedIds"].includes(key),
          )
        )
          throw new KnowledgeError("仅支持修改召回开关和知识库范围");
        return parseSettings(await client.request("/settings", "PUT", body));
      });
      scoped.post("/bases", async (request) => {
        const body = record(request.body);
        if (Object.keys(body).some((key) => key !== "name"))
          throw new KnowledgeError("仅支持创建当前账户的知识库");
        return parseSettings(await client.request("/bases", "POST", body));
      });
      scoped.delete<{ Params: { id: string } }>("/bases/:id", async (request) =>
        parseSettings(
          await client.request(
            `/bases/${encodeURIComponent(request.params.id)}`,
            "DELETE",
          ),
        ),
      );
      scoped.get<{ Params: { id: string } }>("/bases/:id/members", async (request) => {
        const data = record(await client.request(`/bases/${encodeURIComponent(request.params.id)}/members`));
        return { members: Array.isArray(data.members) ? data.members : [] };
      });
      scoped.post<{ Params: { id: string } }>("/bases/:id/members", async (request) => {
        const body = record(request.body);
        if (Object.keys(body).some((key) => key !== "userId") || !text(body.userId).trim()) throw new KnowledgeError("用户 ID 无效");
        return client.request(`/bases/${encodeURIComponent(request.params.id)}/members`, "POST", { userId: text(body.userId).trim() });
      });
      scoped.delete<{ Params: { id: string; memberId: string } }>("/bases/:id/members/:memberId", async (request) => {
        await client.request(`/bases/${encodeURIComponent(request.params.id)}/members/${encodeURIComponent(request.params.memberId)}`, "DELETE");
        return { ok: true };
      });
      scoped.get<{ Params: { id: string }; Querystring: { page?: string } }>(
        "/bases/:id/files",
        async (request) => {
          const page = Number(request.query.page ?? 1);
          if (!Number.isSafeInteger(page) || page < 1 || page > 10000)
            throw new KnowledgeError("页码无效");
          const data = record(
            await client.request(
              `/bases/${encodeURIComponent(request.params.id)}/files?page=${page}`,
            ),
          );
          if (!Array.isArray(data.files))
            throw new KnowledgeError("文件列表格式无效", 502);
          return {
            files: data.files.map((value) => {
              const file = record(value);
              return {
                id: text(file.id),
                name: text(file.name),
                status: text(file.status),
                message: text(file.message),
              };
            }),
            total: typeof data.total === "number" ? data.total : 0,
            page,
          };
        },
      );
      scoped.post<{ Params: { id: string } }>(
        "/bases/:id/files",
        { bodyLimit: Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4096 },
        async (request) => {
          const body = record(request.body);
          if (
            Object.keys(body).some((key) => !["name", "content"].includes(key))
          )
            throw new KnowledgeError("文件参数无效");
          await client.request(
            `/bases/${encodeURIComponent(request.params.id)}/files`,
            "POST",
            body,
          );
          return { ok: true };
        },
      );
      scoped.delete<{ Params: { id: string; fileId: string } }>(
        "/bases/:id/files/:fileId",
        async (request) => {
          const body = record(request.body);
          if (Object.keys(body).some((key) => key !== "page"))
            throw new KnowledgeError("文件参数无效");
          await client.request(
            `/bases/${encodeURIComponent(request.params.id)}/files/${encodeURIComponent(request.params.fileId)}`,
            "DELETE",
            body,
          );
          return { ok: true };
        },
      );
      scoped.post("/recall", async (request) => {
        const body = record(request.body);
        if (
          Object.keys(body).some((key) => key !== "query") ||
          !text(body.query).trim() ||
          text(body.query).length > 8000
        )
          throw new KnowledgeError("检索问题无效");
        return client.recall(text(body.query));
      });
    },
    { prefix: "/api/knowledge" },
  );
}
