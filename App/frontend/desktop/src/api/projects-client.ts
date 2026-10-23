import type { RuntimeConfig } from "@memmy/local-api-contracts";
import { z } from "zod";
import { requestJson } from "./http.js";

const DirectoryResponseSchema = z.object({ path: z.string() });

/**
 * The folder a project runs its tasks in when the person did not pick one. It lives next to the project cache,
 * so a name-only project still has somewhere to work instead of borrowing a folder nobody chose.
 */
export async function prepareProjectDirectory(config: RuntimeConfig, name: string): Promise<string> {
  const result = await requestJson({
    config,
    path: "/api/projects/working-directory",
    schema: DirectoryResponseSchema,
    body: { name },
    init: { method: "POST" }
  });
  return result.path;
}
