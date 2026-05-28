import { exec } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { anonymize } from "../anonymizer/pipeline.js";
const execAsync = promisify(exec);
// ── Helpers ──────────────────────────────────────────────────────────────
const MAX_OUTPUT = 50_000; // chars sent to the model
const MAX_FILE_READ = 200_000; // chars read from disk
function truncate(s, max = MAX_OUTPUT) {
    if (s.length <= max)
        return s;
    const head = s.slice(0, max);
    return `${head}\n\n[…truncated ${s.length - max} chars…]`;
}
function resolveInside(cwd, p) {
    const abs = resolve(cwd, p);
    // Guardrail: refuse to escape the project root.
    const rel = relative(cwd, abs);
    if (rel.startsWith("..") || /^[a-z]:/i.test(rel)) {
        throw new Error(`refusing to access path outside project root: ${p}`);
    }
    return abs;
}
function reqString(args, key) {
    const v = args[key];
    if (typeof v !== "string" || !v)
        throw new Error(`missing string arg "${key}"`);
    return v;
}
function optString(args, key) {
    const v = args[key];
    return typeof v === "string" && v ? v : undefined;
}
// ── Tools ────────────────────────────────────────────────────────────────
const readFileTool = {
    name: "read_file",
    description: "Read a UTF-8 text file from the project. Returns the file content with line numbers.",
    parameters: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Path to the file, relative to the project root.",
            },
        },
        required: ["path"],
    },
    readOnly: true,
    summarize: (a) => `read_file(${JSON.stringify(a.path)})`,
    run: async (args, ctx) => {
        const path = resolveInside(ctx.cwd, reqString(args, "path"));
        if (!existsSync(path))
            return { output: `file not found: ${args.path}`, isError: true };
        let content = readFileSync(path, "utf8");
        if (content.length > MAX_FILE_READ) {
            content = content.slice(0, MAX_FILE_READ);
        }
        const numbered = content
            .split("\n")
            .map((line, i) => `${String(i + 1).padStart(5, " ")}\t${line}`)
            .join("\n");
        return { output: truncate(numbered) };
    },
};
const writeFileTool = {
    name: "write_file",
    description: "Create or fully overwrite a file with the given content. Creates parent directories as needed.",
    parameters: {
        type: "object",
        properties: {
            path: { type: "string", description: "Path relative to the project root." },
            content: { type: "string", description: "Full file content." },
        },
        required: ["path", "content"],
    },
    readOnly: false,
    summarize: (a) => {
        const lines = String(a.content ?? "").split("\n").length;
        return `write_file(${JSON.stringify(a.path)}, ${lines} lines)`;
    },
    run: async (args, ctx) => {
        const path = resolveInside(ctx.cwd, reqString(args, "path"));
        const content = reqString(args, "content");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content, "utf8");
        return { output: `wrote ${content.length} chars to ${args.path}` };
    },
};
const editFileTool = {
    name: "edit_file",
    description: "Replace one occurrence of `old_string` with `new_string` in the file. `old_string` MUST be unique in the file; otherwise this errors. Use larger context if needed.",
    parameters: {
        type: "object",
        properties: {
            path: { type: "string" },
            old_string: { type: "string", description: "Exact text to find." },
            new_string: { type: "string", description: "Text to replace it with." },
        },
        required: ["path", "old_string", "new_string"],
    },
    readOnly: false,
    summarize: (a) => {
        const old = String(a.old_string ?? "");
        return `edit_file(${JSON.stringify(a.path)}, ${old.length} → ${String(a.new_string ?? "").length} chars)`;
    },
    run: async (args, ctx) => {
        const path = resolveInside(ctx.cwd, reqString(args, "path"));
        const oldS = reqString(args, "old_string");
        const newS = reqString(args, "new_string");
        if (!existsSync(path))
            return { output: `file not found: ${args.path}`, isError: true };
        const before = readFileSync(path, "utf8");
        const idx = before.indexOf(oldS);
        if (idx === -1) {
            return { output: `old_string not found in ${args.path}`, isError: true };
        }
        if (before.indexOf(oldS, idx + 1) !== -1) {
            return {
                output: `old_string is not unique in ${args.path}; include more context`,
                isError: true,
            };
        }
        const after = before.slice(0, idx) + newS + before.slice(idx + oldS.length);
        writeFileSync(path, after, "utf8");
        return { output: `replaced 1 occurrence in ${args.path}` };
    },
};
const listDirTool = {
    name: "list_dir",
    description: "List the entries of a directory. Returns names with type (dir/file/size).",
    parameters: {
        type: "object",
        properties: {
            path: { type: "string", description: "Defaults to project root.", default: "." },
        },
    },
    readOnly: true,
    summarize: (a) => `list_dir(${JSON.stringify(a.path ?? ".")})`,
    run: async (args, ctx) => {
        const path = resolveInside(ctx.cwd, optString(args, "path") ?? ".");
        if (!existsSync(path))
            return { output: `not found: ${args.path}`, isError: true };
        const stat = statSync(path);
        if (!stat.isDirectory())
            return { output: `not a directory: ${args.path}`, isError: true };
        const entries = readdirSync(path).sort();
        const lines = [];
        for (const name of entries) {
            try {
                const s = statSync(join(path, name));
                if (s.isDirectory())
                    lines.push(`  ${name}/`);
                else
                    lines.push(`  ${name}  ${s.size}b`);
            }
            catch {
                lines.push(`  ${name}  (stat error)`);
            }
        }
        return { output: lines.join("\n") || "(empty)" };
    },
};
const globTool = {
    name: "glob",
    description: "Find files by glob pattern (e.g. 'src/**/*.ts'). Returns up to 200 matches.",
    parameters: {
        type: "object",
        properties: {
            pattern: { type: "string" },
        },
        required: ["pattern"],
    },
    readOnly: true,
    summarize: (a) => `glob(${JSON.stringify(a.pattern)})`,
    run: async (args, ctx) => {
        const { glob } = await import("node:fs/promises");
        const pattern = reqString(args, "pattern");
        const out = [];
        for await (const m of glob(pattern, { cwd: ctx.cwd })) {
            out.push(m);
            if (out.length >= 200)
                break;
        }
        return { output: out.length ? out.join("\n") : "(no matches)" };
    },
};
const grepTool = {
    name: "grep",
    description: "Search for a regex pattern across files. Returns matching lines (max 200).",
    parameters: {
        type: "object",
        properties: {
            pattern: { type: "string", description: "Regex (JavaScript syntax)." },
            path: { type: "string", description: "Directory or file to search; defaults to '.'." },
            glob: { type: "string", description: "Optional file glob filter, e.g. '*.ts'." },
        },
        required: ["pattern"],
    },
    readOnly: true,
    summarize: (a) => `grep(${JSON.stringify(a.pattern)}, path=${JSON.stringify(a.path ?? ".")})`,
    run: async (args, ctx) => {
        const re = new RegExp(reqString(args, "pattern"));
        const startRel = optString(args, "path") ?? ".";
        const start = resolveInside(ctx.cwd, startRel);
        const globPat = optString(args, "glob");
        const matchesGlob = (p) => {
            if (!globPat)
                return true;
            const esc = globPat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
            return new RegExp(`^${esc}$`).test(p.split(/[\\/]/).pop());
        };
        const results = [];
        const visit = (p) => {
            if (results.length >= 200)
                return;
            let s;
            try {
                s = statSync(p);
            }
            catch {
                return;
            }
            if (s.isDirectory()) {
                if (/[\\/](node_modules|\.git|dist|build)$/.test(p))
                    return;
                for (const name of readdirSync(p))
                    visit(join(p, name));
                return;
            }
            if (!s.isFile())
                return;
            if (!matchesGlob(p))
                return;
            if (s.size > 1_000_000)
                return; // skip huge files
            let content;
            try {
                content = readFileSync(p, "utf8");
            }
            catch {
                return;
            }
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
                if (re.test(lines[i])) {
                    results.push(`${relative(ctx.cwd, p)}:${i + 1}: ${lines[i]}`);
                    if (results.length >= 200)
                        return;
                }
            }
        };
        visit(start);
        return { output: results.length ? results.join("\n") : "(no matches)" };
    },
};
const bashTool = {
    name: "bash",
    description: "Run a shell command in the project root and capture stdout+stderr. 30s timeout. Use for build/test/lint/git.",
    parameters: {
        type: "object",
        properties: {
            command: { type: "string" },
        },
        required: ["command"],
    },
    readOnly: false,
    summarize: (a) => `bash(${JSON.stringify(a.command)})`,
    run: async (args, ctx) => {
        const command = reqString(args, "command");
        try {
            const { stdout, stderr } = await execAsync(command, {
                cwd: ctx.cwd,
                timeout: 30_000,
                maxBuffer: 10 * 1024 * 1024,
                // On Windows the default shell is cmd; that's fine for most uses.
            });
            const out = (stdout.trim() ? `[stdout]\n${stdout}` : "") +
                (stderr.trim() ? `\n[stderr]\n${stderr}` : "");
            return { output: truncate(out.trim() || "(no output)") };
        }
        catch (err) {
            const e = err;
            const out = (e.stdout ? `[stdout]\n${e.stdout}` : "") +
                (e.stderr ? `\n[stderr]\n${e.stderr}` : "") +
                `\n[exit ${e.code ?? "?"}] ${e.message ?? ""}`;
            return { output: truncate(out.trim()), isError: true };
        }
    },
};
const spawnAgentTool = {
    name: "spawn_agent",
    description: "Delegate a self-contained subtask to a sub-agent that has the same tools as you and operates in the same project. Returns the sub-agent's final report. Use for parallelizable research, audits, or contained refactors — you may call this multiple times in one turn and they will run concurrently. Do NOT use it for trivial single-tool work, and do NOT pass tasks that require asking the user clarifying questions.",
    parameters: {
        type: "object",
        properties: {
            task: {
                type: "string",
                description: "Clear, self-contained task description. The sub-agent will not have access to the parent conversation — include all background it needs to act.",
            },
            context: {
                type: "string",
                description: "Optional extra context (file paths, constraints, prior findings).",
            },
        },
        required: ["task"],
    },
    readOnly: false,
    summarize: (a) => {
        const task = String(a.task ?? "");
        const short = task.length > 80 ? task.slice(0, 77) + "…" : task;
        return `spawn_agent(${JSON.stringify(short)})`;
    },
    run: async (args, ctx) => {
        if (!ctx.agentDeps || !ctx.agentCallbacks) {
            return {
                output: "spawn_agent is only available inside the agent loop",
                isError: true,
            };
        }
        const { runAgent } = await import("../agent/loop.js");
        const task = reqString(args, "task");
        const context = optString(args, "context");
        const parent = ctx.agentDeps;
        const childId = `${parent.agentId}/${ctx.callId ?? "sub"}`;
        const childSystem = `You are a sub-agent spawned by "${parent.agentId}" to complete one self-contained task. You have the same tools and the same project workspace.

PRIVACY CONTRACT
The same placeholder rules apply to you: real values are replaced by tokens of the form [TYPE_N] (PERSON, EMAIL, PATH, …). Reuse them verbatim, never invent new ones.

OUTPUT
When finished, reply with one concise final report — no preamble, no follow-up questions. Your reply becomes the tool result returned to your parent agent.`;
        const childHistory = [
            { role: "system", content: childSystem },
            {
                role: "user",
                content: context ? `Context:\n${context}\n\nTask:\n${task}` : task,
            },
        ];
        const result = await runAgent({
            client: parent.client,
            model: parent.model,
            cwd: parent.cwd,
            allocator: parent.allocator,
            agentId: childId,
            depth: parent.depth + 1,
        }, {
            history: childHistory,
            autoAllow: ctx.agentOpts?.autoAllow,
            maxIterations: ctx.agentOpts?.maxIterations,
        }, ctx.agentCallbacks);
        return {
            output: result.finalContent.trim() || "(sub-agent returned no content)",
            isError: result.cancelled,
        };
    },
};
export const TOOLS = [
    readFileTool,
    writeFileTool,
    editFileTool,
    listDirTool,
    globTool,
    grepTool,
    bashTool,
    spawnAgentTool,
];
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
export function getTool(name) {
    return TOOL_BY_NAME.get(name);
}
/** OpenAI-style tool schemas to ship with each chat completion call. */
export function openaiTools() {
    return TOOLS.map((t) => ({
        type: "function",
        function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
        },
    }));
}
/**
 * Anonymize a tool's output before sending it back to the model.
 * Coherent with the session's allocator, so placeholders match the chat.
 */
export async function anonymizeToolOutput(output, allocator) {
    const r = await anonymize(output, { allocator });
    return { anonymized: r.anonymized, entities: r.entities };
}
/**
 * De-anonymize a tool's arguments before executing.
 * The model emits placeholders like [PATH_1] — we substitute back the real
 * values so the call hits the real filesystem.
 */
export function deanonymizeArgs(args, allocator) {
    const reverse = allocator.reverseMap();
    const sub = (s) => s.replace(/\[[A-Z_]+_\d+\]/g, (p) => reverse.get(p) ?? p);
    const walk = (v) => {
        if (typeof v === "string")
            return sub(v);
        if (Array.isArray(v))
            return v.map(walk);
        if (v && typeof v === "object") {
            const out = {};
            for (const [k, val] of Object.entries(v))
                out[k] = walk(val);
            return out;
        }
        return v;
    };
    return walk(args);
}
