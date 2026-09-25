import { randomUUID } from "expo-crypto";

/** Device-side id for a recording or memo, so retries never create duplicates on the server. */
export const newLocalId = () => randomUUID();
