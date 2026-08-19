import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RECOMMENDED_HOOK_TIMEOUT_SEC,
  runVscodeAlignMcpJson,
} from "./vscode-align-mcp-json.mjs";

const COPILOT_INPUT = JSON.stringify({
  hook_event_name: "SessionStart",
  source: "new",
  session_id: "test-session",
  cwd: "/workspace",
});

test("forwards discovered paths and their plugin roots to the shared pipeline", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "vscode-align-roots-"));
  const paths = [
    path.join(root, "a", "mcp.json"),
    path.join(root, "b", ".mcp.json"),
  ];
  mkdirSync(path.dirname(paths[0]), { recursive: true });
  mkdirSync(path.dirname(paths[1]), { recursive: true });
  writeFileSync(paths[0], "{}");
  writeFileSync(paths[1], "{}");
  let received;

  const result = await runVscodeAlignMcpJson({
    mode: "session-start",
    stdinRaw: COPILOT_INPUT,
    discover: () => paths,
    pipeline: async (options) => {
      received = {
        paths: await options.discover(),
        allowRoots: options.allowRoots(paths),
      };
      return { exitCode: 0, outcome: "skipped_current", reason: "" };
    },
  });

  assert.deepEqual(received, {
    paths,
    allowRoots: [path.join(root, "a"), path.join(root, "b")].map((entry) =>
      realpathSync(entry),
    ),
  });
  assert.equal(result.stdout, "{}");
  assert.equal(result.exitCode, 0);
});

test("emits exact Copilot reconnect context after a rewrite", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "vscode-align-"));
  const configPath = path.join(root, "mcp.json");
  writeFileSync(configPath, '{"mcpServers":{}}\n');
  const result = await runVscodeAlignMcpJson({
    mode: "session-start",
    stdinRaw: COPILOT_INPUT,
    discover: () => [configPath],
    pipeline: async (options) => {
      await options.discover();
      writeFileSync(configPath, '{"mcpServers":{"secured":{}}}\n');
      return {
        exitCode: 0,
        outcome: "rewritten",
        reason: "",
      };
    },
  });

  assert.deepEqual(JSON.parse(result.stdout), {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        "JFrog Agent Guard secured your plugins' MCP servers. Run Developer: Reload Window to reconnect.",
    },
  });
  assert.equal(result.exitCode, 0);
});

test("successful Agent Guard run with zero changed files is a no-op", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "vscode-align-"));
  const configPath = path.join(root, "mcp.json");
  writeFileSync(configPath, '{"mcpServers":{}}\n');

  const result = await runVscodeAlignMcpJson({
    mode: "session-start",
    stdinRaw: COPILOT_INPUT,
    discover: () => [configPath],
    pipeline: async (options) => {
      await options.discover();
      return {
        exitCode: 0,
        outcome: "rewritten",
        reason: "",
      };
    },
  });

  assert.deepEqual(result, { exitCode: 0, stdout: "{}" });
});

test("unknown mode and harness mismatch are soft no-ops", async () => {
  let calls = 0;
  const pipeline = async () => {
    calls += 1;
    return { exitCode: 1, outcome: "failed_spawn", reason: "boom" };
  };

  const unknown = await runVscodeAlignMcpJson({
    mode: "other",
    stdinRaw: COPILOT_INPUT,
    pipeline,
  });
  const mismatch = await runVscodeAlignMcpJson({
    mode: "session-start",
    stdinRaw: JSON.stringify({
      hook_event_name: "SessionStart",
      source: "startup",
    }),
    pipeline,
  });

  assert.deepEqual(unknown, { exitCode: 0, stdout: "{}" });
  assert.deepEqual(mismatch, { exitCode: 0, stdout: "{}" });
  assert.equal(calls, 0);
});

test("pipeline failure after changing bytes still emits reconnect guidance", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "vscode-align-failed-"));
  const configPath = path.join(root, "mcp.json");
  writeFileSync(configPath, '{"mcpServers":{}}\n');
  const result = await runVscodeAlignMcpJson({
    mode: "session-start",
    stdinRaw: COPILOT_INPUT,
    discover: () => [configPath],
    pipeline: async (options) => {
      await options.discover();
      writeFileSync(configPath, '{"mcpServers":{"partiallySecured":{}}}\n');
      return {
        exitCode: 1,
        outcome: "failed_spawn",
        reason: "failed",
      };
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(
    JSON.parse(result.stdout).hookSpecificOutput.additionalContext,
    "JFrog Agent Guard secured your plugins' MCP servers. Run Developer: Reload Window to reconnect.",
  );
});

test("pipeline failure without changed bytes is a no-op", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "vscode-align-failed-"));
  const configPath = path.join(root, "mcp.json");
  writeFileSync(configPath, '{"mcpServers":{}}\n');
  const result = await runVscodeAlignMcpJson({
    mode: "session-start",
    stdinRaw: COPILOT_INPUT,
    discover: () => [configPath],
    pipeline: async (options) => {
      await options.discover();
      return {
        exitCode: 1,
        outcome: "failed_timeout",
        reason: "timeout",
      };
    },
  });

  assert.deepEqual(result, { exitCode: 0, stdout: "{}" });
});

test("recommended hook timeout leaves rewrite, gate, and grace headroom", () => {
  assert.equal(RECOMMENDED_HOOK_TIMEOUT_SEC, 60);
  assert.ok(RECOMMENDED_HOOK_TIMEOUT_SEC * 1000 > 35_000 + 5_000 + 2_000);

  const pluginRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const config = JSON.parse(
    readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"),
  );
  const hooks = config.hooks.SessionStart.flatMap((entry) => entry.hooks);
  const align = hooks.find((hook) =>
    hook.command.includes("vscode-align-mcp-json.mjs"),
  );
  assert.deepEqual(align, {
    type: "command",
    command:
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/vscode-align-mcp-json.mjs" session-start',
    timeout: RECOMMENDED_HOOK_TIMEOUT_SEC,
    statusMessage: "Securing plugin MCP servers with JFrog Agent Guard…",
  });
});
