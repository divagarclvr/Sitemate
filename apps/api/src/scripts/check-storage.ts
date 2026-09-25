/**
 * Checks file storage works end to end (upload URL → upload → exists → download → delete).
 *   npm run check:storage -w @sitemate/api
 */
import { loadEnv } from "../config/env";
import { supabaseStorage } from "../services/storage";

const env = loadEnv();
const storage = supabaseStorage(env);
const path = `_checks/storage-check-${Date.now()}.txt`;
const body = `SiteMate storage check ${new Date().toISOString()}`;

try {
  const { url } = await storage.createUploadUrl(path);
  // Same request the phone makes: PUT the raw file to the signed URL.
  const res = await fetch(url, { method: "PUT", headers: { "content-type": "text/plain" }, body });
  if (!res.ok) throw new Error(`upload failed: HTTP ${res.status} ${await res.text()}`);
  if (!(await storage.exists(path))) throw new Error("file not found after upload");
  const back = (await storage.download(path)).toString("utf8");
  if (back !== body) throw new Error("downloaded content differs");
  await storage.remove([path]);
  console.log("✓ Storage works: upload, download and delete OK");
} catch (err) {
  console.error(`✗ Storage check failed: ${(err as Error).message}`);
  process.exit(1);
}
