import { detectRegex } from "./detectors/regex.js";
import { detectNER } from "./detectors/ner.js";
import { detectSecrets } from "./detectors/secrets.js";
import { detectNamesByDictionary } from "./detectors/names.js";
import { PlaceholderAllocator } from "./placeholders.js";
import type { AnonymizationResult, Entity, EntityType } from "./types.js";

export interface AnonymizeOptions {
  allocator?: PlaceholderAllocator;
  /** Skip NER (regex only). Useful for fast paths / tests. */
  skipNER?: boolean;
  /** Override default minimum NER confidence. */
  nerMinScore?: number;
  /**
   * Extra substrings the user explicitly marked for redaction. Each occurrence
   * in the text is wrapped in a SECRET placeholder, taking priority over
   * everything else.
   */
  manualRedactions?: string[];
}

function findAllOccurrences(text: string, needle: string): Entity[] {
  if (!needle) return [];
  const out: Entity[] = [];
  let from = 0;
  while (from <= text.length) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) break;
    out.push({
      type: "SECRET",
      start: idx,
      end: idx + needle.length,
      text: needle,
      score: 1,
      source: "manual",
    });
    from = idx + needle.length;
  }
  return out;
}

/**
 * Type-priority used when two detectors overlap on the same span. Higher wins.
 * Regex matches for structured data are more reliable than NER guesses.
 */
const PRIORITY: Record<EntityType, number> = {
  SECRET: 110,
  HASH: 105,
  API_KEY: 100,
  CREDIT_CARD: 95,
  IBAN: 90,
  SSN: 90,
  EMAIL: 85,
  IP: 85,
  PHONE: 80,
  UUID: 75,
  URL: 70,
  PATH: 60,
  ADDRESS: 55,
  DATE: 40,
  PERSON: 30,
  ORG: 25,
  LOC: 20,
};

/** Resolve overlapping entities: keep the higher-priority span, drop the rest. */
function resolveOverlaps(entities: Entity[]): Entity[] {
  // Drop exact-duplicate spans first so the same (type,start,end) tuple
  // can't get replaced multiple times in the slice/concat loop.
  const seen = new Set<string>();
  const unique = entities.filter((e) => {
    const k = `${e.type}:${e.start}:${e.end}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const sorted = [...unique].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    // Longer first on ties — usually better.
    return b.end - b.start - (a.end - a.start);
  });
  const kept: Entity[] = [];
  for (const e of sorted) {
    const overlap = kept.find((k) => k.start < e.end && e.start < k.end);
    if (!overlap) {
      kept.push(e);
      continue;
    }
    // Decide who wins.
    const overlapWins =
      PRIORITY[overlap.type] >= PRIORITY[e.type] ? overlap : null;
    if (!overlapWins) {
      // Replace overlap with e.
      kept.splice(kept.indexOf(overlap), 1, e);
    }
    // else: drop e.
  }
  return kept.sort((a, b) => a.start - b.start);
}

export async function anonymize(
  text: string,
  opts: AnonymizeOptions = {},
): Promise<AnonymizationResult> {
  const allocator = opts.allocator ?? new PlaceholderAllocator();

  const regexHits = detectRegex(text);
  const secretHits = detectSecrets(text);
  const nameHits = detectNamesByDictionary(text);
  const nerHits = opts.skipNER
    ? []
    : await detectNER(text, opts.nerMinScore).catch(() => [] as Entity[]);
  const manualHits = (opts.manualRedactions ?? []).flatMap((s) =>
    findAllOccurrences(text, s),
  );

  const merged = resolveOverlaps([
    ...regexHits,
    ...secretHits,
    ...nameHits,
    ...nerHits,
    ...manualHits,
  ]);

  // Replace from right to left to preserve indices.
  let out = text;
  const replacedEntities: Entity[] = [];
  for (let i = merged.length - 1; i >= 0; i--) {
    const e = merged[i]!;
    const placeholder = allocator.allocate(e.type, e.text);
    e.placeholder = placeholder;
    out = out.slice(0, e.start) + placeholder + out.slice(e.end);
    replacedEntities.unshift(e);
  }

  return {
    anonymized: out,
    entities: replacedEntities,
    reverseMap: allocator.reverseMap(),
  };
}
