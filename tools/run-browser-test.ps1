# Runs a page in headful Edge and waits for it to POST results back.
#
# Headful is mandatory: headless Chromium ships no platform HEVC decoder, so a
# headless run reports every codec in these files as unsupported.
#
# The window must also be FOREGROUND. Chromium defers media element loading
# while document.hidden is true, so a background window leaves MediaSource
# stuck in "closed" and every playback check fails for a reason that has
# nothing to do with the player.
param(
  [string]$Page = 'public/autotest.html',
  [int]$TimeoutSec = 480,
  [string]$Root = 'D:\xiaochengxu\webplayer'
)

$ErrorActionPreference = 'Stop'
Set-Location $Root

Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process node   -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 1500
Remove-Item 'probe-result.txt' -ErrorAction SilentlyContinue

Start-Process node -ArgumentList 'tools/serve.mjs', $Root -WindowStyle Hidden
Start-Sleep -Milliseconds 1200

$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$proc = Start-Process $edge -PassThru -ArgumentList `
  '--new-window', '--window-position=0,0', '--window-size=1280,900',
  '--autoplay-policy=no-user-gesture-required',
  "http://localhost:8080/$Page"

# Pull the window to the front, then keep it there: Edge spawns several
# processes and the one owning the window is not always the one we launched.
Start-Sleep -Seconds 3
$shell = New-Object -ComObject WScript.Shell
foreach ($p in Get-Process msedge -ErrorAction SilentlyContinue) {
  if ($p.MainWindowTitle) { $null = $shell.AppActivate($p.Id) }
}
$null = $shell.AppActivate($proc.Id)

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$lastSize = -1
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  if (Test-Path 'probe-result.txt') {
    $content = Get-Content 'probe-result.txt' -Raw
    if ($content -match 'ALL BROWSER CHECKS PASSED|CHECK\(S\) FAILED|ALL CHECKS PASSED') { break }
    # nudge the window forward again if the run has stalled with no new output
    if ($content.Length -eq $lastSize) { $null = $shell.AppActivate($proc.Id) }
    $lastSize = $content.Length
  }
}

if (Test-Path 'probe-result.txt') { Get-Content 'probe-result.txt' -Raw }
else { "TIMEOUT: no results posted within ${TimeoutSec}s" }
