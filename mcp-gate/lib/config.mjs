import { appendFileSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

// Product identity
export const PRODUCT_NAME = "jfrog-mcp-gate";


// Policy — the launch command we require. Anything else is DENIED.
// Example mcp.json entry that PASSES this policy:
//   "command": "npx",
//   "args":    ["--yes", "--registry", "<any-url>", "@jfrog/agent-guard", "chrome-devtools-mcp@latest"]
export const POLICY = {
  command:       "npx",
  required_args: ["--yes", "@jfrog/agent-guard"],
  registry_arg:  "--registry",
};


// Where the JSON-per-line audit log lives.
export const AUDIT_LOG_PATH = platform() === "win32"
  ? join(process.env.ProgramData ?? "C:\\ProgramData", "JFrog\\Logs\\jfrog-mcp-gate.log")
  : "/var/log/jfrog-mcp-gate.log";

// VS Code's user-level config folder.
export const VSCODE_USER_DIR = (() => {
  const home = homedir();
  if (platform() === "darwin") return join(home, "Library/Application Support/Code/User");
  if (platform() === "win32")  return join(process.env.APPDATA ?? home, "Code/User");
  return join(home, ".config/Code/User");
})();

export const VSCODE_SETTINGS_PATH = join(VSCODE_USER_DIR, "settings.json");

// Where VS Code looks for our hook config.
export const HOOK_CONFIG_TILDE = "~/.jfrog/mcp-gate/vscode-hooks.json";

// Hook-config payload — the JSON that setup-user writes to ~/.jfrog/mcp-gate/vscode-hooks.json. VS Code reads this file
// and spawns `command` for every PreToolUse event.
export const buildHookConfig = (hookBinAbsPath) => ({
  version: 1,
  hooks: {
    PreToolUse: [{ type: "command", command: hookBinAbsPath }],
  },
});


// JSONC helpers
// VS Code's settings.json + mcp.json allow comments and trailing commas that plain JSON.parse rejects.
// stripJsonc removes them.
export const stripJsonc = (s) =>
  s
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, comment) => (comment ? "" : m))
    .replace(/,(\s*[}\]])/g, "$1");

export const parseJsonc = (s) => JSON.parse(stripJsonc(s));


// Audit logger — append one JSON entry per line. Never throws.
// Example deny line:
//   {"ts":"2026-...","product":"jfrog-mcp-gate","event_type":"decision",
//    "tool_name":"mcp_x_y","server":"","decision":"deny",
//    "reason":"server not found in mcp.json"}
export const audit = (entry) => {
  try {
    mkdirSync(dirname(AUDIT_LOG_PATH), { recursive: true });
    appendFileSync(
      AUDIT_LOG_PATH,
      JSON.stringify({ ts: new Date().toISOString(), product: PRODUCT_NAME, ...entry }) + "\n",
    );
  } catch { /* best-effort */ }
};
