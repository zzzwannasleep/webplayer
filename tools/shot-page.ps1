# Launches ONE page windowed, waits, and screenshots the actual composited
# screen to a PNG. Every JS-side measurement reads the <video> element's
# decoded frame, which stays live even when the browser composites BLACK to the
# real display (hardware-overlay hole-punch under a transparent overlay canvas).
# A screenshot is the only oracle that sees what the user actually sees.
param(
  [string]$Page = 'public/assdiag.html',
  [int]$WaitSec = 60,
  [string]$Root = 'D:\xiaochengxu\webplayer',
  [string]$Out = 'D:\xiaochengxu\webplayer\shot.png'
)
Set-Location $Root
try { Get-Process msedge -ErrorAction Stop | Stop-Process -Force } catch {}
try { Get-Process node   -ErrorAction Stop | Stop-Process -Force } catch {}
Start-Sleep -Milliseconds 1500

Start-Process node -ArgumentList 'tools/serve.mjs', $Root -WindowStyle Hidden
Start-Sleep -Milliseconds 1500

$profileDir = Join-Path $env:TEMP ("edge-shot-" + [guid]::NewGuid().ToString('N'))
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
Start-Process $edge -ArgumentList `
  '-inprivate', '--disable-sync', '--disable-features=msImplicitSignin,ImplicitSignin,CalculateNativeWinOcclusion',
  "--user-data-dir=$profileDir", '--no-first-run', '--no-default-browser-check',
  '--new-window', '--window-position=0,0', '--window-size=1280,900',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  "http://localhost:8080/$Page"

Start-Sleep -Seconds 3
$shell = New-Object -ComObject WScript.Shell
foreach ($p in Get-Process msedge -ErrorAction SilentlyContinue) {
  if ($p.MainWindowTitle) { $null = $shell.AppActivate($p.Id) }
}

Write-Output "waiting ${WaitSec}s for the ASS state to establish..."
Start-Sleep -Seconds $WaitSec

# CopyFromScreen grabs whatever is topmost at (0,0) -- the only way to capture a
# hardware-overlay video (PrintWindow would show black for the overlay plane).
# So Edge MUST be foreground at capture time. Windows blocks a background process
# from stealing foreground, so inject an ALT keystroke first: that lifts the
# foreground-change lock, after which SetForegroundWindow is honoured.
$sig = @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern void keybd_event(byte b, byte s, uint f, IntPtr e);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
'@
$u = Add-Type -MemberDefinition $sig -Name W -Namespace N -PassThru
$edgeHwnd = [IntPtr]::Zero
foreach ($p in Get-Process msedge -ErrorAction SilentlyContinue) {
  if ($p.MainWindowHandle -ne 0 -and $p.MainWindowTitle) { $edgeHwnd = $p.MainWindowHandle; $edgeId = $p.Id }
}
# Retry until Edge is genuinely foreground -- otherwise CopyFromScreen captures
# whatever else is on top. The ALT keystroke lifts the foreground-change lock.
$isFg = $false
for ($i = 0; $i -lt 20 -and -not $isFg; $i++) {
  $u::keybd_event(0x12, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 40
  $u::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
  $null = $u::ShowWindow($edgeHwnd, 9)          # SW_RESTORE
  $null = $u::BringWindowToTop($edgeHwnd)
  $null = $u::SetForegroundWindow($edgeHwnd)
  try { $null = $shell.AppActivate($edgeId) } catch {}
  Start-Sleep -Milliseconds 400
  $isFg = ($u::GetForegroundWindow() -eq $edgeHwnd)
}
if (-not $isFg) { Write-Output "WARN: Edge is not foreground; capture may be wrong" }
Start-Sleep -Milliseconds 600

Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 1280, 900
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(0, 0, 0, 0, (New-Object System.Drawing.Size 1280, 900))
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "saved $Out"

if (Test-Path 'probe-result.txt') { Get-Content 'probe-result.txt' -Raw }
try { Get-Process msedge -ErrorAction Stop | Stop-Process -Force } catch {}
Start-Sleep -Milliseconds 800
Remove-Item $profileDir -Recurse -Force -ErrorAction Ignore
