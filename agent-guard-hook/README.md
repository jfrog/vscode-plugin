# JFrog Agent Guard Hook (VS Code)

A VS Code PreToolUse hook that blocks MCP tool calls unless the server is
launched through JFrog's Agent Guard gateway. User-space install, single
file, no sudo, MDM-deployable.

> **Status**: pre-release. The package is shipped via the JFrog Agent Guard
> distribution channel (`coding-agents-generic`) — same family as
> `@jfrog/agent-guard`.

---

## Install

### One-liner (what IT runs)

```bash
# macOS / Linux
curl -fsSL https://releases.jfrog.io/artifactory/coding-agents-generic/agent-guard-hook/install.mjs | node

# Windows (PowerShell)
iwr -useb https://releases.jfrog.io/artifactory/coding-agents-generic/agent-guard-hook/install.mjs | node
```

---

## Idempotent updates

The hook script carries its version on line 2:

```js
#!/usr/bin/env node
// agent-guard-hook-version: 0.1.0
```

When MDM re-runs `install.mjs` periodically, the script reads that line on
the locally installed file, compares it to the staged archive, and skips
the file copy if they match. The `--register` step always runs so the
registration in `settings.json` is re-asserted on every tick.

---

## Hook policy

A tool call `mcp_<server>_<tool>` is **allowed** only if the matching server
in `mcp.json` has all of:

- `"command": "npx"`
- `"args"` contains `"--yes"` AND `"@jfrog/agent-guard"`
- `"args"` contains `"--registry <some-url>"` where the value parses as an
  `http://` or `https://` URL.
  on-prem Artifactory remotes both pass.

Anything else passed through `args` after `@jfrog/agent-guard` (and the `env`
block) is the guard's concern, not the hook's.

Anything else (different command, missing flags, no matching server) is
**denied** with exit code 2 and a one-line stderr message; VS Code surfaces
this in the chat UI.

Example `mcp.json` entry that passes:

```jsonc
{
  "servers": {
    "chrome-devtools-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "--yes",
        "--registry", "https://releases.jfrog.io/artifactory/api/npm/coding-agents-npm/",
        "@jfrog/agent-guard"
      ],
      "env": {
        "_JF_MCP_LOADER_ARGS": "project=nadav2&mcp=chrome-devtools-mcp"
      }
    }
  }
}
```

---

## Audit log format

`~/.vscode/hooks/agent-guard-hook.log` is append-only, one JSON object per line.

Allow / deny:

```jsonc
{"ts":"2026-05-27T08:14:00Z","product":"agent-guard-hook","event_type":"decision","tool_use_id":"abc-1","tool_name":"mcp_chrome-devtoo_new_page","server":"chrome-devtools-mcp","decision":"allow","reason":"npx + @jfrog/agent-guard + --registry <url>"}
{"ts":"2026-05-27T08:14:05Z","product":"agent-guard-hook","event_type":"decision","tool_use_id":"abc-2","tool_name":"mcp_postgres_query","server":"postgres","decision":"deny","reason":"server 'postgres' does not match JFrog gateway shape (command 'docker' must be 'npx')"}
```

Tail with `tail -f ~/.vscode/hooks/agent-guard-hook.log`.

---

## CI pipeline

One workflow: `.github/workflows/agent-guard-hook-ci.yml`.

| Trigger | What it does |
| --- | --- |
| pull_request → `main` | Validation only. Runs `pre-build` + `build-and-upload`'s local steps (sed-inject + tar) so a broken build fails the PR check. **No Artifactory write.** |
| push to `main` (after merge) | Dev build — versioned archive uploaded to the internal dev Artifactory repo for soak testing. **Not distributed to `releases.jfrog.io`.** |
| workflow_dispatch with `build-type: release` | Full release — uploaded to the release repo, release bundle promoted, mirrored to `releases.jfrog.io`, copied into `latest/`. Run this manually when the dev build has been verified. |
| Feature-branch pushes (no PR) | Nothing — the workflow is gated on `main` pushes and pull_requests only. |

Jobs run in order: `pre-build` → `build-and-upload` → `post-build` →
`distribution` (release only) → `promote-latest` (release only).
On PR runs everything after `build-and-upload`'s local steps is skipped.

### Cutting a release

1. Merge the change to `main`. CI fires a dev build automatically; the archive lands in the internal dev Artifactory repo (`dev-main-generic-local`) with a version like `0.1.1-devf-…`.
2. Soak-test the dev archive however internal QA verifies (the dev `install.mjs` and `.tgz` are reachable from the internal dev Artifactory repo).
3. Go to **GitHub Actions → "agent-guard-hook CI" → Run workflow** and pick `build-type: release`. The version is computed by `pre-build` from the existing git tags (e.g. previous tag `agent-guard-hook/v0.1.0` → next is `v0.1.1`) and `sed`-injected into line 2 of `agent-guard-hook.mjs` during the build.
4. Verify the run; the `promote-latest` job is the last step.
5. `install.mjs` now resolves the new version through the `LATEST` file on `releases.jfrog.io`.

### Local engineer release (before CI is wired up)

```bash
cd agent-guard-hook
./poc/release.sh --dry-run     # preview
./poc/release.sh               # for real (needs `jf` logged in)
```

---

## File layout in this repo

```
agent-guard-hook/
├── agent-guard-hook.mjs                     the hook (this is what ships to laptops)
├── install.mjs                              cross-platform installer
├── com.jfrog.agent-guard-hook.mobileconfig  MDM payload: locks ChatHooks=true in VS Code
├── .jfrog-distribution.yml                  artifacts list for the distribution step
├── poc/release.sh                           engineer-local release fallback
└── README.md                                this file
```
