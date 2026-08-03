# AGENTS.md

Repo-specific guidance for AI coding agents working on this codebase. For product/user docs, see [README.md](README.md).

## What this repo is

The **JFrog VS Code / Copilot Chat plugin** (also compatible with Claude Code's plugin/hook shape). It ships:

- A `SessionStart` hook that injects governance instructions into the agent's context.
- Three bundled skills under [plugin/skills/](plugin/skills/) (`jfrog`, `jfrog-ai-catalog-skills`, `jfrog-package-safety-and-download`).
- A `.mcp.json` that auto-attaches the JFrog remote MCP server.

There is **no build step, no bundler, no `package.json`**. Everything is plain ESM (`.mjs`) executed by Node ≥ 14 (CI uses Node 20). Do not introduce a `package.json`, TypeScript, or a bundler without discussing it first.

## Layout at a glance

| Path | Role |
| --- | --- |
| [marketplace.json](marketplace.json) | Marketplace listing for `chat.plugins.marketplaces`. Must stay in sync with `plugin.json`. |
| [plugin/.claude-plugin/plugin.json](plugin/.claude-plugin/plugin.json) | Plugin manifest. `name` and `version` must match `marketplace.json`. |
| [plugin/hooks/hooks.json](plugin/hooks/hooks.json) | Wires `SessionStart` → `scripts/inject-instructions.mjs`. `${CLAUDE_PLUGIN_ROOT}` resolves to `plugin/`. |
| [plugin/scripts/inject-instructions.mjs](plugin/scripts/inject-instructions.mjs) | The hook. Reads [plugin/templates/jfrog-mcp-management.md](plugin/templates/jfrog-mcp-management.md) and emits it as `hookSpecificOutput.additionalContext`. |
| [plugin/templates/jfrog-mcp-management.md](plugin/templates/jfrog-mcp-management.md) | The governance template injected into every session. Editing this changes agent behavior globally. |
| [plugin/.mcp.json](plugin/.mcp.json) | Attaches the remote JFrog MCP server at `${JFROG_URL}/mcp`. |
| [scripts/validate-hook-injector.mjs](scripts/validate-hook-injector.mjs) | Smoke test for the injector + packaging. This is the sole test suite. |
| [.github/workflows/validate-inject-instructions.yml](.github/workflows/validate-inject-instructions.yml) | CI runs the validator on PRs to `main`. |

## Running tests

Only one command matters:

```bash
node scripts/validate-hook-injector.mjs
```

Run it after any edit to the injector, the template, `hooks.json`, `plugin.json`, or `marketplace.json`. It checks:

- Syntax (`node --check`) on the injector.
- Manifest lint: `marketplace.json` ↔ `plugin.json` name+version parity, hook path exists, template filename referenced by the injector matches a real non-empty file.
- The `SessionStart` payload shape (valid JSON, `hookEventName === "SessionStart"`, non-empty `additionalContext`).
- Force-enable injects the template byte-for-byte; force-disable emits `{}`.

If the validator's CI trigger paths (`.github/workflows/validate-inject-instructions.yml` → `paths:`) don't cover a file you added, extend that list.

## Editing conventions

- **Every `.mjs` file starts with the standard Apache-2.0 copyright header** — see [plugin/scripts/inject-instructions.mjs](plugin/scripts/inject-instructions.mjs#L1-L3). New scripts must include it.
- **Injector output discipline**: stdout is reserved for the JSON payload. All logs go to stderr via `log`/`debug` (gated on `JF_AGENT_GUARD_DEBUG=true`). Never `console.log` from the injector — it corrupts the hook payload.
- **Fail closed**: if anything goes wrong (missing template, network failure, bad settings), the injector must write `"{}"` to stdout and `process.exit(0)`. Never throw uncaught. See existing `try`/`catch` blocks for the pattern.
- **Env var precedence**: `JFROG_URL`/`JFROG_ACCESS_TOKEN` (new) take precedence over legacy `JF_URL`/`JF_ACCESS_TOKEN`. Use the `env(newName, oldName)` helper in the injector.
- **Force flags**: `_JF_AGENT_GUARD_FORCE_DISABLE=true` short-circuits to `{}`; `JF_AGENT_GUARD_FORCE_ENABLE=true` bypasses the account-settings check. The validator relies on both — do not rename them.
- **Version bumps**: bump [plugin/.claude-plugin/plugin.json](plugin/.claude-plugin/plugin.json) and [marketplace.json](marketplace.json) together. The validator hard-fails if they diverge.

## The injected template is agent-facing code

[plugin/templates/jfrog-mcp-management.md](plugin/templates/jfrog-mcp-management.md) is not documentation — it is the prompt every downstream agent sees at session start. Treat edits like code changes:

- Keep the byte content valid and self-contained (no unresolved template variables, no links to files outside the injected string).
- The smoke test verifies byte-for-byte equality between the file on disk and the injected payload — no build step transforms it.
- Changes here alter behavior for every user who has the plugin installed on their next session; bump the plugin version.

## Skills under `plugin/skills/`

Each skill is a directory with a `SKILL.md` (YAML frontmatter + body) and optional `references/`, `scripts/`, `assets/`. When editing a skill:

- Preserve the `name`, `description`, and `metadata.role` frontmatter shape — see [plugin/skills/jfrog/SKILL.md](plugin/skills/jfrog/SKILL.md) for the canonical example.
- Skills are shipped as-is; there is no compilation. Anything you write in `SKILL.md` is what the agent reads.
- The `jfrog` skill is `role: base` (foundational); the other two are `role: workflow` and depend on it.

## Things not to do

- Do not add a `package.json`, `node_modules`, or a build/bundler pipeline. The plugin is intentionally dependency-free.
- Do not switch the injector to CommonJS. Node ≥ 14 ESM is a hard requirement.
- Do not turn `plugin/README.md` into a regular file — it is a symlink to the root [README.md](README.md).
- Do not bypass the injector's fail-closed pattern by letting exceptions surface; the hook has a 7-second timeout (see `hooks.json`) and a crash would silently break sessions for every user.
- Do not commit real JFrog credentials to fixtures or logs. The validator runs with cleared force flags precisely to avoid picking up ambient creds.
