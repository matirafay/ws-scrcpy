param(
    [Parameter(Mandatory = $true)][string]$OutPath,
    [switch]$SkipPrintWindow
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing | Out-Null
Add-Type @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public class ScrcpyCap {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, int nFlags);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static IntPtr FindVideoWindow() {
    var pids = new HashSet<int>();
    foreach (var proc in Process.GetProcessesByName("scrcpy")) { pids.Add(proc.Id); }
    IntPtr best = IntPtr.Zero;
    int bestScore = -1;
    EnumWindows((hWnd, lParam) => {
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      if (!pids.Contains((int)pid) || !IsWindowVisible(hWnd)) return true;
      var cls = new StringBuilder(256);
      var ttl = new StringBuilder(256);
      GetClassName(hWnd, cls, 256);
      GetWindowText(hWnd, ttl, 256);
      string className = cls.ToString();
      string title = ttl.ToString();
      if (className == "ConsoleWindowClass") return true;
      if (title.StartsWith("scrcpy -", StringComparison.OrdinalIgnoreCase)) return true;
      RECT rect;
      GetWindowRect(hWnd, out rect);
      int width = Math.Max(0, rect.Right - rect.Left);
      int height = Math.Max(0, rect.Bottom - rect.Top);
      int area = width * height;
      if (area < 200 * 200) return true;
      int score = area;
      if (className.IndexOf("SDL", StringComparison.OrdinalIgnoreCase) >= 0) score += 100000000;
      if (score > bestScore) { bestScore = score; best = hWnd; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
"@
try { [void][ScrcpyCap]::SetProcessDPIAware() } catch { }

function Get-ScrcpyWindow {
    $hwnd = [ScrcpyCap]::FindVideoWindow()
    if ($hwnd -eq [IntPtr]::Zero) { return $null }
    [void][ScrcpyCap]::ShowWindow($hwnd, 9) # SW_RESTORE
    Start-Sleep -Milliseconds 120
    $rect = New-Object ScrcpyCap+RECT
    [void][ScrcpyCap]::GetWindowRect($hwnd, [ref]$rect)
    $w = [Math]::Max(0, $rect.Right - $rect.Left)
    $h = [Math]::Max(0, $rect.Bottom - $rect.Top)
    [pscustomobject]@{
        Hwnd = $hwnd
        Rect = $rect
        W = $w
        H = $h
        Area = $w * $h
    }
}

$win = Get-ScrcpyWindow
if (-not $win) {
    throw 'scrcpy window not found - start scrcpy and show the phone screen'
}
if ($win.Area -lt (200 * 200)) {
    throw "scrcpy window too small $($win.W)x$($win.H) - maximize/restore scrcpy so the phone is visible"
}

[void][ScrcpyCap]::SetForegroundWindow($win.Hwnd)
Start-Sleep -Milliseconds 150
# Re-read rect after foreground
$rect = New-Object ScrcpyCap+RECT
[void][ScrcpyCap]::GetWindowRect($win.Hwnd, [ref]$rect)
$w = [Math]::Max(1, $rect.Right - $rect.Left)
$h = [Math]::Max(1, $rect.Bottom - $rect.Top)

function Save-Bmp([System.Drawing.Bitmap]$Bitmap, [string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    }
    $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function Get-FileSize([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    return (Get-Item -LiteralPath $Path).Length
}

if (-not $SkipPrintWindow) {
    $printed = New-Object System.Drawing.Bitmap $w, $h
    $gp = [System.Drawing.Graphics]::FromImage($printed)
    $hdc = $gp.GetHdc()
    try {
        [void][ScrcpyCap]::PrintWindow($win.Hwnd, $hdc, 2)
    } finally {
        $gp.ReleaseHdc($hdc)
    }
    try {
        Save-Bmp $printed $OutPath
    } finally {
        $gp.Dispose()
        $printed.Dispose()
    }
    if ((Get-FileSize $OutPath) -ge 8000) {
        Write-Output $OutPath
        exit 0
    }
}

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
    $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
    Save-Bmp $bmp $OutPath
} finally {
    $g.Dispose()
    $bmp.Dispose()
}

$size = Get-FileSize $OutPath
if ($size -lt 8000) {
    throw "scrcpy capture blank/too small bytes=$size (${w}x${h})"
}
Write-Output $OutPath
