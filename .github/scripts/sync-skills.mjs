#!/usr/bin/env node
// Vendors skill content from the upstream jfrog/jfrog-skills repository
// into this plugin. Run manually when bumping the pin: bump `pin` in
// <plugin>/.vendor.json, then run this script to regenerate the
// plugin's skills/ tree, then commit both alongside each other.
//
// Usage:
//   node .github/scripts/sync-skills.mjs
//
// Steps the script performs:
//   1. Reads marketplace.json and walks each plugin entry.
//   2. For each plugin, reads <plugin>/.vendor.json to learn which
//      repo + ref to pull.
//   3. Downloads that tarball from codeload.github.com (public, no auth).
//   4. Extracts it into a temp directory.
//   5. Copies the requested paths (e.g. "skills") into the plugin folder,
//      replacing any existing tree.
//
// The pin in .vendor.json is the single source of truth — there is no
// runtime override. To ship a different skill version, change the pin
// in a PR and commit the synced tree alongside it.

import { promises as fs, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

// filesystem helpers
async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function fileExists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

// download the upstream tarball

// codeload.github.com serves any public repo's archive over HTTPS
// without auth, accepting a tag, branch, or commit SHA as the ref.
async function downloadTarball(repo, ref, destPath) {
  const url = `https://codeload.github.com/${repo}/tar.gz/${encodeURIComponent(ref)}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Could not download ${repo}@${ref} (HTTP ${res.status})`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
  console.log(`  fetched ${url}`);
}

// extract the tarball

// Shells out to the system `tar` instead of pulling in an npm tar library —
// keeps the script zero-dependency.
//
// GitHub tarballs always have exactly one top-level directory whose
// name encodes the repo + commit. We return that path so the caller
// knows where to find the extracted tree.
async function extractTarball(tarballPath, intoDir) {
  await fs.mkdir(intoDir, { recursive: true });
  const result = spawnSync("tar", ["-xzf", tarballPath, "-C", intoDir], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`tar exited with status ${result.status}`);
  const [topLevel] = await fs.readdir(intoDir);
  return path.join(intoDir, topLevel);
}

// copy one path from the extracted tree into the plugin

// Removes the destination first so we never end up with stale leftovers
// from a previous sync, then creates the destination's parent directory then copies.
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

// Resolves the plugin's local directory from the marketplace `source` field.
function localPluginDir(plugin) {
  if (typeof plugin.source === "string") return plugin.source;
  if (plugin.source && typeof plugin.source.path === "string") return plugin.source.path;
  return null;
}

// Sync one plugin: read its .vendor.json, download + extract + copy.
// Plugins without a local path or without a .vendor.json are silently skipped.
async function syncPlugin(plugin, workDir) {
  const localPath = localPluginDir(plugin);
  if (!localPath) return;
  const pluginDir = path.resolve(localPath);
  const vendorPath = path.join(pluginDir, ".vendor.json");
  if (!(await fileExists(vendorPath))) return;

  const { repo, pin, paths } = await readJson(vendorPath);
  if (!repo || !pin || !Array.isArray(paths) || paths.length === 0) {
    throw new Error(`${vendorPath} must define 'repo', 'pin' and a non-empty 'paths' array`);
  }

  console.log(`--- ${plugin.name} (ref: ${pin}) ---`);

  // `slug` is just a unique filename for this plugin's tarball + extract.
  const slug = `${repo.replace("/", "-")}-${pin.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  const tarball = path.join(workDir, `${slug}.tar.gz`);
  await downloadTarball(repo, pin, tarball);
  const extracted = await extractTarball(tarball, path.join(workDir, slug));
  for (const rel of paths) await copyPath(extracted, pluginDir, rel);
}

// Entry point: walk marketplace.json, sync each plugin sequentially,
// always clean up the temp work directory.
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
