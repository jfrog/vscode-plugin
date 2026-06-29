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

Releases are automated by `.github/workflows/release.yml`. To cut a release, push (or merge) a commit to `main` whose message contains `[major]`, `[minor]`, or `[patch]`:

- `[patch]` — bug fixes; bumps `X.Y.Z` → `X.Y.Z+1`
- `[minor]` — new features; bumps `X.Y.Z` → `X.Y+1.0`
- `[major]` — breaking changes; bumps `X.Y.Z` → `X+1.0.0`

The workflow:
1. Bumps `VERSION` and syncs the version in `plugin/.claude-plugin/plugin.json` and `marketplace.json`
2. Commits and pushes the bump to `main`
3. Creates a `vX.Y.Z` git tag
4. Publishes a GitHub Release with a repo zip attached

**Prerequisite:** `github-actions[bot]` must be allowed to push to `main`. In the repository's branch protection (or ruleset) settings, add `github-actions[bot]` to the bypass list.

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
