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

1. In your PR, bump `VERSION` and sync both `plugin/.claude-plugin/plugin.json` `.version` and `marketplace.json` `.plugins[0].version` to match. The `validate-version` PR check enforces this.
2. Merge to `main` with `[major]`, `[minor]`, or `[patch]` anywhere in the commit message.

The release workflow reads `VERSION`, creates a `vX.Y.Z` git tag, and publishes a GitHub Release with a repo zip attached. No bot push to `main` — the version bump is part of the PR itself.

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
