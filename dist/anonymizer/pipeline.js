import { detectRegex } from "./detectors/regex.js";
import { detectNER } from "./detectors/ner.js";
import { PlaceholderAllocator } from "./placeholders.js";
/**
 * Type-priority used when two detectors overlap on the same span. Higher wins.
 * Regex matches for structured data are more reliable than NER guesses.
 */
const PRIORITY = {
    API_KEY: 100,
    CREDIT_CARD: 95,
    IBAN: 90,
    SSN: 90,
    EMAIL: 85,
    PHONE: 80,
    UUID: 75,
    URL: 70,
    IP: 65,
    PATH: 60,
    DATE: 40,
    PERSON: 30,
    ORG: 25,
    LOC: 20,
};
/** Resolve overlapping entities: keep the higher-priority span, drop the rest. */
function resolveOverlaps(entities) {
    const sorted = [...entities].sort((a, b) => {
        if (a.start !== b.start)
            return a.start - b.start;
        // Longer first on ties — usually better.
        return b.end - b.start - (a.end - a.start);
    });
    const kept = [];
    for (const e of sorted) {
        const overlap = kept.find((k) => k.start < e.end && e.start < k.end);
        if (!overlap) {
            kept.push(e);
            continue;
        }
        // Decide who wins.
        const overlapWins = PRIORITY[overlap.type] >= PRIORITY[e.type] ? overlap : null;
        if (!overlapWins) {
            // Replace overlap with e.
            kept.splice(kept.indexOf(overlap), 1, e);
        }
        // else: drop e.
    }
    return kept.sort((a, b) => a.start - b.start);
}
export async function anonymize(text, opts = {}) {
    const allocator = opts.allocator ?? new PlaceholderAllocator();
    const regexHits = detectRegex(text);
    const nerHits = opts.skipNER
        ? []
        : await detectNER(text, opts.nerMinScore).catch(() => []);
    const merged = resolveOverlaps([...regexHits, ...nerHits]);
    // Replace from right to left to preserve indices.
    let out = text;
    const replacedEntities = [];
    for (let i = merged.length - 1; i >= 0; i--) {
        const e = merged[i];
        const placeholder = allocator.allocate(e.type, e.text);
        out = out.slice(0, e.start) + placeholder + out.slice(e.end);
        replacedEntities.unshift(e);
    }
    return {
        anonymized: out,
        entities: replacedEntities,
        reverseMap: allocator.reverseMap(),
    };
}
