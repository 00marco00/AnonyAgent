import "dotenv/config";
import { readUserConfig } from "./userConfig.js";

export interface Config {
  baseURL: string;
  apiKey: string | undefined;
  model: string;
  nerModel: string | undefined;
}

/**
 * Resolution order for each field: env var > user config file > built-in default.
 * `apiKey` is allowed to be undefined — the REPL will prompt for /login.
 */
export function loadConfig(): Config {
  const user = readUserConfig();
  return {
    baseURL:
      process.env.ANONYAGENT_BASE_URL ??
      user.baseURL ??
      "https://openrouter.ai/api/v1",
    apiKey: process.env.ANONYAGENT_API_KEY ?? user.apiKey,
    model:
      process.env.ANONYAGENT_MODEL ?? user.model ?? "anthropic/claude-sonnet-4",
    nerModel: process.env.ANONYAGENT_NER_MODEL,
  };
}
