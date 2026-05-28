import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, } from "node:fs";
const DIR = join(homedir(), ".anonyagent");
const FILE = join(DIR, "config.json");
export function configPath() {
    return FILE;
}
export function readUserConfig() {
    if (!existsSync(FILE))
        return {};
    try {
        const raw = readFileSync(FILE, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
export function writeUserConfig(patch) {
    mkdirSync(DIR, { recursive: true });
    const merged = { ...readUserConfig(), ...patch };
    writeFileSync(FILE, JSON.stringify(merged, null, 2), "utf8");
    // Best-effort lockdown. No-op on Windows where POSIX perms are ignored.
    try {
        chmodSync(FILE, 0o600);
    }
    catch {
        /* ignore */
    }
    return merged;
}
