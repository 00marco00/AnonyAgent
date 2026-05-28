import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";

export interface StoredConfig {
  apiKey?: string;
  model?: string;
  baseURL?: string;
}

const DIR = join(homedir(), ".anonyagent");
const FILE = join(DIR, "config.json");

export function configPath(): string {
  return FILE;
}

export function readUserConfig(): StoredConfig {
  if (!existsSync(FILE)) return {};
  try {
    const raw = readFileSync(FILE, "utf8");
    return JSON.parse(raw) as StoredConfig;
  } catch {
    return {};
  }
}

export function writeUserConfig(patch: Partial<StoredConfig>): StoredConfig {
  mkdirSync(DIR, { recursive: true });
  const merged: StoredConfig = { ...readUserConfig(), ...patch };
  writeFileSync(FILE, JSON.stringify(merged, null, 2), "utf8");
  // Best-effort lockdown. No-op on Windows where POSIX perms are ignored.
  try {
    chmodSync(FILE, 0o600);
  } catch {
    /* ignore */
  }
  return merged;
}
