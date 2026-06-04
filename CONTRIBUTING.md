# Contributing to the JFrog VS Code Plugin

Thank you for your interest in contributing! This project is maintained by JFrog and licensed under the [Apache License 2.0](LICENSE).

## Contributor License Agreement (CLA)

All contributors must sign the [JFrog CLA](https://jfrog.com/cla/) before contributions can be merged. A CLA check runs automatically on every pull request — follow the prompts to sign if you haven't already.

## How to Contribute

1. **Fork** the repository and create a feature branch from `main`.
2. Make your changes, ensuring they follow the existing code style and project conventions.
3. **Test** by loading the plugin from source — see [the README](README.md#installation) for setup instructions.
4. **Commit** with a clear, descriptive message.
5. Open a **pull request** against `main` with a summary of what changed and why.

### Updating the vendored skills

The `plugin/skills/` tree is vendored from [jfrog/jfrog-skills](https://github.com/jfrog/jfrog-skills) and committed to `main`. The full refresh flow lives in [`README.md`](README.md#updating-the-vendored-skills) and [`VENDOR.md`](VENDOR.md).

## Pre-release checklist

- [ ] Version bumped in [`plugin/.claude-plugin/plugin.json`](plugin/.claude-plugin/plugin.json) when the plugin changes.
- [ ] No secrets, credentials, or files under `**/local-cache/` committed.
- [ ] If the skill tree changed: `.github/scripts/sync-skills-vendor.json` `pin` matches the upstream tag the new tree was generated from.
- [ ] Smoke-test the plugin locally.

## Reporting Issues

Open a [GitHub issue](https://github.com/jfrog/vscode-plugin/issues) with:

- A clear title and description of the problem.
- Steps to reproduce (if applicable).
- Expected vs. actual behavior.

## Code Guidelines

- Keep changes focused — one logical change per PR.
- Follow existing patterns and naming conventions in the codebase.
- Do not commit secrets, credentials, or API keys.
- Add copyright headers to new source files:

```
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0
```

## Code of Conduct

Be respectful and constructive. We are committed to providing a welcoming and inclusive experience for everyone.

## Questions?

Reach out to the JFrog DevRel team at <devrel@jfrog.com>.
