import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, } from "node:fs";
const DIR = join(homedir(), ".anonyagent");
const FILE = join(DIR, "history");
const MAX_ENTRIES = 500;
/**
 * Each line is JSON-encoded so that entries containing newlines or quotes
 * round-trip safely.
 */
export function loadHistory() {
    if (!existsSync(FILE))
        return [];
    try {
        const raw = readFileSync(FILE, "utf8");
        const out = [];
        for (const line of raw.split("\n")) {
            if (!line)
                continue;
            try {
                const v = JSON.parse(line);
                if (typeof v === "string")
                    out.push(v);
            }
            catch {
                // skip malformed line
            }
        }
        return out.slice(-MAX_ENTRIES);
    }
    catch {
        return [];
    }
}
export function saveHistory(entries) {
    try {
        mkdirSync(DIR, { recursive: true });
        const lines = entries
            .slice(-MAX_ENTRIES)
            .map((e) => JSON.stringify(e))
            .join("\n");
        writeFileSync(FILE, lines + (lines ? "\n" : ""), "utf8");
    }
    catch {
        // best effort; UI shouldn't crash on history-write failure
    }
}
/** Append one entry. Skips duplicates of the most recent line. */
export function appendHistory(current, entry) {
    const trimmed = entry.trim();
    if (!trimmed)
        return current;
    if (current.length > 0 && current[current.length - 1] === trimmed) {
        return current;
    }
    const next = [...current, trimmed].slice(-MAX_ENTRIES);
    saveHistory(next);
    return next;
}
