# jfrog-mcp-gate

A VS Code `PreToolUse` hook that allows only MCP tool calls whose server is launched through the JFrog gateway (`npx --yes --registry <…jfrog…> @jfrog/agent-guard …`). Everything else is denied.

Ships from `releases.jfrog.io/artifactory/jfrog-cli-plugins/jfrog-mcp-gate/` (the same trust boundary the hook itself enforces).

### Platform support

The hook code (`bin/*.mjs`, `lib/config.mjs`) is plain Node ≥ 20 and runs on every platform. Only the installer and the per-user service flavor change per OS.

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Hook code | yes | yes | yes |
| Installer | `install.sh` | `install.sh` (same script, auto-detects `uname`) | `install.ps1` (elevated PowerShell) |
| Per-user service | LaunchAgent | `systemd --user` timer (`OnBootSec=10s, OnUnitActiveSec=60s`) | Scheduled Task (at logon + every 1 min) |
| Install root | `/usr/local/jfrog/mcp-gate/` | `/usr/local/jfrog/mcp-gate/` | `%ProgramFiles%\JFrog\mcp-gate\` |
| Audit log | `/var/log/jfrog-mcp-gate.log` (0666) | `/var/log/jfrog-mcp-gate.log` (0666) | `%ProgramData%\JFrog\Logs\jfrog-mcp-gate.log` (Users:Modify) |
| Setup-tick logs | `/Library/Logs/jfrog-mcp-gate/setup.*.log` | `journalctl --user -u jfrog-mcp-user-setup.service` | Task Scheduler history |
| Per-user state | `~/.jfrog/mcp-gate/` | `~/.jfrog/mcp-gate/` | `%USERPROFILE%\.jfrog\mcp-gate\` |
| ChatHooks policy | `com.jfrog.mcp-gate.mobileconfig` | `/etc/vscode/policy.json` | `HKLM\Software\Policies\Microsoft\VSCode\ChatHooks` (Group Policy / Intune) |

> **Anti-tamper**: The hook config and settings.json entry are heal-on-tick — if a user deletes them the per-user scheduler restores them within ≤60s and writes an `event_type=reseed` audit line. The hook binary itself sits in a root-owned install root that requires sudo/admin to modify; MDM heals that on its check-in.

## How the pipeline works

```
   engineer machine                 GitHub                       entplus.jfrog.io                            releases.jfrog.io                    laptop
   ─────────────────                ──────                       ────────────────                            ─────────────────                    ──────
   edit code + VERSION
   → git push                    PR build (optional)             ─                                           ─                                    ─
                                 ↓
                                 merge to main
                                 ↓
                                 merge-mcp-gate-dev.yml      →   dev-master-generic-local/                   ─                                    ─
                                 (fires automatically)           jfrog-mcp-gate/v<VER>-dev.<run>/
                                                                 mcp-gate-<VER>-dev.<run>.tgz
                                                                 (engineers can pull this for staging tests)

                                 release-mcp-gate.yml        →   dev-master-generic-local/...                jfrog-cli-plugins/                   IT's MDM re-runs
                                 (manual: bump VERSION,          → release bundle promote                    jfrog-mcp-gate/v<VER>/                install.sh on its
                                  click "Run workflow")          → distribute to edges                       mcp-gate-<VER>.tgz                   schedule and pulls
                                                                                                             + install.sh, uninstall.sh,          the new version
                                                                                                             LATEST, .mobileconfig
```

Two workflows:

| Workflow | Trigger | Lands on |
| --- | --- | --- |
| `merge-mcp-gate-dev.yml` | Every merge to `main` | entplus dev master generic (`dev-master-generic-local/jfrog-mcp-gate/v<VER>-dev.<run>/`) |
| `release-mcp-gate.yml` | Manual (`workflow_dispatch`) | `releases.jfrog.io/jfrog-cli-plugins/jfrog-mcp-gate/v<VER>/` and the top-level `install.sh` / `uninstall.sh` / `LATEST` / `.mobileconfig` |

Until JFrog CI infra onboards the repo, `poc/release.sh` is the local-engineer fallback (uses `jf rt upload` directly).

## Files in this repo

### Top level — what IT and laptops consume

| File | Owner | Purpose |
| --- | --- | --- |
| `install.sh` | IT, MDM (macOS + Linux). Engineers locally. | Auto-detects `uname` and dispatches macOS vs. Linux. Default: download the latest install package (`mcp-gate-<VER>.tgz`) from Artifactory. With `--package <path>`: install from a local `.tgz` file (engineer testing). |
| `uninstall.sh` | IT, support (macOS + Linux) | Removes everything `install.sh` wrote + per-user state for the logged-in user. Audit log preserved. |
| `install.ps1` | IT, MDM (Windows). Engineers locally. | PowerShell equivalent of `install.sh`. Must be run from an elevated PowerShell. Same `-Package` flag for local testing. |
| `uninstall.ps1` | IT, support (Windows) | PowerShell equivalent of `uninstall.sh`. |
| `com.jfrog.mcp-gate.mobileconfig` | IT, MDM (macOS only) | macOS configuration profile. Sets `ChatHooks=true` so users can't disable VS Code hooks. Pushed via Jamf/Intune/Munki. |
| `VERSION` | Engineer | The only metadata you edit when cutting a release. |
| `.jfrog-distribution.yml` | CI | Required by `JFROG/next-gen-ci-distribution` in the release workflow. Lists the artefacts to bundle into a release bundle and push to the edge. |

### `bin/` — the binaries that get installed

| File | Purpose |
| --- | --- |
| `bin/jfrog-mcp-gate.mjs` | **The hook.** VS Code spawns it with a `PreToolUse` payload on every chat tool call. Reads `mcp.json`, validates the launch command against `lib/config.mjs`, exits `0` (allow) or `2` (deny). No flags — the hook is a pure stdin→exit-code program. |
| `bin/jfrog-setup-user.mjs` | **Per-user setup.** Run by the per-user service at login + every 60s. Writes `~/.jfrog/mcp-gate/vscode-hooks.json`, adds the `chat.hookFilesLocations` entry to `settings.json`, applies macOS locks. One flag: `--clean` (reverse of a tick — used by uninstallers). |

### `lib/` — the shared module

| File | Purpose |
| --- | --- |
| `lib/config.mjs` | Single shared module: policy (`POLICY`), OS-specific paths, hook-config payload, JSONC helpers, audit logger. Both binaries import only this file. |

### `poc/` — engineer-local fallback (delete once CI infra is in place)

| File | Purpose |
| --- | --- |
| `poc/release.sh` | Builds the install package (`mcp-gate-<VER>.tgz`) and `jf rt upload`s it to `JFROG_MCP_GATE_REPO` (default `jfrog-cli-plugins/jfrog-mcp-gate`). Same outputs as the GH Action — produces `dist/mcp-gate-<VER>.tgz` and `dist/LATEST`. Supports `--dry-run` to build the file without uploading. |

### `.github/workflows/` — at the repo root

| File | Purpose |
| --- | --- |
| `merge-mcp-gate-dev.yml` | Auto-publishes the dev install package (`mcp-gate-<VER>-dev.<run>.tgz`) to entplus dev master generic on every merge to main. |
| `release-mcp-gate.yml` | Manual-trigger production release. Pre-Build → Build & Upload → Post-Build (release bundle + promote) → Distribute → Promote-Latest. |

## What gets installed on each laptop

### macOS

Root-owned (by `install.sh`):

```
/usr/local/jfrog/mcp-gate/bin/jfrog-mcp-gate.mjs       the hook
/usr/local/jfrog/mcp-gate/bin/jfrog-setup-user.mjs     per-user setup
/usr/local/jfrog/mcp-gate/lib/config.mjs               policy + helpers
/usr/local/jfrog/mcp-gate/VERSION
/Library/LaunchAgents/com.jfrog.mcp-user-setup.plist
/var/log/jfrog-mcp-gate.log                            audit log (0666)
```

MDM-pushed (from `.mobileconfig`):
`/Library/Managed Preferences/com.microsoft.VSCode.plist` → `ChatHooks=true`.

Per-user state (heal-on-tick by the LaunchAgent every 60s):

```
~/.jfrog/mcp-gate/vscode-hooks.json
chat.hookFilesLocations entry in ~/Library/Application Support/Code/User/settings.json
```

### Linux

Root-owned (by `install.sh`):

```
/usr/local/jfrog/mcp-gate/...                            same layout as macOS
/etc/systemd/user/jfrog-mcp-user-setup.service           per-user oneshot
/etc/systemd/user/jfrog-mcp-user-setup.timer             OnBootSec=10s, OnUnitActiveSec=60s
/var/log/jfrog-mcp-gate.log                              audit log (0666)
```

MDM-pushed: `/etc/vscode/policy.json` containing `{"ChatHooks": true}`.

Per-user state (no kernel-level lock):

```
~/.jfrog/mcp-gate/vscode-hooks.json
chat.hookFilesLocations entry in ~/.config/Code/User/settings.json
```

### Windows

Admin-owned (by `install.ps1`):

```
%ProgramFiles%\JFrog\mcp-gate\bin\jfrog-mcp-gate.mjs       the hook
%ProgramFiles%\JFrog\mcp-gate\bin\jfrog-setup-user.mjs     per-user setup
%ProgramFiles%\JFrog\mcp-gate\lib\config.mjs               policy + helpers
%ProgramFiles%\JFrog\mcp-gate\VERSION
Scheduled Task "JFrogMcpUserSetup"                          at logon + every 1 min
%ProgramData%\JFrog\Logs\jfrog-mcp-gate.log                 audit log (Users:Modify)
```

MDM-pushed: `HKLM\Software\Policies\Microsoft\VSCode\ChatHooks` (REG_DWORD, 1) — via Group Policy / Intune.

Per-user state (no kernel-level lock):

```
%USERPROFILE%\.jfrog\mcp-gate\vscode-hooks.json
chat.hookFilesLocations entry in %APPDATA%\Code\User\settings.json
```

## Demo outcomes

The hook walks every `mcp.json` VS Code can load (user profile + workspace + ancestor `.vscode/mcp.json`) and validates each launch command against `lib/config.mjs`.

| Demo case | Expected outcome |
| --- | --- |
| MCP through the gateway: `npx --yes --registry <any-url> @jfrog/agent-guard …` | **ALLOW**, audit reason `npx + @jfrog/agent-guard + --registry <url>`. |
| MCP launched outside the gateway: `"command": "node"` | **DENY**, audit reason `… (command 'node' must be 'npx')`. |
| MCP with the old `@jfrog/mcp-gateway` | **DENY**, audit reason `… (missing required arg '@jfrog/agent-guard')`. |
| Extension-registered MCP (e.g. bundled PostgreSQL MCP) | **DENY**, audit reason `server not found in mcp.json - extension-registered MCPs are not gateway-served`. |
| Non-MCP tools (`run_in_terminal`, `read_file`) | **ALLOW**, audit reason `non-MCP tool, out of scope`. |

## Enforcement

| Bypass attempt | Outcome |
| --- | --- |
| User sets `chat.useHooks=false` | MDM `ChatHooks=true` policy overrides. |
| User deletes `chat.hookFilesLocations` from `settings.json` | Setup-user re-adds it ≤60s (`event_type=reseed`). |
| User `rm ~/.jfrog/mcp-gate/vscode-hooks.json` | Works once; setup-user rewrites it on the next tick (≤60s). |
| User deletes the hook binary in `/usr/local/jfrog/…` (or Windows equivalent) | Requires sudo/admin. MDM reruns `install.sh` on next check-in. |
| User unloads the LaunchAgent / disables the Scheduled Task / stops the timer | Requires sudo/admin. MDM re-registers it on next check-in. |

## Audit log

Every decision is one JSON line in `/var/log/jfrog-mcp-gate.log`. Fields: `ts`, `product`, `version`, `event_type` (`decision` / `reseed` / `setup_user_tick`), `tool_use_id`, `tool_name`, `server`, `decision` (`allow` / `deny`), `reason`.

```sh
tail -f /var/log/jfrog-mcp-gate.log | jq -c 'select(.event_type=="decision")'
```

## Adjusting the policy

`lib/config.mjs` is the single source of truth:

```js
export const POLICY = {
  command:       "npx",
  required_args: ["--yes", "@jfrog/agent-guard"],
  registry_arg:  "--registry",
};
```

We require the `--registry <url>` pair (Agent Guard can't run without
it) but we don't restrict the URL value — different customers point at
different repos.

After editing, bump `VERSION` and trigger the release workflow.

---

## Three flows

### Flow 1 — test it locally in VS Code (engineer)

Six steps. Same `install.sh` IT runs in production, just pointed at a locally-built `.tgz` file instead of Artifactory.

```sh
cd /Users/yanivt/Jfrog/vscode-plugin/mcp-gate

# 1. Clean slate (remove any previous install, including locks).
sudo ./uninstall.sh

# 2. Build the install package. Produces dist/mcp-gate-<VERSION>.tgz.
./poc/release.sh --dry-run

# 3. Install from that local package. You'll be asked for your sudo password.
sudo ./install.sh --package dist/mcp-gate-0.1.0.tgz

# 4. In a second terminal, watch the audit log:
tail -f /var/log/jfrog-mcp-gate.log | jq -c 'select(.event_type=="decision")'

# 5. Open VS Code → Copilot Chat → trigger MCP tool calls:
#    - Allowed: any MCP server you've configured to launch via
#               "command": "npx", "args": ["--yes", "--registry",
#               "<any-url>", "@jfrog/agent-guard", ...]
#    - Denied:  anything else (extension-registered MCP, "command": "node",
#               missing "--registry <url>" pair, missing @jfrog/agent-guard).

# 6. Tamper test (verifies the heal-on-tick scheduler works):
rm ~/.jfrog/mcp-gate/vscode-hooks.json
# Within 60s the LaunchAgent rewrites the file and writes
# `event_type=reseed` to the audit log.

# 7. Clean up when done.
sudo ./uninstall.sh
```

Quick smoke without going through VS Code — feed the hook a fake VS Code payload:

```sh
echo '{"tool_name":"mcp_chrome-devtools-mcp_new_page","cwd":"'$PWD'"}' \
  | node bin/jfrog-mcp-gate.mjs && echo "ALLOW" || echo "DENY"
tail -1 /var/log/jfrog-mcp-gate.log | jq .
```

### Flow 2 — release a new version (engineer)

```sh
# 1. (Optional) Edit code, e.g. tweak the policy in lib/config.mjs.
# 2. Bump VERSION (the only metadata you change).
echo "0.1.1" > mcp-gate/VERSION
# 3. Commit + push.
git commit -am "mcp-gate: 0.1.1 - widen registry regex"
git push
```

What happens automatically and what's manual:

- **On merge to `main`** → `merge-mcp-gate-dev.yml` fires. Publishes `mcp-gate-0.1.1-dev.<run>.tgz` to entplus dev master generic. Engineers can pull from there for staging tests.
- **Manual when ready to ship** → GitHub → Actions → `Release jfrog-mcp-gate` → Run workflow (`promote_to_latest: true`). Ships `0.1.1` to `releases.jfrog.io/jfrog-cli-plugins/jfrog-mcp-gate/v0.1.1/` and refreshes the top-level files IT downloads.

POC fallback (only until CI infra is onboarded):

```sh
cd mcp-gate
./poc/release.sh --dry-run    # build only
./poc/release.sh              # actually push to JFROG_MCP_GATE_REPO via `jf`
```

### Flow 3 — deploy to N laptops (IT)

Two steps per laptop, wrapped by Jamf/Intune/Munki/Group-Policy. **The OS-specific bit is only the policy push + the one-liner**; the rest (Artifactory, versioning, rollback) is identical across all three.

#### macOS

```sh
# 1. Push com.jfrog.mcp-gate.mobileconfig via Jamf/Intune (sets ChatHooks=true).
# 2. Run the installer (typically scheduled to re-run every 30 min).
curl -sSfL https://releases.jfrog.io/artifactory/jfrog-cli-plugins/jfrog-mcp-gate/install.sh \
  | sudo bash
```

#### Linux

```sh
# 1. Write the ChatHooks=true VS Code policy.
sudo install -m 0644 /dev/stdin /etc/vscode/policy.json <<<'{"ChatHooks": true}'
# 2. Run the installer (same script auto-detects Linux).
curl -sSfL https://releases.jfrog.io/artifactory/jfrog-cli-plugins/jfrog-mcp-gate/install.sh \
  | sudo bash
```

#### Windows

```powershell
# 1. Push ChatHooks=1 via Group Policy (preferred) or directly:
reg add HKLM\Software\Policies\Microsoft\VSCode /v ChatHooks /t REG_DWORD /d 1 /f
# 2. Run the installer from an elevated PowerShell.
iwr -useb https://releases.jfrog.io/artifactory/jfrog-cli-plugins/jfrog-mcp-gate/install.ps1 | iex
```

#### Common to all three

Updates are automatic — each re-run reads `/LATEST` from Artifactory and reinstalls only if the version changed. To roll back or stage a specific build, download the `.tgz` directly and pass `--package`:

```sh
# macOS + Linux — pin to v0.1.0
curl -sSfLO https://releases.jfrog.io/artifactory/jfrog-cli-plugins/jfrog-mcp-gate/v0.1.0/mcp-gate-0.1.0.tgz
sudo ./install.sh --package ./mcp-gate-0.1.0.tgz

# Windows — same idea
iwr -useb https://releases.jfrog.io/artifactory/jfrog-cli-plugins/jfrog-mcp-gate/v0.1.0/mcp-gate-0.1.0.tgz -OutFile mcp-gate-0.1.0.tgz
.\install.ps1 -Package .\mcp-gate-0.1.0.tgz
```

Uninstall a laptop:

```sh
# macOS + Linux
curl -sSfL https://releases.jfrog.io/artifactory/jfrog-cli-plugins/jfrog-mcp-gate/uninstall.sh \
  | sudo bash

# Windows (elevated PowerShell)
iwr -useb https://releases.jfrog.io/artifactory/jfrog-cli-plugins/jfrog-mcp-gate/uninstall.ps1 | iex
```

Dev install packages live under `entplus.jfrog.io/.../dev-master-generic-local/jfrog-mcp-gate/v<VER>-dev.<N>/`. To stage one, download the `.tgz` from there and pass `--package`/`-Package` as above.

## Prerequisites

- macOS (Apple Silicon or Intel), Linux with systemd, or Windows 10+.
- VS Code ≥ 1.109 (`ChatHooks` enterprise policy shipped in 1.109).
- Node.js ≥ 20 on `PATH` (`node.exe` on Windows).
- macOS: nothing extra. Linux: `tar`, `curl`, `systemd --user`. Windows: PowerShell 5.1+ (or PowerShell 7), `tar.exe` (ships with Windows 10+).

## Deferred

- **Filesystem-level anti-tamper.** Today the user-level files (`~/.jfrog/mcp-gate/vscode-hooks.json` and the `chat.hookFilesLocations` entry in `settings.json`) are healed by the per-user scheduler every 60s, so a deletion only opens a ≤60s bypass window. Adding `chflags uchg` (macOS), `chattr +i` (Linux), or NTFS DENY ACLs would slow casual tampering, but each would require root/admin to apply, which a user-mode setup process can't do — so the heal-on-tick model is the cross-platform defense.
- **Non-default VS Code profiles.** The hook scans only the default profile's `mcp.json` (`<user-dir>/mcp.json`) plus workspace `.vscode/mcp.json` files. If a user creates a named profile (`<user-dir>/profiles/<name>/mcp.json`) and runs MCP servers from it, those servers won't be found → all their tool calls get denied. Rare in practice; we'll wire up profile discovery if it bites someone.
- **Validated on real Linux + Windows boxes.** The installers were authored on macOS. Linux + Windows runs need a smoke test pass before IT picks them up.
- **Signed `.pkg` (macOS) and signed `.msi` (Windows).** Today's distribution is the raw `.tgz` install package + the shell/PowerShell scripts; signed installer bundles are the natural next step once CI infra is in place.
