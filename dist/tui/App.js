import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { writeUserConfig } from "../userConfig.js";
import { createClient, } from "../llm/client.js";
import { fetchModels, filterModels } from "../llm/models.js";
import { Session } from "../session.js";
import { StreamingDeanonymizer } from "../anonymizer/deanonymize.js";
import { warmupNER } from "../anonymizer/detectors/ner.js";
import { appendHistory, loadHistory } from "../history.js";
import { MultilineInput } from "./MultilineInput.js";
import { runAgent } from "../agent/loop.js";
export function parseArgs(argv) {
    const flags = { autoAllow: false, warmup: true, model: undefined };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case "--dangerously-auto-allow":
            case "--dangerously":
            case "--auto":
            case "-y":
                flags.autoAllow = true;
                break;
            case "--no-warmup":
                flags.warmup = false;
                break;
            case "--model":
            case "-m":
                flags.model = argv[++i];
                break;
        }
    }
    return flags;
}
// ── Helpers ──────────────────────────────────────────────────────────────────
function colorFor(type) {
    switch (type) {
        case "PERSON":
            return "magenta";
        case "ORG":
            return "blue";
        case "LOC":
            return "cyan";
        case "EMAIL":
        case "PHONE":
            return "yellow";
        case "API_KEY":
        case "CREDIT_CARD":
        case "IBAN":
        case "SSN":
            return "red";
        case "PATH":
        case "URL":
        case "IP":
        case "UUID":
            return "green";
        default:
            return "gray";
    }
}
function formatError(err) {
    if (err && typeof err === "object") {
        const e = err;
        if (e.status === 429) {
            return `rate limited (429). OpenRouter "free" models are heavily throttled — switch with /model.`;
        }
        if (e.status === 401)
            return `unauthorized (401). Re-check your key with /login.`;
        if (e.status === 402)
            return `payment required (402). Add credits to your account.`;
        if (e.status)
            return `HTTP ${e.status}: ${e.message ?? "unknown error"}`;
    }
    return err?.message ?? String(err);
}
const AGENTS_TEMPLATE = `# AGENTS.md

Operating instructions for the AnonyAgent inside this project.

## What this project is

(Short description — what does the code do, who uses it, what is its shape?)

## Conventions

- Language / runtime:
- Package manager:
- Test command:
- Lint / format command:

## House rules

- Prefer editing existing files over creating new ones.
- (Add anything the agent should always do or never do here.)

## Hot zones

- (List files / directories that are sensitive, vendored, or read-only.)
`;
function RULES_TEMPLATE(name) {
    return `# ${name}

One rule per line, or grouped under headings. Examples:

- Never run \`rm -rf\`.
- Always run the test suite before declaring a refactor complete.
- (Add your rules here.)
`;
}
function truncForDisplay(s, lines = 5, maxLen = 400) {
    const trimmed = s.trim();
    if (!trimmed)
        return "(no output)";
    const ls = trimmed.split("\n");
    if (ls.length > lines) {
        return ls.slice(0, lines).join("\n") + `\n  … +${ls.length - lines} more lines`;
    }
    if (trimmed.length > maxLen)
        return trimmed.slice(0, maxLen) + " …";
    return trimmed;
}
// ── Sub-views ────────────────────────────────────────────────────────────────
function AnonymizedPreview({ text }) {
    const parts = text.split(/(\[[A-Z_]+_\d+\])/g);
    return (_jsx(Text, { children: parts.map((p, i) => {
            const m = /^\[([A-Z_]+)_\d+\]$/.exec(p);
            if (m) {
                return (_jsx(Text, { color: colorFor(m[1]), bold: true, children: p }, i));
            }
            return _jsx(Text, { children: p }, i);
        }) }));
}
function MessageView({ entry }) {
    if (entry.kind === "user") {
        return (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsx(Text, { color: "green", bold: true, children: "you \u25B8" }), _jsx(Text, { children: entry.text }), entry.entities && entry.entities.length > 0 && (_jsxs(Text, { color: "gray", children: ["  ", "redacted: ", entry.entities.length, " ", entry.entities.length === 1 ? "entity" : "entities", " · ", entry.entities
                            .map((e) => e.type)
                            .filter((t, i, a) => a.indexOf(t) === i)
                            .join(", ")] }))] }));
    }
    if (entry.kind === "assistant") {
        return (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsx(Text, { color: "cyan", bold: true, children: "AnonyAgent \u25B8" }), _jsx(Text, { children: entry.text })] }));
    }
    if (entry.kind === "tool") {
        const iconColor = entry.toolStatus === "error"
            ? "red"
            : entry.toolStatus === "cancelled"
                ? "yellow"
                : "blue";
        const icon = entry.toolStatus === "cancelled"
            ? "✗"
            : entry.toolStatus === "error"
                ? "⚠"
                : "⚙";
        return (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsxs(Text, { children: [_jsxs(Text, { color: iconColor, bold: true, children: [icon, " "] }), _jsx(Text, { bold: true, children: entry.toolSummary }), entry.toolStatus === "cancelled" && (_jsx(Text, { color: "yellow", children: " (cancelled)" }))] }), entry.toolResult && (_jsx(Box, { marginLeft: 2, flexDirection: "column", children: truncForDisplay(entry.toolResult)
                        .split("\n")
                        .map((line, i) => (_jsx(Text, { color: "gray", children: line }, i))) }))] }));
    }
    if (entry.kind === "error") {
        return (_jsx(Box, { marginTop: 1, children: _jsxs(Text, { color: "red", children: ["  \u26A0 ", entry.text] }) }));
    }
    return (_jsx(Box, { marginTop: 1, children: _jsxs(Text, { color: "gray", italic: true, children: ["  ", entry.text] }) }));
}
function ChatBar({ value, cursor, onChange, onSubmit, onHistoryUp, onHistoryDown, hasKey, isActive, }) {
    return (_jsxs(Box, { borderStyle: "round", borderColor: hasKey ? "gray" : "yellow", paddingX: 1, children: [_jsx(Box, { marginRight: 1, children: _jsx(Text, { color: hasKey ? "cyan" : "yellow", bold: true, children: ">" }) }), _jsx(MultilineInput, { value: value, cursor: cursor, onChange: onChange, onSubmit: onSubmit, onHistoryUp: onHistoryUp, onHistoryDown: onHistoryDown, placeholder: hasKey
                    ? "Send a message  (↑↓ history · /help)"
                    : "/login to set your API key first", isActive: isActive })] }));
}
function ReviewView({ anonymized, entities, }) {
    return (_jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: "yellow", paddingX: 1, children: [_jsxs(Text, { bold: true, color: "yellow", children: ["review \u00B7 ", entities.length, " ", entities.length === 1 ? "entity" : "entities", " detected"] }), entities.length > 0 && (_jsx(Box, { flexDirection: "column", marginTop: 1, children: entities.map((e, i) => (_jsxs(Text, { children: ["  ", _jsx(Text, { color: colorFor(e.type), children: e.type.padEnd(12) }), " ", _jsx(Text, { bold: true, children: JSON.stringify(e.text) }), " ", _jsxs(Text, { color: "gray", children: ["(", e.source, e.source === "ner" ? ` ${e.score.toFixed(2)}` : "", ")"] })] }, i))) })), _jsxs(Box, { marginTop: 1, flexDirection: "column", children: [_jsx(Text, { bold: true, children: "will send:" }), _jsx(Box, { marginLeft: 2, children: _jsx(AnonymizedPreview, { text: anonymized }) })] })] }));
}
function ToolReviewView({ name, summary, anonOutput, entities, isError, }) {
    return (_jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: isError ? "red" : "yellow", paddingX: 1, children: [_jsxs(Text, { bold: true, color: isError ? "red" : "yellow", children: ["send tool output to LLM? \u00B7", " ", _jsx(Text, { color: "white", children: name }), isError && _jsx(Text, { color: "red", children: " (errored)" })] }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { color: "gray", children: summary }) }), entities.length > 0 && (_jsx(Box, { marginTop: 1, flexDirection: "column", children: _jsxs(Text, { color: "gray", children: ["redacted in output: ", entities.length, " ", entities.length === 1 ? "entity" : "entities", " \u00B7", " ", entities
                            .map((e) => e.type)
                            .filter((t, i, a) => a.indexOf(t) === i)
                            .join(", ")] }) })), _jsxs(Box, { marginTop: 1, flexDirection: "column", children: [_jsx(Text, { bold: true, children: "will send:" }), _jsx(Box, { marginLeft: 2, flexDirection: "column", children: truncForDisplay(anonOutput, 12, 1200)
                            .split("\n")
                            .map((line, i) => (_jsx(AnonymizedPreview, { text: line }, i))) })] })] }));
}
const PAGE_SIZE = 12;
function ModelPickerView({ mode, input, onSearchChange, currentModel, }) {
    const filtered = filterModels(mode.all, mode.query);
    const cursor = filtered.length === 0 ? 0 : Math.min(mode.cursor, filtered.length - 1);
    const page = Math.floor(cursor / PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const slice = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const cursorInPage = cursor - page * PAGE_SIZE;
    return (_jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingX: 1, children: [_jsxs(Box, { children: [_jsx(Text, { bold: true, color: "cyan", children: "model picker" }), _jsxs(Text, { color: "gray", children: ["  ", filtered.length, "/", mode.all.length, filtered.length > 0
                                ? `  ·  ${cursor + 1} of ${filtered.length}  ·  page ${page + 1}/${totalPages}`
                                : ""] })] }), _jsxs(Box, { marginTop: 1, children: [_jsx(Text, { color: "cyan", bold: true, children: "▸ " }), _jsx(Box, { flexGrow: 1, children: _jsx(TextInput, { value: input, onChange: onSearchChange, placeholder: "type to filter\u2026", showCursor: true }) })] }), mode.loading && (_jsx(Box, { marginTop: 1, children: _jsxs(Text, { color: "gray", children: [_jsx(Spinner, { type: "dots" }), " fetching catalog\u2026"] }) })), _jsx(Box, { flexDirection: "column", marginTop: 1, children: slice.length === 0 ? (_jsx(Text, { color: "yellow", children: "  no model matches" })) : (slice.map((m, i) => {
                    const isCursor = i === cursorInPage;
                    const isCurrent = m.id === currentModel;
                    const marker = isCursor ? "▸ " : "  ";
                    return (_jsx(Box, { children: _jsxs(Text, { color: isCursor ? "cyan" : undefined, bold: isCursor, inverse: isCursor, children: [marker, m.id, m.context_length ? `  ${m.context_length}ctx` : "", isCurrent ? "  ←current" : ""] }) }, m.id));
                })) })] }));
}
function LoginView({ input, onChange, onSubmit, baseURL, }) {
    return (_jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: "magenta", paddingX: 1, children: [_jsx(Text, { bold: true, color: "magenta", children: "login" }), _jsxs(Text, { color: "gray", children: ["endpoint: ", baseURL] }), _jsxs(Box, { marginTop: 1, children: [_jsx(Text, { children: "API key: " }), _jsx(TextInput, { value: input, onChange: onChange, onSubmit: onSubmit, mask: "*" })] }), _jsx(Text, { color: "gray", children: "enter to save \u00B7 empty to cancel" })] }));
}
function FooterHint({ cfg, mode, autoAllow, }) {
    let left;
    switch (mode.kind) {
        case "chat":
            left = (_jsxs(Text, { children: [_jsx(Text, { color: "cyan", bold: true, children: "\u21B5" }), _jsx(Text, { color: "white", children: " send" }), _jsx(Text, { color: "gray", children: "  │  " }), _jsx(Text, { color: "cyan", bold: true, children: "/" }), _jsx(Text, { color: "white", children: " commands" }), _jsx(Text, { color: "gray", children: "  │  " }), _jsx(Text, { color: "white", children: "/exit" })] }));
            break;
        case "review":
        case "toolReview":
            left = (_jsxs(Text, { children: [_jsx(Text, { color: "green", bold: true, children: "Y" }), _jsx(Text, { color: "white", children: " approve" }), _jsx(Text, { color: "gray", children: "  │  " }), _jsx(Text, { color: "red", bold: true, children: "N" }), _jsx(Text, { color: "white", children: " deny" }), _jsx(Text, { color: "gray", children: "  │  " }), _jsx(Text, { color: "white", children: "Esc cancel" })] }));
            break;
        case "modelPicker":
            left = (_jsxs(Text, { children: [_jsx(Text, { color: "cyan", bold: true, children: "\u2191\u2193" }), _jsx(Text, { color: "white", children: " move" }), _jsx(Text, { color: "gray", children: "  │  " }), _jsx(Text, { color: "cyan", bold: true, children: "\u21B5" }), _jsx(Text, { color: "white", children: " pick" }), _jsx(Text, { color: "gray", children: "  │  " }), _jsx(Text, { color: "white", children: "type to filter" }), _jsx(Text, { color: "gray", children: "  │  " }), _jsx(Text, { color: "white", children: "Esc cancel" })] }));
            break;
        case "login":
            left = (_jsxs(Text, { children: [_jsx(Text, { color: "cyan", bold: true, children: "\u21B5" }), _jsx(Text, { color: "white", children: " save" }), _jsx(Text, { color: "gray", children: "  │  " }), _jsx(Text, { color: "white", children: "empty=cancel" })] }));
            break;
        case "streaming":
            left = _jsx(Text, { color: "cyan", children: "streaming\u2026" });
            break;
        case "toolRunning":
            left = (_jsxs(Text, { children: [_jsx(Text, { color: "cyan", children: "running " }), _jsx(Text, { color: "white", children: mode.name }), _jsx(Text, { color: "cyan", children: "\u2026" })] }));
            break;
        case "warmup":
            left = _jsx(Text, { color: "cyan", children: "loading\u2026" });
            break;
    }
    const host = cfg.baseURL.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return (_jsxs(Box, { paddingX: 1, justifyContent: "space-between", children: [left, _jsxs(Text, { children: [_jsx(Text, { color: "white", children: cfg.model }), _jsx(Text, { color: "gray", children: "  │  " }), _jsx(Text, { color: "gray", children: host }), _jsx(Text, { color: "gray", children: "  │  " }), cfg.apiKey ? (_jsx(Text, { color: "green", bold: true, children: "\u25CF key" })) : (_jsx(Text, { color: "red", bold: true, children: "\u25CB no key" })), autoAllow && (_jsxs(_Fragment, { children: [_jsx(Text, { color: "gray", children: "  │  " }), _jsx(Text, { color: "yellow", bold: true, children: "auto-allow" })] }))] })] }));
}
// ── Main app ─────────────────────────────────────────────────────────────────
export function App({ flags }) {
    const app = useApp();
    const [cfg, setCfg] = useState(() => {
        const c = loadConfig();
        return flags.model ? { ...c, model: flags.model } : c;
    });
    const [transcript, setTranscript] = useState([]);
    const [streaming, setStreaming] = useState("");
    const [mode, setMode] = useState({ kind: "warmup" });
    const [chatInput, setChatInput] = useState("");
    const [chatCursor, setChatCursor] = useState(0);
    const [modalInput, setModalInput] = useState("");
    const [history, setHistory] = useState(() => loadHistory());
    const [historyIndex, setHistoryIndex] = useState(null);
    const [draft, setDraft] = useState("");
    const sessionRef = useRef(new Session());
    const clientRef = useRef(cfg.apiKey ? createClient(cfg) : null);
    const idRef = useRef(0);
    const cwdRef = useRef(sessionRef.current.project?.root ?? process.cwd());
    const decisionRef = useRef(null);
    const append = (entry) => {
        idRef.current += 1;
        setTranscript((t) => [...t, { ...entry, id: idRef.current }]);
    };
    const setChatBoth = (v, c) => {
        setChatInput(v);
        setChatCursor(c);
        if (historyIndex !== null)
            setHistoryIndex(null);
    };
    const onHistoryUp = () => {
        if (history.length === 0)
            return;
        if (historyIndex === null) {
            setDraft(chatInput);
            const idx = history.length - 1;
            const entry = history[idx] ?? "";
            setHistoryIndex(idx);
            setChatInput(entry);
            setChatCursor(entry.length);
            return;
        }
        if (historyIndex > 0) {
            const idx = historyIndex - 1;
            const entry = history[idx] ?? "";
            setHistoryIndex(idx);
            setChatInput(entry);
            setChatCursor(entry.length);
        }
    };
    const onHistoryDown = () => {
        if (historyIndex === null)
            return;
        if (historyIndex < history.length - 1) {
            const idx = historyIndex + 1;
            const entry = history[idx] ?? "";
            setHistoryIndex(idx);
            setChatInput(entry);
            setChatCursor(entry.length);
        }
        else {
            setHistoryIndex(null);
            setChatInput(draft);
            setChatCursor(draft.length);
        }
    };
    const askApproval = (next) => {
        return new Promise((resolve) => {
            decisionRef.current = resolve;
            setMode(next);
        });
    };
    const appendNoKeyHintIfNeeded = () => {
        if (cfg.apiKey)
            return;
        append({
            kind: "system",
            text: "no API key set — type  /login  to paste an OpenRouter key, then send a message",
        });
    };
    useEffect(() => {
        let cancelled = false;
        if (!flags.warmup) {
            setMode({ kind: "chat" });
            append({
                kind: "system",
                text: `project root: ${cwdRef.current}${sessionRef.current.project?.agentsMd ? " · AGENTS.md loaded" : ""}${sessionRef.current.project?.rules ? " · rules loaded" : ""}`,
            });
            appendNoKeyHintIfNeeded();
            return;
        }
        (async () => {
            try {
                await warmupNER();
                if (!cancelled) {
                    append({
                        kind: "system",
                        text: `ready · ${cwdRef.current}${sessionRef.current.project?.agentsMd ? " · AGENTS.md" : ""}${sessionRef.current.project?.rules ? " · rules" : ""}`,
                    });
                    appendNoKeyHintIfNeeded();
                    setMode({ kind: "chat" });
                }
            }
            catch (err) {
                if (!cancelled) {
                    append({
                        kind: "system",
                        text: `NER unavailable, regex-only: ${formatError(err)}`,
                    });
                    appendNoKeyHintIfNeeded();
                    setMode({ kind: "chat" });
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);
    // Ctrl-C anywhere → exit.
    useInput((char, key) => {
        if (key.ctrl && char === "c")
            app.exit();
    });
    // Approve / deny for any review (entity or tool).
    useInput((char, key) => {
        if (mode.kind !== "review" && mode.kind !== "toolReview")
            return;
        if (char === "y" || char === "Y" || key.return) {
            const r = decisionRef.current;
            decisionRef.current = null;
            r?.(true);
        }
        else if (char === "n" || char === "N" || key.escape) {
            const r = decisionRef.current;
            decisionRef.current = null;
            r?.(false);
        }
    }, { isActive: mode.kind === "review" || mode.kind === "toolReview" });
    // ── Slash commands ───────────────────────────────────────────────────────
    const handleSlash = async (raw) => {
        const cmd = raw.split(/\s+/, 1)[0];
        const rest = raw.slice(cmd.length).trim();
        switch (cmd) {
            case "/exit":
            case "/quit":
                app.exit();
                return true;
            case "/help":
                append({
                    kind: "system",
                    text: "commands: /login · /model [search] · /endpoint <url> · /status · /map · /init · /create-rules [name] · /rules · /clear · /reset · /exit",
                });
                return true;
            case "/init": {
                const dir = join(cwdRef.current, ".anonyagent");
                const file = join(dir, "AGENTS.md");
                if (existsSync(file)) {
                    append({ kind: "error", text: `already exists: ${file}` });
                    return true;
                }
                try {
                    mkdirSync(dir, { recursive: true });
                    writeFileSync(file, AGENTS_TEMPLATE, "utf8");
                }
                catch (err) {
                    append({
                        kind: "error",
                        text: `could not create ${file}: ${err.message}`,
                    });
                    return true;
                }
                const project = sessionRef.current.reloadProject(cwdRef.current);
                if (project?.root)
                    cwdRef.current = project.root;
                append({ kind: "system", text: `created ${file} — edit it then continue` });
                return true;
            }
            case "/create-rules": {
                const baseDir = join(cwdRef.current, ".anonyagent");
                let file;
                let template;
                if (!rest) {
                    file = join(baseDir, "rules.md");
                    template = RULES_TEMPLATE("project rules");
                }
                else {
                    const slug = rest
                        .replace(/[^a-zA-Z0-9_-]+/g, "-")
                        .replace(/^-+|-+$/g, "")
                        .toLowerCase();
                    if (!slug) {
                        append({ kind: "error", text: "invalid rules name" });
                        return true;
                    }
                    file = join(baseDir, "rules", `${slug}.md`);
                    template = RULES_TEMPLATE(slug);
                }
                if (existsSync(file)) {
                    append({ kind: "error", text: `already exists: ${file}` });
                    return true;
                }
                try {
                    mkdirSync(join(file, ".."), { recursive: true });
                    writeFileSync(file, template, "utf8");
                }
                catch (err) {
                    append({
                        kind: "error",
                        text: `could not create ${file}: ${err.message}`,
                    });
                    return true;
                }
                const project = sessionRef.current.reloadProject(cwdRef.current);
                if (project?.root)
                    cwdRef.current = project.root;
                append({ kind: "system", text: `created ${file} — edit it then continue` });
                return true;
            }
            case "/rules": {
                const rules = sessionRef.current.project?.rules;
                if (!rules) {
                    append({
                        kind: "system",
                        text: "(no rules loaded — create one with /create-rules [name])",
                    });
                    return true;
                }
                for (const line of rules.split("\n")) {
                    append({ kind: "system", text: line });
                }
                return true;
            }
            case "/status":
                append({
                    kind: "system",
                    text: `endpoint=${cfg.baseURL} model=${cfg.model} key=${cfg.apiKey ? "set" : "missing"} cwd=${cwdRef.current}`,
                });
                return true;
            case "/clear":
                // Reset chat history but keep system prompt at index 0.
                sessionRef.current.history.length = 1;
                setTranscript([]);
                append({ kind: "system", text: "conversation cleared (placeholder map kept)" });
                return true;
            case "/reset":
                sessionRef.current.history.length = 1;
                sessionRef.current.allocator.clear();
                setTranscript([]);
                append({ kind: "system", text: "conversation + placeholder map reset" });
                return true;
            case "/map": {
                const map = sessionRef.current.allocator.reverseMap();
                if (map.size === 0)
                    append({ kind: "system", text: "(no placeholders yet)" });
                else
                    for (const [k, v] of map)
                        append({ kind: "system", text: `${k} = ${JSON.stringify(v)}` });
                return true;
            }
            case "/endpoint": {
                if (!rest) {
                    append({ kind: "error", text: "usage: /endpoint <url>" });
                    return true;
                }
                const next = writeUserConfig({ baseURL: rest });
                const newCfg = { ...cfg, baseURL: next.baseURL ?? rest };
                setCfg(newCfg);
                clientRef.current = newCfg.apiKey ? createClient(newCfg) : null;
                append({ kind: "system", text: `endpoint → ${rest}` });
                return true;
            }
            case "/login":
                setModalInput("");
                setMode({ kind: "login" });
                return true;
            case "/model": {
                setModalInput(rest);
                setMode({
                    kind: "modelPicker",
                    all: [],
                    query: rest,
                    cursor: 0,
                    loading: true,
                });
                try {
                    const models = await fetchModels(cfg.baseURL, cfg.apiKey);
                    setMode({
                        kind: "modelPicker",
                        all: models,
                        query: rest,
                        cursor: 0,
                    });
                }
                catch (err) {
                    append({
                        kind: "error",
                        text: `model fetch failed: ${formatError(err)}`,
                    });
                    setMode({ kind: "chat" });
                }
                return true;
            }
            default:
                append({ kind: "error", text: `unknown command: ${cmd}` });
                return true;
        }
    };
    // ── Agent loop driver ────────────────────────────────────────────────────
    const accumulatedContentRef = useRef("");
    const assembledRef = useRef("");
    const deanonRef = useRef(null);
    const reviewQueueRef = useRef(Promise.resolve());
    const enqueueReview = (fn) => {
        const next = reviewQueueRef.current.then(fn, fn);
        reviewQueueRef.current = next.then(() => undefined, () => undefined);
        return next;
    };
    const callbacks = {
        onTurnStart(agentId) {
            if (agentId !== "main")
                return;
            accumulatedContentRef.current = "";
            assembledRef.current = "";
            deanonRef.current = new StreamingDeanonymizer(sessionRef.current.allocator.reverseMap());
            setStreaming("");
            setMode({ kind: "streaming" });
        },
        onContentDelta(agentId, text) {
            if (agentId !== "main" || !deanonRef.current)
                return;
            accumulatedContentRef.current += text;
            const out = deanonRef.current.push(text);
            if (out) {
                assembledRef.current += out;
                setStreaming((s) => s + out);
            }
        },
        onTurnEnd(agentId, content) {
            if (agentId !== "main")
                return;
            const tail = deanonRef.current?.flush() ?? "";
            if (tail)
                assembledRef.current += tail;
            if (content.trim()) {
                append({ kind: "assistant", text: assembledRef.current });
            }
            setStreaming("");
        },
        onToolStart(agentId, _callId, name) {
            if (agentId === "main")
                setMode({ kind: "toolRunning", name });
        },
        onToolFinish(agentId, _callId, name, summary, rawOutput, _anonOutput, isError) {
            const prefix = agentId === "main" ? "" : "↳ ";
            append({
                kind: "tool",
                toolName: name,
                toolSummary: `${prefix}${summary}`,
                toolStatus: isError ? "error" : "done",
                toolResult: rawOutput,
            });
        },
        requestSendApproval(req) {
            return enqueueReview(() => new Promise((resolve) => {
                decisionRef.current = resolve;
                setMode({
                    kind: "toolReview",
                    name: req.toolName,
                    summary: req.summary,
                    anonOutput: req.anonOutput,
                    entities: req.entities,
                    isError: req.isError,
                });
            }));
        },
        onError(_agentId, msg) {
            append({ kind: "error", text: msg });
        },
    };
    const driveAgent = async () => {
        if (!clientRef.current) {
            append({ kind: "error", text: "no API key — run /login" });
            setMode({ kind: "chat" });
            return;
        }
        try {
            await runAgent({
                client: clientRef.current,
                model: cfg.model,
                cwd: cwdRef.current,
                allocator: sessionRef.current.allocator,
                agentId: "main",
                depth: 0,
            }, {
                history: sessionRef.current.history,
                autoAllow: flags.autoAllow,
            }, callbacks);
        }
        catch (err) {
            append({ kind: "error", text: formatError(err) });
        }
        setMode({ kind: "chat" });
    };
    // ── Chat submit ──────────────────────────────────────────────────────────
    const onChatSubmit = async (value) => {
        const raw = value.trim();
        setChatInput("");
        setChatCursor(0);
        setHistoryIndex(null);
        setDraft("");
        if (!raw)
            return;
        setHistory((h) => appendHistory(h, raw));
        if (raw.startsWith("/")) {
            await handleSlash(raw);
            return;
        }
        if (!clientRef.current) {
            append({ kind: "error", text: "no API key — run /login" });
            return;
        }
        const { anonymized, entities } = await sessionRef.current.anonymizeUserMessage(raw);
        if (!flags.autoAllow) {
            const ok = await askApproval({
                kind: "review",
                anonymized,
                entities,
                original: raw,
            });
            if (!ok) {
                append({ kind: "system", text: "cancelled" });
                setMode({ kind: "chat" });
                return;
            }
        }
        append({ kind: "user", text: raw, entities });
        sessionRef.current.history.push({
            role: "user",
            content: anonymized,
        });
        await driveAgent();
    };
    // ── Model picker keys ────────────────────────────────────────────────────
    const pickModelAt = (index) => {
        if (mode.kind !== "modelPicker")
            return;
        const filtered = filterModels(mode.all, mode.query);
        const chosen = filtered[index];
        if (!chosen)
            return;
        const next = writeUserConfig({ model: chosen.id });
        const newCfg = { ...cfg, model: next.model ?? chosen.id };
        setCfg(newCfg);
        append({ kind: "system", text: `model → ${chosen.id}` });
        setModalInput("");
        setMode({ kind: "chat" });
    };
    useInput((_char, key) => {
        if (mode.kind !== "modelPicker")
            return;
        const filtered = filterModels(mode.all, mode.query);
        const max = Math.max(0, filtered.length - 1);
        const cursor = Math.min(mode.cursor, max);
        if (key.escape) {
            setModalInput("");
            setMode({ kind: "chat" });
            return;
        }
        if (key.return) {
            pickModelAt(cursor);
            return;
        }
        if (key.upArrow) {
            setMode({ ...mode, cursor: Math.max(0, cursor - 1) });
            return;
        }
        if (key.downArrow) {
            setMode({ ...mode, cursor: Math.min(max, cursor + 1) });
            return;
        }
        if (key.pageUp) {
            setMode({ ...mode, cursor: Math.max(0, cursor - PAGE_SIZE) });
            return;
        }
        if (key.pageDown) {
            setMode({ ...mode, cursor: Math.min(max, cursor + PAGE_SIZE) });
            return;
        }
    }, { isActive: mode.kind === "modelPicker" });
    const onPickerSearchChange = (v) => {
        setModalInput(v);
        if (mode.kind === "modelPicker") {
            setMode({ ...mode, query: v, cursor: 0 });
        }
    };
    // ── Login submit ────────────────────────────────────────────────────────
    const onLoginSubmit = (value) => {
        const v = value.trim();
        setModalInput("");
        if (!v) {
            append({ kind: "system", text: "login cancelled" });
            setMode({ kind: "chat" });
            return;
        }
        writeUserConfig({ apiKey: v });
        const newCfg = { ...cfg, apiKey: v };
        setCfg(newCfg);
        clientRef.current = createClient(newCfg);
        append({ kind: "system", text: `key saved (…${v.slice(-4)})` });
        setMode({ kind: "chat" });
    };
    // ── Render ──────────────────────────────────────────────────────────────
    return (_jsxs(_Fragment, { children: [_jsx(Static, { items: transcript, children: (item) => _jsx(MessageView, { entry: item }, item.id) }), mode.kind === "warmup" && (_jsx(Box, { children: _jsxs(Text, { color: "gray", children: [_jsx(Spinner, { type: "dots" }), " warming up local NER model\u2026"] }) })), streaming && (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsx(Text, { color: "cyan", bold: true, children: "AnonyAgent \u25B8" }), _jsx(Text, { children: streaming })] })), mode.kind === "streaming" && !streaming && (_jsx(Box, { marginTop: 1, children: _jsxs(Text, { color: "cyan", children: [_jsx(Spinner, { type: "dots" }), " thinking\u2026"] }) })), mode.kind === "toolRunning" && (_jsx(Box, { marginTop: 1, children: _jsxs(Text, { color: "cyan", children: [_jsx(Spinner, { type: "dots" }), " running ", mode.name, "\u2026"] }) })), mode.kind === "review" && (_jsx(ReviewView, { anonymized: mode.anonymized, entities: mode.entities })), mode.kind === "toolReview" && (_jsx(ToolReviewView, { name: mode.name, summary: mode.summary, anonOutput: mode.anonOutput, entities: mode.entities, isError: mode.isError })), mode.kind === "modelPicker" && (_jsx(ModelPickerView, { mode: mode, input: modalInput, onSearchChange: onPickerSearchChange, currentModel: cfg.model })), mode.kind === "login" && (_jsx(LoginView, { input: modalInput, onChange: setModalInput, onSubmit: onLoginSubmit, baseURL: cfg.baseURL })), mode.kind === "chat" && (_jsx(ChatBar, { value: chatInput, cursor: chatCursor, onChange: setChatBoth, onSubmit: onChatSubmit, onHistoryUp: onHistoryUp, onHistoryDown: onHistoryDown, hasKey: !!cfg.apiKey, isActive: mode.kind === "chat" })), _jsx(FooterHint, { cfg: cfg, mode: mode, autoAllow: flags.autoAllow })] }));
}
