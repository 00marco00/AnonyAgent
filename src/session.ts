import { PlaceholderAllocator } from "./anonymizer/placeholders.js";
import { anonymize } from "./anonymizer/pipeline.js";
import type { ChatMessage } from "./llm/client.js";
import {
  loadProjectConfig,
  projectPromptSection,
  type ProjectConfig,
} from "./projectConfig.js";

export const BASE_SYSTEM_PROMPT = `You are AnonyAgent, an autonomous coding agent operating behind a local privacy layer.

PRIVACY CONTRACT
The user's messages and ALL tool results have been preprocessed on the user's machine.
Any personal or sensitive data is replaced with opaque placeholders of the form [TYPE_N],
for example: [PERSON_1], [EMAIL_2], [API_KEY_1], [PATH_3], [PHONE_2].

Possible TYPEs you may see:
  PERSON, ORG, LOC, EMAIL, PHONE, IBAN, CREDIT_CARD, IP, URL, PATH, UUID, API_KEY, SSN, DATE

The same placeholder ALWAYS denotes the same underlying value across the whole conversation
AND across tool calls. The local layer substitutes the real values back before the user sees
your responses, and substitutes the real values back into tool arguments before executing
them — so you can freely pass [PATH_3] to read_file and it will hit the right file.

OUTPUT FORMAT — STRICT
1. Reuse placeholders VERBATIM with brackets: [PATH_3], never "<PATH_3>", "PATH_3" or "[path]".
2. Never invent new [TYPE_N] tokens. Use ordinary illustrative text in code examples instead.
3. Do not try to guess what a placeholder stands for and do not ask the user to un-redact.
4. Do not mention or comment on the anonymization process.
5. Reply in the same language the user wrote in.

YOU HAVE TOOLS
You can call tools to read files, search code, write/edit files, and run shell commands.
Plan, then act. Prefer reading before writing. After making changes, verify with bash
(tests, build, lint) before declaring success. Keep your messages short — the user reads
your tool calls and diffs as well.

WHEN UNSURE
Ask one focused question rather than making a wrong guess that costs the user a destructive
write or a confusing diff.`;

export function buildSystemPrompt(project: ProjectConfig | null): string {
  const projectSection = projectPromptSection(project);
  return projectSection
    ? `${BASE_SYSTEM_PROMPT}\n\n${projectSection}`
    : BASE_SYSTEM_PROMPT;
}

export class Session {
  readonly allocator = new PlaceholderAllocator();
  project: ProjectConfig | null;
  readonly history: ChatMessage[];

  constructor(project: ProjectConfig | null = loadProjectConfig()) {
    this.project = project;
    this.history = [{ role: "system", content: buildSystemPrompt(project) }];
  }

  /**
   * Re-read .anonyagent/ from disk and refresh the system prompt in-place.
   * Conversation history beyond the system message is preserved.
   */
  reloadProject(from?: string): ProjectConfig | null {
    this.project = loadProjectConfig(from);
    this.history[0] = {
      role: "system",
      content: buildSystemPrompt(this.project),
    };
    return this.project;
  }

  async anonymizeUserMessage(content: string, manualRedactions?: string[]) {
    return anonymize(content, {
      allocator: this.allocator,
      manualRedactions,
    });
  }
}
