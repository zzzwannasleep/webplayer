# Runs ONE page in a clean, foreground Edge and waits for it to POST results.
#
# Split out of run-browser-test.ps1 because that script inherited whatever tabs
# Edge felt like restoring: a stale autotest tab raced the page under test and
# POSTed its own results first, so the harness reported a run that never
# happened. A throwaway --user-data-dir is the only way to guarantee the window
# contains exactly the page asked for.
param(
  [string]$Page = 'public/autotest.html',
  [int]$TimeoutSec = 480,
  [string]$Root = 'D:\xiaochengxu\webplayer',
  # A subtitle raster is sized by CSS pixels TIMES devicePixelRatio, so the
  # resolution cap only engages on a big or HiDPI screen. Forcing the scale
  # factor is how a 1280x900 test window reproduces what a 4K panel does.
  [double]$DeviceScale = 1
)

Set-Location $Root
try { Get-Process msedge -ErrorAction Stop | Stop-Process -Force } catch {}
try { Get-Process node   -ErrorAction Stop | Stop-Process -Force } catch {}
Start-Sleep -Milliseconds 1500
Remove-Item 'probe-result.txt' -ErrorAction Ignore

Start-Process node -ArgumentList 'tools/serve.mjs', $Root -WindowStyle Hidden
Start-Sleep -Milliseconds 1500

$profileDir = Join-Path $env:TEMP ("edge-run-" + [guid]::NewGuid().ToString('N'))
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$proc = Start-Process $edge -PassThru -ArgumentList `
  "--user-data-dir=$profileDir", '--no-first-run', '--no-default-browser-check',
  '--new-window', '--window-position=0,0', '--window-size=1280,900',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion',
  "--force-device-scale-factor=$DeviceScale",
  "http://localhost:8080/$Page"

Start-Sleep -Seconds 3
$shell = New-Object -ComObject WScript.Shell
foreach ($p in Get-Process msedge -ErrorAction SilentlyContinue) {
  if ($p.MainWindowTitle) { $null = $shell.AppActivate($p.Id) }
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
$lastSize = -1
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  if (Test-Path 'probe-result.txt') {
    $c = Get-Content 'probe-result.txt' -Raw
    if ($c -match 'ALL BROWSER CHECKS PASSED|CHECK\(S\) FAILED|DIAG DONE') { break }
    if ($c.Length -eq $lastSize) { $null = $shell.AppActivate($proc.Id) }
    $lastSize = $c.Length
  }
}

if (Test-Path 'probe-result.txt') { Get-Content 'probe-result.txt' -Raw }
else { "TIMEOUT: no results within ${TimeoutSec}s" }

try { Get-Process msedge -ErrorAction Stop | Stop-Process -Force } catch {}
Start-Sleep -Milliseconds 800
Remove-Item $profileDir -Recurse -Force -ErrorAction Ignore
