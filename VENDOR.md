# Vendoring

This repository vendors (copies, pinned, and committed in tree) content from
other JFrog-owned repositories rather than resolving it at install time. This
keeps the plugin self-contained: installing it does not require reaching out
to any repository other than the one it ships as.

## Skills — vendored from `jfrog/jfrog-skills`

The Agent Skills under [`plugin/skills/`](plugin/skills/) are taken from
[`jfrog/jfrog-skills`](https://github.com/jfrog/jfrog-skills) at a pinned
version and committed to this repo. They are not downloaded or resolved at
runtime.

Because the skills are bundled, updating them requires a new plugin release —
there are no runtime skill updates. Skill-sync PRs bring in a pinned
`jfrog/jfrog-skills` release and bump the plugin version accordingly.

The README deliberately omits release numbers. The `version` in
[`plugin/.claude-plugin/plugin.json`](plugin/.claude-plugin/plugin.json),
mirrored by [`marketplace.json`](marketplace.json), and GitHub tags/releases
are the authoritative plugin-version sources.

## Modules — vendored from `JFROG/jfrog-agent-hooks`

The session-start and package-resolution modules under
[`plugin/modules/`](plugin/modules/) are vendored from
[`JFROG/jfrog-agent-hooks`](https://github.com/JFROG/jfrog-agent-hooks) at
the pin recorded in
[`.github/scripts/sync-modules-vendor.json`](.github/scripts/sync-modules-vendor.json).
[`.github/scripts/sync-modules.mjs`](.github/scripts/sync-modules.mjs) performs
the sync, and
[`.github/scripts/check-vendored-modules.mjs`](.github/scripts/check-vendored-modules.mjs)
verifies the committed tree matches the pin (see
[`sync-modules-integrity.json`](.github/scripts/sync-modules-integrity.json)
for the per-file checksums used in that check).

The authoritative module release is the `pin` in
[`.github/scripts/sync-modules-vendor.json`](.github/scripts/sync-modules-vendor.json).
Only upstream `modules/` are vendored; upstream tests remain in the source
repository.

## Not vendored

[`@jfrog/agent-guard`](https://jfrog.com) is fetched at runtime via `npx` from
JFrog's own npm registry (see [`plugin/.mcp.json`](plugin/.mcp.json)). It is a
first-party JFrog package, not a vendored copy.

See [`NOTICE`](NOTICE) for the license and attribution details of each vendored
source.
