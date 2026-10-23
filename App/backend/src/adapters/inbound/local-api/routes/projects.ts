/** Local project utilities: the managed folder a project without a chosen directory runs in. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";
import type { ProjectDirectoryService } from "../../../../services/project-directory-service.js";

export interface RegisterProjectRoutesOptions {
  projectDirectory: ProjectDirectoryService;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

const PrepareDirectorySchema = z.object({
  name: z.string().trim().min(1, "请填写项目名称").max(60, "项目名称过长")
}).strict();

/** Registers the local project routes. */
export function registerProjectRoutes(app: FastifyInstance, options: RegisterProjectRoutesOptions): void {
  // A project created by name alone still needs a working directory: this is where it gets one.
  app.post("/api/projects/working-directory", { preHandler: options.authenticateRuntimeToken }, withErrorEnvelope(async (request, reply) => {
    const input = PrepareDirectorySchema.parse(request.body ?? {});
    return reply.send(await options.projectDirectory.prepareManagedDirectory(input.name));
  }));
}
