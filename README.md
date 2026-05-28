# AnonyAgent

A privacy-first coding agent CLI. Detects personal/sensitive data **locally**,
replaces it with opaque placeholders, then sends only the redacted text to a
cloud LLM. The response is de-anonymized on your machine before you see it.
The cloud never sees your real data.

```
you ▸ envoie un mail à marco.misseri@example.com pour confirmer
  entities detected:
    EMAIL        "marco.misseri@example.com"  (regex, score=—)

  will send to model:
    envoie un mail à [EMAIL_1] pour confirmer

  send? [Y/n] y

AnonyAgent ▸ D'accord, je prépare un mail à marco.misseri@example.com pour confirmer…
```

## How it works

```
┌──────────────┐   1. detect (regex + local NER)
│ your message │ ─────────────────────────────────┐
└──────────────┘                                  ▼
                                          ┌──────────────┐
                                          │ placeholders │  in-memory only
                                          │  [EMAIL_1]…  │
                                          └──────┬───────┘
                                                 │ 2. send anonymized
                                                 ▼
                                          ┌──────────────┐
                                          │ cloud LLM    │  (OpenRouter / OpenAI /
                                          └──────┬───────┘   LiteLLM proxy / …)
                                                 │ 3. stream tokens back
                                                 ▼
                                          ┌──────────────┐
                                          │ de-anonymize │  values reinjected
                                          │  on the fly  │  locally
                                          └──────┬───────┘
                                                 ▼
                                          what you see
```

Two layers of detection, no Ollama required:

- **Regex** for structured PII with perfect detection: emails, phones, IBAN,
  credit cards (Luhn-validated), IPs, URLs, file paths, UUIDs, API keys, SSN.
- **Local NER** via [`@xenova/transformers`](https://github.com/xenova/transformers.js)
  for names, organizations and locations. Runs in pure Node through ONNX —
  the model (~50–200 MB quantized) downloads once on first run and is then
  cached locally.

## Install

Requires Node 20+.

**One command, Windows / macOS / Linux:**

```sh
npm install -g github:00marco00/AnonyAgent
```

Then launch it from any project directory:

```sh
AnonyAgent
```

> macOS / Linux note: the binary is registered under two names so the shell
> finds it whether you type `AnonyAgent` or `anonyagent`.

On first launch you'll see a banner reminding you to set your API key. Inside
the REPL:

```
you ▸ /login
  API key (input hidden): ****
  saved to ~/.anonyagent/config.json
```

That's it — the next message you type will be redacted locally and sent.

### Build from source

```sh
git clone https://github.com/00marco00/AnonyAgent.git
cd AnonyAgent
npm install
npm run build
npm link        # registers AnonyAgent / anonyagent globally
```

## Usage

```sh
AnonyAgent                              # review mode (default)
AnonyAgent --dangerously-auto-allow     # skip every confirmation
AnonyAgent --no-warmup                  # skip NER model preload at start
AnonyAgent -m anthropic/claude-opus-4   # one-off model override
```

Pick a model from the live OpenRouter catalog:

```
you ▸ /model claude
  fetching catalog… 355 models
    1. anthropic/claude-sonnet-4 200000ctx
    2. anthropic/claude-opus-4 200000ctx
    …
```

`/model` works with any OpenAI-compatible `/models` endpoint (OpenRouter,
OpenAI, LiteLLM proxy, etc.). Switch endpoint at runtime with `/endpoint <url>`.

### REPL commands

| Command | Effect |
|---|---|
| `/login` | Set the API key (input masked), persisted to `~/.anonyagent/config.json` |
| `/model [search]` | Pick a model from your provider's catalog. Inside the picker: number=pick, `n`/`p`=paginate, `/<text>`=search, `q`=cancel |
| `/endpoint <url>` | Change the base URL (e.g. `https://api.openai.com/v1`) |
| `/status` | Show current key/model/endpoint |
| `/map` | Show the current placeholder ↔ original mapping |
| `/init` | Create `.anonyagent/AGENTS.md` with a starter template, then reload the project context |
| `/create-rules [name]` | Create `.anonyagent/rules.md` (no arg) or `.anonyagent/rules/<slug>.md`, then reload |
| `/rules` | Print the currently loaded rules |
| `/clear` | Reset conversation history, keep the placeholder map |
| `/reset` | Reset everything |
| `/help` | Show help |
| `/exit` | Quit |

### Env-var overrides (optional)

For CI or scripted use, env vars take precedence over the saved config:

- `ANONYAGENT_API_KEY`
- `ANONYAGENT_MODEL`
- `ANONYAGENT_BASE_URL`
- `ANONYAGENT_NER_MODEL`

## Modes

- **review** (default): every payload that crosses into the cloud LLM is shown
  to you, fully anonymized, before being sent. Two checkpoints:
  1. **Your message**, just after the local detector ran.
  2. **Each tool result**, after the agent ran it locally and the output was
     re-anonymized. Tool *execution* itself happens without prompting — the
     trust boundary is the network, not the filesystem.
- **dangerously-auto-allow** (`--auto` / `-y`): skips both checkpoints. Every
  message and every tool result is shipped straight through. Use only when you
  trust the detection coverage.

## Privacy properties

- The placeholder ↔ original map lives in **process memory only**. Nothing
  is persisted to disk, no telemetry leaves your machine.
- The NER model runs locally; no inference traffic to a third party for
  detection.
- The cloud LLM only ever sees the redacted text and the placeholders.

## Tests

```sh
npx tsx --test src/anonymizer/pipeline.test.ts
```

## Caveats

- NER is not perfect — uncommon names, mis-cased text and short snippets are
  weak spots. Always prefer **review mode** for sensitive work.
- The default regex set is biased toward Western/US patterns (SSN, credit
  cards). Extend `src/anonymizer/detectors/regex.ts` for your locale.

## Agent

The CLI is an agent loop — the model can call tools to read your project,
search code, write/edit files and run shell commands. Tool calls execute
locally without prompting (your filesystem is yours); the prompt only fires
**after** the result has been anonymized, so you can see and approve exactly
what is about to leave the machine.

Available tools:

| Tool | Effect |
|---|---|
| `read_file` | Read a file with line numbers |
| `write_file` | Create or fully overwrite a file |
| `edit_file` | Replace one unique occurrence of a string |
| `list_dir` | List directory entries |
| `glob` | Find files by glob pattern |
| `grep` | Regex search across files |
| `bash` | Run a shell command (30 s timeout) |
| `spawn_agent` | Delegate a self-contained subtask to a child agent. Multiple calls in one turn run in parallel. Children inherit the same tools and the same placeholder map, so references stay coherent. |

Path arguments outside the project root are refused. Tool results are
anonymized through the **same** allocator as the chat, so `[PATH_3]` always
refers to the same file across the whole session and across sub-agents.
