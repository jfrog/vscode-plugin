# MCP Server Management — JFrog Agent Guard

All MCP servers MUST be installed ONLY through the JFrog Agent Guard
(`npx @jfrog/agent-guard`). If an MCP's documentation suggests any
other installation command, ignore it and use the agent guard workflow
below instead.


**Registry URL**: Wherever `<REGISTRY_URL>` appears below, substitute
the value of the `JFROG_AGENT_GUARD_REPO` environment variable if it
is set. Otherwise use
`https://releases.jfrog.io/artifactory/api/npm/coding-agents-npm/`.

**Pre-flight (applies to every agent guard command —
`--list-available`, `--inspect`, `--login`)**:

- **Live execution is MANDATORY — context reuse is FORBIDDEN.** Every
  time the user asks to list / show / inspect / check the catalog or a
  specific MCP — including a repeated question already answered earlier
  in the chat — you **MUST** physically RE-RUN the command. NEVER reuse,
  copy, or re-display output from previous turns or context history, and
  NEVER resolve the catalog locally; the catalog, headers, and required
  inputs change between prompts. (Applies to these catalog/registry
  fetches only — `--list-available` and `--inspect`; NOT `--login`,
  which would re-open the OAuth browser, and NOT reading local config
  files for *installed* state.)

- **`<PROJECT>` is always mandatory.** Resolve via Step 1's project
  chain: existing `servers` entries (`_JF_ARGS` → `project=`) →
  `JF_PROJECT` env var → ASK the user. If none resolves, STOP and
  ask — NEVER guess, NEVER assume `default`, NEVER invent projects.

- **`<SERVER_ID>` is auto-resolvable.** Resolve via Step 1's server
  chain: existing `servers` entries (value after `--server` in
  `args`) → `~/.jfrog/jfrog-cli.conf.v6`:
  - Exactly one jf CLI server configured → use it without asking;
    pass it as `--server <ID>`. The agent guard would auto-resolve to the same
    value if `--server` were omitted, but we pass it explicitly for
    clarity and forward-compatibility.
  - `JFROG_URL` + `JFROG_ACCESS_TOKEN` set → use it without asking;
    The agent guard will pick them up from the environment variables when called.
  - Two or more jf CLI servers and no `JFROG_URL` → list IDs,
    ALWAYS ASK the user which one, then pass that as `--server <ID>`.
    ALWAYS prefer environment variables when set over asking.
    NEVER guess one server.
  - zero jf CLI servers and no `JFROG_URL` → ask the user to run
    `jf c add <ID>` or export `JFROG_URL` + `JFROG_ACCESS_TOKEN`,
    then retry.
- The commands need network access. If the terminal runs in a
  restricted/sandboxed environment, run them with full network access;
  otherwise they may fail with `Forbidden` / `403` errors.

Once both are determined, proceed. If either is still unknown,
STOP — do NOT run the command with guesses.

## Adding an MCP

**Did the user name a specific MCP package?** ("add `foo-mcp`",
"install `@scope/bar`"). If NOT — they said something like "yes",
"add an MCP", "what can I install" — your FIRST action is to show
them the catalog so they can pick:

1. Resolve server (Server ID `<SERVER_ID>` or URL `JFROG_URL`)
   and `<PROJECT>` per the Pre-flight rule at the top of this document.
   Server: auto-use the single jf CLI configs serverId as the server ID
   or the `JFROG_URL` env var as the URL if unambiguous; only ask when
   there are multiple or no jf configs and no env vars.
   Project: Ask unless `JF_PROJECT` is set, or it's already in an
   existing `servers` entry.
2. Run "Listing MCPs > Available to install" with that server +
   project and present the result as a numbered table.
3. Wait for the user to pick. Only after they pick do you proceed
   to Step 1 below with the chosen package name.

NEVER ask "which package would you like?" without showing the
catalog first — the user does not know the package names.

Once you have a specific MCP package name, do ALL of the following
autonomously — do NOT ask for project, server, or package name
unless absolutely necessary:

### Step 1: Determine project, server, and target config file

**Server ID**

1. Any existing `servers` entry in the workspace `.vscode/mcp.json` or
   the VS Code user-level MCP config (`MCP: Open User Configuration`) —
   take the value after `--server` in `args`.
2. Else `JFROG_URL` env var set (with `JFROG_ACCESS_TOKEN`) — the
   agent guard can resolve credentials from these directly;
   DO NOT pass `--server` as that would make the agent guard try to
   parse the server details from the jf cli configuration.
3. Else read `~/.jfrog/jfrog-cli.conf.v6`
   (`%USERPROFILE%\.jfrog\jfrog-cli.conf.v6` on Windows) via a
   terminal command (file-search skips hidden dirs).
   NEVER print the full file contents as it can contain secrets.
   Use the serverId subkeys:
   - exactly one server → use it without asking.
   - two or more → list the `serverId`s and ASK the user which one.
4. Else (file missing, empty, or unreadable, and no `JFROG_URL`)
   ask the user to either run `jf c add <ID>` or export
   `JFROG_URL` + `JFROG_ACCESS_TOKEN`, then retry.

NEVER try multiple servers — pick one. Once chosen: if using a jf CLI
server, always pass it explicitly as `--server <ID>` in every agent
guard invocation; if using `JFROG_URL` + `JFROG_ACCESS_TOKEN` instead,
do NOT pass `--server <ID>`.

**Project**

1. From existing `servers` entries, `_JF_ARGS` → `project=` value.
2. Else `JF_PROJECT` env var.
3. Else ask. NEVER guess, NEVER assume "default", NEVER use the server ID,
   NEVER infer the project from other sources, NEVER make up projects,
   ALWAYS ask.

**Target config file**

- **Default: `.vscode/mcp.json` in the workspace root.** Create it if
  missing (`{ "servers": {}, "inputs": [] }`). Shareable via git.
- Use the VS Code **user-level MCP config** (`MCP: Open User
  Configuration`) ONLY if the user says "globally" / "personal only" /
  "do not commit". It lives in the VS Code profile folder:
  - macOS: `~/Library/Application Support/Code/User/mcp.json`
  - Linux: `~/.config/Code/User/mcp.json`
  - Windows: `%APPDATA%\Code\User\mcp.json`

  When installing globally, write exclusively to the user-level config —
  do NOT touch the workspace `.vscode/mcp.json`.
- Do not ask which scope unless the user brings it up.

### Step 2: Inspect the MCP in the catalog

Step 2 needs a specific MCP name. If the user did NOT name one, do
not call `--inspect` — go to "Listing MCPs > Available to install"
instead, show the catalog, have them pick, then come back to Step 2
with the chosen name.

Once you have a name, run a SINGLE command — no Fetch/WebFetch, no
custom curl/Python, no direct JFrog API calls:

```
npx --yes \
  --registry <REGISTRY_URL> \
  @jfrog/agent-guard \
  --inspect \
  --server <SERVER_ID> \
  --project <PROJECT> \
  --mcp <MCP_NAME>
```

From the output JSON, extract (keep BOTH required AND optional):

- `spec.packageName` — exact package name for the config.
- `spec.mcpServerType.local.bootParams.environmentVariables[]` for
  local MCPs (each has `name`, `description`, `isRequired`, `isSecret`).
- `spec.mcpServerType.remote.endpoints[].headers[]` for remote MCPs
  (each has `name` plus `mcpInput.mcpInputDetails` with the same
  fields).

On non-zero exit (typo, MCP not in catalog, network error, etc.),
show the error verbatim, then run `--list-available` (see "Listing
MCPs") so the user can pick a valid name and retry. If the failure is
because the MCP is **not allowed in the current project**, say so
conversationally and name the project — do NOT retry against a
different project.

If the user gave a name that is NOT in the catalog (typo, near-miss),
do NOT auto-install or guess. Run `--list-available`, present the
nearest matching names, and ask the user to confirm which one they
meant before proceeding.

### Step 3: Plan inputs

You will NOT collect the input *values* here. VS Code prompts for them
the first time the server starts, using its native secure-input
mechanism, and stores them in the OS keychain (never in the file).
Step 3 only decides which inputs go into the config.

Split Step 2 inputs by `isRequired`:

1. **Required** (`isRequired=true`) — always include in Step 4. Record
   `name`, `description`, and `isSecret`.
2. **Optional** (`isRequired=false`) — if even ONE exists, STOP and
   ask. First list each required input (informational, so the user
   knows what will be added without being asked), then list each
   optional input by name + description and ask which (if any) they
   want to configure. Do NOT skip this question, do NOT include
   optional inputs by default, do NOT decide for the user. Continue to
   Step 4 only after they answer, including exactly the inputs they
   opted into.
3. No inputs at all → skip the `inputs` block in Step 4.

### Step 4: Write the config entry

Add the entry under `servers` in the target config (default
`.vscode/mcp.json` — see Step 1), and declare every input you are
configuring under the top-level `inputs` array. **Secrets MUST use
`${input:...}` substitution — never write a raw secret value into the
JSON file.**

**Identifier (`<PACKAGE_ID>` below):** for **local** MCPs use
`spec.packageName`. For **remote** MCPs there is NO `spec.packageName` —
use the catalog `name` (the install identifier from Step 2 /
`--list-available`, e.g. `com.notion/mcp`, `coralogixDemo`) for BOTH the
server key and the `mcp=` value in `_JF_ARGS`.
**Both `--yes` and `--registry <URL>` MUST come BEFORE
`@jfrog/agent-guard`** or `npx` falls back to the default
registry (404) and may block on a no-TTY prompt. Use
`"type": "stdio"` — never `"http"`, `"sse"`, or a top-level `"url"`
(those bypass the agent guard).

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "<mcp-slug>-<input-name-lowercased>",
      "description": "<description from the catalog>",
      "password": true
    }
  ],
  "servers": {
    "<PACKAGE_ID>": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "--yes",
        "--registry",
        "<REGISTRY_URL>",
        "@jfrog/agent-guard",
        "--server",
        "<SERVER_ID>"
      ],
      "env": {
        "_JF_ARGS": "project=<PROJECT>&mcp=<PACKAGE_ID>",
        "<ENV_VAR_OR_HEADER_NAME>": "${input:<mcp-slug>-<input-name-lowercased>}"
      }
    }
  }
}
```

Rules for the `inputs` block:

- One entry per env var / header you are configuring from Step 3.
- `id` is an identifier unique within the config file it lives in
  (user-level `~/.vscode/mcp.json` or workspace `.vscode/mcp.json`), in
  the form
  `<mcp-slug>-<input-name>`, all lowercase, words separated by
  hyphens. Re-use the same `id` across servers only when the value
  truly is shared.
- `type` is always `"promptString"`.
- `password: true` for secret inputs (catalog `isSecret=true`) — hides
  the characters VS Code shows while typing and stores the value
  encrypted. OMIT the `password` key entirely (never set it to `false`)
  for non-secret values like URLs or flags (VS Code still prompts, but
  does not mask the typing).
- `description` shows in the VS Code prompt — use the catalog's
  `description` field. If the catalog leaves the description as an empty
  string `""`, construct a brief context-appropriate description instead.
- Reference the input from `env` with `"${input:<id>}"`. For HTTP
  headers with a `Bearer` prefix, either put the prefix in the
  description and ask the user to include it, or use
  `"Bearer ${input:<id>}"` and ask only for the token.

VS Code substitutes every `${input:<id>}` with the stored value before
handing the env to the process — so the agent guard sees the real
value, while the file on disk shows only the placeholder.

### 4a: Start and verify the entry (mandatory)

Writing the entry to `.vscode/mcp.json` is not enough — the server has
to start and actually expose tools.

1. VS Code detects the edited `mcp.json` and offers a **Start** action
   (CodeLens above the server entry, or via `MCP: List Servers` →
   select the server → **Start Server**). Start it.
2. On first start, VS Code prompts for any `${input:...}` values
   (Step 3) using its native secure input and stores them in the OS
   keychain. Required values must be supplied or the server fails.
3. **Verify (mandatory):** open `MCP: List Servers` and confirm the
   server is **Running** AND exposes **at least one tool**. A server
   shown as Running but reporting **0 tools** ("Discovered 0 tools") is
   NOT healthy — the agent guard connected but the upstream MCP did
   not come up, so no tools were exposed. NEVER report success when
   there are 0 tools; treat 0 tools as Failed and follow Troubleshooting
   "Running but 0 tools".

### Step 5: Authenticate OAuth MCPs (auto, after Step 4)

Run ONLY for OAuth-style remote MCPs — i.e. `--inspect` showed a
`remote` section with `type: "http"` AND Step 4 wrote no `${input:...}`
auth header into `env` (no static token). Skip for local MCPs and for remote MCPs whose
auth comes from a static token configured via `inputs`.

`--login` opens the browser, runs OAuth, caches tokens in
`~/.jfrog/jfrogmcp.conf.json`. Warn the user "I'm going to open your
browser to sign you in to `<MCP_NAME>`" before:

```
npx --yes \
  --registry <REGISTRY_URL> \
  @jfrog/agent-guard \
  --login \
  --server <SERVER_ID> \
  --project <PROJECT> \
  --mcp <spec.packageName>
```

Note: `--login` launches the system browser and runs a local OAuth
callback server, so in a restricted/sandboxed environment it needs full
(unrestricted) permissions — network access alone is not enough.

Outcomes:

- **Exit 0** — OAuth completed; tokens cached; server ready.
- **`expected 401, got 200`** — MCP is anonymous (no auth needed);
  ignore.
- **Any other error** — paste it to the user verbatim and stop.

## Removing an MCP

1. Delete the entry from `servers` in the file it was installed in
   (user-level `~/.vscode/mcp.json` or workspace `.vscode/mcp.json`).
2. Delete any now-unused entries from the top-level `inputs` array —
   leave NO orphaned input entries for the removed server. For remote
   MCPs, also remove any HTTP header entries that were configured for
   it.
3. If OAuth was used (Step 5), also remove its entry from
   `~/.jfrog/jfrogmcp.conf.json` so cached login tokens are wiped.
4. Tell the user to reload (`Developer: Reload Window`) or restart the
   server from `MCP: List Servers` so the removed entry stops loading
   (the config is read at session start only).

## Listing MCPs

**Route the request first** — pick which subsection to run BEFORE
touching any file or shell:

| User said… | Run |
| --- | --- |
| "available", "what can I install", "what's in the catalog", "list MCPs" without other context | **Available to install** below — go straight to `--list-available`; do NOT inspect local files first |
| "installed", "configured", "connected", "running", "what MCPs do I have" | **Currently installed** below |
| ambiguous / both | run **both** subsections in order: Currently installed first, then Available to install, and present them as separate tables |

NEVER invent MCP integrations from outside the catalog. The only
authoritative source for what's available is `--list-available`
against the configured server + project. If that command returns
nothing or errors, say so — do not pad the answer with names from
elsewhere. If the project has zero allowed MCPs, say so conversationally
and name the project.

### Currently installed

1. Open `MCP: List Servers` for connection status (one row per
   server: Running / Stopped / Failed).
2. For JFrog metadata, read `servers` directly from BOTH the user-level
   `~/.vscode/mcp.json` and the workspace `.vscode/mcp.json` — use the
   file-read tool or a single `jq` invocation, NOT chained
   `python3 -c "..."` pipes. For each entry whose `command` is `npx`
   and whose `args` include `@jfrog/agent-guard`, show: display name
   (the JSON key), package (`mcp=` in `_JF_ARGS`), server ID (value
   after `--server`), scope (workspace / user), and its installed
   status. Your output should structurally mirror the config.
3. If a configured entry does not appear in `MCP: List Servers`, it
   was never started — re-run Step 4a.

### Available to install

1. Determine **server** and **project** per the Pre-flight rule at
   the top of this document. `--list-available` does NOT require
   any existing `servers` entry or pre-installed agent guard —
   `npx --yes` fetches the agent guard on demand, so this works on a
   fresh machine too.
2. Run EXACTLY this command — `--project` is passed as a CLI flag.
   To configure the server, either use the serverId from a jf cli
   config with `--server` or omit `--server` if env vars are used to
   configure URL and Access Token. **no additional env vars needed**:

```
npx --yes \
  --registry <REGISTRY_URL> \
  @jfrog/agent-guard \
  --list-available \
  --project <PROJECT> \
  [--server <SERVER_ID>]
```

The output is a compact TSV: a header line, then one server per line,
tab-separated: `name<TAB>type<TAB>version<TAB>description`.
Run the command ONCE and present the rows directly as a numbered
table — do NOT re-run it, redirect it, or parse it with `python3`/`jq`.
The `name` column is the install identifier (the value you pass to
`--inspect --mcp` and to install); `packageName` is NOT a separate
column — for remote/http MCPs there is no package name, so `name` is
the display name.

3. Filter out any `name` already present in the installed list
   (compare against `mcp=` in `_JF_ARGS`). Present the available
   (not-yet-installed) MCPs, and also show which ones are already
   installed so the user has the full picture.

## Key Rules

- **Package scope is case-sensitive — ALWAYS write it lowercase as
  `@jfrog/agent-guard`, NEVER `@JFrog/agent-guard`.** npm scopes are
  case-sensitive; the published package is the lowercase
  `@jfrog/agent-guard`. Capitalizing the brand (`@JFrog`) points at a
  different/nonexistent scope and breaks the command. Use the exact
  lowercase string in every command and config entry.
- **`npx` arg order:** `--yes`, `--registry <URL>`,
  `@jfrog/agent-guard`, then agent guard flags. Both `--yes` and
  `--registry` MUST precede the package name or `npx` falls back to
  the default registry (404) and may block on a no-TTY prompt.
- **Always `"type": "stdio"`** pointing at `npx @jfrog/agent-guard`,
  even for remote-only catalog MCPs (the agent guard proxies them).
  `"http"`, `"sse"`, or a top-level `"url"` bypass the agent guard and
  trigger VS Code's native remote-MCP OAuth dialog instead of using the
  configured `${input:...}` secret.
- `_JF_ARGS` is **only** for the entry VS Code launches at session
  start (Step 4's `servers.*.env`); MUST contain
  `project=<NAME>&mcp=<PACKAGE_NAME>`. NEVER pass `_JF_ARGS` to
  `--list-available`, `--inspect`, or `--login` — those take
  `--server` / `--project` as CLI flags only.
- NEVER assume `default` as a project name. If the project is unknown
  after Step 1's chain (existing `servers` entries → `JF_PROJECT`
  env var), STOP and ask the user. Same for server ID if used.
  NEVER invent or guess projects or server IDs.
- Package name MUST come from the catalog (`--inspect` /
  `--list-available`). NEVER guess. NEVER install MCPs outside the
  agent guard. NEVER use Fetch/WebFetch for catalog calls.
- NEVER pipe a catalog command through `python3`, and NEVER capture it
  with `2>&1` — `npx`/`npm` writes progress to stderr, which corrupts
  the output stream. For `--list-available` present the compact TSV it
  prints; for `--inspect` read the JSON it prints on stdout
  directly (or with a single `jq` filter), never via `python3`.
- NEVER write a raw secret into `.vscode/mcp.json` — always use an
  `${input:<id>}` reference. NEVER show tokens / API keys.
- NEVER try multiple servers — ask the user to pick one.

## Troubleshooting

- **Running but 0 tools (`MCP: List Servers` shows the server Running
  but it reports "Discovered 0 tools")** — agent guard proxy started,
  upstream MCP did not. The Running label is misleading here. NEVER
  report success when there are 0 tools.
  1. In `MCP: List Servers`, right-click the server and choose **Show
     Output**; read the last ~50 lines of agent guard stderr before
     guessing, then diagnose by MCP type:
     - **OAuth (remote)** — re-run Step 5 (`--login`); refresh token
       likely expired.
     - **Static-token (remote)** — confirm the `${input:...}` value is
       set (re-prompt via the **Clear** CodeLens, then restart) and the
       token is still valid.
     - **Local (stdio)** — check that the bundled binary actually
       launched (agent guard stderr will show the spawn error).
  2. Verify that the mcp server is still allowed.
     See "Listing MCPs > Available to install".
- **`.vscode/mcp.json` server missing from `MCP: List Servers`** —
  never started, or a JSON parse failure (often an undefined
  `${input:...}` id). Fix the config and re-run Step 4a.
- **HTTP 401 / 403 on a server with `${input:...}`** — the stored
  secret is wrong. Tell the user to click the **Clear** CodeLens above
  the matching `inputs` entry in `.vscode/mcp.json`, then restart the
  server; VS Code re-prompts for the secret.
- **Agent Guard: `multiple/no JFrog server configured`** (the agent guard
  cannot pick a JFrog server) — pass `--server <ID>` (after
  `jf c add <SERVER_ID>`) OR export both `JFROG_URL` and
  `JFROG_ACCESS_TOKEN` in the launching shell, then reload VS Code.
- **OAuth MCP failing / `invalid_grant` / `No such refresh token`** —
  refresh token expired; re-run Step 5.
- **Network / proxy / DNS error** — outside the agent guard's scope;
  tell the user and stop.
- **npx package fetch returns 403 in-agent** — often a network
  sandbox/egress policy. Run with full network access. If it still
  fails, troubleshoot registry/auth/package/curation policy as usual.
