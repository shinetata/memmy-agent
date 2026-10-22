/** Online project store tests: the sidebar and the board read one list and one selection. */
import { beforeEach, describe, expect, it } from "vitest";
import type { CollabClient, CollabProject } from "../../api/collab-client.js";
import {
  addCollabProject,
  consumeCreateCollabProjectRequest,
  getCollabProjectsSnapshot,
  loadCollabProjects,
  replaceCollabProject,
  requestCreateCollabProject,
  resetCollabProjectsStore,
  selectCollabProject
} from "../collab-projects-store.js";

function project(id: string, name = id): CollabProject {
  return { id, name, role: "owner", memberCount: 1, sessionCount: 0, createdAt: null };
}

function clientWith(list: () => Promise<CollabProject[]>): CollabClient {
  return {
    listProjects: list,
    createProject: async (name) => project("new", name),
    listSessions: async () => ({ project: project("x"), sessions: [] }),
    listLocalSessions: async () => ({ sessions: [], refreshing: false }),
    getLinks: async () => ({ groups: [], sessions: [] }),
    saveLinks: async () => ({ uploaded: 0, removed: 0, failed: 0 }),
    removeSession: async () => undefined
  };
}

beforeEach(() => {
  resetCollabProjectsStore();
});

describe("collab projects store", () => {
  it("selects the first project once the list loads", async () => {
    await loadCollabProjects(clientWith(async () => [project("a"), project("b")]));

    expect(getCollabProjectsSnapshot().projects?.map((item) => item.id)).toEqual(["a", "b"]);
    expect(getCollabProjectsSnapshot().selectedId).toBe("a");
    expect(getCollabProjectsSnapshot().loading).toBe(false);
  });

  it("keeps a selected project that is still listed", async () => {
    await loadCollabProjects(clientWith(async () => [project("a"), project("b")]));
    selectCollabProject("b");

    await loadCollabProjects(clientWith(async () => [project("a"), project("b")]));

    expect(getCollabProjectsSnapshot().selectedId).toBe("b");
  });

  it("falls back to the first project when the selected one disappears", async () => {
    await loadCollabProjects(clientWith(async () => [project("a"), project("b")]));
    selectCollabProject("b");

    await loadCollabProjects(clientWith(async () => [project("a")]));

    expect(getCollabProjectsSnapshot().selectedId).toBe("a");
  });

  it("keeps an empty list and the reason when loading fails", async () => {
    await loadCollabProjects(clientWith(async () => {
      throw new Error("请先登录 Memmy 后使用在线项目");
    }));

    expect(getCollabProjectsSnapshot().projects).toEqual([]);
    expect(getCollabProjectsSnapshot().error).toContain("请先登录");
    expect(getCollabProjectsSnapshot().selectedId).toBeNull();
  });

  it("opens a newly created project and puts it first", async () => {
    await loadCollabProjects(clientWith(async () => [project("a")]));

    addCollabProject(project("b"));

    expect(getCollabProjectsSnapshot().projects?.map((item) => item.id)).toEqual(["b", "a"]);
    expect(getCollabProjectsSnapshot().selectedId).toBe("b");
  });

  it("updates a project in place after the board reloads it", async () => {
    await loadCollabProjects(clientWith(async () => [project("a")]));

    replaceCollabProject(project("a", "更名为 A"));

    expect(getCollabProjectsSnapshot().projects?.[0]?.name).toBe("更名为 A");
  });

  it("hands one create request to the board, then clears it", () => {
    requestCreateCollabProject();
    expect(getCollabProjectsSnapshot().createPending).toBe(true);

    consumeCreateCollabProjectRequest();
    expect(getCollabProjectsSnapshot().createPending).toBe(false);
  });
});
