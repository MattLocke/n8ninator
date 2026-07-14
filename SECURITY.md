# Security

n8ninator is a single-user local development tool. Its default trust boundary is one Mac user, one explicitly selected workspace, one local Ollama service, and an optional n8n instance authorized by the user.

## Defaults

- The web server binds to `127.0.0.1`, not the LAN.
- The browser API never returns the configured n8n token.
- Settings are written to `~/.n8ninator/settings.json` with user-only permissions (`0600`).
- File operations reject traversal and symlink escapes outside the canonical workspace.
- `.env`, `.env.*` except `.env.example`, private-key names, `.pem`, and `.key` files are excluded from reads and searches.
- File writes and exact replacements are atomic.
- Writes, shell commands, and n8n mutations require browser approval in the default mode.
- Web assets load locally under a restrictive Content Security Policy.

## What approval means

Approval is a boundary around a tool invocation, not proof that the proposed action is safe. Read the tool name and arguments before approving. A shell command can modify anything accessible to your macOS user, even though its working directory begins inside the selected workspace.

Use **Read only** when reviewing unfamiliar projects. Use **Auto approve** only with a disposable workspace and a non-production n8n instance.

## Known limits

- Settings are permission-protected plaintext, not Keychain-encrypted. Anyone who can act as your macOS user can read them.
- A locally running model can misunderstand a request, generate unsafe code, or request a destructive action.
- `fetch_url` allows the model to request HTTP(S) resources. Do not use this app in a network environment where requests to internal URLs are inherently privileged.
- Connecting n8n MCP grants the app the capabilities represented by that token and the workflows enabled in n8n.
- The local workflow validator checks document and graph structure; it is not a substitute for n8n's version-aware MCP validation or an actual test execution.
- n8ninator is not designed as a multi-user service and should not be exposed to the public internet.

## Recommended operating practice

1. Keep **Ask before changes** enabled.
2. Commit or back up a workspace before large edits.
3. Use a development n8n instance for workflow construction and testing.
4. Enable only the workflows needed for the current task.
5. Review workflow diffs and validation output before publishing.
6. Rotate the n8n MCP token if the settings file is copied or exposed.

## Reporting a vulnerability

Open a GitHub issue without including tokens, credentials, workflow secrets, or private instance URLs. For a report that cannot be made public safely, use GitHub's private vulnerability reporting feature if enabled on the repository.
