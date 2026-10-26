#!/usr/bin/env node

// Starts @jfrog/agent-guard --enforce-skill. The hook string in hooks.json is only
// `node` plus this file: VS Code runs that string with PowerShell on Windows, which
// cannot parse a POSIX env prefix or $(date). This process computes the deadline,
// then spawns npx. It does not read the verdict.
//
// Exit codes: VS Code's PreToolUse fails closed on ANY non-zero exit, and exit 2 is
// the only deliberate block. agent-guard exits 0 or 2, so both pass through with its
// stdout. Every other outcome (spawn failure, signal, any other exit code) prints `{}`
// and exits 0, so a machine that cannot run the guard is not blocked by it.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { isMainEntry } from "../modules/core/entry.mjs";
import {
  AGENT_GUARD_PACKAGE,
  resolveAgentGuardNpmRegistry,
} from "../modules/core/rewrite-mcp-json.mjs";

const DEADLINE_SLACK_SEC = 25;
export const FAIL_OPEN_OUTPUT = "{}";

/**
 * npm's npx entry point, installed next to node.exe by the Windows Node installer.
 * Running it with process.execPath needs no shell, unlike npx.cmd.
 *
 * @param {string} execPath
 * @param {(p: string) => boolean} [exists]
 * @returns {string | undefined}
 */
export function bundledNpxCli(execPath, exists = existsSync) {
  const cli = path.win32.join(path.win32.dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js");
  return exists(cli) ? cli : undefined;
}

/**
 * Quote one argument for the npx.cmd fallback under `cmd.exe /d /s /c`. That command
 * line has no escape for `%` (`%%` stays literal, `%VAR%` expands) and none for `"`
 * inside quotes, so an argument holding either is refused rather than mangled.
 *
 * @param {string} arg
 * @returns {string}
 */
export function quoteCmdArg(arg) {
  const value = String(arg ?? "");
  if (/[\r\n%"]/.test(value)) {
    throw new Error(`cmd.exe cannot carry this argument intact: ${JSON.stringify(value)}`);
  }
  return `"${value}"`;
}

/**
 * Spawn plan for `npx --enforce-skill`. POSIX runs npx with no shell. Windows runs
 * npm's npx-cli.js with node itself, and falls back to npx.cmd under cmd.exe (not
 * ComSpec, which may be PowerShell) only when npm is not installed beside node.exe.
 * JFROG_AGENT_GUARD_VERSION is ignored: governance must stay on the latest release.
 *
 * @param {{
 *   preferOffline?: boolean,
 *   env?: NodeJS.ProcessEnv,
 *   nowSec?: number,
 *   platform?: NodeJS.Platform,
 *   execPath?: string,
 *   exists?: (p: string) => boolean,
 * }} [opts]
 * @returns {{ command: string, args: string[], shell: string | false, env: NodeJS.ProcessEnv }}
 */
export function resolveEnforceSpawn(opts = {}) {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const execPath = opts.execPath ?? process.execPath;
  const childEnv = { ...env };
  childEnv.npm_config_fetch_retries = "0";
  childEnv.npm_config_fetch_timeout = "10000";
  if (Number.isFinite(opts.nowSec)) {
    childEnv.JF_AGENT_GUARD_ENFORCE_DEADLINE = String(Math.trunc(opts.nowSec) + DEADLINE_SLACK_SEC);
  } else {
    delete childEnv.JF_AGENT_GUARD_ENFORCE_DEADLINE;
  }

  const args = ["--yes"];
  if (opts.preferOffline === true) args.push("--prefer-offline");
  args.push(
    "--registry",
    resolveAgentGuardNpmRegistry(env),
    AGENT_GUARD_PACKAGE,
    "--enforce-skill",
    "--client",
    "vscode",
  );

  if (platform !== "win32") {
    return { command: "npx", args, shell: false, env: childEnv };
  }
  const cli = bundledNpxCli(execPath, opts.exists);
  if (cli) {
    return { command: execPath, args: [cli, ...args], shell: false, env: childEnv };
  }
  return { command: "npx.cmd", args: args.map(quoteCmdArg), shell: "cmd.exe", env: childEnv };
}

/**
 * Runs agent-guard with the hook payload on its stdin and resolves the exit code for
 * VS Code: the child's 0 or 2 with its stdout, otherwise `{}` and 0.
 *
 * @param {{
 *   argv?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   execPath?: string,
 *   exists?: (p: string) => boolean,
 *   nowSec?: number,
 *   spawnFn?: typeof spawn,
 *   stdin?: NodeJS.ReadableStream,
 *   stdout?: NodeJS.WritableStream,
 * }} [opts]
 * @returns {Promise<0 | 2>}
 */
export function runEnforce(opts = {}) {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const spawnFn = opts.spawnFn ?? spawn;

  return new Promise((resolve) => {
    let settled = false;
    /** @param {0 | 2} code @param {string | Buffer} output */
    const finish = (code, output) => {
      if (settled) return;
      settled = true;
      if (output.length === 0) {
        resolve(code);
        return;
      }
      stdout.write(output, () => resolve(code));
    };
    const failOpen = () => finish(0, FAIL_OPEN_OUTPUT);

    /** @type {ReturnType<typeof resolveEnforceSpawn>} */
    let plan;
    try {
      plan = resolveEnforceSpawn({
        preferOffline: (opts.argv ?? process.argv.slice(2)).includes("--prefer-offline"),
        env: opts.env ?? process.env,
        nowSec: opts.nowSec ?? Math.floor(Date.now() / 1000),
        platform: opts.platform,
        execPath: opts.execPath,
        exists: opts.exists,
      });
    } catch {
      failOpen();
      return;
    }

    /** @type {ReturnType<typeof spawn>} */
    let child;
    try {
      child = spawnFn(plan.command, plan.args, {
        env: plan.env,
        shell: plan.shell,
        windowsHide: true,
        stdio: ["pipe", "pipe", "inherit"],
      });
    } catch {
      failOpen();
      return;
    }

    child.on("error", failOpen);
    if (!child.stdin || !child.stdout) {
      child.kill?.();
      failOpen();
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    // A fast exit (including a policy exit 2) can EPIPE the stdin pipe. That must
    // not replace the child's status.
    child.stdin.on("error", () => {});
    stdin.pipe(child.stdin);
    child.on("close", (code, signal) => {
      if (!signal && (code === 0 || code === 2)) finish(code, Buffer.concat(chunks));
      else failOpen();
    });
  });
}

if (isMainEntry(import.meta.url)) {
  runEnforce().then(
    (code) => process.exit(code),
    () => process.stdout.write(FAIL_OPEN_OUTPUT, () => process.exit(0)),
  );
}
