# Vendored skills

The skill packages under `plugin/skills/` are vendored from **[jfrog/jfrog-skills](https://github.com/jfrog/jfrog-skills)** and committed to `main`.

| | |
| --- | --- |
| **Repository** | https://github.com/jfrog/jfrog-skills |
| **Pinned release** | see `pin` in [`plugin/.vendor.json`](plugin/.vendor.json) |

Included directories: `jfrog/`, `jfrog-package-safety-and-download/` (as of the pinned release).

## Refreshing

When the upstream repo publishes a new release, refresh the vendored tree via a PR that:

1. Bumps `pin` in [`plugin/.vendor.json`](plugin/.vendor.json) to the new tag.
2. Re-syncs and commits the refreshed `plugin/skills/` tree.
3. Bumps `version` in [`marketplace.json`](marketplace.json) so users actually receive the update (Claude Code/Copilot skip installs whose resolved version hasn't changed).

To regenerate the tree locally before opening the PR:

```bash
node .github/scripts/sync-skills.mjs
```

The script reads `plugin/.vendor.json`, downloads the pinned upstream tarball from `codeload.github.com`, and replaces the directories listed in `paths` (today: `plugin/skills/`).
