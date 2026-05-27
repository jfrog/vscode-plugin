#!/usr/bin/env node
// JFrog Ltd. — cross-platform installer for the JFrog Agent Guard Hook.

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

const PRODUCT_NAME = "agent-guard-hook";
const HOOK_FILE = `${PRODUCT_NAME}.mjs`;
const VERSION_RE = /^\/\/\s*agent-guard-hook-version:\s*(.+)$/m;

const HOME = homedir();
const HOOK_DIR = join(HOME, ".vscode", "hooks");
const HOOK_SCRIPT = join(HOOK_DIR, HOOK_FILE);
const AUDIT_LOG = join(HOOK_DIR, `${PRODUCT_NAME}.log`);

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


// ────────────────────────── entrypoint ──────────────────────────

cmdInstall().catch((err) => exitWithError(err?.stack ?? err?.message ?? String(err)));
