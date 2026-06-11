# JFrog Plugin for VS Code
The official JFrog plugin for [Visual Studio Code](https://code.visualstudio.com/) and **GitHub Copilot Chat**. The plugin connects your Copilot agent to the JFrog Platform with policy-governed MCP access, auto-installed governance instructions, and Agent Guard.

Paste this into your browser:

```
vscode://chat-plugin/install?source=jfrog/vscode-plugin
```

---

## Features

The JFrog plugin provides the following capabilities, grouped by component:

| Component | Feature | Description |
| --- | --- | --- |
| **MCP** | JFrog MCP (always-on) | Plugin-bundled JFrog MCP routed through `@jfrog/agent-guard` to `${JFROG_URL}/mcp`. Always available, not subject to AI Catalog policy — see [Plugin-managed JFrog MCP](#plugin-managed-jfrog-mcp). |
| **Hook** | Agent Guard | Copilot manage MCPs through the JFrog Agent Guard. Through it you can discover, install, configure, update, and remove MCP servers from the JFrog AI Catalog approved for your project, and authenticate to remote HTTP MCPs via OAuth, API key, or bearer token. |

---

## Prerequisites

Before installing, make sure you have:

- **JFrog host URL and access token** — Your JFrog platform URL and a valid access token.
- **VS Code** — With the **GitHub Copilot Chat** extension installed and signed in.
- **GitHub Copilot editor preview features enabled** (organizations only) — If your Copilot access is managed by a GitHub organization, an admin must navigate to **Settings → Copilot → Policies → Editor preview features** and set it to **Enabled**. Individual (non-org) Copilot users can skip this step.
- **Node.js** (≥ 14) — with `npx` on your `PATH` 
- **JFrog CLI** (≥ 2.x, optional) — Recommended for `jf config add` authentication (see [Authentication](#authentication)).
- **JFrog Platform access** (optional) — If you want to use the Agent Guard feature, your JFrog subscription needs to include the AI Catalog entitlement. Contact your JFrog account team if you're unsure whether it's enabled.
- **JFrog project** (optional) — If you want to use the Agent Guard feature.
---

## Installation

You have three options for installing the plugin in VS Code. Pick whichever fits your workflow.

### Option 1 — Magic link (recommended)

1. From the JFrog Platform, navigate to **AI/ML → Registry → Your Project → MCP Servers**.
2. Select an MCP server, then click **Install MCP**.
3. Choose **VS Code** as your IDE, then click **Install via magic link**.

Alternatively, paste this into your browser:

```
vscode://chat-plugin/install?source=jfrog/vscode-plugin
```

VS Code opens, prompts you to install the plugin, and asks you to **Trust** the source.

### Option 2 — Install from source via the command palette

1. Open the Quick Open palette (`Cmd+Shift+P` on macOS or `Ctrl+Shift+P` on Windows/Linux).
2. Run **Chat: Install Plugin from Source**.
3. When prompted, enter:
   ```
   https://github.com/jfrog/vscode-plugin/
   ```
4. Click **Trust**.

### Option 3 — Add the marketplace to your VS Code settings

1. Open your user `settings.json` (`Cmd+Shift+P` → **Preferences: Open User Settings (JSON)**).
2. Add the following entry inside the top-level `{ ... }` object (don't forget a trailing comma if it isn't the last entry):
   ```json
   {
     "chat.plugins.marketplaces": [
       "https://github.com/jfrog/vscode-plugin/"
     ]
   }
   ```
3. Open the Extensions panel (`Cmd+Shift+X`) and search for `@agentPlugins jfrog/vscode-plugin`.
4. Select the plugin, click **Install**, and click **Trust** if prompted.

---

## Authentication

### 1. Set persistent environment variables

| Variable | Description |
| --- | --- |
| `JFROG_URL` | Your JFrog platform URL, e.g. `https://mycompany.jfrog.io` |
| `JFROG_ACCESS_TOKEN` | Your JFrog access token |

### 2. Configure the JFrog CLI

If you have never configured the JFrog CLI on this machine:

1. Open your terminal.
2. Run:
   ```bash
   jf config add
   ```
3. Follow the interactive prompts to enter the same JFrog platform URL and access token.
---


## Usage

After authentication, open a workspace in VS Code. The session-start hook installs the governance file, the JFrog Agent Guard becomes active, and any MCP servers approved for your project become available to your Copilot agent. You can manage everything through natural language — no terminal commands required.

### Discover, inspect, and install MCPs

| Ask the agent… | What happens |
| --- | --- |
| "Which MCP servers can I install?" | Returns all MCP servers approved for your current project that you can install. |
| "What MCP servers do I already have?" | Returns only the MCP servers already installed on your machine. |
| "Show me the details for the filesystem MCP server." | Returns detailed metadata, required configuration (environment variables, runtime arguments), and active tool policies for a given server. |
| "Add the GitHub MCP server." | Installs an approved MCP server and syncs its tool policies locally. Secrets are requested via a CLI command — never in chat. |
| "Update the environment variables for the Slack MCP." | Replaces the configuration for an already-installed server without removing and reinstalling it. |
| "Remove the Slack MCP server." | Removes the server and its stored credentials from your local setup. Changes apply immediately. |
| "Log in to the remote Jira MCP server using OAuth." | Authenticates with a remote HTTP-based MCP server (OAuth, API key, or bearer token). |
| "Log out of the Jira MCP server." | Removes stored authentication credentials for a server. |

### Plugin-managed JFrog MCP

The plugin ships a built-in JFrog MCP (server name: `jfrog`)
registered in the plugin's `.mcp.json`. VS Code starts it
automatically when the plugin is enabled — no `MCP: List Servers`
command, no catalog install, no AI Catalog approval involved. It
launches the standard `npx @jfrog/agent-guard` shape with the
**reserved upstream name** `jfrog-plugin-mcp` in `_JF_ARGS` (see
`.mcp.json`).

Inside agent-guard the reserved name follows a **catalog-first /
fallback-on-catalog-empty** path:

1. agent-guard always tries the AI Catalog for `jfrog-plugin-mcp` first.
2. If the catalog has an entry under that name, agent-guard uses it —
   tool policy and headers from the catalog apply normally.
3. If the catalog has no entry / is unreachable / the user has no
   entitlement, agent-guard falls back to its hardcoded HTTP endpoint
   `${JFROG_URL}/mcp` with `Authorization: Bearer ${JFROG_ACCESS_TOKEN}`.

Both env vars are listed under [Authentication](#authentication); if
either is unset the fallback path errors at startup with a clear
message instead of silently allowing all tools.

**Always on, regardless of AI Catalog allowlist.** A user with no AI
Catalog entitlement, or whose catalog explicitly omits the JFrog
MCP, still gets the plugin-managed `jfrog` working through the
fallback.

**Org policy still wins when configured.** Because the catalog is
consulted first, an admin who publishes `jfrog-plugin-mcp` in their
AI Catalog with a tool policy gets that policy enforced — the
fallback never fires for that org. Anyone (including a malicious
project-level `.mcp.json`) writing the same `_JF_ARGS=mcp=jfrog-plugin-mcp`
is subject to the same catalog-first check, so the reserved name is
not a policy bypass.

**No agent-guard-hook change required.** The plugin entry is launched
via the canonical `npx @jfrog/agent-guard` shape, which is exactly
the shape the
[`agent-guard-hook`](https://github.com/jfrog/agent-guard) already
allows. The reserved name lives in `env._JF_ARGS`, which the hook
policy does not inspect.

### How secrets are handled

When an MCP server requires a sensitive configuration, the agent cannot set the value directly. Instead, it returns a CLI command for you to copy and run in your terminal. Secrets such as API keys, tokens, and connection strings are never exposed in the agent chat history.

---

## Troubleshooting

See the [JFrog MCP Registry troubleshooting guide](https://docs.jfrog.com/ai-ml/docs/mcp-registry-troubleshooting).

---

## Support

- Contact JFrog support at <devrel@jfrog.com>.

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development setup, coding conventions, and the pull-request process.

## Security

See [`SECURITY.md`](SECURITY.md) for how to report vulnerabilities.

## License

Licensed under the [Apache License 2.0](LICENSE).
