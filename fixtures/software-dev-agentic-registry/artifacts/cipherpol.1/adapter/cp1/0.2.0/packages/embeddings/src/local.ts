import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { config } from "@kb/core";

const BATCH = 32; // keep peak memory bounded on CPU

let extractorP: Promise<FeatureExtractionPipeline> | null = null;

/**
 * Lazily load the local embedding model. The first call downloads the model
 * from the HuggingFace hub (one time, cached under ~/.cache); every embedding
 * after that runs fully offline in-process — no external service per query.
 */
function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorP) {
    extractorP = pipeline("feature-extraction", config.embeddings.model) as Promise<FeatureExtractionPipeline>;
  }
  return extractorP;
}

async function encode(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    // mean pooling + L2 normalize → cosine-ready vectors matching the DB index.
    const tensor = await extractor(batch, { pooling: "mean", normalize: true });
    out.push(...(tensor.tolist() as number[][]));
  }
  return out;
}

/** Embed many documents (index time). Auto-batched. */
export async function embedDocuments(texts: string[]): Promise<number[][]> {
  return encode(texts);
}

/** Embed a single query string (search time). */
export async function embedQuery(text: string): Promise<number[]> {
  const [vec] = await encode([text]);
  if (!vec) throw new Error("embedding model returned no vector for query");
  return vec;
}

/** Expected embedding dimension (must match the pgvector column). */
export function embeddingDim(): number {
  return config.embeddings.dimensions;
}
