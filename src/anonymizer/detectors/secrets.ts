import type { Entity } from "../types.js";

// Words that strongly suggest the value to their right is a secret.
const SECRET_KEYS =
  "api[_-]?key|apikey|api[_-]?secret|secret[_-]?key|access[_-]?key(?:[_-]?id)?|access[_-]?token|auth[_-]?token|bearer[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|x-api-key|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?access[_-]?key[_-]?id|password|passwd|pwd|secret|token";

// Match assignments like:
//   API_KEY=abcdef...
//   "apiKey": "abcdef..."
//   password: 'hunter2hunter2'
//   Authorization: Bearer abc...
// Capture group 1 = the secret value (without surrounding quotes).
// The optional ["'] between key and separator covers JSON / YAML forms
// like  "password": "..."  or  'apiKey' = '...'.
const ASSIGNMENT = new RegExp(
  `\\b(?:${SECRET_KEYS})\\b["']?\\s*[:=]\\s*["']?([A-Za-z0-9._~+/=-]{8,})["']?`,
  "gi",
);

// Authorization headers, where Bearer/Basic prefix the token.
const BEARER = /\b(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{16,})\b/g;

// AWS-style secret access keys: 40 chars from [A-Za-z0-9/+=], unprefixed.
// Conservative: only fires when on a line that mentions AWS / secret / access,
// to avoid grabbing any base64-ish blob.
const AWS_SECRET_LINE =
  /(?:aws|secret|access)[^\n]{0,40}?([A-Za-z0-9/+=]{40})\b/gi;

// Conservative high-entropy detector: only fires for long alphanum tokens that
// look obviously random. Designed to catch generic API keys without snagging
// long file paths or sentences.
const ENTROPY_CANDIDATE = /\b[A-Za-z0-9_-]{32,}\b/g;
const ENTROPY_THRESHOLD = 4.0;

function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  const n = s.length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksLikeSecret(token: string): boolean {
  if (token.length < 32) return false;
  // Require character-class mixing to skip natural-language CamelCase or kebab
  // identifiers.
  const hasLower = /[a-z]/.test(token);
  const hasUpper = /[A-Z]/.test(token);
  const hasDigit = /\d/.test(token);
  const classes = Number(hasLower) + Number(hasUpper) + Number(hasDigit);
  // All-hex (32+ chars) is almost always a token/hash/secret — accept with 2 classes.
  const isHex = /^[a-fA-F0-9]+$/.test(token) && token.length >= 32;
  if (!isHex && classes < 2) return false;
  return shannonEntropy(token) >= ENTROPY_THRESHOLD;
}

function pushSecret(out: Entity[], start: number, end: number, text: string, source: Entity["source"]) {
  out.push({ type: "API_KEY", start, end, text, score: 1, source });
}

export function detectSecrets(text: string): Entity[] {
  const out: Entity[] = [];

  // 1) keyword=value / "keyword": "value"
  ASSIGNMENT.lastIndex = 0;
  for (let m = ASSIGNMENT.exec(text); m; m = ASSIGNMENT.exec(text)) {
    const val = m[1];
    if (!val) continue;
    const start = m.index + m[0].lastIndexOf(val);
    pushSecret(out, start, start + val.length, val, "regex");
  }

  // 2) Bearer / Basic / Token headers
  BEARER.lastIndex = 0;
  for (let m = BEARER.exec(text); m; m = BEARER.exec(text)) {
    const val = m[1];
    if (!val) continue;
    const start = m.index + m[0].lastIndexOf(val);
    pushSecret(out, start, start + val.length, val, "regex");
  }

  // 2b) AWS-style 40-char secret keys when the line mentions aws/secret/access.
  AWS_SECRET_LINE.lastIndex = 0;
  for (let m = AWS_SECRET_LINE.exec(text); m; m = AWS_SECRET_LINE.exec(text)) {
    const val = m[1];
    if (!val) continue;
    const start = m.index + m[0].lastIndexOf(val);
    pushSecret(out, start, start + val.length, val, "regex");
  }

  // 3) Generic high-entropy tokens — fallback for unknown vendors.
  ENTROPY_CANDIDATE.lastIndex = 0;
  for (let m = ENTROPY_CANDIDATE.exec(text); m; m = ENTROPY_CANDIDATE.exec(text)) {
    const tok = m[0];
    if (!looksLikeSecret(tok)) continue;
    pushSecret(out, m.index, m.index + tok.length, tok, "heuristic");
  }

  return out;
}
