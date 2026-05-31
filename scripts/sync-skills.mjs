#!/usr/bin/env node
//
// Reads <source>/.vendor.json for every plugin in marketplace.json,
// downloads each upstream tarball, and copies the listed paths into the
// plugin folder. Runs at release time only — main stays skill-free.

import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const repoRoot = process.cwd();
const readJson = async (p) => JSON.parse(await fs.readFile(p, "utf8"));
const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };

async function download(repo, ref, dest) {
  // Try tag, branch, then raw ref (commit SHA). codeload.github.com is
  // public and requires no auth, which keeps local dev simple.
  for (const url of [
    `https://codeload.github.com/${repo}/tar.gz/refs/tags/${encodeURIComponent(ref)}`,
    `https://codeload.github.com/${repo}/tar.gz/refs/heads/${encodeURIComponent(ref)}`,
    `https://codeload.github.com/${repo}/tar.gz/${encodeURIComponent(ref)}`,
  ]) {
    const res = await fetch(url, { redirect: "follow" });
    if (res.ok) {
      await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
      console.log(`  fetched ${url}`);
      return;
    }
  }
  throw new Error(`Could not download ${repo}@${ref}`);
}

async function extract(tarball, into) {
  await fs.mkdir(into, { recursive: true });
  const r = spawnSync("tar", ["-xzf", tarball, "-C", into], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`tar failed (status ${r.status})`);
  const [top] = await fs.readdir(into);
  return path.join(into, top);
}

const workDir = await fs.mkdtemp(path.join(tmpdir(), "sync-skills-"));
try {
  const marketplace = await readJson(path.join(repoRoot, "marketplace.json"));
  for (const plugin of marketplace.plugins ?? []) {
    const pluginDir = path.join(repoRoot, plugin.source);
    const vendorPath = path.join(pluginDir, ".vendor.json");
    if (!(await exists(vendorPath))) continue;

    console.log(`--- ${plugin.name} ---`);
    const { sources = [] } = await readJson(vendorPath);
    for (const { repo, pin, paths } of sources) {
      if (!repo || !pin || !Array.isArray(paths) || paths.length === 0) {
        throw new Error(`${vendorPath}: each source needs 'repo', 'pin', and 'paths[]'`);
      }
      const tag = `${repo.replace("/", "-")}-${pin.replace(/[^A-Za-z0-9._-]/g, "_")}`;
      const tarball = path.join(workDir, `${tag}.tar.gz`);
      await download(repo, pin, tarball);
      const extracted = await extract(tarball, path.join(workDir, `extract-${tag}`));
      for (const rel of paths) {
        const to = path.join(pluginDir, rel);
        await fs.rm(to, { recursive: true, force: true });
        await fs.cp(path.join(extracted, rel), to, { recursive: true });
        console.log(`  ${rel} -> ${path.relative(repoRoot, to)}`);
      }
    }
  }
} finally {
  await fs.rm(workDir, { recursive: true, force: true });
}
console.log("done.");
