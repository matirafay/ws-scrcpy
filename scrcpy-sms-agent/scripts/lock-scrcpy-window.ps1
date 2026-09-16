# Hide the scrcpy console and disable the phone-window Close button.
# Taskbar "Close window" can still kill it; the agent watchdog restarts it.
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public class ScrcpyLock {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetSystemMenu(IntPtr hWnd, bool bRevert);
  [DllImport("user32.dll")] public static extern bool DeleteMenu(IntPtr hMenu, uint uPosition, uint uFlags);
  [DllImport("user32.dll")] public static extern bool DrawMenuBar(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  const uint SC_CLOSE = 0xF060;
  const uint MF_BYCOMMAND = 0;
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  const uint SWP_NOMOVE = 0x0002;
  const uint SWP_NOSIZE = 0x0001;
  const uint SWP_SHOWWINDOW = 0x0040;

  public static string Apply() {
    var pids = new HashSet<int>();
    foreach (var proc in Process.GetProcessesByName("scrcpy")) { pids.Add(proc.Id); }
    if (pids.Count == 0) return "scrcpy not running";
    IntPtr video = IntPtr.Zero;
    int bestScore = -1;
    int hiddenConsoles = 0;
    EnumWindows((hWnd, lParam) => {
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      var cls = new StringBuilder(256);
      var ttl = new StringBuilder(256);
      GetClassName(hWnd, cls, 256);
      GetWindowText(hWnd, ttl, 256);
      string className = cls.ToString();
      string title = ttl.ToString();
      bool isScrcpyLog =
          className == "ConsoleWindowClass" ||
          className == "CASCADIA_HOSTING_WINDOW_CLASS" && title.IndexOf("scrcpy", StringComparison.OrdinalIgnoreCase) >= 0 ||
          title.StartsWith("scrcpy -", StringComparison.OrdinalIgnoreCase);
      if (isScrcpyLog && IsWindowVisible(hWnd)) {
        ShowWindow(hWnd, 6); // SW_MINIMIZE — do not close; that kills the phone mirror
        hiddenConsoles++;
        return true;
      }
      if (!pids.Contains((int)pid)) return true;
      if (!IsWindowVisible(hWnd)) return true;
      RECT rect;
      GetWindowRect(hWnd, out rect);
      int area = Math.Max(0, rect.Right - rect.Left) * Math.Max(0, rect.Bottom - rect.Top);
      if (area < 200 * 200) return true;
      int score = area;
      if (className.IndexOf("SDL", StringComparison.OrdinalIgnoreCase) >= 0) score += 100000000;
      if (score > bestScore) { bestScore = score; video = hWnd; }
      return true;
    }, IntPtr.Zero);
    if (video == IntPtr.Zero) return "video window not found (hiddenConsoles=" + hiddenConsoles + ")";
    ShowWindow(video, 9); // SW_RESTORE
    IntPtr menu = GetSystemMenu(video, false);
    if (menu != IntPtr.Zero) {
      DeleteMenu(menu, SC_CLOSE, MF_BYCOMMAND);
      DrawMenuBar(video);
    }
    SetWindowPos(video, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    return "locked hwnd=" + video.ToInt64() + " hiddenConsoles=" + hiddenConsoles;
  }
}
"@
Write-Output ([ScrcpyLock]::Apply())
