import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../config/env";

/** Private file storage (Supabase Storage). Only the server holds the key. */
export interface FileStorage {
  /** A short-lived URL the phone can PUT the file to directly. */
  createUploadUrl(path: string): Promise<{ url: string }>;
  exists(path: string): Promise<boolean>;
  download(path: string): Promise<Buffer>;
  /** A short-lived URL to play or open a file. */
  createDownloadUrl(path: string, seconds?: number): Promise<string>;
  remove(paths: string[]): Promise<void>;
}

export function supabaseStorage(env: Env): FileStorage {
  const client: SupabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const bucket = () => client.storage.from(env.STORAGE_BUCKET);

  return {
    async createUploadUrl(path) {
      const { data, error } = await bucket().createSignedUploadUrl(path, { upsert: true });
      if (error) throw new Error(`storage: cannot create upload URL (${error.message})`);
      return { url: data.signedUrl };
    },
    async exists(path) {
      const { data, error } = await bucket().exists(path);
      if (error) return false;
      return data;
    },
    async download(path) {
      const { data, error } = await bucket().download(path);
      if (error || !data) throw new Error(`storage: cannot download ${path} (${error?.message})`);
      return Buffer.from(await data.arrayBuffer());
    },
    async createDownloadUrl(path, seconds = 600) {
      const { data, error } = await bucket().createSignedUrl(path, seconds);
      if (error) throw new Error(`storage: cannot create download URL (${error.message})`);
      return data.signedUrl;
    },
    async remove(paths) {
      if (paths.length === 0) return;
      const { error } = await bucket().remove(paths);
      if (error) throw new Error(`storage: cannot delete (${error.message})`);
    },
  };
}
