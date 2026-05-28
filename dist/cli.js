#!/usr/bin/env node
import { render } from "ink";
import { createElement } from "react";
import { App, parseArgs } from "./tui/App.js";
function printHelp() {
    console.log(`AnonyAgent — privacy-first coding agent

Usage:
  AnonyAgent [flags]

Flags:
  --dangerously-auto-allow, --auto, -y   Skip approval for entity review and tool output review.
  --model, -m <name>                     Override the active model for this run.
  --no-warmup                            Don't preload the NER model at start.
  --help, -h                             Show this help.

Inside the REPL, type /help to list slash commands.

Project context (auto-loaded from any ancestor of the current directory):
  .anonyagent/AGENTS.md       Main agent instructions.
  .anonyagent/rules.md        Project rules (single file).
  .anonyagent/rules/*.md      Project rules (split across files).
  AGENTS.md                   Fallback if no .anonyagent/ directory exists.

User state:
  ~/.anonyagent/config.json   API key, default model, base URL.
  ~/.anonyagent/history       Prompt history (max 500 entries).
`);
}
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    process.exit(0);
}
const flags = parseArgs(argv);
render(createElement(App, { flags }), { exitOnCtrlC: true });
