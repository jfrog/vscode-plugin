#!/usr/bin/env bash
# Engineer-local release fallback. The canonical release is the GH workflow
# (.github/workflows/agent-guard-hook-ci.yml). This exists for sanity checks
# and for ad-hoc dev archives before CI is wired.
#
# Usage:
#   ./poc/release.sh                       version=0.0.0-local.<ts>.g<sha>
#   ./poc/release.sh --version 0.1.0       explicit version
#   ./poc/release.sh --dry-run
#
# Env:
#   AGENT_GUARD_HOOK_REPO  default: coding-agents-generic/agent-guard-hook
#
# Needs: jf (logged in), tar, sed.

set -euo pipefail

DRY_RUN=0
VERSION_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)  DRY_RUN=1; shift ;;
    --version)  VERSION_OVERRIDE="${2:?--version needs a value}"; shift 2 ;;
    *)          echo "release.sh: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_HOOK="${ROOT}/agent-guard-hook.mjs"

# Mirror CI's versioning: real version preferred (--version), else compose a
# local dev version like the CI dev format so install.mjs sees a sane string.
if [[ -n "${VERSION_OVERRIDE}" ]]; then
  VERSION="${VERSION_OVERRIDE}"
else
  TS="$(date -u +%Y%m%d%H%M%S)"
  SHA="$(git -C "${ROOT}" rev-parse --short HEAD 2>/dev/null || echo nogit)"
  VERSION="0.0.0-local.${TS}.g${SHA}"
fi

TGZ="agent-guard-hook-${VERSION}.tgz"
REPO="${AGENT_GUARD_HOOK_REPO:-coding-agents-generic/agent-guard-hook}"
# Top-level artefacts IT downloads. install.mjs is the entry point for the
# `curl ... | node` one-liner; the mobileconfig is the optional MDM payload.
TOP_LEVEL_FILES=(install.mjs com.jfrog.agent-guard-hook.mobileconfig)

command -v tar >/dev/null 2>&1 || { echo "release.sh: tar not in PATH." >&2; exit 1; }
command -v sed >/dev/null 2>&1 || { echo "release.sh: sed not in PATH." >&2; exit 1; }
if [[ ${DRY_RUN} -eq 0 ]]; then
    command -v jf >/dev/null 2>&1 || { echo "release.sh: jf (JFrog CLI) not in PATH." >&2; exit 1; }
fi

DIST="${ROOT}/dist"
STAGE="${DIST}/stage"
rm -rf "${DIST}" && mkdir -p "${STAGE}"

# Stage the .mjs into dist/stage/, sed-inject the version on line 2 of the
# COPY (never touch the committed source), then tar from the staging dir.
cp "${SRC_HOOK}" "${STAGE}/agent-guard-hook.mjs"
# BSD sed needs `-i ''`, GNU sed wants no arg — handle both.
if sed --version >/dev/null 2>&1; then
  sed -i -E "2s|^// agent-guard-hook-version: .*$|// agent-guard-hook-version: ${VERSION}|" "${STAGE}/agent-guard-hook.mjs"
else
  sed -i '' -E "2s|^// agent-guard-hook-version: .*$|// agent-guard-hook-version: ${VERSION}|" "${STAGE}/agent-guard-hook.mjs"
fi
echo "==> Packaging ${TGZ} (version=${VERSION})"
echo "    line 2 of staged .mjs: $(sed -n '2p' "${STAGE}/agent-guard-hook.mjs")"

tar -C "${STAGE}" -czf "${DIST}/${TGZ}" agent-guard-hook.mjs
echo "${VERSION}" > "${DIST}/LATEST"

echo "    -> ${DIST}/${TGZ}"
echo "    -> ${DIST}/LATEST"

if [[ ${DRY_RUN} -eq 1 ]]; then
    echo
    echo "==> Dry run, skipping upload."
    echo "    Would upload to ${REPO}:"
    echo "      ${VERSION}/${TGZ}"
    echo "      LATEST"
    for f in "${TOP_LEVEL_FILES[@]}"; do echo "      ${f}"; done
    exit 0
fi

echo
echo "==> Uploading versioned archive -> ${REPO}/${VERSION}/"
jf rt upload "${DIST}/${TGZ}" "${REPO}/${VERSION}/"

echo
echo "==> Refreshing top-level artefacts on ${REPO}/"
jf rt upload "${DIST}/LATEST" "${REPO}/LATEST"
for f in "${TOP_LEVEL_FILES[@]}"; do
    jf rt upload "${ROOT}/${f}" "${REPO}/${f}"
done

cat <<EOF

==> Release ${VERSION} published to ${REPO}.
    IT one-liner (no sudo — user-space install):
      curl -fsSL https://\${ARTIFACTORY_HOST}/artifactory/${REPO}/install.mjs | node
EOF
