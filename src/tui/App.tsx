import React, { useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import OpenAI from "openai";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig, type Config } from "../config.js";
import { writeUserConfig } from "../userConfig.js";
import {
  createClient,
  type ChatMessage,
} from "../llm/client.js";
import { fetchModels, filterModels, type ModelInfo } from "../llm/models.js";
import { Session } from "../session.js";
import { StreamingDeanonymizer } from "../anonymizer/deanonymize.js";
import type { Entity } from "../anonymizer/types.js";
import { isNERAvailable, warmupNER } from "../anonymizer/detectors/ner.js";
import { appendHistory, loadHistory } from "../history.js";
import { MultilineInput } from "./MultilineInput.js";
import { runAgent, type AgentCallbacks } from "../agent/loop.js";

export interface CliFlags {
  autoAllow: boolean;
  warmup: boolean;
  model: string | undefined;
}

export function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = { autoAllow: false, warmup: true, model: undefined };
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

// ── Types ────────────────────────────────────────────────────────────────────

type Mode =
  | { kind: "warmup" }
  | { kind: "chat" }
  | {
      kind: "review";
      anonymized: string;
      entities: Entity[];
      original: string;
      manualRedactions: string[];
    }
  | {
      kind: "editRedact";
      anonymized: string;
      entities: Entity[];
      original: string;
      manualRedactions: string[];
    }
  | { kind: "streaming" }
  | {
      kind: "toolReview";
      name: string;
      summary: string;
      anonOutput: string;
      entities: Entity[];
      isError: boolean;
    }
  | { kind: "toolRunning"; name: string }
  | { kind: "login" }
  | {
      kind: "modelPicker";
      all: ModelInfo[];
      query: string;
      cursor: number;
      loading?: boolean;
    };

interface TranscriptEntry {
  id: number;
  kind: "user" | "assistant" | "system" | "error" | "tool";
  text?: string;
  entities?: Entity[];
  // For tool entries:
  toolName?: string;
  toolSummary?: string;
  toolStatus?: "done" | "error" | "cancelled";
  toolResult?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function colorFor(type: string): string {
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

function formatError(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { status?: number; message?: string };
    if (e.status === 429) {
      return `rate limited (429). OpenRouter "free" models are heavily throttled — switch with /model.`;
    }
    if (e.status === 401) return `unauthorized (401). Re-check your key with /login.`;
    if (e.status === 402) return `payment required (402). Add credits to your account.`;
    if (e.status) return `HTTP ${e.status}: ${e.message ?? "unknown error"}`;
  }
  return (err as Error)?.message ?? String(err);
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

function RULES_TEMPLATE(name: string): string {
  return `# ${name}

One rule per line, or grouped under headings. Examples:

- Never run \`rm -rf\`.
- Always run the test suite before declaring a refactor complete.
- (Add your rules here.)
`;
}

function truncForDisplay(s: string, lines = 5, maxLen = 400): string {
  const trimmed = s.trim();
  if (!trimmed) return "(no output)";
  const ls = trimmed.split("\n");
  if (ls.length > lines) {
    return ls.slice(0, lines).join("\n") + `\n  … +${ls.length - lines} more lines`;
  }
  if (trimmed.length > maxLen) return trimmed.slice(0, maxLen) + " …";
  return trimmed;
}

// ── Sub-views ────────────────────────────────────────────────────────────────

function AnonymizedPreview({ text }: { text: string }) {
  const parts = text.split(/(\[[A-Z_]+_\d+\])/g);
  return (
    <Text>
      {parts.map((p, i) => {
        const m = /^\[([A-Z_]+)_\d+\]$/.exec(p);
        if (m) {
          return (
            <Text key={i} color={colorFor(m[1]!)} bold>
              {p}
            </Text>
          );
        }
        return <Text key={i}>{p}</Text>;
      })}
    </Text>
  );
}

function MessageView({ entry }: { entry: TranscriptEntry }) {
  if (entry.kind === "user") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="green" bold>you ▸</Text>
        <Text>{entry.text}</Text>
        {entry.entities && entry.entities.length > 0 && (
          <Text color="gray">
            {"  "}redacted: {entry.entities.length}{" "}
            {entry.entities.length === 1 ? "entity" : "entities"}
            {" · "}
            {entry.entities
              .map((e) => e.type)
              .filter((t, i, a) => a.indexOf(t) === i)
              .join(", ")}
          </Text>
        )}
      </Box>
    );
  }
  if (entry.kind === "assistant") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="cyan" bold>AnonyAgent ▸</Text>
        <Text>{entry.text}</Text>
      </Box>
    );
  }
  if (entry.kind === "tool") {
    const iconColor =
      entry.toolStatus === "error"
        ? "red"
        : entry.toolStatus === "cancelled"
          ? "yellow"
          : "blue";
    const icon =
      entry.toolStatus === "cancelled"
        ? "✗"
        : entry.toolStatus === "error"
          ? "⚠"
          : "⚙";
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text color={iconColor} bold>{icon} </Text>
          <Text bold>{entry.toolSummary}</Text>
          {entry.toolStatus === "cancelled" && (
            <Text color="yellow"> (cancelled)</Text>
          )}
        </Text>
        {entry.toolResult && (
          <Box marginLeft={2} flexDirection="column">
            {truncForDisplay(entry.toolResult)
              .split("\n")
              .map((line, i) => (
                <Text key={i} color="gray">
                  {line}
                </Text>
              ))}
          </Box>
        )}
      </Box>
    );
  }
  if (entry.kind === "error") {
    return (
      <Box marginTop={1}>
        <Text color="red">  ⚠ {entry.text}</Text>
      </Box>
    );
  }
  return (
    <Box marginTop={1}>
      <Text color="gray" italic>
        {"  "}
        {entry.text}
      </Text>
    </Box>
  );
}

function ChatBar({
  value,
  cursor,
  onChange,
  onSubmit,
  onHistoryUp,
  onHistoryDown,
  hasKey,
  isActive,
}: {
  value: string;
  cursor: number;
  onChange: (v: string, c: number) => void;
  onSubmit: (v: string) => void;
  onHistoryUp: () => void;
  onHistoryDown: () => void;
  hasKey: boolean;
  isActive: boolean;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor={hasKey ? "gray" : "yellow"}
      paddingX={1}
    >
      <Box marginRight={1}>
        <Text color={hasKey ? "cyan" : "yellow"} bold>{">"}</Text>
      </Box>
      <MultilineInput
        value={value}
        cursor={cursor}
        onChange={onChange}
        onSubmit={onSubmit}
        onHistoryUp={onHistoryUp}
        onHistoryDown={onHistoryDown}
        placeholder={
          hasKey
            ? "Send a message  (↑↓ history · /help)"
            : "/login to set your API key first"
        }
        isActive={isActive}
      />
    </Box>
  );
}

function ReviewView({
  anonymized,
  entities,
}: {
  anonymized: string;
  entities: Entity[];
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        review · {entities.length}{" "}
        {entities.length === 1 ? "entity" : "entities"} detected
      </Text>
      {entities.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {entities.map((e, i) => (
            <Text key={i}>
              {"  "}
              <Text color={colorFor(e.type)} bold>
                {(e.placeholder ?? `[${e.type}]`).padEnd(16)}
              </Text>{" "}
              <Text color="gray">←</Text>{" "}
              <Text bold>{JSON.stringify(e.text)}</Text>{" "}
              <Text color="gray">
                ({e.source}
                {e.source === "ner" ? ` ${e.score.toFixed(2)}` : ""})
              </Text>
            </Text>
          ))}
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text bold>will send:</Text>
        <Box marginLeft={2}>
          <AnonymizedPreview text={anonymized} />
        </Box>
      </Box>
    </Box>
  );
}

function ToolReviewView({
  name,
  summary,
  anonOutput,
  entities,
  isError,
}: {
  name: string;
  summary: string;
  anonOutput: string;
  entities: Entity[];
  isError: boolean;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={isError ? "red" : "yellow"}
      paddingX={1}
    >
      <Text bold color={isError ? "red" : "yellow"}>
        send tool output to LLM? ·{" "}
        <Text color="white">{name}</Text>
        {isError && <Text color="red"> (errored)</Text>}
      </Text>
      <Box marginTop={1}>
        <Text color="gray">{summary}</Text>
      </Box>
      {entities.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">
            redacted in output: {entities.length}{" "}
            {entities.length === 1 ? "entity" : "entities"} ·{" "}
            {entities
              .map((e) => e.type)
              .filter((t, i, a) => a.indexOf(t) === i)
              .join(", ")}
          </Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text bold>will send:</Text>
        <Box marginLeft={2} flexDirection="column">
          {truncForDisplay(anonOutput, 12, 1200)
            .split("\n")
            .map((line, i) => (
              <AnonymizedPreview key={i} text={line} />
            ))}
        </Box>
      </Box>
    </Box>
  );
}

const PAGE_SIZE = 12;

function ModelPickerView({
  mode,
  input,
  onSearchChange,
  currentModel,
}: {
  mode: Extract<Mode, { kind: "modelPicker" }>;
  input: string;
  onSearchChange: (v: string) => void;
  currentModel: string;
}) {
  const filtered = filterModels(mode.all, mode.query);
  const cursor =
    filtered.length === 0 ? 0 : Math.min(mode.cursor, filtered.length - 1);
  const page = Math.floor(cursor / PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const slice = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const cursorInPage = cursor - page * PAGE_SIZE;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        <Text bold color="cyan">model picker</Text>
        <Text color="gray">
          {"  "}
          {filtered.length}/{mode.all.length}
          {filtered.length > 0
            ? `  ·  ${cursor + 1} of ${filtered.length}  ·  page ${page + 1}/${totalPages}`
            : ""}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color="cyan" bold>{"▸ "}</Text>
        <Box flexGrow={1}>
          <TextInput
            value={input}
            onChange={onSearchChange}
            placeholder="type to filter…"
            showCursor
          />
        </Box>
      </Box>
      {mode.loading && (
        <Box marginTop={1}>
          <Text color="gray">
            <Spinner type="dots" /> fetching catalog…
          </Text>
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        {slice.length === 0 ? (
          <Text color="yellow">  no model matches</Text>
        ) : (
          slice.map((m, i) => {
            const isCursor = i === cursorInPage;
            const isCurrent = m.id === currentModel;
            const marker = isCursor ? "▸ " : "  ";
            return (
              <Box key={m.id}>
                <Text
                  color={isCursor ? "cyan" : undefined}
                  bold={isCursor}
                  inverse={isCursor}
                >
                  {marker}
                  {m.id}
                  {m.context_length ? `  ${m.context_length}ctx` : ""}
                  {isCurrent ? "  ←current" : ""}
                </Text>
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
}

function EditRedactView({
  anonymized,
  entities,
  manualRedactions,
  input,
  onChange,
  onSubmit,
}: {
  anonymized: string;
  entities: Entity[];
  manualRedactions: string[];
  input: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Text bold color="cyan">edit · add custom redaction</Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold>current placeholders ({entities.length}):</Text>
        {entities.map((e, i) => (
          <Text key={i}>
            {"  "}
            <Text color={colorFor(e.type)} bold>
              {(e.placeholder ?? `[${e.type}]`).padEnd(16)}
            </Text>{" "}
            <Text color="gray">←</Text>{" "}
            <Text bold>{JSON.stringify(e.text)}</Text>
          </Text>
        ))}
        {manualRedactions.length > 0 && (
          <Text color="gray">
            {"  "}({manualRedactions.length} manual added)
          </Text>
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>will send:</Text>
        <Box marginLeft={2}>
          <AnonymizedPreview text={anonymized} />
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text>paste text to redact: </Text>
        <TextInput value={input} onChange={onChange} onSubmit={onSubmit} />
      </Box>
      <Text color="gray">
        enter to add as [SECRET_n] · empty enter or Esc to return to review
      </Text>
    </Box>
  );
}

function LoginView({
  input,
  onChange,
  onSubmit,
  baseURL,
}: {
  input: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  baseURL: string;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">login</Text>
      <Text color="gray">endpoint: {baseURL}</Text>
      <Box marginTop={1}>
        <Text>API key: </Text>
        <TextInput
          value={input}
          onChange={onChange}
          onSubmit={onSubmit}
          mask="*"
        />
      </Box>
      <Text color="gray">enter to save · empty to cancel</Text>
    </Box>
  );
}

function FooterHint({
  cfg,
  mode,
  autoAllow,
  nerStatus,
}: {
  cfg: Config;
  mode: Mode;
  autoAllow: boolean;
  nerStatus: "unknown" | "on" | "off";
}) {
  let left: React.ReactNode;
  switch (mode.kind) {
    case "chat":
      left = (
        <Text>
          <Text color="cyan" bold>↵</Text>
          <Text color="white"> send</Text>
          <Text color="gray">{"  │  "}</Text>
          <Text color="cyan" bold>/</Text>
          <Text color="white"> commands</Text>
          <Text color="gray">{"  │  "}</Text>
          <Text color="white">/exit</Text>
        </Text>
      );
      break;
    case "review":
      left = (
        <Text>
          <Text color="green" bold>Y</Text>
          <Text color="white"> approve</Text>
          <Text color="gray">{"  │  "}</Text>
          <Text color="red" bold>N</Text>
          <Text color="white"> deny</Text>
          <Text color="gray">{"  │  "}</Text>
          <Text color="cyan" bold>E</Text>
          <Text color="white"> edit</Text>
          <Text color="gray">{"  │  "}</Text>
          <Text color="white">Esc cancel</Text>
        </Text>
      );
      break;
    case "toolReview":
      left = (
        <Text>
          <Text color="green" bold>Y</Text>
          <Text color="white"> approve</Text>
          <Text color="gray">{"  │  "}</Text>
          <Text color="red" bold>N</Text>
          <Text color="white"> deny</Text>
          <Text color="gray">{"  │  "}</Text>
          <Text color="white">Esc cancel</Text>
        </Text>
      );
      break;
    case "editRedact":
      left = (
        <Text>
          <Text color="cyan" bold>↵</Text>
          <Text color="white"> add redaction</Text>
          <Text color="gray">{"  │  "}</Text>
          <Text color="white">Esc back</Text>
        </Text>
      );
      break;
    case "modelPicker":
      left = (
        <Text>
          <Text color="cyan" bold>↑↓</Text>
          <Text color="white"> move</Text>
          <Text color="gray">{"  │  "}</Text>
          <Text color="cyan" bold>↵</Text>
          <Text color="white"> pick</Text>
          <Text color="gray">{"  │  "}</Text>
          <Text color="white">type to filter</Text>
          <Text color="gray">{"  │  "}</Text>
          <Text color="white">Esc cancel</Text>
        </Text>
      );
      break;
    case "login":
      left = (
        <Text>
          <Text color="cyan" bold>↵</Text>
          <Text color="white"> save</Text>
          <Text color="gray">{"  │  "}</Text>
          <Text color="white">empty=cancel</Text>
        </Text>
      );
      break;
    case "streaming":
      left = <Text color="cyan">streaming…</Text>;
      break;
    case "toolRunning":
      left = (
        <Text>
          <Text color="cyan">running </Text>
          <Text color="white">{mode.name}</Text>
          <Text color="cyan">…</Text>
        </Text>
      );
      break;
    case "warmup":
      left = <Text color="cyan">loading…</Text>;
      break;
  }
  const host = cfg.baseURL.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return (
    <Box paddingX={1} justifyContent="space-between">
      {left}
      <Text>
        <Text color="white">{cfg.model}</Text>
        <Text color="gray">{"  │  "}</Text>
        <Text color="gray">{host}</Text>
        <Text color="gray">{"  │  "}</Text>
        {cfg.apiKey ? (
          <Text color="green" bold>● key</Text>
        ) : (
          <Text color="red" bold>○ no key</Text>
        )}
        <Text color="gray">{"  │  "}</Text>
        {nerStatus === "on" ? (
          <Text color="green" bold>● ner</Text>
        ) : nerStatus === "off" ? (
          <Text color="yellow" bold>○ regex-only</Text>
        ) : (
          <Text color="gray">… ner</Text>
        )}
        {autoAllow && (
          <>
            <Text color="gray">{"  │  "}</Text>
            <Text color="yellow" bold>auto-allow</Text>
          </>
        )}
      </Text>
    </Box>
  );
}

// ── Main app ─────────────────────────────────────────────────────────────────

export function App({ flags }: { flags: CliFlags }) {
  const app = useApp();
  const [cfg, setCfg] = useState<Config>(() => {
    const c = loadConfig();
    return flags.model ? { ...c, model: flags.model } : c;
  });
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [streaming, setStreaming] = useState<string>("");
  const [mode, setMode] = useState<Mode>({ kind: "warmup" });
  const [chatInput, setChatInput] = useState("");
  const [chatCursor, setChatCursor] = useState(0);
  const [modalInput, setModalInput] = useState("");

  const [history, setHistory] = useState<string[]>(() => loadHistory());
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [nerStatus, setNerStatus] = useState<"unknown" | "on" | "off">(
    flags.warmup ? "unknown" : "off",
  );

  const sessionRef = useRef(new Session());
  const clientRef = useRef<OpenAI | null>(cfg.apiKey ? createClient(cfg) : null);
  const idRef = useRef(0);
  const cwdRef = useRef(sessionRef.current.project?.root ?? process.cwd());
  const decisionRef = useRef<((approved: boolean) => void) | null>(null);
  type ReviewFinalState = {
    anonymized: string;
    entities: Entity[];
  } | null;
  const reviewResolverRef = useRef<((state: ReviewFinalState) => void) | null>(
    null,
  );

  const append = (entry: Omit<TranscriptEntry, "id">) => {
    idRef.current += 1;
    setTranscript((t) => [...t, { ...entry, id: idRef.current }]);
  };

  const setChatBoth = (v: string, c: number) => {
    setChatInput(v);
    setChatCursor(c);
    if (historyIndex !== null) setHistoryIndex(null);
  };

  const onHistoryUp = () => {
    if (history.length === 0) return;
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
    if (historyIndex === null) return;
    if (historyIndex < history.length - 1) {
      const idx = historyIndex + 1;
      const entry = history[idx] ?? "";
      setHistoryIndex(idx);
      setChatInput(entry);
      setChatCursor(entry.length);
    } else {
      setHistoryIndex(null);
      setChatInput(draft);
      setChatCursor(draft.length);
    }
  };

  const askApproval = (next: Mode): Promise<boolean> => {
    return new Promise((resolve) => {
      decisionRef.current = resolve;
      setMode(next);
    });
  };

  const askApprovalReview = (initial: {
    anonymized: string;
    entities: Entity[];
    original: string;
    manualRedactions: string[];
  }): Promise<ReviewFinalState> => {
    return new Promise((resolve) => {
      reviewResolverRef.current = resolve;
      setMode({ kind: "review", ...initial });
    });
  };

  const appendNoKeyHintIfNeeded = () => {
    if (cfg.apiKey) return;
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
        if (cancelled) return;
        const nerOk = await isNERAvailable();
        setNerStatus(nerOk ? "on" : "off");
        const suffix = `${sessionRef.current.project?.agentsMd ? " · AGENTS.md" : ""}${sessionRef.current.project?.rules ? " · rules" : ""}${nerOk ? " · NER on" : " · regex+dict only (NER unavailable — run: npm i -g anonyagent --include=optional)"}`;
        append({
          kind: "system",
          text: `ready · ${cwdRef.current}${suffix}`,
        });
        appendNoKeyHintIfNeeded();
        setMode({ kind: "chat" });
      } catch (err) {
        if (!cancelled) {
          setNerStatus("off");
          append({
            kind: "system",
            text: `NER unavailable, regex+dict only: ${formatError(err)}`,
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
    if (key.ctrl && char === "c") app.exit();
  });

  // Approve / deny for tool review (y/n only).
  useInput(
    (char, key) => {
      if (mode.kind !== "toolReview") return;
      if (char === "y" || char === "Y" || key.return) {
        const r = decisionRef.current;
        decisionRef.current = null;
        r?.(true);
      } else if (char === "n" || char === "N" || key.escape) {
        const r = decisionRef.current;
        decisionRef.current = null;
        r?.(false);
      }
    },
    { isActive: mode.kind === "toolReview" },
  );

  // Approve / deny / edit for the entity review.
  useInput(
    (char, key) => {
      if (mode.kind !== "review") return;
      if (char === "e" || char === "E") {
        setModalInput("");
        setMode({
          kind: "editRedact",
          anonymized: mode.anonymized,
          entities: mode.entities,
          original: mode.original,
          manualRedactions: mode.manualRedactions,
        });
        return;
      }
      if (char === "y" || char === "Y" || key.return) {
        const r = reviewResolverRef.current;
        reviewResolverRef.current = null;
        r?.({ anonymized: mode.anonymized, entities: mode.entities });
      } else if (char === "n" || char === "N" || key.escape) {
        const r = reviewResolverRef.current;
        reviewResolverRef.current = null;
        r?.(null);
      }
    },
    { isActive: mode.kind === "review" },
  );

  // ── Slash commands ───────────────────────────────────────────────────────
  const handleSlash = async (raw: string): Promise<boolean> => {
    const cmd = raw.split(/\s+/, 1)[0]!;
    const rest = raw.slice(cmd.length).trim();
    switch (cmd) {
      case "/exit":
      case "/quit":
        app.exit();
        return true;
      case "/help":
        append({
          kind: "system",
          text: "commands: /login · /model [search] · /endpoint <url> · /status · /map (or /mappings) · /init · /create-rules [name] · /rules · /clear · /reset · /exit",
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
        } catch (err) {
          append({
            kind: "error",
            text: `could not create ${file}: ${(err as Error).message}`,
          });
          return true;
        }
        const project = sessionRef.current.reloadProject(cwdRef.current);
        if (project?.root) cwdRef.current = project.root;
        append({ kind: "system", text: `created ${file} — edit it then continue` });
        return true;
      }
      case "/create-rules": {
        const baseDir = join(cwdRef.current, ".anonyagent");
        let file: string;
        let template: string;
        if (!rest) {
          file = join(baseDir, "rules.md");
          template = RULES_TEMPLATE("project rules");
        } else {
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
        } catch (err) {
          append({
            kind: "error",
            text: `could not create ${file}: ${(err as Error).message}`,
          });
          return true;
        }
        const project = sessionRef.current.reloadProject(cwdRef.current);
        if (project?.root) cwdRef.current = project.root;
        append({ kind: "system", text: `created ${file} — edit it then continue` });
        return true;
      }
      case "/rules": {
        const rules = sessionRef.current.project?.rules;
        if (!rules) {
          append({
            kind: "system",
            text:
              "(no rules loaded — create one with /create-rules [name])",
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
      case "/map":
      case "/mappings": {
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
        const newCfg: Config = { ...cfg, baseURL: next.baseURL ?? rest };
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
        } catch (err) {
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
  const deanonRef = useRef<StreamingDeanonymizer | null>(null);
  const reviewQueueRef = useRef<Promise<void>>(Promise.resolve());

  const enqueueReview = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = reviewQueueRef.current.then(fn, fn);
    reviewQueueRef.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const callbacks: AgentCallbacks = {
    onTurnStart(agentId) {
      if (agentId !== "main") return;
      accumulatedContentRef.current = "";
      assembledRef.current = "";
      deanonRef.current = new StreamingDeanonymizer(
        sessionRef.current.allocator.reverseMap(),
      );
      setStreaming("");
      setMode({ kind: "streaming" });
    },
    onContentDelta(agentId, text) {
      if (agentId !== "main" || !deanonRef.current) return;
      accumulatedContentRef.current += text;
      const out = deanonRef.current.push(text);
      if (out) {
        assembledRef.current += out;
        setStreaming((s) => s + out);
      }
    },
    onTurnEnd(agentId, content) {
      if (agentId !== "main") return;
      const tail = deanonRef.current?.flush() ?? "";
      if (tail) assembledRef.current += tail;
      if (content.trim()) {
        append({ kind: "assistant", text: assembledRef.current });
      }
      setStreaming("");
    },
    onToolStart(agentId, _callId, name) {
      if (agentId === "main") setMode({ kind: "toolRunning", name });
    },
    onToolFinish(
      agentId,
      _callId,
      name,
      summary,
      rawOutput,
      _anonOutput,
      isError,
    ) {
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
      return enqueueReview(
        () =>
          new Promise<boolean>((resolve) => {
            decisionRef.current = resolve;
            setMode({
              kind: "toolReview",
              name: req.toolName,
              summary: req.summary,
              anonOutput: req.anonOutput,
              entities: req.entities,
              isError: req.isError,
            });
          }),
      );
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
      await runAgent(
        {
          client: clientRef.current,
          model: cfg.model,
          cwd: cwdRef.current,
          allocator: sessionRef.current.allocator,
          agentId: "main",
          depth: 0,
        },
        {
          history: sessionRef.current.history,
          autoAllow: flags.autoAllow,
        },
        callbacks,
      );
    } catch (err) {
      append({ kind: "error", text: formatError(err) });
    }
    setMode({ kind: "chat" });
  };

  // ── Chat submit ──────────────────────────────────────────────────────────
  const onChatSubmit = async (value: string) => {
    const raw = value.trim();
    setChatInput("");
    setChatCursor(0);
    setHistoryIndex(null);
    setDraft("");
    if (!raw) return;
    setHistory((h) => appendHistory(h, raw));
    if (raw.startsWith("/")) {
      await handleSlash(raw);
      return;
    }
    if (!clientRef.current) {
      append({ kind: "error", text: "no API key — run /login" });
      return;
    }

    let { anonymized, entities } =
      await sessionRef.current.anonymizeUserMessage(raw);

    if (!flags.autoAllow) {
      const finalState = await askApprovalReview({
        anonymized,
        entities,
        original: raw,
        manualRedactions: [],
      });
      if (!finalState) {
        append({ kind: "system", text: "cancelled" });
        setMode({ kind: "chat" });
        return;
      }
      anonymized = finalState.anonymized;
      entities = finalState.entities;
    }

    append({ kind: "user", text: raw, entities });
    sessionRef.current.history.push({
      role: "user",
      content: anonymized,
    } as ChatMessage);

    await driveAgent();
  };

  // ── Model picker keys ────────────────────────────────────────────────────
  const pickModelAt = (index: number) => {
    if (mode.kind !== "modelPicker") return;
    const filtered = filterModels(mode.all, mode.query);
    const chosen = filtered[index];
    if (!chosen) return;
    const next = writeUserConfig({ model: chosen.id });
    const newCfg: Config = { ...cfg, model: next.model ?? chosen.id };
    setCfg(newCfg);
    append({ kind: "system", text: `model → ${chosen.id}` });
    setModalInput("");
    setMode({ kind: "chat" });
  };

  useInput(
    (_char, key) => {
      if (mode.kind !== "modelPicker") return;
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
    },
    { isActive: mode.kind === "modelPicker" },
  );

  const onPickerSearchChange = (v: string) => {
    setModalInput(v);
    if (mode.kind === "modelPicker") {
      setMode({ ...mode, query: v, cursor: 0 });
    }
  };

  // ── Edit-redaction submit ───────────────────────────────────────────────
  const onEditRedactSubmit = async (value: string) => {
    if (mode.kind !== "editRedact") return;
    const v = value.trim();
    setModalInput("");
    if (!v) {
      setMode({
        kind: "review",
        anonymized: mode.anonymized,
        entities: mode.entities,
        original: mode.original,
        manualRedactions: mode.manualRedactions,
      });
      return;
    }
    if (!mode.original.includes(v)) {
      append({
        kind: "error",
        text: `"${v}" not found in the original message — leaving redactions unchanged`,
      });
      setMode({
        kind: "review",
        anonymized: mode.anonymized,
        entities: mode.entities,
        original: mode.original,
        manualRedactions: mode.manualRedactions,
      });
      return;
    }
    const nextManual = [...mode.manualRedactions, v];
    const result = await sessionRef.current.anonymizeUserMessage(
      mode.original,
      nextManual,
    );
    setMode({
      kind: "review",
      anonymized: result.anonymized,
      entities: result.entities,
      original: mode.original,
      manualRedactions: nextManual,
    });
  };

  useInput(
    (_char, key) => {
      if (mode.kind !== "editRedact") return;
      if (key.escape) {
        setModalInput("");
        setMode({
          kind: "review",
          anonymized: mode.anonymized,
          entities: mode.entities,
          original: mode.original,
          manualRedactions: mode.manualRedactions,
        });
      }
    },
    { isActive: mode.kind === "editRedact" },
  );

  // ── Login submit ────────────────────────────────────────────────────────
  const onLoginSubmit = (value: string) => {
    const v = value.trim();
    setModalInput("");
    if (!v) {
      append({ kind: "system", text: "login cancelled" });
      setMode({ kind: "chat" });
      return;
    }
    writeUserConfig({ apiKey: v });
    const newCfg: Config = { ...cfg, apiKey: v };
    setCfg(newCfg);
    clientRef.current = createClient(newCfg);
    append({ kind: "system", text: `key saved (…${v.slice(-4)})` });
    setMode({ kind: "chat" });
  };

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <>
      <Static items={transcript}>
        {(item) => <MessageView entry={item} key={item.id} />}
      </Static>

      {mode.kind === "warmup" && (
        <Box>
          <Text color="gray">
            <Spinner type="dots" /> warming up local NER model…
          </Text>
        </Box>
      )}

      {streaming && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="cyan" bold>AnonyAgent ▸</Text>
          <Text>{streaming}</Text>
        </Box>
      )}

      {mode.kind === "streaming" && !streaming && (
        <Box marginTop={1}>
          <Text color="cyan">
            <Spinner type="dots" /> thinking…
          </Text>
        </Box>
      )}

      {mode.kind === "toolRunning" && (
        <Box marginTop={1}>
          <Text color="cyan">
            <Spinner type="dots" /> running {mode.name}…
          </Text>
        </Box>
      )}

      {mode.kind === "review" && (
        <ReviewView anonymized={mode.anonymized} entities={mode.entities} />
      )}

      {mode.kind === "editRedact" && (
        <EditRedactView
          anonymized={mode.anonymized}
          entities={mode.entities}
          manualRedactions={mode.manualRedactions}
          input={modalInput}
          onChange={setModalInput}
          onSubmit={onEditRedactSubmit}
        />
      )}

      {mode.kind === "toolReview" && (
        <ToolReviewView
          name={mode.name}
          summary={mode.summary}
          anonOutput={mode.anonOutput}
          entities={mode.entities}
          isError={mode.isError}
        />
      )}

      {mode.kind === "modelPicker" && (
        <ModelPickerView
          mode={mode}
          input={modalInput}
          onSearchChange={onPickerSearchChange}
          currentModel={cfg.model}
        />
      )}

      {mode.kind === "login" && (
        <LoginView
          input={modalInput}
          onChange={setModalInput}
          onSubmit={onLoginSubmit}
          baseURL={cfg.baseURL}
        />
      )}

      {mode.kind === "chat" && (
        <ChatBar
          value={chatInput}
          cursor={chatCursor}
          onChange={setChatBoth}
          onSubmit={onChatSubmit}
          onHistoryUp={onHistoryUp}
          onHistoryDown={onHistoryDown}
          hasKey={!!cfg.apiKey}
          isActive={mode.kind === "chat"}
        />
      )}

      <FooterHint
        cfg={cfg}
        mode={mode}
        autoAllow={flags.autoAllow}
        nerStatus={nerStatus}
      />
    </>
  );
}
