# n8ninator

**A private, local-first n8n coding agent for Apple Silicon.**

n8ninator gives an Ollama model a focused n8n system prompt, a safe working directory, current web access, and n8n's official instance-level MCP tools—all behind a friendly ChatGPT-style interface that runs on your Mac.

It has no accounts, cloud backend, telemetry, or hosted model dependency. The UI and model run locally. An n8n access token is only needed if you choose to connect an n8n instance through MCP.

## What it can do

- Inspect, search, create, and precisely edit files inside one chosen workspace.
- Run builds, tests, linters, and Git diagnostics after asking for approval.
- Read current public documentation from the internet.
- Validate the basic structure and connection graph of local n8n workflow JSON.
- Discover and call the official n8n MCP tools dynamically instead of relying on a stale hard-coded schema.
- Ask before file writes, shell commands, workflow changes, executions, publishing, archiving, or other n8n mutations.
- Stream answers, reasoning traces, tool calls, results, model downloads, and approvals in the browser.
- Show elapsed-time liveness updates while Ollama is silent, automatically retry a request that stalls before producing output, and stop with a concrete recovery message instead of waiting forever.
- Audit every candidate final answer against the original goal and real tool evidence, automatically continuing when the model stops at planning or partial work.
- Keep recent chats in the browser's local storage. Nothing is sent to a n8ninator service.

## Quick start on a Mac

### One-command setup

```bash
git clone https://github.com/MattLocke/n8ninator.git
cd n8ninator
./setup.sh
```

The setup script checks for Node.js 20+ and Ollama, offers to install missing prerequisites through Homebrew, installs the app, builds it, and offers to download the recommended model.

Then double-click `start-n8ninator.command` in Finder, or run:

```bash
./start-n8ninator.command
```

n8ninator opens at [http://127.0.0.1:3210](http://127.0.0.1:3210). It binds to the loopback interface by default, so other devices on the network cannot open it.

### Manual setup

1. Install [Ollama for macOS](https://ollama.com/download/mac) and Node.js 20 or newer.
2. Run `ollama pull gpt-oss:20b`.
3. Run `npm install && npm run build`.
4. Run `npm start`.

To open a specific project on launch:

```bash
npm start -- --workspace "/absolute/path/to/your/n8n/project"
```

You can also change the working directory in **Settings → Workspace**.

## Recommended model for an M4 Pro with 24 GB RAM

The default is **`gpt-oss:20b` at a 16K context window**. It is the best reliability/headroom tradeoff in this memory class: the Ollama package is about 14 GB, the model supports native tool calling, and OpenAI explicitly positions it for local use with 16 GB of memory. Its Apache 2.0 license also makes local and commercial use straightforward.

Model package size is not total runtime memory. The operating system, app, Ollama runtime, context/KV cache, and tool results also need RAM. That is why n8ninator does not default to the largest model that can merely load.

| Model | Ollama size | 24 GB fit | Best use |
|---|---:|---|---|
| [`gpt-oss:20b`](https://ollama.com/library/gpt-oss) | 14 GB | **Recommended** | Best overall reasoning and tool-use balance |
| [`qwen2.5-coder:14b`](https://ollama.com/library/qwen2.5-coder) | 9 GB | Lean | Faster, lighter coding; more room for other apps |
| [`devstral-small-2:24b`](https://registry.ollama.com/library/devstral-small-2/tags) | 15 GB | Stretch | Strong 24B software engineering model with less unified-memory headroom |
| [`qwen3-coder:30b`](https://ollama.com/library/qwen3-coder) | 19 GB | Too large for reliable daily use | Capable agentic coding, but leaves too little headroom |

If the default swaps heavily or competes with a large n8n/Docker workload, select Qwen2.5-Coder 14B. If responses are slow, lower context before lowering reasoning effort. A longer advertised model context is a ceiling, not a target.

Research sources: [OpenAI's GPT-OSS announcement](https://openai.com/index/introducing-gpt-oss/), [GPT-OSS 20B model documentation](https://developers.openai.com/api/docs/models/gpt-oss-20b), [Mistral's Devstral 2 announcement](https://mistral.ai/news/devstral-2-vibe-cli/), and [Qwen's Qwen3-Coder announcement](https://qwenlm.github.io/blog/qwen3-coder/).

## Connect n8n MCP

n8ninator supports n8n's official instance-level Streamable HTTP MCP server. Recent n8n releases expose both knowledge tools and workflow-building tools through this connection.

1. In n8n, open **Settings → Instance-level MCP**.
2. Enable MCP access.
3. Generate or copy an access token.
4. Make the workflows you want the agent to access available to MCP.
5. In n8ninator, open **Settings → n8n MCP**.
6. Paste the MCP URL and token, enable the connection, and save.
7. Select **Test connection**.

For a local n8n instance, the default URL is:

```text
http://127.0.0.1:5678/mcp-server/http
```

For a hosted instance, use:

```text
https://YOUR-N8N-DOMAIN/mcp-server/http
```

The token is sent as an `Authorization: Bearer …` header. n8ninator stores settings in `~/.n8ninator/settings.json`, restricts that file to the local user (`0600`), masks the token from its browser API, and never adds it to prompts or tool results.

Important n8n behavior:

- n8n 2.13+ adds workflow-management MCP tools intended for coding agents.
- Search can preview accessible workflows, while full access and mutation depend on the workflows enabled for MCP.
- MCP lets an authorized local model change the connected n8n instance. Keep **Ask before changes** enabled unless you deliberately want autonomous mutations.
- The authoritative tool list varies by n8n version. n8ninator discovers it at connection time.

See n8n's [MCP access guide](https://docs.n8n.io/advanced-ai/mcp/accessing-n8n-mcp-server/) and [MCP tools reference](https://docs.n8n.io/advanced-ai/mcp/mcp_tools_reference/).

## Safety and approval modes

The default **Ask before changes** mode automatically permits reads, searches, local validation, and public web fetches. It pauses for:

- file creation or editing;
- shell commands;
- n8n workflow creation, updates, publication, execution, or archiving;
- data-table writes and other MCP operations that are not clearly read-only.

Other modes:

- **Read only** denies all approval-requiring actions.
- **Auto approve** permits them without pausing. Use it only in a disposable workspace and non-production n8n environment.

Workspace paths are canonicalized to block `..` traversal and symlink escapes. Common secret files such as `.env`, private keys, and PEM files are excluded from reading and search. Writes are atomic. Large files, searches, command output, and agent loops are bounded.

See [SECURITY.md](SECURITY.md) for the trust model and limitations.

## The n8n specialist prompt

[`prompts/n8n-system.md`](prompts/n8n-system.md) instructs the model to:

- inspect the current project before making claims or edits;
- treat node schemas and versions as facts to verify through MCP;
- preserve workflow/node IDs, credentials, expressions, metadata, and connection references;
- validate local workflow structure and use authoritative n8n validation when connected;
- understand Code node item arrays, expressions, execution modes, and item linking;
- favor small changes, retries, idempotency, error paths, and observability;
- fetch current official n8n documentation when behavior may have changed;
- report only checks that actually ran.

Set `N8NINATOR_PROMPT=/absolute/path/to/prompt.md` before launch to use a customized prompt.

## Follow-through and goal checks

Local models sometimes inspect a task, explain the required work, and then emit a final-looking response before performing it. n8ninator does not treat “the model stopped calling tools” as proof of completion.

Every candidate final response goes through a separate structured completion review using the same local model at low reasoning effort. The controller receives:

- the conversation leading to the current request;
- successful, failed, and denied tool evidence from the run;
- the candidate final response;
- strict rules distinguishing an answer-only question, completed action, unfinished work, and a genuine blocker.

If work remains, the UI displays **Goal check: continuing**, removes the premature draft, tells the agent exactly what is missing, and resumes the tool loop. The agent may stop only when the review passes, a concrete blocker requires the user, or the bounded agent-step safety limit is reached. If structured review is unavailable, a conservative local fallback still rejects empty responses, future-tense plans, and action claims without action evidence.

Exact file-content requests get an additional deterministic gate. `write_file_lines` lets smaller models express content as `lines[]` plus an explicit final-newline flag without fragile escaping. The `verify_file` tool then compares exact content or line arrays and separately checks final-newline state, byte count, line endings, and SHA-256. A request involving exact file whitespace cannot pass until verification returns `exactMatch=true`; this prevents a model from confusing the literal characters `\\n` with a real newline.

## Architecture

```text
Browser UI on 127.0.0.1:3210
        │ streamed NDJSON
        ▼
Local TypeScript agent harness
        ├── safe workspace tools
        ├── approval broker
        ├── evidence ledger + completion controller
        ├── public web fetcher
        ├── local workflow validator
        ├── Ollama chat + native tool calls
        └── n8n Streamable HTTP MCP client
                ▼
          optional n8n instance
```

The UI is intentionally a lightweight local web app rather than Electron: it leaves more of the 24 GB memory budget for the model. The server uses Express, the official TypeScript MCP SDK, Ollama's native `/api/chat` tool-calling protocol, and dependency-local assets under a strict Content Security Policy.

## Developer commands

```bash
npm run dev       # TypeScript watch mode
npm run check     # type-check without emitting
npm test          # integration and safety tests
npm run build     # compile to dist/
npm run verify    # check + test + build
```

The test suite includes a real local Streamable HTTP MCP mock that verifies bearer authentication, tool discovery and calls, mutation classification, workspace containment and secret-file blocking, workflow validation, and server routes. A follow-through regression test deliberately makes a mock model stop at “I will create the file,” confirms that the goal gate rejects it, and proves the harness resumes and writes the requested artifact before accepting completion.

Environment overrides:

| Variable | Default | Purpose |
|---|---|---|
| `N8NINATOR_HOME` | `~/.n8ninator` | Local settings directory |
| `N8NINATOR_WORKSPACE` | launch directory | Initial workspace |
| `N8NINATOR_PROMPT` | `prompts/n8n-system.md` | System prompt file |
| `N8NINATOR_HOST` | `127.0.0.1` | Bind address |
| `N8NINATOR_PORT` | `3210` | UI/server port |
| `N8NINATOR_NO_OPEN` | unset | Set to `1` to prevent browser launch |
| `N8NINATOR_MODEL_SILENCE_MS` | `120000` | Silence allowed before restarting a model request that has produced no output |
| `N8NINATOR_MODEL_ACTIVE_SILENCE_MS` | `60000` | Silence allowed after a response has started before stopping with partial output preserved |
| `N8NINATOR_MODEL_HEARTBEAT_MS` | `10000` | Interval for honest elapsed-time status updates while waiting on Ollama |
| `N8NINATOR_REVIEW_TIMEOUT_MS` | `90000` | Maximum time for the separate completion review before its conservative fallback takes over |

## Troubleshooting

**Ollama shows Offline**  
Open the Ollama macOS app, wait a few seconds, then reload n8ninator. Confirm `curl http://127.0.0.1:11434/api/version` returns JSON.

**The selected model is not downloaded**  
Open Settings and use **Download model**, or run `ollama pull gpt-oss:20b`.

**The model appears stuck on “Waiting for local model…”**

n8ninator reports how long Ollama has been quiet. After two minutes without any output it automatically restarts that model step once. If the retry also stalls, restart Ollama or select `qwen2.5-coder:14b`. If output had already started, n8ninator preserves the partial response and stops after one quiet minute rather than replaying and duplicating text.

**The Mac swaps or becomes unresponsive**  
Quit memory-heavy apps, reduce context to 8K, or use `qwen2.5-coder:14b`. Avoid Qwen3-Coder 30B on a 24 GB machine when reliability matters.

**MCP returns 401 or 403**  
Regenerate the n8n MCP access token, confirm the exact `/mcp-server/http` URL, save settings, then test again.

**MCP connects but cannot open or update a workflow**  
Enable that workflow for MCP access in n8n. Tool availability and permissions are enforced by the n8n instance.

**A model loops on tools**  
Use GPT-OSS 20B, keep reasoning at Medium, and lower **Maximum agent steps**. Smaller general-purpose models may format tool calls less reliably.

## License

[MIT](LICENSE)
