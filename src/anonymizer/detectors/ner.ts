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
        // Lazy-load — transformers is heavy AND optional. If the package
        // isn't installed (or its native deps failed), bail to regex-only.
        // Use a dynamic specifier so esbuild leaves the import as runtime —
        // the optional dep may legitimately be absent in regex-only installs.
        const specifier = "@huggingface/transformers";
        const mod = await import(specifier);
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

// Common greetings / interjections the multilingual NER model frequently
// mis-tags as PER/LOC. Compared lowercase + trimmed.
const NER_STOPLIST = new Set([
  "bonjour","bonsoir","salut","coucou","hello","hi","hey","yo","ciao","hola",
  "merci","thanks","thank","please","stp","svp","ok","oui","non","yes","no",
  "cher","chère","dear","madame","monsieur","sir","madam","mr","mrs","ms","dr",
  "test","todo","fixme","note","warning","error","info","debug","tbd",
]);

// A real PER/LOC/ORG fits in a short span: a name, a city, a company.
// If the transformers backend returns a giant multi-line "entity", it's a
// runaway merge — not a real named entity. Hard-cap the span.
const MAX_NER_LEN = 80;

function isNoiseHit(e: Entity): boolean {
  const t = e.text.trim();
  if (t.length < 2) return true;
  if (t.length > MAX_NER_LEN) return true;
  if (/[\n\r]/.test(t)) return true;
  if (!/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(t)) return true;
  if (NER_STOPLIST.has(t.toLowerCase())) return true;
  return false;
}

// Defensive dedup: same (type, start, end) triple should not appear twice.
// Some transformer backends emit duplicate spans per token group.
function dedupSpans(entities: Entity[]): Entity[] {
  const seen = new Set<string>();
  const out: Entity[] = [];
  for (const e of entities) {
    const key = `${e.type}:${e.start}:${e.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export async function detectNER(text: string, minScore = 0.85): Promise<Entity[]> {
  if (!text.trim()) return [];
  const pipe = await getPipeline();
  if (pipe === UNAVAILABLE) return [];
  const raw = await pipe(text, { ignore_labels: [] });
  const merged = mergeBIO(raw, text);
  const filtered = merged.filter(
    (e) => e.score >= minScore && !isNoiseHit(e),
  );
  return dedupSpans(filtered);
}

/** Pre-warm the model so the first user message isn't slow. */
export async function warmupNER(): Promise<void> {
  await getPipeline();
}

/** Check whether the optional NER stack is installed and loadable. */
export async function isNERAvailable(): Promise<boolean> {
  return (await getPipeline()) !== UNAVAILABLE;
}
