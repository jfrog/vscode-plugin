#!/usr/bin/env bash
# Engineer-local release fallback. Canonical release is the GH workflow;
# this exists so we can ship updates before CI infra onboards the repo.
# Usage:   ./poc/release.sh [--dry-run]
# Env:     JFROG_MCP_GATE_REPO  (default: jfrog-cli-plugins/jfrog-mcp-gate)
# Needs:   jf (JFrog CLI) logged in, tar.

set -euo pipefail

# Settings
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

MCP_GATE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # the mcp-gate/ folder
VERSION="$(cat "${MCP_GATE_ROOT}/VERSION")"
TGZ="mcp-gate-${VERSION}.tgz"
REPO="${JFROG_MCP_GATE_REPO:-jfrog-cli-plugins/jfrog-mcp-gate}"
TOP_LEVEL_FILES=(install.sh uninstall.sh install.ps1 uninstall.ps1 com.jfrog.mcp-gate.mobileconfig)

# Preflight (need VERSION + tar; need jf if not dry-run)

[[ -n "${VERSION}" ]] || { echo "release.sh: VERSION is empty." >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "release.sh: tar not in PATH." >&2; exit 1; }
if [[ ${DRY_RUN} -eq 0 ]]; then
    command -v jf >/dev/null 2>&1 || { echo "release.sh: jf (JFrog CLI) not in PATH." >&2; exit 1; }
fi

# Build the install package (.tgz) + LATEST file
DIST="${MCP_GATE_ROOT}/dist"
mkdir -p "${DIST}"
rm -f "${DIST}/${TGZ}" "${DIST}/LATEST"

echo "==> Packaging ${TGZ} (version=${VERSION})"
tar -C "${MCP_GATE_ROOT}" -czf "${DIST}/${TGZ}" bin lib VERSION
echo "${VERSION}" > "${DIST}/LATEST"

echo "    -> ${DIST}/${TGZ}"
echo "    -> ${DIST}/LATEST"

# Upload to Artifactory (or print what would have been uploaded)
if [[ ${DRY_RUN} -eq 1 ]]; then
    echo
    echo "==> Dry run, skipping upload."
    echo "    Would upload to ${REPO}:"
    echo "      v${VERSION}/${TGZ}"
    echo "      LATEST"
    for f in "${TOP_LEVEL_FILES[@]}"; do echo "      ${f}"; done
    exit 0
fi

echo
echo "==> Uploading versioned package -> ${REPO}/v${VERSION}/"
jf rt upload "${DIST}/${TGZ}" "${REPO}/v${VERSION}/"

echo
echo "==> Refreshing top-level artefacts on ${REPO}/"
jf rt upload "${DIST}/LATEST" "${REPO}/LATEST"
for f in "${TOP_LEVEL_FILES[@]}"; do
    jf rt upload "${MCP_GATE_ROOT}/${f}" "${REPO}/${f}"
done

cat <<EOF

==> Release ${VERSION} published to ${REPO}.
    IT command:
      curl -sSfL https://\${ARTIFACTORY_HOST}/artifactory/${REPO}/install.sh | sudo bash
EOF
