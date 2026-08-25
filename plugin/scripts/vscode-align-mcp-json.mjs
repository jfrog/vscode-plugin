#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";

import { isMainEntry } from "../modules/core/entry.mjs";
import {
  detectHarness,
  parseWorkspaceRoots,
  readStdin,
} from "../modules/core/io.mjs";
import {
  DEFAULT_AGENT_GUARD_VERSION,
  runRewriteMcpJsonPipeline,
} from "../modules/core/rewrite-mcp-json.mjs";
import {
  allowRootsForMcpJson,
  discoverVscodeMcpJson,
} from "./vscode-mcp-json-discover.mjs";

const HARNESS_ID = "copilot";
export const RECONNECT_CONTEXT =
  "JFrog Agent Guard secured your plugins' MCP servers. Run Developer: Reload Window to reconnect.";

export const RECOMMENDED_HOOK_TIMEOUT_SEC = 60;

function noOp() {
  return { exitCode: 0, stdout: "{}" };
}

function contentFingerprint(configPath) {
  try {
    return createHash("sha256")
      .update(readFileSync(configPath))
      .digest("hex");
  } catch {
    return null;
  }
}

export async function runVscodeAlignMcpJson(options = {}) {
  try {
    if (options.mode !== "session-start") return noOp();
    const harness = detectHarness(options.stdinRaw ?? "");
    if (harness && harness !== HARNESS_ID) return noOp();

    const env = {
      ...(options.env ?? process.env),
      JFROG_AGENT_GUARD_VERSION: DEFAULT_AGENT_GUARD_VERSION,
    };
    const workspaceRoots = parseWorkspaceRoots(options.stdinRaw ?? "");
    const discover =
      options.discover ??
      (() => discoverVscodeMcpJson({ env, workspaceRoots }));
    const pipeline = options.pipeline ?? runRewriteMcpJsonPipeline;
    let discoveredPaths = [];
    let before = new Map();
    await pipeline({
      discover: async () => {
        discoveredPaths = await discover();
        before = new Map(
          discoveredPaths.map((configPath) => [
            configPath,
            contentFingerprint(configPath),
          ]),
        );
        return discoveredPaths;
      },
      allowRoots: allowRootsForMcpJson,
      env,
    });
    const rewritten = discoveredPaths.some(
      (configPath) =>
        before.get(configPath) !== contentFingerprint(configPath),
    );
    if (!rewritten) return noOp();

    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: RECONNECT_CONTEXT,
        },
      }),
    };
  } catch {
    return noOp();
  }
}

async function main() {
  const result = await runVscodeAlignMcpJson({
    mode: process.argv[2],
    stdinRaw: await readStdin(),
  });
  process.stdout.write(result.stdout);
  process.exitCode = 0;
}

if (isMainEntry(import.meta.url)) {
  main().catch(() => {
    process.stdout.write("{}");
    process.exitCode = 0;
  });
}
