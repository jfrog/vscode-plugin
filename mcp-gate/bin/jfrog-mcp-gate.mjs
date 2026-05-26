#!/usr/bin/env node
// jfrog-mcp-gate — VS Code PreToolUse hook.
//
// On every chat tool call, VS Code spawns this script, pipes a JSON
// payload into its stdin, and reads our exit code:
//     exit 0  =  allow the tool call
//     exit 2  =  deny  the tool call
//
// What this script does:
//   Step 1.  Read VS Code's payload from stdin.
//   Step 2.  Find every mcp.json VS Code could load
//            (user-level + workspace + ancestor folders).
//   Step 3.  Merge them into one server list (user-level wins on conflict).
//   Step 4.  Figure out which server the tool call came from.
//   Step 5.  Validate that server's launch command against the policy.
//   Step 6.  Write one audit-log line and exit.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";

import {
  POLICY,
  PRODUCT_NAME,
  VSCODE_USER_DIR,
  audit,
  parseJsonc,
} from "../lib/config.mjs";

// Constants
const HOME            = homedir();
const MCP_TOOL_PREFIX = "mcp_";


// Step 1. Read VS Code's JSON payload from stdin.
const readStdinText = () =>
  new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end",  () => resolve(text));
  });


// Step 2. Find every mcp.json VS Code could load.
// Order matters — `collectServers` below is "first wins". We list the user-level mcp.json FIRST because Agent Guard's
// flow writes the trusted server entry there, and we want that entry to be the one we validate against
// `cwd` is the workspace folder VS Code told us about. After the user-level file we walk upward from `cwd` toward
// $HOME, picking up any `.vscode/mcp.json` along the way.
const findMcpJsonFiles = (cwd) => {
  const paths = [];
  const addIfExists = (p) => { if (existsSync(p)) paths.push(p); };

  // 1. User-level mcp.json — trusted source, must win on conflict.
  addIfExists(join(VSCODE_USER_DIR, "mcp.json"));

  // 2. Workspace + ancestors — walk upward until we hit $HOME or "/".
  if (cwd) {
    let dir          = resolvePath(cwd);
    const stopAt     = resolvePath(HOME, "..");
    while (dir && dir !== "/" && dir !== stopAt) {
      addIfExists(join(dir, ".vscode/mcp.json"));
      const parent = dirname(dir);
      if (parent === dir) break;          // reached filesystem root
      dir = parent;
    }
  }
  return paths;
};


// Read + parse a JSONC file. Returns null on any error so the caller
// can skip an unparseable mcp.json without crashing the hook.
const readMcpJson = (path) => {
  try { return parseJsonc(readFileSync(path, "utf8")); } catch { return null; }
};


// Step 3. Merge all servers from the found mcp.json files into one dict. "First wins": if two mcp.json files both
// define a server named "chrome", the FIRST one in `mcpJsonPaths` takes priority. Because Step 2 puts the user-level
// mcp.json first, the user-level entry wins over any workspace override
const collectServers = (mcpJsonPaths) => {
  const serversByName = Object.create(null);
  for (const mcpJsonPath of mcpJsonPaths) {
    const mcpJson       = readMcpJson(mcpJsonPath);
    const serversInFile = mcpJson?.servers ?? {};
    for (const [serverName, serverEntry] of Object.entries(serversInFile)) {
      if (!(serverName in serversByName)) {
        serversByName[serverName] = { entry: serverEntry, sourcePath: mcpJsonPath };
      }
    }
  }
  return serversByName;
};


// Step 4. Tool name → server name.
// VS Code tool names look like:  "mcp_<sanitized-and-truncated-server>_<tool>"
// e.g.  server "chrome-devtools-mcp"  →  tool "mcp_chrome-devtoo_new_page"
// We walk both strings side-by-side until they diverge; the server whose
// prefix matches the longest stretch of the tool name wins.
const findServerForTool = (toolName, serverNames) => {
  if (!toolName?.startsWith(MCP_TOOL_PREFIX)) return null;
  const toolSuffix = toolName.slice(MCP_TOOL_PREFIX.length);

  let bestName   = null;
  let bestLength = 0;

  for (const serverName of serverNames) {
    const sanitized = serverName.replace(/[^A-Za-z0-9_-]/g, "_");
    const maxLen    = Math.min(sanitized.length, toolSuffix.length);

    // Count how many leading chars match.
    let matchedLen = 0;
    while (matchedLen < maxLen && sanitized[matchedLen] === toolSuffix[matchedLen]) matchedLen++;
    if (matchedLen === 0) continue;

    // Right after the match the tool name must be "_" (separator) or end.
    const fits = matchedLen === toolSuffix.length || toolSuffix[matchedLen] === "_";
    if (fits && matchedLen > bestLength) {
      bestName   = serverName;
      bestLength = matchedLen;
    }
  }
  return bestName;
};


// Step 5. Check the server's launch command against POLICY.
// Returns null on a successful match. Otherwise returns a short string saying which part of the policy failed.
// We require: command=npx, "--yes", "@jfrog/agent-guard", and a "--registry <url>" pair.
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
  return null;
};


// Step 6. Emit one audit-log line and exit.
// deny  → write to stderr (VS Code shows the reason) and exit 2.
// allow → silent and exit 0.
const exitWith = ({ decision, reason, toolName = "", toolUseId = "", server = "" }) => {
  audit({ event_type: "decision", tool_use_id: toolUseId, tool_name: toolName, server, decision, reason });
  if (decision === "deny") process.stderr.write(`${PRODUCT_NAME}: ${reason}\n`);
  process.exit(decision === "deny" ? 2 : 0);
};


// The hook.
const main = async () => {
  const stdinText = await readStdinText();
  let request = {};
  try { request = parseJsonc(stdinText) ?? {}; } catch { /* leave empty if not JSON */ }

  const toolName  = request.tool_name  ?? "";
  const toolUseId = request.tool_use_id ?? "";

  // VS Code sends cwd in the payload. process.cwd() is the fallback for command-line testing
  const cwd = request.cwd ?? process.cwd();

  // Non-MCP tools (run_in_terminal, read_file, memory, …) are not our policy.
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) {
    return exitWith({ decision: "allow", reason: "non-MCP tool, out of scope", toolName, toolUseId });
  }

  const servers = collectServers(findMcpJsonFiles(cwd));
  const server  = findServerForTool(toolName, Object.keys(servers));

  // Server not in any mcp.json. Deny.
  if (!server) {
    return exitWith({
      decision: "deny",
      reason:   "server not found in mcp.json",
      toolName, toolUseId,
    });
  }

  const failure = validateAgentGuard(servers[server].entry);
  if (failure) {
    return exitWith({
      decision: "deny",
      reason:   `server '${server}' does not match JFrog gateway shape (${failure})`,
      toolName, toolUseId, server,
    });
  }
  return exitWith({
    decision: "allow",
    reason:   "npx + @jfrog/agent-guard + --registry <url>",
    toolName, toolUseId, server,
  });
};


main().catch((err) => {
  // Fail-closed: any unhandled error becomes a deny, never a bypass.
  const reason = `unexpected error: ${err?.stack ?? err?.message ?? err}`;
  audit({ event_type: "decision", server: "", decision: "deny", reason });
  process.stderr.write(`${PRODUCT_NAME}: ${reason}\n`);
  process.exit(2);
});
