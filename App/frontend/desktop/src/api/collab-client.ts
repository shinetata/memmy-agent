import type { RuntimeConfig } from "@memmy/local-api-contracts";
import { z } from "zod";
import { requestJson } from "./http.js";

const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  memberCount: z.number(),
  sessionCount: z.number(),
  createdAt: z.string().nullable(),
  /**
   * The local Memmy project this online project runs tasks in, or null until it is bound. A backend that predates
   * the binding omits it, which must not fail the whole list.
   */
  localProjectId: z.string().nullish().transform((value) => value ?? null)
});

const ProjectSessionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  title: z.string(),
  lastQuestion: z.string(),
  memberName: z.string(),
  mine: z.boolean(),
  source: z.string(),
  turnCount: z.number(),
  lastActiveAt: z.string().nullable(),
  link: z.string(),
  shareText: z.string()
});

const LocalSessionGroupSchema = z.object({
  id: z.string(),
  label: z.string(),
  path: z.string().nullable()
});

const LocalAgentSessionSchema = z.object({
  sourceId: z.string(),
  agentName: z.string(),
  conversationId: z.string(),
  title: z.string(),
  lastQuestion: z.string(),
  workspacePath: z.string().nullable(),
  group: LocalSessionGroupSchema.nullable(),
  updatedAt: z.string(),
  turnCount: z.number()
});

const LinksSchema = z.object({
  groups: z.array(z.object({ sourceId: z.string(), groupId: z.string(), excluded: z.array(z.string()) })),
  sessions: z.array(z.object({ sourceId: z.string(), conversationId: z.string() }))
});

const ProjectsResponseSchema = z.object({ projects: z.array(ProjectSchema) });
const CreateProjectResponseSchema = z.object({ project: ProjectSchema, localDirectory: z.string().optional() });
const ProjectSessionsResponseSchema = z.object({
  project: ProjectSchema,
  sessions: z.array(ProjectSessionSchema),
  /** Every session matching the query, which may be more than this page. */
  total: z.number().optional()
});
const SessionTurnSchema = z.object({
  question: z.string(),
  reply: z.string(),
  steps: z.array(z.string()),
  startedAt: z.string()
});
const SessionDetailResponseSchema = z.object({ session: ProjectSessionSchema, turns: z.array(SessionTurnSchema) });
const LocalSessionsResponseSchema = z.object({ sessions: z.array(LocalAgentSessionSchema), refreshing: z.boolean() });
const SyncResponseSchema = z.object({
  uploaded: z.number(),
  removed: z.number(),
  failed: z.number(),
  /** Sessions queued for upload; absent when nothing was queued. */
  started: z.number().optional()
});
const SyncProgressSchema = z.object({
  running: z.boolean(),
  total: z.number(),
  completed: z.number(),
  failed: z.number()
});
/** One Memmy session of the project's local folder, as the sync picker lists it. */
const ProjectTaskSchema = z.object({
  conversationId: z.string(),
  title: z.string(),
  lastQuestion: z.string(),
  updatedAt: z.string(),
  turnCount: z.number(),
  included: z.boolean(),
  synced: z.boolean()
});
const ProjectTasksResponseSchema = z.object({ tasks: z.array(ProjectTaskSchema) });
const OkResponseSchema = z.object({ ok: z.literal(true) });
const ItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  /** The last 演变轨迹 entry. */
  latest: z.string(),
  /** Whether MemOS has the latest Markdown in effect: 处理中, 已生效, 失败. */
  status: z.enum(["PROCESSING", "AVAILABLE", "FAILED"]),
  statusMessage: z.string().nullable(),
  /** The version a save builds on. */
  version: z.number(),
  markdown: z.string(),
  sources: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedBy: z.object({ name: z.string(), kind: z.enum(["organize", "edit"]) }).nullable()
});
const ItemsResponseSchema = z.object({
  items: z.array(ItemSchema),
  organizedAt: z.string().nullable(),
  role: z.string(),
  canEdit: z.boolean(),
  canOrganize: z.boolean(),
  pendingSessions: z.number(),
  /** Why this device's last pass failed; null when it did not. */
  lastError: z.string().nullable()
});
const ItemResponseSchema = z.object({ item: ItemSchema });
const SaveItemResponseSchema = z.object({ item: ItemSchema, changed: z.boolean() });

export type CollabProject = z.infer<typeof ProjectSchema>;
export type CollabProjectSession = z.infer<typeof ProjectSessionSchema>;
export type LocalAgentSession = z.infer<typeof LocalAgentSessionSchema>;
export type LocalSessionGroup = z.infer<typeof LocalSessionGroupSchema>;
/** What this computer associates with a project: whole groups (new sessions included) and single sessions. */
export type CollabLinks = z.infer<typeof LinksSchema>;
export type CollabSyncResult = z.infer<typeof SyncResponseSchema>;
export type CollabSessionTurn = z.infer<typeof SessionTurnSchema>;
export interface CollabSessionPage {
  project: CollabProject;
  sessions: CollabProjectSession[];
  total: number;
}
export type CollabSyncProgress = z.infer<typeof SyncProgressSchema>;
/** A Memmy session of this project's local folder, and whether the project includes it. */
export type CollabProjectTask = z.infer<typeof ProjectTaskSchema>;
/** A work item: one Markdown file in the project's knowledge base, indexed by the cloud. */
export type CollabItem = z.infer<typeof ItemSchema>;
export type CollabItemsView = z.infer<typeof ItemsResponseSchema>;

export interface CollabClient {
  listProjects(): Promise<CollabProject[]>;
  /** Creates the cloud project and returns the directory its tasks run in, absent on a backend without it. */
  createProject(name: string, directory?: string): Promise<{ project: CollabProject; localDirectory?: string }>;
  /** Records which local Memmy project runs this online project's tasks. */
  bindLocalProject(projectId: string, localProjectId: string): Promise<void>;
  /** Deletes the shared project and keeps the local project, so its tasks stay on this computer. */
  deleteProject(projectId: string): Promise<void>;
  /**
   * The folder this project's tasks run in, created on demand for a project that predates binding. `name` names
   * the managed folder after the project, since that folder is what a task page shows.
   */
  ensureWorkingDirectory(projectId: string, name?: string): Promise<string>;
  /** One page of a project's sessions, newest activity first; `total` counts every match. */
  listSessions(projectId: string, options?: { query?: string; member?: "me" | "others"; offset?: number; limit?: number }): Promise<CollabSessionPage>;
  /** A session and its turns, for reading it in the app. */
  readSessionDetail(sessionId: string): Promise<{ session: CollabProjectSession; turns: CollabSessionTurn[] }>;
  /**
   * Sessions the person can reference from a message, limited to one project and most recent first.
   * No query returns the latest few.
   */
  listCandidateSessions(input: { projectId: string; query?: string; limit?: number }): Promise<CollabProjectSession[]>;
  /** Downloads one session and returns the text a message carries so an agent reads it. */
  readReference(reference: string): Promise<{ session: CollabProjectSession; path: string; text: string }>;
  /** Answers from the last scan at once; `refreshing` means asking again with `fresh` returns a newer list. */
  listLocalSessions(input: { query?: string; sourceIds?: string[]; limit?: number; fresh?: boolean }): Promise<{ sessions: LocalAgentSession[]; refreshing: boolean }>;
  getLinks(projectId: string): Promise<CollabLinks>;
  /** Saves the selection and queues the upload; it returns before the sessions arrive. */
  saveLinks(projectId: string, links: CollabLinks): Promise<CollabSyncResult>;
  /** The Memmy sessions of the project's local folder, each saying whether the project includes it. */
  listProjectTasks(projectId: string): Promise<CollabProjectTask[]>;
  /** Keeps only the listed sessions in the project and queues what is missing. */
  saveProjectTasks(projectId: string, included: readonly string[]): Promise<CollabSyncResult>;
  getSyncProgress(projectId: string): Promise<CollabSyncProgress>;
  removeSession(projectId: string, sessionId: string): Promise<void>;
  /**
   * Uploads newly finished Memmy tasks. `tasks` keeps it to those, which needs no agent scan and is what a board
   * opening can afford; the full sync also covers sessions associated from other agents. `projectId` limits the
   * task sync to one project, so opening a board never waits for the others.
   */
  syncSessions(options?: { tasksOnly?: boolean; projectId?: string }): Promise<CollabSyncResult>;
  /** The project's work items, most recently updated first. */
  listItems(projectId: string): Promise<CollabItemsView>;
  /** One item with its current Markdown, to edit it. */
  readItem(projectId: string, itemId: string): Promise<CollabItem>;
  /** Saves a hand edit on top of `baseVersion`; a newer version in between fails with code "conflict". */
  saveItem(projectId: string, itemId: string, input: { markdown: string; baseVersion: number }): Promise<{ item: CollabItem; changed: boolean }>;
}

/** Online projects through the desktop's local API, which signs cloud requests with the person's account. */
export function createHttpCollabClient(config: RuntimeConfig): CollabClient {
  return {
    async listProjects() {
      return (await requestJson({ config, path: "/api/collab/projects", schema: ProjectsResponseSchema })).projects;
    },

    async createProject(name, directory) {
      return requestJson({
        config,
        path: "/api/collab/projects",
        schema: CreateProjectResponseSchema,
        body: { name, ...(directory ? { directory } : {}) }
      });
    },

    async ensureWorkingDirectory(projectId, name) {
      const result = await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/working-directory`,
        schema: z.object({ localDirectory: z.string() }),
        body: name ? { name } : {},
        init: { method: "POST" }
      });
      return result.localDirectory;
    },

    async deleteProject(projectId) {
      await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}`,
        schema: OkResponseSchema,
        init: { method: "DELETE" }
      });
    },

    async bindLocalProject(projectId, localProjectId) {
      await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/binding`,
        schema: OkResponseSchema,
        body: { localProjectId },
        init: { method: "PUT" }
      });
    },

    async listSessions(projectId, options) {
      const query = new URLSearchParams();
      if (options?.query) query.set("q", options.query);
      if (options?.member) query.set("member", options.member);
      if (options?.offset !== undefined) query.set("offset", String(options.offset));
      if (options?.limit !== undefined) query.set("limit", String(options.limit));
      const suffix = query.toString();
      const result = await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/sessions${suffix ? `?${suffix}` : ""}`,
        schema: ProjectSessionsResponseSchema
      });
      // A backend that predates paging sends every session and no total; treat that as one full page.
      return { ...result, total: result.total ?? result.sessions.length };
    },

    async readSessionDetail(sessionId) {
      return requestJson({
        config,
        path: `/api/collab/sessions/${encodeURIComponent(sessionId)}`,
        schema: SessionDetailResponseSchema
      });
    },

    async readReference(reference) {
      return requestJson({
        config,
        path: "/api/collab/sessions/read",
        schema: z.object({ session: ProjectSessionSchema, path: z.string(), text: z.string() }),
        body: { reference }
      });
    },

    async listCandidateSessions(input) {
      const query = new URLSearchParams({ projectId: input.projectId });
      if (input.query) query.set("q", input.query);
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      const suffix = query.toString();
      const result = await requestJson({
        config,
        path: `/api/collab/sessions/candidates${suffix ? `?${suffix}` : ""}`,
        schema: z.object({ sessions: z.array(ProjectSessionSchema) })
      });
      return result.sessions;
    },

    async listLocalSessions(input) {
      return requestJson({ config, path: "/api/collab/local-sessions", schema: LocalSessionsResponseSchema, body: input });
    },

    async getLinks(projectId) {
      return requestJson({ config, path: `/api/collab/projects/${encodeURIComponent(projectId)}/links`, schema: LinksSchema });
    },

    async saveLinks(projectId, links) {
      return requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/links`,
        schema: SyncResponseSchema,
        body: links,
        init: { method: "PUT" }
      });
    },

    async listProjectTasks(projectId) {
      return (await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/tasks`,
        schema: ProjectTasksResponseSchema
      })).tasks;
    },

    async saveProjectTasks(projectId, included) {
      return requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/tasks`,
        schema: SyncResponseSchema,
        body: { included },
        init: { method: "PUT" }
      });
    },

    async syncSessions(options) {
      return requestJson({
        config,
        path: "/api/collab/sync",
        schema: SyncResponseSchema,
        body: options?.tasksOnly
          ? { tasks: true, ...(options.projectId ? { projectId: options.projectId } : {}) }
          : {},
        init: { method: "POST" }
      });
    },

    async getSyncProgress(projectId) {
      return requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/sync-progress`,
        schema: SyncProgressSchema
      });
    },

    async removeSession(projectId, sessionId) {
      await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`,
        schema: OkResponseSchema,
        init: { method: "DELETE" }
      });
    },

    async listItems(projectId) {
      return requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/items`,
        schema: ItemsResponseSchema
      });
    },

    async readItem(projectId, itemId) {
      const data = await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}`,
        schema: ItemResponseSchema
      });
      return data.item;
    },

    async saveItem(projectId, itemId, input) {
      return requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(itemId)}`,
        schema: SaveItemResponseSchema,
        body: input,
        init: { method: "PUT" }
      });
    }
  };
}
