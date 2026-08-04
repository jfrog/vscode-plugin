# Contributing to JFrog VS Code Plugin

Thank you for your interest in contributing! This project is maintained by JFrog and licensed under the [Apache License 2.0](LICENSE).

## Contributor License Agreement (CLA)

All contributors must sign the [JFrog CLA](https://jfrog.com/cla/) before contributions can be merged. A CLA check runs automatically on every pull request — follow the prompts to sign if you haven't already.

## How to Contribute

1. **Fork** the repository and create a feature branch from `main`.
2. Make your changes, ensuring they follow the existing code style and project conventions.
3. **Commit** with a clear, descriptive message.
4. Open a **pull request** against `main` with a summary of what changed and why.

## Releasing

To cut a release:

1. In your PR, bump `.version` in [`plugin/.claude-plugin/plugin.json`](plugin/.claude-plugin/plugin.json) and sync the matching entry in [`marketplace.json`](marketplace.json) to match. `plugin.json` is canonical; the `validate-version` PR check enforces that the two agree.
2. Merge to `main` with `[major]`, `[minor]`, or `[patch]` in the commit **subject** - the first
   line. A marker further down in the body is ignored on purpose: this repo squash-merges, and
   GitHub pre-fills the squash body from the branch commits or the PR description, either of
   which may quote a marker while only documenting it.

The marker only decides *whether* to release; the version comes from the manifest either way, so the bump is reviewed in the PR that makes it. There is no bot push to `main`. Merging a marker without bumping the manifests fails the release rather than re-tagging a shipped version.

The workflow reads the version from `plugin.json`, confirms `marketplace.json` agrees, refuses to continue if that version is already tagged, packages the tracked files at `HEAD` (minus `.github/`) into `release.zip`, and creates the `vX.Y.Z` tag as part of publishing the GitHub Release.

Two things to know before changing it:

- There is no plugin-layout validator in this repo, so a release is gated only on the two manifests agreeing. If a validator is added, run it as a step inside the release job as well: a separate workflow triggered by the same push can be red while a release still goes out.
- The tag is created by the release, not before it. `gh release create --target` does both in one API call, so a failed run can't leave a tag behind with no release attached to it.

## Reporting Issues

Open a [GitHub issue](https://github.com/jfrog/vscode-plugin/issues) with:

- A clear title and description of the problem.
- Steps to reproduce (if applicable).
- Expected vs. actual behavior.

## Code Guidelines

- Keep changes focused — one logical change per PR.
- Follow existing patterns and naming conventions in the codebase.
- Do not commit secrets, credentials, or API keys.

## Code of Conduct

Be respectful and constructive. We are committed to providing a welcoming and inclusive experience for everyone.

## Questions?

Reach out to the JFrog DevRel team at devrel@jfrog.com.
