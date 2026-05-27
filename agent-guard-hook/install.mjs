#!/usr/bin/env node
// JFrog Ltd. — cross-platform installer for the JFrog Agent Guard Hook.

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

const PRODUCT_NAME = "agent-guard-hook";
const HOOK_FILE = `${PRODUCT_NAME}.mjs`;
const HOOK_CONFIG_TILDE = `~/.vscode/hooks/${PRODUCT_NAME}.json`;
const VERSION_RE = /^\/\/\s*agent-guard-hook-version:\s*(.+)$/m;

const HOME = homedir();
const HOOK_DIR = join(HOME, ".vscode", "hooks");
const HOOK_SCRIPT = join(HOOK_DIR, HOOK_FILE);
const HOOK_CONFIG = join(HOOK_DIR, `${PRODUCT_NAME}.json`);
const AUDIT_LOG = join(HOOK_DIR, `${PRODUCT_NAME}.log`);

// VS Code's user-level settings.json (kept in sync with agent-guard-hook.mjs).
const VSCODE_SETTINGS_PATH = (() => {
  if (platform() === "darwin") return join(HOME, "Library/Application Support/Code/User/settings.json");
  if (platform() === "win32") return join(process.env.APPDATA ?? join(HOME, "AppData/Roaming"), "Code/User/settings.json");
  return join(HOME, ".config/Code/User/settings.json");
})();

const ART_HOST = "https://releases.jfrog.io/artifactory";
const REPO = "coding-agents-generic";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const force = flag("--force");


// Logging.
const log = (msg) => process.stdout.write(`==> ${msg}\n`);
const exitWithError = (msg) => { process.stderr.write(`!!  ${msg}\n`); process.exit(1); };


// Idempotent version check — read line 2 of the locally installed hook
// and compare against the staged archive's hook before overwriting.
const versionInFile = (path) => {
  if (!existsSync(path)) return null;
  const match = readFileSync(path, "utf8").match(VERSION_RE);
  return match ? match[1].trim() : null;
};


const fetchToFile = async (url, dest) => {
  log(`download ${url}`);
  const res = await fetch(url);
  if (!res.ok) exitWithError(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
};

const fetchText = async (url) => {
  const res = await fetch(url);
  if (!res.ok) exitWithError(`HTTP ${res.status} for ${url}`);
  return (await res.text()).trim();
};


// Extract a .tgz archive using whichever extractor the OS provides.
const extractArchive = (archivePath, destDir) => {
  log(`extract ${archivePath} → ${destDir}`);
  const result = spawnSync("tar", ["-xzf", archivePath, "-C", destDir], { stdio: "inherit" });
  if (result.status !== 0) exitWithError("tar -xzf failed");
};


// Make the hook executable on POSIX. 0o755 = rwxr-xr-x:
//   owner: read+write+execute (we need +x so VS Code can spawn it via the #!/usr/bin/env node shebang),
//   group + others: read+execute (so `node` / `cat` / `tail` can inspect it).
// On Windows, chmod is a no-op — execute permission comes from the file extension, and VS Code launches the
// script through `node`.
const makeHookExecutable = (path) => {
  if (platform() === "win32") return; // Windows ignores POSIX file modes
  chmodSync(path, 0o755);
};

const installFiles = (stagedHookPath) => {
  mkdirSync(HOOK_DIR, { recursive: true });
  if (existsSync(HOOK_SCRIPT)) {
    const tmpPath = `${HOOK_SCRIPT}.${process.pid}.new`;
    copyFileSync(stagedHookPath, tmpPath);
    makeHookExecutable(tmpPath);
    renameSync(tmpPath, HOOK_SCRIPT);
  } else {
    copyFileSync(stagedHookPath, HOOK_SCRIPT);
    makeHookExecutable(HOOK_SCRIPT);
  }

  if (!existsSync(AUDIT_LOG)) writeFileSync(AUDIT_LOG, "");
};


// Find the latest version from Artifactory's LATEST text file.
// LATEST file content is just the version string (e.g. "0.1.0").
const resolveLatestVersion = async () =>
  fetchText(`${ART_HOST}/${REPO}/${PRODUCT_NAME}/LATEST`);

const archiveUrl = (version) =>
  `${ART_HOST}/${REPO}/${PRODUCT_NAME}/${PRODUCT_NAME}-${version}.tgz`;


// ────────────────────────── install ──────────────────────────

const cmdInstall = async () => {
  log(`installing ${PRODUCT_NAME}`);

  // Stage everything in a temp dir so an aborted installation leaves no debris.
  const stagingDir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-`));
  const version = await resolveLatestVersion();
  log(`latest version: ${version}`);
  const archivePath = join(stagingDir, `${PRODUCT_NAME}-${version}.tgz`);
  await fetchToFile(archiveUrl(version), archivePath);

  extractArchive(archivePath, stagingDir);
  const stagedHookPath = join(stagingDir, HOOK_FILE);
  if (!existsSync(stagedHookPath)) exitWithError(`archive missing ${HOOK_FILE}`);

  // Idempotent skip — if the version already on disk matches the staged one, do nothing
  // (apart from a register call to heal settings.json).
  const localVersion = versionInFile(HOOK_SCRIPT);
  const stagedVersion = versionInFile(stagedHookPath);
  if (localVersion && stagedVersion && localVersion === stagedVersion && !force) {
    log(`already at ${localVersion}, skipping file copy`);
  } else {
    installFiles(stagedHookPath);
    log(`installed version ${stagedVersion} at ${HOOK_SCRIPT}`);
  }

  // Register (or re-register) the hook in VS Code's settings.json.
  log("registering in VS Code settings.json");
  spawnSync(process.execPath, [HOOK_SCRIPT, "--register"], { stdio: "inherit" });

  rmSync(stagingDir, { recursive: true, force: true });
  log("done");
};


// ────────────────────────── uninstall ──────────────────────────

// Fallback for when the hook script was already deleted by hand — strip our
// key from settings.json directly so we don't leave a dangling entry behind.
const stripSettingsEntry = () => {
  if (!existsSync(VSCODE_SETTINGS_PATH)) return;
  let text;
  try { text = readFileSync(VSCODE_SETTINGS_PATH, "utf8"); }
  catch { return; }
  // VS Code allows JSONC; mimic agent-guard-hook.mjs's stripper.
  const stripped = text
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, c) => (c ? "" : m))
    .replace(/,(\s*[}\]])/g, "$1");
  let parsed;
  try { parsed = JSON.parse(stripped); } catch { return; }
  const locations = parsed?.["chat.hookFilesLocations"];
  if (!locations || typeof locations !== "object" || !(HOOK_CONFIG_TILDE in locations)) return;
  delete locations[HOOK_CONFIG_TILDE];
  if (Object.keys(locations).length === 0) delete parsed["chat.hookFilesLocations"];
  const tmp = `${VSCODE_SETTINGS_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  renameSync(tmp, VSCODE_SETTINGS_PATH);
  log(`stripped settings.json entry at ${VSCODE_SETTINGS_PATH}`);
};


const cmdUninstall = () => {
  log(`uninstalling ${PRODUCT_NAME}`);

  if (existsSync(HOOK_SCRIPT)) {
    spawnSync(process.execPath, [HOOK_SCRIPT, "--unregister"], { stdio: "inherit" });
  } else {
    log("hook script not present, cleaning settings.json directly");
    stripSettingsEntry();
  }

  // Archive the audit log rather than delete it — forensics for IT.
  if (existsSync(AUDIT_LOG)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivedLog = `${AUDIT_LOG}.uninstalled-${stamp}`;
    renameSync(AUDIT_LOG, archivedLog);
    log(`archived audit log → ${archivedLog}`);
  }

  for (const path of [HOOK_SCRIPT, HOOK_CONFIG]) {
    if (existsSync(path)) {
      rmSync(path);
      log(`removed ${path}`);
    }
  }
  log("done");
};


// ────────────────────────── entrypoint ──────────────────────────

(async () => {
  if (flag("--uninstall")) cmdUninstall();
  else await cmdInstall();
})().catch((err) => exitWithError(err?.stack ?? err?.message ?? String(err)));
