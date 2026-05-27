#!/usr/bin/env node
// agent-guard-hook-version: 0.0.0-dev
// JFrog Ltd. — VS Code PreToolUse hook for the JFrog Agent Guard gateway.
//
// Line 2 above is a placeholder in the committed source. CI overwrites it
// with the metadata-derived version (e.g. "0.1.0" or "0.0.0-devf-1234.…")
//
//   Modes:
//   hook mode: allow / deny one tool call.
//   --register this hook in VS Code settings.json.
//   --unregister it (used by uninstall).
//   --version print the version marker on line 2.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

// Constants
const PRODUCT_NAME = "agent-guard-hook";
const FORCE_DISABLE_ENV = "_JF_AGENT_GUARD_HOOK_FORCE_DISABLE";

// Policy — the launch command we require. Anything else is DENIED.
// Example mcp.json entry that PASSES this policy:
//   "chrome-devtools-mcp": {
//     "command": "npx",
//     "args": [
//       "--yes",
//       "--registry", "https://releases.jfrog.io/artifactory/api/npm/coding-agents-npm/",
//       "@jfrog/agent-guard"
//     ]
//   }
const POLICY = {
  command: "npx",
  required_args: ["--yes", "@jfrog/agent-guard"],
  registry_arg: "--registry",
};

// Paths
const HOME = homedir();
const HOOK_SCRIPT_PATH = fileURLToPath(import.meta.url);
const HOOK_DIR = join(HOME, ".vscode", "hooks");
const HOOK_CONFIG_PATH = join(HOOK_DIR, "agent-guard-hook.json");
const HOOK_CONFIG_TILDE = "~/.vscode/hooks/agent-guard-hook.json";
const AUDIT_LOG_PATH = join(HOOK_DIR, "agent-guard-hook.log");

// VS Code's user-level config folder (settings.json + mcp.json live here).
const VSCODE_USER_DIR = (() => {
  if (platform() === "darwin") return join(HOME, "Library/Application Support/Code/User"); // macOS
  if (platform() === "win32") return join(process.env.APPDATA ?? join(HOME, "AppData/Roaming"), "Code/User"); // Windows
  return join(HOME, ".config/Code/User"); // Linux
})();
const VSCODE_SETTINGS_PATH = join(VSCODE_USER_DIR, "settings.json");

// Tool-name prefix VS Code uses for MCP tools, e.g. "mcp_chrome-devtoo_new_page".
const MCP_TOOL_PREFIX = "mcp_";


// JSONC helpers — VS Code's settings.json + mcp.json allow comments and trailing commas that plain JSON.parse rejects.
const stripJsonc = (s) =>
  s
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, comment) => (comment ? "" : m))
    .replace(/,(\s*[}\]])/g, "$1");

const parseJsonc = (s) => JSON.parse(stripJsonc(s));

const readJsoncFile = (path) => {
  try { return parseJsonc(readFileSync(path, "utf8")); } catch { return null; }
};

const atomicWrite = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    // If rename failed (permissions, antivirus lock, etc.) the staging file
    // would otherwise sit around forever. Best-effort cleanup, then rethrow.
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* swallow */ }
    throw err;
  }
};


// Audit logger — append one JSON line.
const audit = (entry) => {
  try {
    mkdirSync(dirname(AUDIT_LOG_PATH), { recursive: true });
    appendFileSync(
      AUDIT_LOG_PATH,
      JSON.stringify({ ts: new Date().toISOString(), product: PRODUCT_NAME, ...entry }) + "\n",
    );
  } catch { /* best-effort */ }
};

const readVersion = () => {
  const line = readFileSync(HOOK_SCRIPT_PATH, "utf8").split("\n", 3)[1] ?? "";
  return line.replace(/^\/\/\s*agent-guard-hook-version:\s*/, "").trim();
};


// ────────────────────────── Hook mode ──────────────────────────

const readStdinText = () =>
  new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => resolve(text));
  });


// Find every mcp.json VS Code could load.
// Order matters — `collectServers` is "first wins". User-level wins because Agent Guard's flow writes the trusted
// entry there.
const findMcpJsonFiles = (cwd) => {
  const paths = [];
  const addIfExists = (p) => { if (existsSync(p)) paths.push(p); };

  // 1. User-level mcp.json — trusted source, must win on conflict.
  addIfExists(join(VSCODE_USER_DIR, "mcp.json"));

  // 2. Workspace + ancestors — walk upward, stopping at $HOME's parent or
  // when dirname() can't go up any further (POSIX "/" or Windows "C:\").
  if (cwd) {
    let dir = resolvePath(cwd);
    const stopAt = resolvePath(HOME, "..");
    while (dir && dir !== stopAt) {
      addIfExists(join(dir, ".vscode/mcp.json"));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return paths;
};


const collectServers = (mcpJsonPaths) => {
  const serversByName = Object.create(null);
  for (const mcpJsonPath of mcpJsonPaths) {
    const mcpJson = readJsoncFile(mcpJsonPath);
    const serversInFile = mcpJson?.servers ?? {};
    for (const [serverName, serverEntry] of Object.entries(serversInFile)) {
      if (!(serverName in serversByName)) {
        serversByName[serverName] = { entry: serverEntry, sourcePath: mcpJsonPath };
      }
    }
  }
  return serversByName;
};


// Map a tool name like "mcp_chrome-devtoo_new_page" back to a server.
// VS Code sanitizes + truncates the server name, so we walk both strings
// side-by-side; the server whose prefix matches longest wins.
const findServerForTool = (toolName, serverNames) => {
  if (!toolName?.startsWith(MCP_TOOL_PREFIX)) return null;
  const toolSuffix = toolName.slice(MCP_TOOL_PREFIX.length);

  let bestName = null;
  let bestLength = 0;

  for (const serverName of serverNames) {
    const sanitized = serverName.replace(/[^A-Za-z0-9_-]/g, "_");
    const maxLen = Math.min(sanitized.length, toolSuffix.length);

    let matchedLen = 0;
    while (matchedLen < maxLen && sanitized[matchedLen] === toolSuffix[matchedLen]) matchedLen++;
    if (matchedLen === 0) continue;

    const fits = matchedLen === toolSuffix.length || toolSuffix[matchedLen] === "_";
    if (fits && matchedLen > bestLength) {
      bestName = serverName;
      bestLength = matchedLen;
    }
  }
  return bestName;
};


// Require the --registry value parses as an http(s) URL. We don't whitelist
// hostnames — on-prem and customer-owned Artifactory subdomains are legit —
// but rejecting non-URL strings catches typos and obviously bogus values.
const isHttpUrl = (value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch { return false; }
};

// Check a server's launch command against POLICY. Returns null on pass,
// or a short string saying which part of the policy failed.
const validateAgentGuard = (entry) => {
  if (!entry || entry.command !== POLICY.command) {
    return `command '${entry?.command ?? "(none)"}' must be '${POLICY.command}'`;
  }
  const args = Array.isArray(entry.args) ? entry.args : [];

  for (const required of POLICY.required_args) {
    if (!args.includes(required)) return `missing required arg '${required}'`;
  }

  const registryIdx = args.indexOf(POLICY.registry_arg);
  if (registryIdx < 0 || registryIdx === args.length - 1) {
    return `missing '${POLICY.registry_arg} <url>' pair`;
  }
  const registryValue = args[registryIdx + 1];
  if (!isHttpUrl(registryValue)) {
    return `'${POLICY.registry_arg} ${registryValue}' is not an http(s) URL`;
  }
  return null;
};


// Emit one audit-log line and exit. deny → stderr + exit 2. allow → silent exit 0.
const exitWith = ({ decision, reason, toolName = "", toolUseId = "", server = "" }) => {
  audit({ event_type: "decision", tool_use_id: toolUseId, tool_name: toolName, server, decision, reason });
  if (decision === "deny") process.stderr.write(`${PRODUCT_NAME}: ${reason}\n`);
  process.exit(decision === "deny" ? 2 : 0);
};


const hookMode = async () => {
  // Kill switch — checked FIRST, before reading stdin or parsing anything.
  const forceDisable = process.env[FORCE_DISABLE_ENV];
  if (forceDisable?.toLowerCase() === "true") {
    audit({ event_type: "force_disabled", env: FORCE_DISABLE_ENV, value: forceDisable, decision: "allow" });
    process.exit(0);
  }

  const stdinText = await readStdinText();
  let request = {};
  try { request = parseJsonc(stdinText) ?? {}; } catch { /* leave empty if not JSON */ }

  const toolName = request.tool_name ?? "";
  const toolUseId = request.tool_use_id ?? "";
  const cwd = request.cwd ?? process.cwd();

  // Non-MCP tools (run_in_terminal, read_file, …) are not our policy.
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) {
    return exitWith({ decision: "allow", reason: "non-MCP tool, out of scope", toolName, toolUseId });
  }

  const servers = collectServers(findMcpJsonFiles(cwd));
  const server = findServerForTool(toolName, Object.keys(servers));

  if (!server) {
    return exitWith({ decision: "deny", reason: "server not found in mcp.json", toolName, toolUseId });
  }

  const failure = validateAgentGuard(servers[server].entry);
  if (failure) {
    return exitWith({
      decision: "deny",
      reason: `server '${server}' does not match JFrog gateway shape (${failure})`,
      toolName, toolUseId, server,
    });
  }
  return exitWith({
    decision: "allow",
    reason: "npx + @jfrog/agent-guard + --registry <url>",
    toolName, toolUseId, server,
  });
};


// ────────────────────────── --register / --unregister ──────────────────────────

const SETTINGS_INDENT = 2;

const readSettings = () => {
  if (!existsSync(VSCODE_SETTINGS_PATH)) return {};
  try { return parseJsonc(readFileSync(VSCODE_SETTINGS_PATH, "utf8")) ?? {}; }
  catch (err) {
    process.stderr.write(`${PRODUCT_NAME}: cannot parse ${VSCODE_SETTINGS_PATH}: ${err.message}\nFix manually and rerun.\n`);
    process.exit(1);
  }
};


const withHookEntry = (current) => {
  const next = { ...current };
  const existing = next["chat.hookFilesLocations"];
  const locations = existing && typeof existing === "object" ? { ...existing } : {};
  locations[HOOK_CONFIG_TILDE] = true;
  next["chat.hookFilesLocations"] = locations;
  return next;
};

const withoutHookEntry = (current) => {
  const next = { ...current };
  const existing = next["chat.hookFilesLocations"];
  const locations = existing && typeof existing === "object" ? { ...existing } : {};
  delete locations[HOOK_CONFIG_TILDE];
  if (Object.keys(locations).length === 0) delete next["chat.hookFilesLocations"];
  else next["chat.hookFilesLocations"] = locations;
  return next;
};

const updateSettings = (transform) => {
  const currentText = existsSync(VSCODE_SETTINGS_PATH) ? readFileSync(VSCODE_SETTINGS_PATH, "utf8") : "";
  const nextText = JSON.stringify(transform(readSettings()), null, SETTINGS_INDENT) + "\n";
  if (currentText !== nextText) atomicWrite(VSCODE_SETTINGS_PATH, nextText);
};


// Write the VS Code hooks-config JSON that chat.hookFilesLocations points at.
// Skip if the file already exists with byte-identical content.
const writeHookConfig = () => {
  const payload = {
    version: 1,
    hooks: {
      PreToolUse: [{ type: "command", command: HOOK_SCRIPT_PATH }],
    },
  };
  const nextText = JSON.stringify(payload, null, 2) + "\n";
  const currentText = existsSync(HOOK_CONFIG_PATH) ? readFileSync(HOOK_CONFIG_PATH, "utf8") : "";
  if (currentText !== nextText) atomicWrite(HOOK_CONFIG_PATH, nextText);
};

// True if settings.json already has our hook-path under chat.hookFilesLocations.
const isHookRegistered = () => {
  if (!existsSync(VSCODE_SETTINGS_PATH)) return false;
  let parsed;
  try { parsed = parseJsonc(readFileSync(VSCODE_SETTINGS_PATH, "utf8")) ?? {}; }
  catch { return false; }
  const locations = parsed["chat.hookFilesLocations"];
  return !!(locations && typeof locations === "object" && locations[HOOK_CONFIG_TILDE] === true);
};

// Re-register on every install / MDM heal. Short-circuits when already
// present so we never touch settings.json after the first install.
const register = () => {
  writeHookConfig();
  if (isHookRegistered()) {
    process.stdout.write(`${PRODUCT_NAME}: already registered in ${VSCODE_SETTINGS_PATH}, no changes\n`);
    return;
  }
  updateSettings(withHookEntry);
  process.stdout.write(`${PRODUCT_NAME}: registered in ${VSCODE_SETTINGS_PATH}\n`);
};

const unregister = () => {
  if (!isHookRegistered()) {
    process.stdout.write(`${PRODUCT_NAME}: not registered, nothing to remove\n`);
    return;
  }
  updateSettings(withoutHookEntry);
  process.stdout.write(`${PRODUCT_NAME}: unregistered\n`);
};


// ────────────────────────── entrypoint ──────────────────────────

const arg = process.argv[2];
if (arg === "--register") register();
else if (arg === "--unregister") unregister();
else if (arg === "--version") process.stdout.write(readVersion() + "\n");
else {
  hookMode().catch((err) => {
    // Fail-closed: any unhandled error becomes a deny, never a bypass.
    const reason = `unexpected error: ${err?.stack ?? err?.message ?? err}`;
    audit({ event_type: "decision", server: "", decision: "deny", reason });
    process.stderr.write(`${PRODUCT_NAME}: ${reason}\n`);
    process.exit(2);
  });
}
