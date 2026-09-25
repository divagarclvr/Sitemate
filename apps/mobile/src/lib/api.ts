import type { ApiError } from "@sitemate/shared";
import { config } from "./config";
import { supabase } from "./supabase";

/** An API failure with a message (and hint) that can be shown to the user as-is. */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    public hint?: string,
    public status?: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;

  let res: Response;
  try {
    res = await fetch(`${config.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiRequestError(
      "Can't reach the SiteMate server.",
      "Check your internet. If the server was asleep, wait 30–60 seconds and try again.",
    );
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (body as ApiError | null)?.error;
    throw new ApiRequestError(err?.message ?? `Server error (${res.status})`, err?.hint, res.status);
  }
  return body as T;
}
