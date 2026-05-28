import { streamAgent, } from "../llm/client.js";
import { anonymizeToolOutput, deanonymizeArgs, getTool, } from "../tools/index.js";
const DEFAULT_MAX_ITERATIONS = 20;
const MAX_DEPTH = 3;
function randomCallId() {
    return `call_${Math.random().toString(36).slice(2, 10)}`;
}
export async function runAgent(deps, opts, cb) {
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
        let toolCalls = [];
        cb.onTurnStart(deps.agentId);
        try {
            for await (const evt of streamAgent(deps.client, deps.model, history)) {
                if (evt.kind === "content_delta") {
                    assistantContent += evt.text;
                    cb.onContentDelta(deps.agentId, evt.text);
                }
                else {
                    toolCalls = evt.toolCalls;
                }
            }
        }
        catch (err) {
            const msg = err?.message ?? String(err);
            cb.onError(deps.agentId, msg);
            return { finalContent: lastContent, cancelled: true, iterations };
        }
        cb.onTurnEnd(deps.agentId, assistantContent, toolCalls);
        lastContent = assistantContent;
        const assistantMsg = {
            role: "assistant",
            content: assistantContent || null,
            ...(toolCalls.length > 0
                ? {
                    tool_calls: toolCalls.map((tc) => ({
                        id: tc.id || randomCallId(),
                        type: "function",
                        function: { name: tc.name, arguments: tc.argsRaw || "{}" },
                    })),
                }
                : {}),
        };
        history.push(assistantMsg);
        if (toolCalls.length === 0) {
            return { finalContent: assistantContent, cancelled: false, iterations };
        }
        // Execute every tool call concurrently. Reviews serialize through the
        // callback's own queue; tool execution itself doesn't.
        const ordered = await Promise.all(toolCalls.map((tc) => runOneToolCall(tc, deps, cb, autoAllow, maxIterations)));
        for (const { callId, content } of ordered) {
            history.push({
                role: "tool",
                tool_call_id: callId,
                content,
            });
        }
    }
    cb.onError(deps.agentId, `agent loop exceeded ${maxIterations} iterations, stopping`);
    return { finalContent: lastContent, cancelled: false, iterations };
}
async function runOneToolCall(tc, deps, cb, autoAllow, maxIterations) {
    const callId = tc.id || randomCallId();
    const tool = getTool(tc.name);
    if (!tool) {
        const msg = `unknown tool: ${tc.name}`;
        cb.onError(deps.agentId, msg);
        return { callId, content: msg };
    }
    let rawArgs;
    try {
        rawArgs = tc.argsRaw ? JSON.parse(tc.argsRaw) : {};
    }
    catch {
        const msg = `${tc.name}: invalid JSON arguments`;
        cb.onError(deps.agentId, msg);
        return { callId, content: `error: ${msg}` };
    }
    const realArgs = deanonymizeArgs(rawArgs, deps.allocator);
    const summary = tool.summarize(realArgs);
    cb.onToolStart(deps.agentId, callId, tc.name, summary, realArgs);
    const ctx = {
        cwd: deps.cwd,
        allocator: deps.allocator,
        callId,
        agentDeps: deps,
        agentCallbacks: cb,
        agentOpts: { autoAllow, maxIterations },
    };
    let result;
    try {
        result = await tool.run(realArgs, ctx);
    }
    catch (err) {
        result = {
            output: `tool error: ${err.message}`,
            isError: true,
        };
    }
    const anon = await anonymizeToolOutput(result.output, deps.allocator);
    cb.onToolFinish(deps.agentId, callId, tc.name, summary, result.output, anon.anonymized, !!result.isError);
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
