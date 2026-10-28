#requires -Version 5.1
[CmdletBinding()]
param([switch] $LinksOnly)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$entry = Join-Path $PSScriptRoot 'scripts/setup.mjs'
if (-not $LinksOnly) {
    & node $entry prepare
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

& node $entry link
$code = $LASTEXITCODE
if ($code -eq 77 -and -not $LinksOnly) {
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -LinksOnly'
    $child = Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments -PassThru -Wait
    $code = $child.ExitCode
}
if ($code -ne 0) { exit $code }
if (-not $LinksOnly) {
    & node $entry finish
    exit $LASTEXITCODE
}
exit 0
