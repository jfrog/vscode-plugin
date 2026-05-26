#!/usr/bin/env bash
# jfrog-mcp-gate installer (macOS + Linux).
# Production:    curl -sSfL https://releases.jfrog.io/artifactory/jfrog-cli-plugins/jfrog-mcp-gate/install.sh | sudo bash
# Local test:    sudo ./install.sh --package dist/mcp-gate-<VER>.tgz

set -euo pipefail

# Settings — paths and the upstream URL are baked in. To install from a
# local .tgz instead of Artifactory pass --package <path>.
URL="https://releases.jfrog.io/artifactory/jfrog-cli-plugins/jfrog-mcp-gate"
INSTALL_ROOT="/usr/local/jfrog/mcp-gate"
AUDIT_LOG="/var/log/jfrog-mcp-gate.log"

# Parse CLI args
LOCAL_PACKAGE=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --package) LOCAL_PACKAGE="$2"; shift 2 ;;
        -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
        *) echo "install.sh: unknown arg '$1' (try --help)" >&2; exit 1 ;;
    esac
done

# OS dispatch — macOS uses LaunchAgents (in /Library/LaunchAgents) and the wheel group; Linux uses systemd --user
# units and group root.
case "$(uname -s)" in
    Darwin) PLATFORM=macos; GROUP=wheel; SETUP_LOG_DIR="/Library/Logs/jfrog-mcp-gate" ;;
    Linux)  PLATFORM=linux; GROUP=root;  SETUP_LOG_DIR="" ;;   # Linux logs to journald
    *)
        # Windows users need install.ps1 — they typically only hit this
        # path if they ran the script via Git Bash or WSL by mistake.
        echo "install.sh: unsupported OS '$(uname -s)' (Windows uses install.ps1)." >&2
        exit 1
        ;;
esac

# Preflight — must run as root because we write to /usr/local + /var/log.
# node + tar are needed at install time (and node at every hook call).
[[ $EUID -eq 0 ]] || { echo "install.sh: must run as root (use 'sudo')." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "install.sh: 'node' not in PATH (need Node.js >= 20)." >&2; exit 1; }
command -v tar  >/dev/null 2>&1 || { echo "install.sh: 'tar' not in PATH." >&2; exit 1; }

# Stage the payload in a temp dir we clean up on exit. The dir ends up
# with bin/, lib/, VERSION after the tar extracts.
STAGE=$(mktemp -d -t jfrog-mcp-gate.XXXXXX)
trap 'rm -rf "${STAGE}"' EXIT

if [[ -n "${LOCAL_PACKAGE}" ]]; then
    [[ -f "${LOCAL_PACKAGE}" ]] || { echo "install.sh: package not found: ${LOCAL_PACKAGE}" >&2; exit 1; }
    echo "==> Installing from local package: ${LOCAL_PACKAGE}"
    cp "${LOCAL_PACKAGE}" "${STAGE}/payload.tgz"
else
    # Resolve "latest" by fetching the LATEST file (one line of text, the
    # version number). Then download mcp-gate-<VER>.tgz from that subdir.
    echo "==> Resolving latest version from ${URL}/LATEST"
    LATEST_VERSION="$(curl -sSfL "${URL}/LATEST" | tr -d '[:space:]')"
    [[ -n "${LATEST_VERSION}" ]] || { echo "install.sh: could not resolve version." >&2; exit 1; }
    echo "==> Installing jfrog-mcp-gate ${LATEST_VERSION} from ${URL}"
    curl -sSfL -o "${STAGE}/payload.tgz" "${URL}/v${LATEST_VERSION}/mcp-gate-${LATEST_VERSION}.tgz"
fi

tar -xzf "${STAGE}/payload.tgz" -C "${STAGE}"
rm -f "${STAGE}/payload.tgz"

# Sanity-check the payload before we touch the install root.
[[ -x "${STAGE}/bin/jfrog-mcp-gate.mjs"   ]] || { echo "install.sh: payload missing bin/jfrog-mcp-gate.mjs"   >&2; exit 1; }
[[ -x "${STAGE}/bin/jfrog-setup-user.mjs" ]] || { echo "install.sh: payload missing bin/jfrog-setup-user.mjs" >&2; exit 1; }
[[ -f "${STAGE}/lib/config.mjs"           ]] || { echo "install.sh: payload missing lib/config.mjs"           >&2; exit 1; }
[[ -f "${STAGE}/VERSION"                  ]] || { echo "install.sh: payload missing VERSION"                  >&2; exit 1; }

# Lay down the install root — root-owned + 0755 so users can read/run
# but cannot modify without sudo. We blow the dir away first so reinstalls
# don't accumulate stale files.
echo "==> Installing into ${INSTALL_ROOT}"
rm -rf "${INSTALL_ROOT}"
mkdir -p "${INSTALL_ROOT}/bin" "${INSTALL_ROOT}/lib"

install -o root -g "${GROUP}" -m 0755 "${STAGE}/bin/jfrog-mcp-gate.mjs"   "${INSTALL_ROOT}/bin/jfrog-mcp-gate.mjs"
install -o root -g "${GROUP}" -m 0755 "${STAGE}/bin/jfrog-setup-user.mjs" "${INSTALL_ROOT}/bin/jfrog-setup-user.mjs"
install -o root -g "${GROUP}" -m 0644 "${STAGE}/lib/config.mjs"           "${INSTALL_ROOT}/lib/config.mjs"
install -o root -g "${GROUP}" -m 0644 "${STAGE}/VERSION"                  "${INSTALL_ROOT}/VERSION"

# Audit log — `touch` creates the file if missing (and is a no-op when
# it exists, so reinstalls preserve existing audit lines). chmod 0666
# lets the user-mode hook + setup-user both append.
touch "${AUDIT_LOG}"
chown "root:${GROUP}" "${AUDIT_LOG}"
chmod 0666 "${AUDIT_LOG}"

# Per-tick log directory (macOS only — Linux logs to journald).
# 0777 because we don't know yet which user the LaunchAgent will run as.
if [[ -n "${SETUP_LOG_DIR}" ]]; then
    mkdir -p "${SETUP_LOG_DIR}"
    chmod 0777 "${SETUP_LOG_DIR}"
fi

# Platform-specific service registration
if [[ "${PLATFORM}" == "macos" ]]; then
    PLIST_DEST="/Library/LaunchAgents/com.jfrog.mcp-user-setup.plist"
    echo "==> Installing LaunchAgent at ${PLIST_DEST}"

    # LaunchAgent plist — describes a per-user background service to launchd.
    #   RunAtLoad      = run once when the agent loads (i.e. at every login)
    #   StartInterval  = re-run every N seconds (here: 60s, our heal-on-tick)
    #   ProgramArgs    = the command line to execute
    #   PATH override  = launchd's default PATH doesn't include /opt/homebrew
    #                    /usr/local/bin where most users have `node`
    cat > "${PLIST_DEST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.jfrog.mcp-user-setup</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/env</string>
        <string>node</string>
        <string>${INSTALL_ROOT}/bin/jfrog-setup-user.mjs</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>60</integer>
    <key>StandardOutPath</key>
    <string>${SETUP_LOG_DIR}/setup.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${SETUP_LOG_DIR}/setup.stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
EOF
    chown root:wheel "${PLIST_DEST}"
    chmod 0644       "${PLIST_DEST}"

    # Kick the LaunchAgent into the currently-logged-in GUI session.
    #   bootout    = unload any older instance with the same Label
    #   bootstrap  = load the (possibly new) plist into the user session
    #   kickstart  = force one immediate tick (-k = re-run even if it just ran)
    # /dev/console belongs to whoever owns the active GUI session.
    LOGGED_IN_UID=$(stat -f%u /dev/console 2>/dev/null || echo "")
    LOGGED_IN_USER=$(stat -f%Su /dev/console 2>/dev/null || echo "")
    if [[ -n "${LOGGED_IN_UID}" && "${LOGGED_IN_UID}" != "0" ]]; then
        echo "==> Bootstrapping LaunchAgent into uid=${LOGGED_IN_UID} (${LOGGED_IN_USER})"
        launchctl bootout "gui/${LOGGED_IN_UID}/com.jfrog.mcp-user-setup" 2>/dev/null || true
        launchctl bootstrap "gui/${LOGGED_IN_UID}" "${PLIST_DEST}"
        launchctl kickstart -k "gui/${LOGGED_IN_UID}/com.jfrog.mcp-user-setup"
    fi

else
    # Linux: systemd --user service + timer. They live in /etc/systemd/user/
    # so every user's `systemctl --user` session picks them up automatically.
    # Logs go to journald — view with: journalctl --user -u jfrog-mcp-user-setup.service
    SYSTEMD_DIR="/etc/systemd/user"
    SERVICE_UNIT="${SYSTEMD_DIR}/jfrog-mcp-user-setup.service"
    TIMER_UNIT="${SYSTEMD_DIR}/jfrog-mcp-user-setup.timer"

    echo "==> Installing systemd --user units in ${SYSTEMD_DIR}"
    mkdir -p "${SYSTEMD_DIR}"

    # The .service runs once on each timer fire.
    cat > "${SERVICE_UNIT}" <<EOF
[Unit]
Description=JFrog mcp-gate per-user setup

[Service]
Type=oneshot
ExecStart=/usr/bin/env node ${INSTALL_ROOT}/bin/jfrog-setup-user.mjs
EOF
    chmod 0644 "${SERVICE_UNIT}"

    # The .timer fires 10s after boot and every 60s after that.
    cat > "${TIMER_UNIT}" <<EOF
[Unit]
Description=JFrog mcp-gate per-user setup timer

[Timer]
OnBootSec=10s
OnUnitActiveSec=60s
Unit=jfrog-mcp-user-setup.service

[Install]
WantedBy=timers.target
EOF
    chmod 0644 "${TIMER_UNIT}"

    # Enable for every user globally — fires on each user's next login.
    systemctl --global enable jfrog-mcp-user-setup.timer >/dev/null 2>&1 || true

    # Best-effort: kick the timer in the currently-logged-in user's session
    # so they don't have to log out/in. systemd --user needs that user's
    # XDG_RUNTIME_DIR which sudo doesn't carry — so we point at it explicitly.
    LOGGED_IN_USER=$(logname 2>/dev/null || echo "")
    LOGGED_IN_UID=$(id -u "${LOGGED_IN_USER}" 2>/dev/null || echo "")
    if [[ -n "${LOGGED_IN_UID}" && "${LOGGED_IN_UID}" != "0" ]]; then
        echo "==> Starting timer in uid=${LOGGED_IN_UID} (${LOGGED_IN_USER}) session"
        sudo -u "${LOGGED_IN_USER}" \
            XDG_RUNTIME_DIR="/run/user/${LOGGED_IN_UID}" \
            systemctl --user daemon-reload         >/dev/null 2>&1 || true
        sudo -u "${LOGGED_IN_USER}" \
            XDG_RUNTIME_DIR="/run/user/${LOGGED_IN_UID}" \
            systemctl --user enable --now jfrog-mcp-user-setup.timer >/dev/null 2>&1 || true
    fi
fi

# Done — print a "what next" hint

INSTALLED_VERSION="$(cat "${INSTALL_ROOT}/VERSION")"
cat <<EOF

==> Installed jfrog-mcp-gate ${INSTALLED_VERSION} (${PLATFORM}).

Per-user state will appear on the next service tick (<=60s):
  ~/.jfrog/mcp-gate/vscode-hooks.json
  chat.hookFilesLocations entry in VS Code user settings

Next:
  1. Push the VS Code enterprise ChatHooks=true policy via your MDM.
       macOS: com.jfrog.mcp-gate.mobileconfig
       Linux: write /etc/vscode/policy.json with {"ChatHooks": true}
  2. Restart VS Code.
  3. tail -f ${AUDIT_LOG}

Uninstall:
  sudo bash -c "\$(curl -sSfL ${URL}/uninstall.sh)"
EOF
