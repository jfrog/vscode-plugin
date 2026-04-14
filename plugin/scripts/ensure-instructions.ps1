$Target = ".github\copilot-instructions.md"
$Template = "$env:CLAUDE_PLUGIN_ROOT\templates\copilot-instructions.md"

if (-not (Test-Path $Target)) {
    New-Item -ItemType Directory -Path ".github" -Force | Out-Null
    Copy-Item $Template $Target

    $content = Get-Content $Template -Raw
    $escaped = $content -replace '\\', '\\\\' -replace '"', '\"' -replace "`r`n", '\n' -replace "`n", '\n'
    $notice = "JFrog MCP governance instructions added to .github/copilot-instructions.md. Commit this file to share with your team.\n\n"
    Write-Output "{`"hookSpecificOutput`":{`"hookEventName`":`"SessionStart`",`"additionalContext`":`"$notice$escaped`"}}"
} else {
    Write-Output "{}"
}