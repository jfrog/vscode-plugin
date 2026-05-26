# jfrog-mcp-gate uninstaller (Windows). macOS / Linux users: uninstall.sh.
# Removes everything install.ps1 wrote plus the per-user state for the
# currently-logged-in user. The audit log is preserved for forensics.
#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

$InstallRoot = Join-Path $env:ProgramFiles "JFrog\mcp-gate"
$AuditLog    = Join-Path $env:ProgramData  "JFrog\Logs\jfrog-mcp-gate.log"
$TaskName    = "JFrogMcpUserSetup"

# Stop the Scheduled Task. We do this BEFORE removing files so the task
# can't fire one last time mid-uninstall and recreate state.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "==> Unregistering Scheduled Task $TaskName"
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# Per-user state cleanup (BEFORE deleting the install root, because we
# call setup-user.mjs --clean from it).
#
# This script runs as Administrator but the user data we want to delete
# lives in another user's profile (Documents, AppData, .jfrog\). So:
#   1. Find who's interactively logged in (Win32_ComputerSystem.UserName
#      gives "DOMAIN\username").
#   2. Find that user's profile folder via Win32_UserProfile.LocalPath.
#   3. Set JFROG_MCP_GATE_HOME so setup-user.mjs writes to THEIR home
#      instead of the Administrator's.
$activeUser = (Get-CimInstance -ClassName Win32_ComputerSystem).UserName
if ($activeUser) {
    $userOnly = $activeUser.Split("\")[-1]                # "DOMAIN\foo" -> "foo"
    $userHome = (Get-CimInstance -ClassName Win32_UserProfile |
                 Where-Object { $_.LocalPath -like "*\$userOnly" } |
                 Select-Object -First 1).LocalPath

    if ($userHome) {
        $McpGateDir = Join-Path $userHome ".jfrog\mcp-gate"
        $HookConfig = Join-Path $McpGateDir "vscode-hooks.json"
        $setupBin   = Join-Path $InstallRoot "bin\jfrog-setup-user.mjs"

        if (Test-Path $setupBin) {
            Write-Host "==> Stripping chat.hookFilesLocations entry for $userOnly"
            # Temporarily set JFROG_MCP_GATE_HOME so setup-user.mjs
            # operates on the active user's settings.json, not ours.
            $env:JFROG_MCP_GATE_HOME = $userHome
            try { & node $setupBin --clean } catch { }
            Remove-Item Env:JFROG_MCP_GATE_HOME -ErrorAction SilentlyContinue
        }

        if (Test-Path $HookConfig) {
            Write-Host "==> Removing $HookConfig"
            Remove-Item $HookConfig -Force
        }
        # Remove the parent dir only if it became empty (-Force without
        # -Recurse on a folder fails if not empty — that's the behavior
        # we want).
        if (Test-Path $McpGateDir) {
            try { Remove-Item $McpGateDir -Force } catch { }
        }
    }
}

# Install root + (if empty) the JFrog parent folder.
if (Test-Path $InstallRoot) {
    Write-Host "==> Removing $InstallRoot"
    Remove-Item -Recurse -Force $InstallRoot
}
$parent = Split-Path $InstallRoot -Parent
if ((Test-Path $parent) -and -not (Get-ChildItem $parent -ErrorAction SilentlyContinue)) {
    Remove-Item $parent
}

# Done — print a "what's preserved" hint
Write-Host ""
Write-Host "==> Uninstall complete."
Write-Host ""
Write-Host "Preserved for forensics:"
Write-Host "  $AuditLog"
Write-Host ""
Write-Host "To remove the ChatHooks=1 enterprise policy:"
Write-Host "  reg delete HKLM\Software\Policies\Microsoft\VSCode /v ChatHooks /f"
