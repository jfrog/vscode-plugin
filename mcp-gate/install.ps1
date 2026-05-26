# jfrog-mcp-gate installer (Windows). macOS / Linux: see install.sh.
# Production:  iwr -useb https://releases.jfrog.io/artifactory/jfrog-cli-plugins/jfrog-mcp-gate/install.ps1 | iex
#              (must run in an elevated PowerShell — "Run as Administrator")
# Local test:  .\install.ps1 -Package .\dist\mcp-gate-<VER>.tgz
#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [string]$Package = ""
)

$ErrorActionPreference = "Stop"

# Settings — the upstream URL is baked in. To install from a local .tgz
# instead of Artifactory pass -Package <path>.
$Url         = "https://releases.jfrog.io/artifactory/jfrog-cli-plugins/jfrog-mcp-gate"
$InstallRoot = Join-Path $env:ProgramFiles "JFrog\mcp-gate"
$LogDir      = Join-Path $env:ProgramData  "JFrog\Logs"
$AuditLog    = Join-Path $LogDir           "jfrog-mcp-gate.log"
$TaskName    = "JFrogMcpUserSetup"

# Preflight — node (for the hook + setup-user at runtime) and tar (for unpacking the .tgz). Windows 10+ ships tar.exe.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "install.ps1: 'node' not on PATH (need Node.js >= 20)."
}
if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
    throw "install.ps1: 'tar' not on PATH (Windows 10+ ships tar.exe; install BSD tar otherwise)."
}

# Stage the payload in a temp dir we clean up at the end (try/finally below).
# Ends up with bin\, lib\, VERSION after the tar extracts.
$Stage = Join-Path $env:TEMP ("jfrog-mcp-gate-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Stage -Force | Out-Null

try {
    $payload = Join-Path $Stage "payload.tgz"

    if ($Package) {
        if (-not (Test-Path $Package)) { throw "install.ps1: package not found: $Package" }
        Write-Host "==> Installing from local package: $Package"
        Copy-Item $Package $payload
    } else {
        # Resolve "latest" by fetching the LATEST file (one line of text,
        # the version number). Then download mcp-gate-<VER>.tgz.
        Write-Host "==> Resolving latest version from $Url/LATEST"
        $Version = (Invoke-WebRequest -UseBasicParsing -Uri "$Url/LATEST").Content.Trim()
        if (-not $Version) { throw "install.ps1: could not resolve version." }
        Write-Host "==> Installing jfrog-mcp-gate $Version from $Url"
        Invoke-WebRequest -UseBasicParsing -Uri "$Url/v$Version/mcp-gate-$Version.tgz" -OutFile $payload
    }

    tar -xzf $payload -C $Stage
    Remove-Item $payload

    foreach ($p in @("bin\jfrog-mcp-gate.mjs", "bin\jfrog-setup-user.mjs", "lib\config.mjs", "VERSION")) {
        if (-not (Test-Path (Join-Path $Stage $p))) { throw "install.ps1: payload missing $p" }
    }

    # Lay down the install root — Program Files inherits ACLs that give
    # Administrators write / Users read+execute, exactly what we want.
    Write-Host "==> Installing into $InstallRoot"
    if (Test-Path $InstallRoot) { Remove-Item -Recurse -Force $InstallRoot }
    New-Item -ItemType Directory -Path (Join-Path $InstallRoot "bin") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $InstallRoot "lib") -Force | Out-Null

    Copy-Item (Join-Path $Stage "bin\jfrog-mcp-gate.mjs")   (Join-Path $InstallRoot "bin\jfrog-mcp-gate.mjs")
    Copy-Item (Join-Path $Stage "bin\jfrog-setup-user.mjs") (Join-Path $InstallRoot "bin\jfrog-setup-user.mjs")
    Copy-Item (Join-Path $Stage "lib\config.mjs")           (Join-Path $InstallRoot "lib\config.mjs")
    Copy-Item (Join-Path $Stage "VERSION")                  (Join-Path $InstallRoot "VERSION")

    # Audit log — grant the BUILTIN\Users group Modify so the user-mode
    # hook + setup-user can append. ProgramData defaults are tighter.
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    if (-not (Test-Path $AuditLog)) { New-Item -ItemType File -Path $AuditLog -Force | Out-Null }
    $acl  = Get-Acl $AuditLog
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        "BUILTIN\Users", "Modify", "Allow")
    $acl.AddAccessRule($rule)
    Set-Acl $AuditLog $acl

    # Scheduled Task — Windows' equivalent of LaunchAgent/systemd-timer.
    # Runs at logon + every 1 min as the interactive user (so setup-user
    # can write under %USERPROFILE%\.jfrog\ and edit their settings.json).
    $setupBin   = Join-Path $InstallRoot "bin\jfrog-setup-user.mjs"
    $action     = New-ScheduledTaskAction -Execute "node.exe" -Argument "`"$setupBin`""
    $atLogon    = New-ScheduledTaskTrigger -AtLogOn

    # Windows doesn't have a "every-N-minutes-forever" trigger directly.
    # Workaround: a one-shot trigger starting in 1 min, with a 1-min
    # repetition interval and a very long repetition duration (~1 year).
    $repeat     = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
                    -RepetitionInterval (New-TimeSpan -Minutes 1) `
                    -RepetitionDuration (New-TimeSpan -Hours 9999)

    # Task settings — survive battery transitions so the heal-on-tick
    # keeps working on a laptop.
    $settings   = New-ScheduledTaskSettingsSet `
                    -AllowStartIfOnBatteries `
                    -DontStopIfGoingOnBatteries `
                    -StartWhenAvailable

    # Run the task as whoever is interactively logged in (not SYSTEM, not
    # a specific account). S-1-5-32-545 = the built-in "Users" group SID.
    $principal  = New-ScheduledTaskPrincipal -GroupId "S-1-5-32-545"

    # Unregister-then-register replaces any older task with the same name,
    # so reinstalls don't accumulate stale schedules.
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask `
        -TaskName    $TaskName `
        -Description "JFrog mcp-gate per-user setup (logon + every 60s)" `
        -Action      $action `
        -Trigger     @($atLogon, $repeat) `
        -Settings    $settings `
        -Principal   $principal | Out-Null

    # Kick the task once so the user doesn't have to wait for the timer.
    Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

} finally {
    Remove-Item -Recurse -Force $Stage -ErrorAction SilentlyContinue
}

# Done — print a "what next" hint

$installed = (Get-Content (Join-Path $InstallRoot "VERSION") -Raw).Trim()
Write-Host ""
Write-Host "==> Installed jfrog-mcp-gate $installed (windows)."
Write-Host ""
Write-Host "Per-user state appears on the next task tick (<=60s):"
Write-Host "  %USERPROFILE%\.jfrog\mcp-gate\vscode-hooks.json"
Write-Host "  chat.hookFilesLocations entry in VS Code user settings"
Write-Host ""
Write-Host "Next:"
Write-Host "  1. Push ChatHooks=1 via Group Policy"
Write-Host "       HKLM\Software\Policies\Microsoft\VSCode\ChatHooks  (REG_DWORD, 1)"
Write-Host "  2. Restart VS Code."
Write-Host "  3. Get-Content -Tail 0 -Wait $AuditLog"
Write-Host ""
Write-Host "Uninstall:"
Write-Host "  iwr -useb $Url/uninstall.ps1 | iex"
