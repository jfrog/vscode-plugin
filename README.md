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
| **MCP** | JFrog MCP server | Remote JFrog MCP server auto-attached to every session via `.mcp.json` at `https://${JFROG_PLATFORM_URL}/mcp` (OAuth, no API keys). |
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
| `JFROG_PLATFORM_URL` | Your JFrog platform **host only**, without the scheme and without a trailing `/`, e.g. `mycompany.jfrog.io`. The MCP server URL is built as `https://${JFROG_PLATFORM_URL}/mcp`, so do **not** include `https://` here. |
| `JFROG_URL` | Your full JFrog platform URL, including the scheme, e.g. `https://mycompany.jfrog.io` (no trailing `/`). Used for authentication and Agent Guard. |
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
