import type { Entity, EntityType } from "../types.js";

type TokenClass = {
  entity: string; // e.g. "B-PER", "I-LOC"
  word: string;
  start: number;
  end: number;
  score: number;
};

type Pipeline = (text: string, opts?: unknown) => Promise<TokenClass[]>;

/** Sentinel returned when the optional ML stack isn't installed. */
const UNAVAILABLE = Symbol("NER unavailable");
type MaybePipeline = Pipeline | typeof UNAVAILABLE;

let pipelinePromise: Promise<MaybePipeline> | null = null;

const DEFAULT_MODEL =
  process.env.ANONYAGENT_NER_MODEL ??
  "Xenova/bert-base-multilingual-cased-ner-hrl";

async function getPipeline(): Promise<MaybePipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      try {
        // Lazy-load — transformers.js is heavy AND optional. If the package
        // isn't installed (or its native deps failed), bail to regex-only.
        const mod = await import("@xenova/transformers");
        const { pipeline, env } = mod as unknown as {
          pipeline: (task: string, model: string) => Promise<unknown>;
          env: { allowLocalModels: boolean; allowRemoteModels: boolean };
        };
        env.allowLocalModels = true;
        env.allowRemoteModels = true;
        const p = await pipeline("token-classification", DEFAULT_MODEL);
        return p as unknown as Pipeline;
      } catch {
        return UNAVAILABLE;
      }
    })();
  }
  return pipelinePromise;
}

/** Map NER tag suffixes to our EntityType. Returns null if unsupported. */
function tagToType(tag: string): EntityType | null {
  const suffix = tag.split("-").pop()?.toUpperCase() ?? "";
  switch (suffix) {
    case "PER":
    case "PERSON":
      return "PERSON";
    case "ORG":
      return "ORG";
    case "LOC":
    case "GPE":
      return "LOC";
    case "DATE":
      return "DATE";
    default:
      return null;
  }
}

/**
 * Merge BIO-tagged tokens into contiguous entities.
 * transformers.js returns per-token classifications; we glue B-* + I-* runs back together.
 */
function mergeBIO(tokens: TokenClass[], text: string): Entity[] {
  const out: Entity[] = [];
  let current: { type: EntityType; start: number; end: number; scores: number[] } | null = null;

  const flush = () => {
    if (!current) return;
    out.push({
      type: current.type,
      start: current.start,
      end: current.end,
      text: text.slice(current.start, current.end),
      score: current.scores.reduce((a, b) => a + b, 0) / current.scores.length,
      source: "ner",
    });
    current = null;
  };

  for (const tok of tokens) {
    const type = tagToType(tok.entity);
    if (!type) {
      flush();
      continue;
    }
    const isBegin = tok.entity.startsWith("B-");
    if (current && current.type === type && !isBegin && tok.start <= current.end + 1) {
      current.end = tok.end;
      current.scores.push(tok.score);
    } else {
      flush();
      current = { type, start: tok.start, end: tok.end, scores: [tok.score] };
    }
  }
  flush();
  return out;
}

export async function detectNER(text: string, minScore = 0.85): Promise<Entity[]> {
  if (!text.trim()) return [];
  const pipe = await getPipeline();
  if (pipe === UNAVAILABLE) return [];
  const raw = await pipe(text, { ignore_labels: [] });
  const merged = mergeBIO(raw, text);
  return merged.filter((e) => e.score >= minScore);
}

/** Pre-warm the model so the first user message isn't slow. */
export async function warmupNER(): Promise<void> {
  await getPipeline();
}

/** Check whether the optional NER stack is installed and loadable. */
export async function isNERAvailable(): Promise<boolean> {
  return (await getPipeline()) !== UNAVAILABLE;
}
