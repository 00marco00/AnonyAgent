function luhnValid(num) {
    const digits = num.replace(/\D/g, "");
    if (digits.length < 12 || digits.length > 19)
        return false;
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let n = Number(digits[i]);
        if (alt) {
            n *= 2;
            if (n > 9)
                n -= 9;
        }
        sum += n;
        alt = !alt;
    }
    return sum % 10 === 0;
}
const RULES = [
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
        pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
    },
    {
        type: "IBAN",
        // 2 letters + 2 digits + 11..30 alphanum. Loose check, no checksum.
        pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    },
    {
        type: "CREDIT_CARD",
        pattern: /\b(?:\d[ -]?){13,19}\b/g,
        validate: luhnValid,
    },
    {
        type: "PHONE",
        // International or local with separators; min 7 digits total.
        pattern: /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]?\d{2,4}){2,4}/g,
        validate: (m) => m.replace(/\D/g, "").length >= 7 && m.replace(/\D/g, "").length <= 15,
    },
    {
        type: "UUID",
        pattern: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
    },
    {
        type: "API_KEY",
        // Common prefixes: sk-, pk-, ghp_, gho_, xoxb-, AKIA, AIza...
        pattern: /\b(?:sk-[A-Za-z0-9_-]{20,}|pk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g,
    },
    {
        type: "PATH",
        // Windows absolute paths, *nix absolute paths under /home or /Users, UNC paths.
        pattern: /(?:[A-Za-z]:\\[^\s"'<>|*?]+|\\\\[^\s"'<>|*?]+|\/(?:home|Users|root)\/[^\s"'<>|*?]+)/g,
    },
    {
        type: "SSN",
        // US SSN. Easy to extend (FR NIR, etc.).
        pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
    },
];
export function detectRegex(text) {
    const out = [];
    for (const rule of RULES) {
        // Reset lastIndex since regexes are reused.
        rule.pattern.lastIndex = 0;
        let m;
        while ((m = rule.pattern.exec(text)) !== null) {
            const matched = m[0];
            if (rule.validate && !rule.validate(matched))
                continue;
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
