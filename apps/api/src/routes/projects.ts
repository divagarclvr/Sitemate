import type { FastifyInstance } from "fastify";
import { CreateProjectBody, type ProjectDto } from "@sitemate/shared";
import type { Sql } from "../db/client";
import { parse } from "../validate";

export function projectsRoutes(db: Sql) {
  return async (app: FastifyInstance) => {
    app.get("/v1/projects", async (req): Promise<ProjectDto[]> => {
      return db<ProjectDto[]>`
        select id, name, code, location, status from projects
        where user_id = ${req.user!.id} order by status, name`;
    });

    app.post("/v1/projects", async (req): Promise<ProjectDto> => {
      const b = parse(CreateProjectBody, req.body);
      const [p] = await db<ProjectDto[]>`
        insert into projects (user_id, name, code, location)
        values (${req.user!.id}, ${b.name.trim()}, ${b.code ?? null}, ${b.location ?? null})
        returning id, name, code, location, status`;
      return p!;
    });
  };
}
