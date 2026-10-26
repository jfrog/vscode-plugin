import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import test from "node:test";

import { DEFAULT_AGENT_GUARD_NPM_REGISTRY } from "../modules/core/rewrite-mcp-json.mjs";
import {
  FAIL_OPEN_OUTPUT,
  bundledNpxCli,
  failOpenMessage,
  quoteCmdArg,
  resolveEnforceSpawn,
  runEnforce,
} from "./enforce-skill.mjs";

const NOW = 1_700_000_000;
const WIN_NODE = "C:\\Program Files\\nodejs\\node.exe";
const WIN_NPX_CLI = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js";
const PAYLOAD = `{"hook_event_name":"PreToolUse","tool_name":"skill"}`;

const winPlan = (opts = {}) =>
  resolveEnforceSpawn({ platform: "win32", execPath: WIN_NODE, nowSec: NOW, env: {}, ...opts });

// --- spawn plan -----------------------------------------------------------------------------

test("POSIX spawns npx with no shell and the expected argv", () => {
  const plan = resolveEnforceSpawn({ platform: "linux", nowSec: NOW, env: {} });
  assert.equal(plan.command, "npx");
  assert.equal(plan.shell, false);
  assert.deepEqual(plan.args, [
    "--yes", "--registry", DEFAULT_AGENT_GUARD_NPM_REGISTRY,
    "@jfrog/agent-guard", "--enforce-skill", "--client", "vscode",
  ]);
});

test("--prefer-offline is passed only when asked for", () => {
  const offline = resolveEnforceSpawn({ platform: "linux", nowSec: NOW, env: {}, preferOffline: true });
  const online = resolveEnforceSpawn({ platform: "linux", nowSec: NOW, env: {} });
  assert.ok(offline.args.includes("--prefer-offline"));
  assert.ok(!online.args.includes("--prefer-offline"));
});

test("npm fetches are bounded: no retries, 10s timeout", () => {
  const { env } = resolveEnforceSpawn({ platform: "linux", nowSec: NOW, env: {} });
  assert.equal(env.npm_config_fetch_retries, "0");
  assert.equal(env.npm_config_fetch_timeout, "10000");
});

test("the deadline is recomputed and replaces an inherited value", () => {
  const { env } = resolveEnforceSpawn({
    platform: "linux", nowSec: NOW, env: { JF_AGENT_GUARD_ENFORCE_DEADLINE: "1" },
  });
  assert.equal(env.JF_AGENT_GUARD_ENFORCE_DEADLINE, String(NOW + 25));
});

test("an unusable clock drops an inherited deadline", () => {
  const { env } = resolveEnforceSpawn({
    platform: "linux", nowSec: Number.NaN, env: { JF_AGENT_GUARD_ENFORCE_DEADLINE: "1" },
  });
  assert.equal(env.JF_AGENT_GUARD_ENFORCE_DEADLINE, undefined);
});

test("JFROG_AGENT_GUARD_VERSION cannot pin the package", () => {
  const plan = resolveEnforceSpawn({
    platform: "linux", nowSec: NOW, env: { JFROG_AGENT_GUARD_VERSION: "0.0.0-master.1.gabc" },
  });
  assert.ok(plan.args.includes("@jfrog/agent-guard"));
  assert.ok(!plan.args.some((a) => a.startsWith("@jfrog/agent-guard@")));
});

test("JFROG_AGENT_GUARD_REPO redirects the registry, trimmed like the MCP-align hook", () => {
  const plan = resolveEnforceSpawn({
    platform: "linux", nowSec: NOW, env: { JFROG_AGENT_GUARD_REPO: "  https://example.invalid/npm/  " },
  });
  assert.equal(plan.args[plan.args.indexOf("--registry") + 1], "https://example.invalid/npm/");
});

test("a blank JFROG_AGENT_GUARD_REPO falls back to the releases registry", () => {
  const plan = resolveEnforceSpawn({ platform: "linux", nowSec: NOW, env: { JFROG_AGENT_GUARD_REPO: "   " } });
  assert.equal(plan.args[plan.args.indexOf("--registry") + 1], DEFAULT_AGENT_GUARD_NPM_REGISTRY);
});

test("bundledNpxCli looks beside node.exe", () => {
  assert.equal(bundledNpxCli(WIN_NODE, (p) => p === WIN_NPX_CLI), WIN_NPX_CLI);
  assert.equal(bundledNpxCli(WIN_NODE, () => false), undefined);
});

test("Windows runs npx-cli.js with node itself, no shell", () => {
  const plan = winPlan({ exists: (p) => p === WIN_NPX_CLI });
  assert.equal(plan.command, WIN_NODE);
  assert.equal(plan.shell, false);
  assert.equal(plan.args[0], WIN_NPX_CLI);
  assert.ok(plan.args.includes("--enforce-skill"));
});

test("Windows without a shell passes a registry with & and % unquoted", () => {
  const registry = "https://example.invalid/npm/?a=1&b=%41";
  const plan = winPlan({ exists: () => true, env: { JFROG_AGENT_GUARD_REPO: registry } });
  assert.equal(plan.args[plan.args.indexOf("--registry") + 1], registry);
});

test("Windows falls back to npx.cmd under a pinned cmd.exe when npm is not beside node.exe", () => {
  const plan = winPlan({ exists: () => false, preferOffline: true });
  assert.equal(plan.command, "npx.cmd");
  assert.equal(plan.shell, "cmd.exe");
  assert.ok(plan.args.includes('"--prefer-offline"'));
  assert.ok(plan.args.includes(`"${DEFAULT_AGENT_GUARD_NPM_REGISTRY}"`));
});

test("the cmd.exe fallback keeps & inside one quoted argument", () => {
  const plan = winPlan({ exists: () => false, env: { JFROG_AGENT_GUARD_REPO: "https://example.invalid/?a=1&b=2" } });
  assert.ok(plan.args.includes('"https://example.invalid/?a=1&b=2"'));
});

test("the cmd.exe fallback refuses an argument it cannot carry intact", () => {
  for (const registry of ["https://x/%PATH%/", 'https://x/"/', "https://x/\r\n/"]) {
    assert.throws(() => winPlan({ exists: () => false, env: { JFROG_AGENT_GUARD_REPO: registry } }),
      `should refuse ${JSON.stringify(registry)}`);
  }
});

test("quoteCmdArg wraps a plain argument in quotes", () => {
  assert.equal(quoteCmdArg("--enforce-skill"), '"--enforce-skill"');
  assert.throws(() => quoteCmdArg("50%"));
  assert.throws(() => quoteCmdArg('a"b'));
  assert.throws(() => quoteCmdArg("a\nb"));
});

// --- runEnforce: exit-code and stdout contract ----------------------------------------------

/**
 * A fake child process. `script(child)` drives it after the launcher has wired its streams.
 * @param {(child: EventEmitter & { stdin: Writable, stdout: PassThrough }) => void} script
 * @param {{ stdin?: Writable, throwOnSpawn?: boolean }} [opts]
 */
function fakeSpawn(script, opts = {}) {
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    if (opts.throwOnSpawn) throw new Error("spawn EINVAL");
    const child = Object.assign(new EventEmitter(), {
      stdin: opts.stdin ?? new PassThrough(),
      stdout: new PassThrough(),
      kill: () => true,
    });
    setImmediate(() => script(child));
    return child;
  };
  return { spawnFn, calls };
}

function captureStdout() {
  let text = "";
  const stream = new Writable({
    write(chunk, _enc, cb) { text += chunk.toString(); cb(); },
  });
  return { stream, text: () => text };
}

/** Emit stdout, then close with the given status, the way a real child does. */
const exitWith = (code, { stdout = "", signal = null } = {}) => (child) => {
  if (stdout) child.stdout.write(stdout);
  child.stdout.end();
  setImmediate(() => child.emit("close", code, signal));
};

const run = (spawnFn, extra = {}) => {
  const out = captureStdout();
  const err = captureStdout();
  const done = runEnforce({
    argv: [], env: {}, platform: "linux", nowSec: NOW,
    spawnFn, stdin: Readable.from([PAYLOAD]), stdout: out.stream, stderr: err.stream, ...extra,
  });
  return done.then((code) => ({ code, stdout: out.text(), stderr: err.text() }));
};

/** A fail-open result: exit 0, `{}` on stdout, and exactly one stderr line naming the cause. */
const assertFailOpen = (r, cause) => {
  assert.equal(r.code, 0);
  assert.equal(r.stdout, FAIL_OPEN_OUTPUT);
  assert.equal(r.stderr.split("\n").filter(Boolean).length, 1, `one stderr line: ${r.stderr}`);
  assert.match(r.stderr, /this skill was not governed/);
  assert.match(r.stderr, cause);
};

test("exit 0 passes the child's stdout through verbatim", async () => {
  const verdict = `{"continue":true}`;
  const r = await run(fakeSpawn(exitWith(0, { stdout: verdict })).spawnFn);
  assert.deepEqual(r, { code: 0, stdout: verdict, stderr: "" });
});

test("exit 0 with no stdout stays silent", async () => {
  const r = await run(fakeSpawn(exitWith(0)).spawnFn);
  assert.deepEqual(r, { code: 0, stdout: "", stderr: "" });
});

test("exit 2 passes through with the child's stdout", async () => {
  const deny = `{"hookSpecificOutput":{"permissionDecision":"deny"}}`;
  const r = await run(fakeSpawn(exitWith(2, { stdout: deny })).spawnFn);
  assert.deepEqual(r, { code: 2, stdout: deny, stderr: "" });
});

test("any other exit code fails open with {} and discards partial output", async () => {
  for (const code of [1, 127, 3]) {
    const r = await run(fakeSpawn(exitWith(code, { stdout: `{"hookSpecificOutput":{"perm` })).spawnFn);
    assertFailOpen(r, new RegExp(`npx exited with code ${code}`));
  }
});

test("a child killed by a signal fails open", async () => {
  const r = await run(fakeSpawn(exitWith(null, { signal: "SIGKILL" })).spawnFn);
  assertFailOpen(r, /killed by SIGKILL/);
});

test("a spawn that throws fails open", async () => {
  const r = await run(fakeSpawn(() => {}, { throwOnSpawn: true }).spawnFn);
  assertFailOpen(r, /could not start npx: spawn EINVAL/);
});

test("a spawn error event (npx missing) fails open, even if close follows", async () => {
  const r = await run(fakeSpawn((child) => {
    child.emit("error", Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" }));
    child.emit("close", -2, null);
  }).spawnFn);
  assertFailOpen(r, /could not start npx: spawn npx ENOENT/);
});

test("a spawn plan that cannot be built fails open without spawning", async () => {
  const { spawnFn, calls } = fakeSpawn(exitWith(2));
  const r = await run(spawnFn, {
    platform: "win32", execPath: WIN_NODE, exists: () => false,
    env: { JFROG_AGENT_GUARD_REPO: "https://x/%PATH%/" },
  });
  assertFailOpen(r, /could not build the npx command: cmd\.exe cannot carry/);
  assert.equal(calls.length, 0);
});

test("an EPIPE on the child's stdin does not replace its exit 2", async () => {
  const brokenStdin = new Writable({
    write(_chunk, _enc, cb) { cb(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })); },
  });
  const r = await run(fakeSpawn(exitWith(2, { stdout: "blocked" }), { stdin: brokenStdin }).spawnFn);
  assert.deepEqual(r, { code: 2, stdout: "blocked", stderr: "" });
});

test("the hook payload reaches the child's stdin verbatim", async () => {
  let received = "";
  const r = await run(fakeSpawn((child) => {
    child.stdin.on("data", (d) => (received += d));
    child.stdin.on("end", () => exitWith(0, { stdout: "{}" })(child));
  }).spawnFn);
  assert.equal(received, PAYLOAD);
  assert.equal(r.code, 0);
});

test("the child gets piped stdout and inherited stderr", async () => {
  const { spawnFn, calls } = fakeSpawn(exitWith(0));
  await run(spawnFn, { argv: ["--prefer-offline"] });
  assert.deepEqual(calls[0].options.stdio, ["pipe", "pipe", "inherit"]);
  assert.equal(calls[0].options.shell, false);
  assert.ok(calls[0].args.includes("--prefer-offline"));
});

test("failOpenMessage is one line naming the cause", () => {
  const line = failOpenMessage("npx exited with code 1");
  assert.ok(line.endsWith("\n") && line.indexOf("\n") === line.length - 1);
  assert.match(line, /npx exited with code 1/);
});
