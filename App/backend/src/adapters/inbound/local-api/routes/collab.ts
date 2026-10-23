/** Online project routes: projects, associated sessions, and references from other agents. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CollabItemsService } from "../../../../services/collab-items-service.js";
import type { CollabService } from "../../../../services/collab-service.js";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";

export interface RegisterCollabRoutesOptions {
  collab: CollabService;
  items?: CollabItemsService;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

const ProjectIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,36}$/u, "项目 ID 无效");
const CreateProjectSchema = z.object({
  name: z.string().trim().min(1, "请填写项目名称").max(20, "项目名称不超过 20 个字"),
  /** The folder the person picked for the project's tasks; a managed folder is used when absent. */
  directory: z.string().trim().min(1).max(4_000).optional()
}).strict();
const BindProjectSchema = z.object({ localProjectId: z.string().min(1).max(200) }).strict();
const WorkingDirectorySchema = z.object({
  /** Names the managed folder after the project instead of its generated id. */
  name: z.string().trim().min(1).max(200).optional(),
  directory: z.string().trim().min(1).max(4_000).optional()
}).strict();
const SyncSchema = z.object({ tasks: z.boolean().optional() }).strict();
const SessionListSchema = z.object({
  q: z.string().max(200).optional(),
  member: z.enum(["me", "others"]).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});
const CandidatesSchema = z.object({
  projectId: ProjectIdSchema,
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional()
});
const SourceIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u);
const ConversationIdSchema = z.string().min(1).max(200);
const LinksSchema = z.object({
  groups: z.array(z.object({
    sourceId: SourceIdSchema,
    groupId: z.string().min(1).max(1_000),
    excluded: z.array(ConversationIdSchema).max(500)
  }).strict()).max(100),
  sessions: z.array(z.object({ sourceId: SourceIdSchema, conversationId: ConversationIdSchema }).strict()).max(500)
}).strict();
const LocalSessionsSchema = z.object({
  query: z.string().max(200).optional(),
  sourceIds: z.array(z.string().max(32)).max(20).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  fresh: z.boolean().optional()
}).strict();
const SearchSchema = z.object({
  q: z.string().max(200).optional(),
  member: z.string().max(100).optional(),
  project: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional()
});
const ReadSchema = z.object({ reference: z.string().trim().min(1).max(2_000) }).strict();
const ItemIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u, "事项 ID 无效");
const SaveItemSchema = z.object({
  markdown: z.string().trim().min(1, "事项内容不能为空").max(30_000, "事项内容过长"),
  baseVersion: z.number().int().min(0)
}).strict();

export function registerCollabRoutes(app: FastifyInstance, options: RegisterCollabRoutesOptions): void {
  const guard = { preHandler: options.authenticateRuntimeToken };

  app.get("/api/collab/projects", guard, withErrorEnvelope(async (_request, reply) =>
    reply.send(await options.collab.listProjects())));

  app.post("/api/collab/projects", guard, withErrorEnvelope(async (request, reply) => {
    const input = CreateProjectSchema.parse(request.body ?? {});
    return reply.send(await options.collab.createProject(input.name, input.directory));
  }));

  // Projects created before binding existed, and tasks that lost their local project, get one on demand.
  // The board polls this while an association runs, so sessions appear as they are uploaded.
  app.get<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/sync-progress", guard, withErrorEnvelope(async (request, reply) =>
    reply.send(await options.collab.getSyncProgress(ProjectIdSchema.parse((request.params as { projectId: string }).projectId)))));

  app.post<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/working-directory", guard, withErrorEnvelope(async (request, reply) => {
    const projectId = ProjectIdSchema.parse((request.params as { projectId: string }).projectId);
    const input = WorkingDirectorySchema.parse(request.body ?? {});
    return reply.send(await options.collab.ensureWorkingDirectory(projectId, input.name, input.directory));
  }));

  app.put<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/binding", guard, withErrorEnvelope(async (request, reply) => {
    const projectId = ProjectIdSchema.parse((request.params as { projectId: string }).projectId);
    const input = BindProjectSchema.parse(request.body ?? {});
    return reply.send(await options.collab.bindLocalProject(projectId, input.localProjectId));
  }));

  app.get<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/sessions", guard, withErrorEnvelope(async (request, reply) => {
    const projectId = ProjectIdSchema.parse((request.params as { projectId: string }).projectId);
    const input = SessionListSchema.parse(request.query ?? {});
    return reply.send(await options.collab.listSessions(projectId, {
      ...(input.q === undefined ? {} : { query: input.q }),
      ...(input.member === undefined ? {} : { member: input.member }),
      ...(input.offset === undefined ? {} : { offset: input.offset }),
      ...(input.limit === undefined ? {} : { limit: input.limit })
    }));
  }));

  // The board's session reader and the @ menu both read one session without downloading a file.
  app.get<{ Params: { sessionId: string } }>("/api/collab/sessions/:sessionId", guard, withErrorEnvelope(async (request, reply) =>
    reply.send(await options.collab.readSessionDetail(ProjectIdSchema.parse((request.params as { sessionId: string }).sessionId)))));

  // The @ menu offers sessions of the project the task belongs to; a reference never leaves that project.
  app.get("/api/collab/sessions/candidates", guard, withErrorEnvelope(async (request, reply) => {
    const input = CandidatesSchema.parse(request.query ?? {});
    return reply.send(await options.collab.candidateSessions(input.projectId, {
      ...(input.q === undefined ? {} : { query: input.q }),
      ...(input.limit === undefined ? {} : { limit: input.limit })
    }));
  }));

  app.get<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/links", guard, withErrorEnvelope(async (request, reply) =>
    reply.send(await options.collab.getLinks(ProjectIdSchema.parse((request.params as { projectId: string }).projectId)))));

  app.put<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/links", guard, withErrorEnvelope(async (request, reply) => {
    const projectId = ProjectIdSchema.parse((request.params as { projectId: string }).projectId);
    const input = LinksSchema.parse(request.body ?? {});
    return reply.send(await options.collab.saveLinks(projectId, input));
  }));

  app.delete<{ Params: { projectId: string } }>("/api/collab/projects/:projectId", guard, withErrorEnvelope(async (request, reply) =>
    reply.send(await options.collab.deleteProject(ProjectIdSchema.parse((request.params as { projectId: string }).projectId)))));

  app.delete<{ Params: { projectId: string; sessionId: string } }>("/api/collab/projects/:projectId/sessions/:sessionId", guard, withErrorEnvelope(async (request, reply) => {
    const params = request.params as { projectId: string; sessionId: string };
    return reply.send(await options.collab.removeSession(ProjectIdSchema.parse(params.projectId), ProjectIdSchema.parse(params.sessionId)));
  }));

  // Opening a board syncs first, so a task finished a moment ago is already in its project's session list.
  // `tasks` keeps it to Memmy's own tasks, which needs no agent scan and returns in milliseconds.
  app.post("/api/collab/sync", guard, withErrorEnvelope(async (request, reply) => {
    const input = SyncSchema.parse(request.body ?? {});
    return reply.send(input.tasks ? await options.collab.syncProjectTasks() : await options.collab.syncLinkedSessions());
  }));

  app.post("/api/collab/local-sessions", guard, withErrorEnvelope(async (request, reply) => {
    const input = LocalSessionsSchema.parse(request.body ?? {});
    return reply.send(await options.collab.listLocalSessions(input));
  }));

  app.get("/api/collab/sessions/search", guard, withErrorEnvelope(async (request, reply) => {
    const input = SearchSchema.parse(request.query ?? {});
    return reply.send(await options.collab.searchSessions({
      ...(input.q === undefined ? {} : { query: input.q }),
      ...(input.member === undefined ? {} : { member: input.member }),
      ...(input.project === undefined ? {} : { project: input.project }),
      ...(input.limit === undefined ? {} : { limit: input.limit })
    }));
  }));

  app.post("/api/collab/sessions/read", guard, withErrorEnvelope(async (request, reply) => {
    const input = ReadSchema.parse(request.body ?? {});
    return reply.send(await options.collab.readSession(input.reference));
  }));

  const items = options.items;
  if (items) {
    app.get<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/items", guard, withErrorEnvelope(async (request, reply) =>
      reply.send(await items.listItems(ProjectIdSchema.parse((request.params as { projectId: string }).projectId)))));

    // Editing opens the item's current Markdown and the version it is saved on top of.
    app.get<{ Params: { projectId: string; itemId: string } }>("/api/collab/projects/:projectId/items/:itemId", guard, withErrorEnvelope(async (request, reply) => {
      const params = request.params as { projectId: string; itemId: string };
      return reply.send(await items.readItem(ProjectIdSchema.parse(params.projectId), ItemIdSchema.parse(params.itemId)));
    }));

    app.put<{ Params: { projectId: string; itemId: string } }>("/api/collab/projects/:projectId/items/:itemId", guard, withErrorEnvelope(async (request, reply) => {
      const params = request.params as { projectId: string; itemId: string };
      const input = SaveItemSchema.parse(request.body ?? {});
      return reply.send(await items.saveItem(ProjectIdSchema.parse(params.projectId), ItemIdSchema.parse(params.itemId), input));
    }));
  }
}
