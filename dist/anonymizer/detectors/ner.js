let pipelinePromise = null;
const DEFAULT_MODEL = process.env.ANONYAGENT_NER_MODEL ??
    "Xenova/bert-base-multilingual-cased-ner-hrl";
async function getPipeline() {
    if (!pipelinePromise) {
        pipelinePromise = (async () => {
            // Lazy-load — transformers.js is heavy.
            const { pipeline, env } = await import("@xenova/transformers");
            // Disable telemetry, cache models locally.
            env.allowLocalModels = true;
            env.allowRemoteModels = true;
            const p = await pipeline("token-classification", DEFAULT_MODEL);
            return p;
        })();
    }
    return pipelinePromise;
}
/** Map NER tag suffixes to our EntityType. Returns null if unsupported. */
function tagToType(tag) {
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
function mergeBIO(tokens, text) {
    const out = [];
    let current = null;
    const flush = () => {
        if (!current)
            return;
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
        }
        else {
            flush();
            current = { type, start: tok.start, end: tok.end, scores: [tok.score] };
        }
    }
    flush();
    return out;
}
export async function detectNER(text, minScore = 0.85) {
    if (!text.trim())
        return [];
    const pipe = await getPipeline();
    const raw = await pipe(text, { ignore_labels: [] });
    const merged = mergeBIO(raw, text);
    return merged.filter((e) => e.score >= minScore);
}
/** Pre-warm the model so the first user message isn't slow. */
export async function warmupNER() {
    await getPipeline();
}
