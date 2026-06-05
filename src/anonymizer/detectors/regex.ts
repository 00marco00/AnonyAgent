import type { Entity, EntityType } from "../types.js";

interface RegexRule {
  type: EntityType;
  pattern: RegExp;
  /** Optional post-filter (e.g. Luhn check for credit cards). */
  validate?: (match: string) => boolean;
}

function luhnValid(num: string): boolean {
  const digits = num.replace(/\D/g, "");
  if (digits.length < 12 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const RULES: RegexRule[] = [
  {
    type: "EMAIL",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    type: "URL",
    pattern: /\bhttps?:\/\/[^\s<>"']+/g,
  },
  {
    type: "IP",
    // IPv4 only for now; IPv6 is noisy.
    pattern:
      /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
  },
  {
    type: "IBAN",
    // 2 letters + 2 digits + 11..30 alphanum, optionally split into 4-char groups
    // by single spaces (FR76 3000 6000 0112 3456 7890 189 etc.). Loose, no checksum.
    pattern: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g,
    validate: (m) => m.replace(/\s/g, "").length >= 15,
  },
  {
    type: "CREDIT_CARD",
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    validate: luhnValid,
  },
  {
    type: "PHONE",
    // International or local with separators; min 7 digits total. The leading
    // `+CC ` country-code group is part of the match so the redaction covers it.
    pattern: /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{1,4}(?:[\s.-]?\d{1,4}){2,7}/g,
    validate: (m) => {
      const digits = m.replace(/\D/g, "").length;
      return digits >= 7 && digits <= 15;
    },
  },
  {
    type: "UUID",
    pattern: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  },
  {
    type: "API_KEY",
    // Vendor-prefixed keys. Order matters only for readability — the regex engine
    // picks the longest valid alternation at each position.
    pattern: new RegExp(
      [
        // OpenAI / Anthropic / OpenRouter / generic sk-
        "sk-ant-[A-Za-z0-9_-]{30,}",
        "sk-or-v\\d-[A-Za-z0-9_-]{30,}",
        "sk-proj-[A-Za-z0-9_-]{30,}",
        "sk-[A-Za-z0-9_-]{20,}",
        // Stripe
        "pk_(?:live|test)_[A-Za-z0-9]{20,}",
        "sk_(?:live|test)_[A-Za-z0-9]{20,}",
        "rk_(?:live|test)_[A-Za-z0-9]{20,}",
        "pk-[A-Za-z0-9_-]{20,}",
        // xAI / Groq / Mistral / Together / Fireworks / Perplexity / Cohere
        "xai-[A-Za-z0-9]{30,}",
        "gsk_[A-Za-z0-9]{30,}",
        "pplx-[A-Za-z0-9]{30,}",
        "co-[A-Za-z0-9]{30,}",
        // Hugging Face / Replicate / Together
        "hf_[A-Za-z0-9]{30,}",
        "r8_[A-Za-z0-9]{30,}",
        // GitHub PAT family + GitLab
        "ghp_[A-Za-z0-9]{30,}",
        "gho_[A-Za-z0-9]{30,}",
        "ghs_[A-Za-z0-9]{30,}",
        "ghu_[A-Za-z0-9]{30,}",
        "ghr_[A-Za-z0-9]{30,}",
        "github_pat_[A-Za-z0-9_]{20,}",
        "glpat-[A-Za-z0-9_-]{20,}",
        // Slack
        "xox[abprso]-[A-Za-z0-9-]{10,}",
        // AWS — access keys are documented as 20 chars but the prefix-only
        // class doesn't have a length anchor in the wild, so extend to word
        // boundary to avoid leaving trailing chars unredacted.
        "AKIA[0-9A-Z]{16,}",
        "ASIA[0-9A-Z]{16,}",
        // Google Cloud / Firebase
        "AIza[0-9A-Za-z_-]{35}",
        "ya29\\.[0-9A-Za-z_-]{20,}",
        // Notion / SendGrid / Postman / Algolia
        "secret_[A-Za-z0-9]{40,}",
        "SG\\.[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{20,}",
        "PMAK-[A-Za-z0-9-]{20,}",
        // JWT (header.payload.signature)
        "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
      ].join("|"),
      "g",
    ),
  },
  {
    type: "PATH",
    // Windows absolute paths, *nix absolute paths under /home or /Users, UNC paths.
    pattern:
      /(?:[A-Za-z]:\\[^\s"'<>|*?]+|\\\\[^\s"'<>|*?]+|\/(?:home|Users|root)\/[^\s"'<>|*?]+)/g,
  },
  {
    type: "SSN",
    // US SSN. Easy to extend (FR NIR, etc.).
    pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
  },
  {
    type: "HASH",
    // bcrypt ($2a/$2b/$2y$), argon2 ($argon2i/$argon2d/$argon2id$), scrypt
    // ($scrypt$), PHC-style ($pbkdf2-sha256$). Catches the whole token until
    // the next whitespace.
    pattern:
      /\$(?:2[aby]|argon2(?:i|d|id)?|scrypt|pbkdf2(?:-[a-z0-9]+)?|sha\d+|md5)\$[^\s]{8,}/g,
  },
  {
    type: "ADDRESS",
    // French-style postal address: house number + street + 5-digit postal code + city.
    // Examples: "12 rue des Lilas, 06000 Nice", "1bis avenue de la République, 75011 Paris".
    // Loose by design — favors over-redaction over leakage.
    pattern:
      /\b\d{1,4}(?:\s?(?:bis|ter|quater))?,?\s+(?:rue|avenue|av\.?|boulevard|bd\.?|bld\.?|place|impasse|chemin|allée|allee|route|rte\.?|quai|cours|passage|villa|square|sentier)\s+(?:de\s+la\s+|de\s+l['’]?|du\s+|des\s+|de\s+|d['’]?)?[A-Za-zÀ-ÖØ-öø-ÿ' -]{2,40}(?:,\s*\d{5}\s+[A-Za-zÀ-ÖØ-öø-ÿ' -]{2,40})?/gi,
  },
];

export function detectRegex(text: string): Entity[] {
  const out: Entity[] = [];
  for (const rule of RULES) {
    // Reset lastIndex since regexes are reused.
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(text)) !== null) {
      const matched = m[0];
      if (rule.validate && !rule.validate(matched)) continue;
      out.push({
        start: m.index,
        end: m.index + matched.length,
        type: rule.type,
        text: matched,
        score: 1,
        source: "regex",
      });
    }
  }
  return out;
}
