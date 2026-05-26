#!/usr/bin/env bash
# jfrog-mcp-gate uninstaller (macOS + Linux). Windows users: uninstall.ps1.
# Removes everything install.sh wrote plus the per-user state for the
# currently-logged-in user. The audit log is preserved for forensics.
set -euo pipefail

INSTALL_ROOT="/usr/local/jfrog/mcp-gate"
AUDIT_LOG="/var/log/jfrog-mcp-gate.log"

# OS dispatch + active-user lookup.
# We capture both the username and the uid because launchctl/systemctl
# both need the uid to address the right user session.
#   macOS: stat /dev/console — that device is owned by whoever owns the
#          active GUI session.
#   Linux: logname — the name of the user who started the login session
#          we inherited from sudo.
case "$(uname -s)" in
    Darwin)
        PLATFORM=macos
        LOGGED_IN_USER=$(stat -f%Su /dev/console 2>/dev/null || echo "")
        LOGGED_IN_UID=$(stat  -f%u  /dev/console 2>/dev/null || echo "")
        PLIST_DEST="/Library/LaunchAgents/com.jfrog.mcp-user-setup.plist"
        SETUP_LOG_HINT="/Library/Logs/jfrog-mcp-gate/setup.{stdout,stderr}.log"
        ;;
    Linux)
        PLATFORM=linux
        LOGGED_IN_USER=$(logname 2>/dev/null || echo "")
        LOGGED_IN_UID=$(id -u "${LOGGED_IN_USER}" 2>/dev/null || echo "")
        SYSTEMD_DIR="/etc/systemd/user"
        SETUP_LOG_HINT="journalctl --user -u jfrog-mcp-user-setup.service (until cleared)"
        ;;
    *)
        echo "uninstall.sh: unsupported OS '$(uname -s)' (Windows uses uninstall.ps1)." >&2
        exit 1
        ;;
esac

[[ $EUID -eq 0 ]] || { echo "uninstall.sh: must run as root." >&2; exit 1; }

# Stop the per-user service. We do this BEFORE removing files so the
# scheduler can't fire one last tick mid-uninstall and recreate state.
if [[ "${PLATFORM}" == "macos" ]]; then
    # bootout = the opposite of bootstrap — unload the LaunchAgent from
    # the active GUI session.
    if [[ -n "${LOGGED_IN_UID}" && "${LOGGED_IN_UID}" != "0" ]]; then
        echo "==> Booting out LaunchAgent from uid=${LOGGED_IN_UID}"
        launchctl bootout "gui/${LOGGED_IN_UID}/com.jfrog.mcp-user-setup" 2>/dev/null || true
    fi
else
    # disable --now = stop the timer right now AND unenable it for future
    # logins. Reach across the sudo boundary by setting XDG_RUNTIME_DIR.
    if [[ -n "${LOGGED_IN_UID}" && "${LOGGED_IN_UID}" != "0" ]]; then
        echo "==> Stopping timer in uid=${LOGGED_IN_UID} (${LOGGED_IN_USER}) session"
        sudo -u "${LOGGED_IN_USER}" \
            XDG_RUNTIME_DIR="/run/user/${LOGGED_IN_UID}" \
            systemctl --user disable --now jfrog-mcp-user-setup.timer >/dev/null 2>&1 || true
    fi
    # Also remove the system-wide --global enablement.
    systemctl --global disable jfrog-mcp-user-setup.timer >/dev/null 2>&1 || true
fi

# Per-user state cleanup (BEFORE deleting the install root, because we
# call setup-user.mjs --clean from it). We delegate settings.json
# cleanup to that script so the JSONC logic stays in one place. Runs
# AS the active user so file ownership stays correct.
if [[ -n "${LOGGED_IN_USER}" && "${LOGGED_IN_USER}" != "root" ]]; then
    # eval echo expands ~user into the user's $HOME on all shells.
    USER_HOME=$(eval echo "~${LOGGED_IN_USER}")
    MCP_GATE_DIR="${USER_HOME}/.jfrog/mcp-gate"
    HOOK_CONFIG="${MCP_GATE_DIR}/vscode-hooks.json"
    SETUP_USER="${INSTALL_ROOT}/bin/jfrog-setup-user.mjs"

    if [[ -x "${SETUP_USER}" ]]; then
        echo "==> Stripping chat.hookFilesLocations entry for ${LOGGED_IN_USER}"
        sudo -u "${LOGGED_IN_USER}" node "${SETUP_USER}" --clean || true
    fi

    [[ -f "${HOOK_CONFIG}"  ]] && { echo "==> Removing ${HOOK_CONFIG}";  rm -f  "${HOOK_CONFIG}"; }
    # rmdir only succeeds if the dir is empty — exactly what we want here.
    [[ -d "${MCP_GATE_DIR}" ]] && rmdir "${MCP_GATE_DIR}" 2>/dev/null || true
fi

# Service files (plist on macOS / unit files on Linux) + install root.
if [[ "${PLATFORM}" == "macos" ]]; then
    [[ -f "${PLIST_DEST}" ]] && { echo "==> Removing ${PLIST_DEST}"; rm -f "${PLIST_DEST}"; }
else
    for unit in jfrog-mcp-user-setup.timer jfrog-mcp-user-setup.service; do
        [[ -f "${SYSTEMD_DIR}/${unit}" ]] && { echo "==> Removing ${SYSTEMD_DIR}/${unit}"; rm -f "${SYSTEMD_DIR}/${unit}"; }
    done
fi

if [[ -d "${INSTALL_ROOT}" ]]; then
    echo "==> Removing ${INSTALL_ROOT}"
    rm -rf "${INSTALL_ROOT}"
fi
# Clean up the /usr/local/jfrog/ parent if nothing else is in it.
[[ -d "/usr/local/jfrog" && -z "$(ls -A /usr/local/jfrog)" ]] && rmdir /usr/local/jfrog

# Done — print a "what's preserved" hint
cat <<EOF

==> Uninstall complete.

Preserved for forensics:
  ${AUDIT_LOG}
  ${SETUP_LOG_HINT}

To remove the ChatHooks=true enterprise policy:
  macOS: sudo profiles remove -identifier com.jfrog.mcp-gate
  Linux: remove /etc/vscode/policy.json
EOF
