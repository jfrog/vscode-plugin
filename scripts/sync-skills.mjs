#!/usr/bin/env node
//
// Reads <plugin>/.vendor.json for every plugin in marketplace.json,
// downloads the upstream tarball at the pinned tag, and copies the
// listed paths into the plugin folder. Runs at release time only —
// main stays skill-free.

import { promises as fs, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function fileExists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

// codeload.github.com serves any public repo's release tarball over HTTPS
// without auth. The pin in .vendor.json is always a release tag (vX.Y.Z).
async function downloadTarball(repo, tag, destPath) {
  const url = `https://codeload.github.com/${repo}/tar.gz/refs/tags/${encodeURIComponent(tag)}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Could not download ${repo}@${tag} (HTTP ${res.status})`);
  // Stream straight to disk so we don't buffer the whole tarball in RAM.
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
  console.log(`  fetched ${url}`);
}

async function extractTarball(tarballPath, intoDir) {
  await fs.mkdir(intoDir, { recursive: true });
  const result = spawnSync("tar", ["-xzf", tarballPath, "-C", intoDir], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`tar exited with status ${result.status}`);
  const [topLevel] = await fs.readdir(intoDir);
  return path.join(intoDir, topLevel);
}

async function copyPath(fromDir, toDir, relativePath) {
  const from = path.join(fromDir, relativePath);
  const to = path.join(toDir, relativePath);
  if (!(await fileExists(from))) {
    throw new Error(`path missing in upstream tarball: ${relativePath}`);
  }
  await fs.rm(to, { recursive: true, force: true });
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.cp(from, to, { recursive: true });
  console.log(`  ${relativePath} -> ${path.relative(process.cwd(), to)}`);
}

async function syncPlugin(plugin, workDir) {
  const pluginDir = path.resolve(plugin.source);
  const vendorPath = path.join(pluginDir, ".vendor.json");
  if (!(await fileExists(vendorPath))) return;

  const { repo, pin, paths } = await readJson(vendorPath);
  if (!repo || !pin || !Array.isArray(paths) || paths.length === 0) {
    throw new Error(`${vendorPath} must define 'repo', 'pin' and a non-empty 'paths' array`);
  }

  console.log(`--- ${plugin.name} ---`);
  const slug = `${repo.replace("/", "-")}-${pin}`;
  const tarball = path.join(workDir, `${slug}.tar.gz`);
  await downloadTarball(repo, pin, tarball);
  const extracted = await extractTarball(tarball, path.join(workDir, slug));
  for (const rel of paths) await copyPath(extracted, pluginDir, rel);
}

async function main() {
  const marketplace = await readJson("marketplace.json");
  const workDir = await fs.mkdtemp(path.join(tmpdir(), "sync-skills-"));
  try {
    for (const plugin of marketplace.plugins ?? []) {
      await syncPlugin(plugin, workDir);
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
  console.log("done.");
}

await main();
