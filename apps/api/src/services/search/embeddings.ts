import { ApiError, GoogleGenAI } from "@google/genai";
import { ProviderUnavailableError, QuotaExceededError } from "../ai/types";

/** Size of the vectors stored in `search_chunks.embedding` (vector(384)). */
export const EMBEDDING_DIMS = 384;

export interface EmbeddingProvider {
  readonly model: string;
  /** One vector per text, in order. Documents and questions are embedded differently for better matches. */
  embed(texts: string[], kind: "document" | "query"): Promise<number[][]>;
}

/** Google's free embedding model. Handles English, Tamil, Kannada, Telugu, Malayalam and Hindi, so no model runs on our server. */
export class GeminiEmbeddings implements EmbeddingProvider {
  private client: GoogleGenAI;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new GoogleGenAI({ apiKey, httpOptions: { timeout: 60_000, retryOptions: { attempts: 1 } } });
  }

  async embed(texts: string[], kind: "document" | "query"): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 20) {
      const batch = texts.slice(i, i + 20);
      try {
        const res = await this.client.models.embedContent({
          model: this.model,
          contents: batch,
          config: { outputDimensionality: EMBEDDING_DIMS, taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT" },
        });
        const vectors = (res.embeddings ?? []).map((e) => normalise(e.values ?? []));
        if (vectors.length !== batch.length) throw new Error("Embedding service returned the wrong number of vectors");
        out.push(...vectors);
      } catch (err) {
        if (err instanceof ApiError && err.status === 429) throw new QuotaExceededError("gemini-embeddings", "Free embedding limit reached");
        if (err instanceof ApiError && err.status >= 500) throw new ProviderUnavailableError("gemini-embeddings", "Embedding service is busy");
        throw err;
      }
    }
    return out;
  }
}

/** Shortened (truncated) Gemini vectors are not unit length; make them so. */
export function normalise(v: number[]): number[] {
  const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / len);
}

/** Postgres `vector` literal. */
export const toVectorLiteral = (v: number[]) => `[${v.map((x) => +x.toFixed(6)).join(",")}]`;
