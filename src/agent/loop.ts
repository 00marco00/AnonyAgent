import type OpenAI from "openai";

import type { PlaceholderAllocator } from "../anonymizer/placeholders.js";
import type { Entity } from "../anonymizer/types.js";
import {
  streamAgent,
  type AccumulatedToolCall,
  type ChatMessage,
} from "../llm/client.js";
import {
  anonymizeToolOutput,
  deanonymizeArgs,
  getTool,
  type ToolContext,
} from "../tools/index.js";

export interface AgentDeps {
  client: OpenAI;
  model: string;
  cwd: string;
  allocator: PlaceholderAllocator;
  /** Path-style id ("main", "main/<callId>", …). Used to scope UI updates. */
  agentId: string;
  /** Recursion depth; 0 = top-level. */
  depth: number;
}

export interface ReviewRequest {
  agentId: string;
  toolName: string;
  summary: string;
  anonOutput: string;
  rawOutput: string;
  entities: Entity[];
  isError: boolean;
}

export interface AgentCallbacks {
  /** Fired once at the start of every model turn, before any deltas. */
  onTurnStart(agentId: string): void;
  /** LLM content delta (still in placeholder form). */
  onContentDelta(agentId: string, text: string): void;
  /** Fired once per model turn after the stream closes. */
  onTurnEnd(
    agentId: string,
    content: string,
    toolCalls: AccumulatedToolCall[],
  ): void;
  onToolStart(
    agentId: string,
    callId: string,
    name: string,
    summary: string,
    args: Record<string, unknown>,
  ): void;
  onToolFinish(
    agentId: string,
    callId: string,
    name: string,
    summary: string,
    rawOutput: string,
    anonOutput: string,
    isError: boolean,
  ): void;
  /** Gate the anonymized output before it crosses into the LLM. */
  requestSendApproval(req: ReviewRequest): Promise<boolean>;
  onError(agentId: string, msg: string): void;
}

export interface AgentRunOptions {
  /** Mutated in place; the loop appends each turn's messages. */
  history: ChatMessage[];
  maxIterations?: number;
  autoAllow?: boolean;
}

export interface AgentRunResult {
  finalContent: string;
  cancelled: boolean;
  iterations: number;
}

const DEFAULT_MAX_ITERATIONS = 20;
const MAX_DEPTH = 3;

function randomCallId(): string {
  return `call_${Math.random().toString(36).slice(2, 10)}`;
}

export async function runAgent(
  deps: AgentDeps,
  opts: AgentRunOptions,
  cb: AgentCallbacks,
): Promise<AgentRunResult> {
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const autoAllow = opts.autoAllow ?? false;
  const { history } = opts;

  if (deps.depth > MAX_DEPTH) {
    return {
      finalContent: `sub-agent depth limit (${MAX_DEPTH}) exceeded`,
      cancelled: true,
      iterations: 0,
    };
  }

  let iterations = 0;
  let lastContent = "";

  while (iterations++ < maxIterations) {
    let assistantContent = "";
    let toolCalls: AccumulatedToolCall[] = [];

    cb.onTurnStart(deps.agentId);

    try {
      for await (const evt of streamAgent(deps.client, deps.model, history)) {
        if (evt.kind === "content_delta") {
          assistantContent += evt.text;
          cb.onContentDelta(deps.agentId, evt.text);
        } else {
          toolCalls = evt.toolCalls;
        }
      }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      cb.onError(deps.agentId, msg);
      return { finalContent: lastContent, cancelled: true, iterations };
    }

    cb.onTurnEnd(deps.agentId, assistantContent, toolCalls);
    lastContent = assistantContent;

    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: assistantContent || null,
      ...(toolCalls.length > 0
        ? {
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id || randomCallId(),
              type: "function" as const,
              function: { name: tc.name, arguments: tc.argsRaw || "{}" },
            })),
          }
        : {}),
    } as ChatMessage;
    history.push(assistantMsg);

    if (toolCalls.length === 0) {
      return { finalContent: assistantContent, cancelled: false, iterations };
    }

    // Execute every tool call concurrently. Reviews serialize through the
    // callback's own queue; tool execution itself doesn't.
    const ordered = await Promise.all(
      toolCalls.map((tc) =>
        runOneToolCall(tc, deps, cb, autoAllow, maxIterations),
      ),
    );

    for (const { callId, content } of ordered) {
      history.push({
        role: "tool",
        tool_call_id: callId,
        content,
      } as ChatMessage);
    }
  }

  cb.onError(
    deps.agentId,
    `agent loop exceeded ${maxIterations} iterations, stopping`,
  );
  return { finalContent: lastContent, cancelled: false, iterations };
}

async function runOneToolCall(
  tc: AccumulatedToolCall,
  deps: AgentDeps,
  cb: AgentCallbacks,
  autoAllow: boolean,
  maxIterations: number,
): Promise<{ callId: string; content: string }> {
  const callId = tc.id || randomCallId();
  const tool = getTool(tc.name);
  if (!tool) {
    const msg = `unknown tool: ${tc.name}`;
    cb.onError(deps.agentId, msg);
    return { callId, content: msg };
  }

  let rawArgs: Record<string, unknown>;
  try {
    rawArgs = tc.argsRaw ? JSON.parse(tc.argsRaw) : {};
  } catch {
    const msg = `${tc.name}: invalid JSON arguments`;
    cb.onError(deps.agentId, msg);
    return { callId, content: `error: ${msg}` };
  }

  const realArgs = deanonymizeArgs(rawArgs, deps.allocator);
  const summary = tool.summarize(realArgs);
  cb.onToolStart(deps.agentId, callId, tc.name, summary, realArgs);

  const ctx: ToolContext = {
    cwd: deps.cwd,
    allocator: deps.allocator,
    callId,
    agentDeps: deps,
    agentCallbacks: cb,
    agentOpts: { autoAllow, maxIterations },
  };

  let result: { output: string; isError?: boolean };
  try {
    result = await tool.run(realArgs, ctx);
  } catch (err) {
    result = {
      output: `tool error: ${(err as Error).message}`,
      isError: true,
    };
  }

  const anon = await anonymizeToolOutput(result.output, deps.allocator);
  cb.onToolFinish(
    deps.agentId,
    callId,
    tc.name,
    summary,
    result.output,
    anon.anonymized,
    !!result.isError,
  );

  if (!autoAllow) {
    const ok = await cb.requestSendApproval({
      agentId: deps.agentId,
      toolName: tc.name,
      summary,
      anonOutput: anon.anonymized,
      rawOutput: result.output,
      entities: anon.entities,
      isError: !!result.isError,
    });
    if (!ok) {
      return {
        callId,
        content: "user denied sending this tool output to the model",
      };
    }
  }

  return { callId, content: anon.anonymized };
}
