import OpenAI from "openai";
import { openaiTools } from "../tools/index.js";
export function createClient(cfg) {
    return new OpenAI({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL,
    });
}
/** Plain streaming chat (no tools). Kept for non-agent uses. */
export async function* streamChat(client, model, messages) {
    const stream = await client.chat.completions.create({
        model,
        messages,
        stream: true,
    });
    for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta)
            yield delta;
    }
}
/**
 * Stream one model turn with tools enabled. Yields content deltas as they come
 * in, and a final `end` event once the response finishes — with any tool calls
 * accumulated so the caller can execute them and loop back.
 */
export async function* streamAgent(client, model, messages) {
    const stream = await client.chat.completions.create({
        model,
        messages,
        tools: openaiTools(),
        stream: true,
    });
    let accumulatedContent = "";
    const accumulatedToolCalls = [];
    let finishReason = null;
    for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice)
            continue;
        const delta = choice.delta;
        if (delta?.content) {
            accumulatedContent += delta.content;
            yield { kind: "content_delta", text: delta.content };
        }
        if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
                const i = tc.index;
                if (typeof i !== "number")
                    continue;
                const slot = accumulatedToolCalls[i] ??
                    ((accumulatedToolCalls[i] = { id: "", name: "", argsRaw: "" }),
                        accumulatedToolCalls[i]);
                if (tc.id)
                    slot.id = tc.id;
                if (tc.function?.name)
                    slot.name = tc.function.name;
                if (tc.function?.arguments)
                    slot.argsRaw += tc.function.arguments;
            }
        }
        if (choice.finish_reason)
            finishReason = choice.finish_reason;
    }
    yield {
        kind: "end",
        finishReason,
        content: accumulatedContent,
        toolCalls: accumulatedToolCalls.filter((t) => t && t.name),
    };
}
