import type { FastifyError, FastifyInstance } from "fastify";
import type { ApiError } from "@sitemate/shared";
import { AppError } from "../errors";
import { QuotaExceededError } from "../services/ai/types";

/** Turns every error into `{ error: { code, message, hint } }` without leaking internals. */
export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    let status = 500;
    let body: ApiError = {
      error: {
        code: "SERVER_ERROR",
        message: "Something went wrong on the server.",
        hint: "Try again in a minute. If it keeps happening, check the server logs.",
      },
    };

    if (err instanceof AppError) {
      status = err.statusCode;
      body = { error: { code: err.code, message: err.message, hint: err.hint } };
    } else if (err instanceof QuotaExceededError) {
      status = 429;
      body = {
        error: {
          code: "AI_QUOTA",
          message: "Today's free AI limit has been reached.",
          hint: "It resets automatically (Gemini resets at midnight US time, about 12:30–1:30 PM IST). Your work is saved and will continue then.",
        },
      };
    } else if ("validation" in err && err.validation) {
      status = 400;
      body = { error: { code: "BAD_REQUEST", message: err.message } };
    } else if ("statusCode" in err && err.statusCode === 429) {
      status = 429;
      body = { error: { code: "TOO_MANY_REQUESTS", message: "Too many requests.", hint: "Wait a minute and try again." } };
    }

    if (status >= 500) req.log.error({ err }, "request failed");
    reply.status(status).send(body);
  });
}
