# Agent Package Resolution — VS Code user guide

Agent Package Resolution adds the Artifactory repository policy to every new
Copilot chat. It is advisory context for the agent; JFrog Curation and
package-manager configuration provide the enforcement layer.

## Prerequisites

Enable both VS Code settings:

```json
{
  "chat.plugins.enabled": true,
  "chat.useHooks": true
}
```

Install Node.js 20 or newer and configure the JFrog CLI:

```bash
jf config add
```

Start a new Copilot chat after changing configuration. If `jf` is missing or
not configured, the hook returns a `NOT READY` advisory and does not invent a
public or unverified repository.

## Enable routing

An administrator must enable the feature and declare the package types:

```json
{
  "packageResolution": {
    "enabled": true,
    "defaultGlobalRepos": {
      "npm": "npm-virtual"
    }
  }
}
```

Use repository keys that exist on the configured JFrog server. A workspace
`.jfrog/local/package-resolution.json` can override an administrator-approved
type, but cannot add a new governed type.

## Troubleshooting

If no policy appears, check `~/.jfrog/agents-conf.json`, `jf config show`, and
start a fresh chat. Set `logLevel` to `debug` temporarily and inspect
`~/.jfrog/logs/agent-hooks.log`.
