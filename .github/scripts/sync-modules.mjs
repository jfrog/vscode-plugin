#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0
//
// Vendors modules bundle from jfrog-agent-hooks into plugin/.
//
// Usage:
//   JFROG_AGENT_HOOKS_PATH=/path/to/jfrog-agent-hooks node .github/scripts/sync-modules.mjs
//
// Defaults JFROG_AGENT_HOOKS_PATH to ../jfrog-agent-hooks (sibling clone).
// Reads paths from sync-modules-vendor.json.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");
const vendorPath = path.join(scriptDir, "sync-modules-vendor.json");

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyPath(fromDir, toDir, relativePath, log = console.log) {
  const from = path.join(fromDir, relativePath);
  const to = path.join(toDir, relativePath);
  if (!(await fileExists(from))) {
    throw new Error(`path missing in upstream: ${relativePath}`);
  }
  await fs.rm(to, { recursive: true, force: true });
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.cp(from, to, { recursive: true });
  log(`  ${relativePath} -> ${path.relative(process.cwd(), to)}`);
}

export async function syncPaths({
  fromDir,
  toDir,
  paths,
  keep = [],
  log = console.log,
}) {
  const stashRoot = await fs.mkdtemp(path.join(tmpdir(), "sync-modules-keep-"));
  try {
    for (const relativePath of keep) {
      const source = path.join(toDir, relativePath);
      if (!(await fileExists(source))) {
        throw new Error(`kept overlay path missing: ${relativePath}`);
      }
      const stashed = path.join(stashRoot, relativePath);
      await fs.mkdir(path.dirname(stashed), { recursive: true });
      await fs.cp(source, stashed, { recursive: true });
    }

    try {
      for (const relativePath of paths) {
        await copyPath(fromDir, toDir, relativePath, log);
      }
    } finally {
      for (const relativePath of keep) {
        const stashed = path.join(stashRoot, relativePath);
        const destination = path.join(toDir, relativePath);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.cp(stashed, destination, { recursive: true, force: true });
        log(`  restored overlay ${relativePath}`);
      }
    }
  } finally {
    await fs.rm(stashRoot, { recursive: true, force: true });
  }
}

async function main() {
  const vendor = JSON.parse(await fs.readFile(vendorPath, "utf8"));
  const paths = vendor.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error(`${vendorPath} must define a non-empty paths array`);
  }

  const hooksRoot =
    process.env.JFROG_AGENT_HOOKS_PATH?.trim() ||
    path.resolve(repoRoot, "..", "jfrog-agent-hooks");

  if (!(await fileExists(hooksRoot))) {
    throw new Error(
      `jfrog-agent-hooks not found at ${hooksRoot}. Set JFROG_AGENT_HOOKS_PATH.`,
    );
  }

  const destPrefix = (vendor.dest_prefix ?? "").replace(/^\/+|\/+$/g, "");
  const destRoot = destPrefix ? path.join(repoRoot, destPrefix) : repoRoot;

  const pin = vendor.pin ? JSON.stringify(vendor.pin) : "local";
  console.log(`--- sync from ${hooksRoot} (pin: ${pin}) ---`);
  await syncPaths({
    fromDir: hooksRoot,
    toDir: destRoot,
    paths,
    keep: vendor.keep,
  });
  console.log("done.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
