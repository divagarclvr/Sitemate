import type { FastifyInstance } from "fastify";
import type { Me } from "@sitemate/shared";
import type { Sql } from "../db/client";

export function meRoutes(db: Sql) {
  return async (app: FastifyInstance) => {
    app.get("/v1/me", async (req): Promise<Me> => {
      const user = req.user!;
      // First visit creates the settings row with defaults (see supabase/migrations).
      const [row] = await db`
        insert into user_settings (user_id) values (${user.id})
        on conflict (user_id) do update set updated_at = user_settings.updated_at
        returning timezone, default_language, transcript_script,
                  to_char(morning_plan_time, 'HH24:MI') as morning_plan_time,
                  to_char(evening_recap_time, 'HH24:MI') as evening_recap_time,
                  evening_recap_enabled, reminder_minutes, audio_retention_days, theme`;
      return { id: user.id, email: user.email, settings: row as unknown as Me["settings"] };
    });
  };
}
