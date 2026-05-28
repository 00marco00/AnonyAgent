import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ProjectConfig {
  /** Directory we anchored on (where `.anonyagent/` or `AGENTS.md` was found). */
  root: string;
  /** Content of AGENTS.md, if present. */
  agentsMd: string | null;
  /** Concatenated rules files, if any. */
  rules: string | null;
}

const MARKERS = [".anonyagent", "AGENTS.md", ".git"] as const;

/**
 * Walk from `from` up to the filesystem root and stop at the first directory
 * that contains any of the anchor markers. If we find a `.git`-only ancestor
 * (a repo root), we still anchor there even without a `.anonyagent/` — that's the
 * natural place for `AGENTS.md`.
 */
export function findProjectRoot(from: string = process.cwd()): string | null {
  let dir = resolve(from);
  while (true) {
    for (const marker of MARKERS) {
      if (existsSync(join(dir, marker))) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readIfExists(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    if (!statSync(path).isFile()) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readRulesDir(rulesDir: string): string | null {
  if (!existsSync(rulesDir)) return null;
  try {
    if (!statSync(rulesDir).isDirectory()) return null;
  } catch {
    return null;
  }
  const out: string[] = [];
  for (const name of readdirSync(rulesDir).sort()) {
    if (!name.endsWith(".md")) continue;
    const content = readIfExists(join(rulesDir, name));
    if (!content) continue;
    out.push(`### ${name}\n\n${content.trim()}`);
  }
  return out.length ? out.join("\n\n") : null;
}

export function loadProjectConfig(from: string = process.cwd()): ProjectConfig | null {
  const root = findProjectRoot(from);
  if (!root) return null;

  // AGENTS.md may live at the root, or inside .anonyagent/.
  const agentsMd =
    readIfExists(join(root, ".anonyagent", "AGENTS.md")) ??
    readIfExists(join(root, "AGENTS.md"));

  // Rules: either a single .anonyagent/rules.md, or one or more files in .anonyagent/rules/.
  const singleRules = readIfExists(join(root, ".anonyagent", "rules.md"));
  const rulesDir = readRulesDir(join(root, ".anonyagent", "rules"));
  const rules =
    singleRules && rulesDir
      ? `${singleRules.trim()}\n\n${rulesDir}`
      : (singleRules?.trim() ?? rulesDir);

  if (!agentsMd && !rules) {
    return { root, agentsMd: null, rules: null };
  }

  return { root, agentsMd: agentsMd?.trim() ?? null, rules };
}

/** Format the loaded project config into a block to append to the system prompt. */
export function projectPromptSection(cfg: ProjectConfig | null): string {
  if (!cfg || (!cfg.agentsMd && !cfg.rules)) return "";
  const parts: string[] = [
    `PROJECT CONTEXT`,
    `You are operating inside this project: ${cfg.root}`,
  ];
  if (cfg.agentsMd) {
    parts.push("", "## AGENTS.md", cfg.agentsMd);
  }
  if (cfg.rules) {
    parts.push("", "## Project rules", cfg.rules);
  }
  return parts.join("\n");
}
