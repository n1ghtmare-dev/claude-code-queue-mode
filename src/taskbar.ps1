# Claude Code Queue Mode - Windows taskbar and notification helper.
#
# Started by activity.js, one per editor window. Reads JSON commands, one per line, on stdin:
#   {"cmd":"capture","name":"ws","any":false} -> answers {"hwnd":N} for the foreground editor window
#                                               (its title must contain the workspace name unless "any")
#   {"cmd":"find","name":"ws"}                -> answers {"hwnd":N} for the only editor window titled with that workspace
#   {"cmd":"progress","hwnd":N,"state":"running|waiting|none"}
#   {"cmd":"flash","hwnd":N}
#   {"cmd":"toast","title":"...","body":"...","launch":"cursor://file/..."}
# Exits when stdin closes and clears the taskbar progress it has set.
param(
  [string]$AppName = 'Cursor',
  [string]$ExeName = 'Cursor.exe'
)

$ErrorActionPreference = 'Stop'

$source = @"
using System;
using System.Text;
using System.Runtime.InteropServices;

[ComImport, Guid("ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ICqTaskbarList3 {
  void HrInit();
  void AddTab(IntPtr hwnd);
  void DeleteTab(IntPtr hwnd);
  void ActivateTab(IntPtr hwnd);
  void SetActiveAlt(IntPtr hwnd);
  void MarkFullscreenWindow(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool fullscreen);
  void SetProgressValue(IntPtr hwnd, ulong completed, ulong total);
  void SetProgressState(IntPtr hwnd, int flags);
}

[ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090"), ClassInterface(ClassInterfaceType.None)]
public class CqTaskbarListClass {}

public static class CqTaskbar {
  const int NOPROGRESS = 0, INDETERMINATE = 1, PAUSED = 8;

  [StructLayout(LayoutKind.Sequential)]
  struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }

  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool FlashWindowEx(ref FLASHWINFO info);

  static ICqTaskbarList3 list;
  static ICqTaskbarList3 List {
    get {
      if (list == null) { list = (ICqTaskbarList3)new CqTaskbarListClass(); list.HrInit(); }
      return list;
    }
  }

  static bool IsEditor(IntPtr hwnd, string processName) {
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    try {
      return string.Equals(System.Diagnostics.Process.GetProcessById((int)pid).ProcessName, processName, StringComparison.OrdinalIgnoreCase);
    } catch { return false; }
  }

  // True when the window title contains the workspace name as a separate word group:
  // "file.ts - name - Cursor", "name - Cursor", "* name - Cursor" all match, "name2 - Cursor" does not.
  static bool TitleHasName(IntPtr hwnd, string name) {
    if (string.IsNullOrEmpty(name)) return false;
    var sb = new StringBuilder(1024);
    GetWindowText(hwnd, sb, sb.Capacity);
    string title = sb.ToString();
    int i = 0;
    while ((i = title.IndexOf(name, i, StringComparison.OrdinalIgnoreCase)) >= 0) {
      int end = i + name.Length;
      if ((i == 0 || title[i - 1] == ' ') && (end == title.Length || title[end] == ' ')) return true;
      i = end;
    }
    return false;
  }

  // The foreground editor window; unless any is set, only if its title carries the workspace name.
  public static long Foreground(string processName, string name, bool any) {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero || !IsEditor(h, processName)) return 0;
    if (!any && !TitleHasName(h, name)) return 0;
    return h.ToInt64();
  }

  // The only visible editor window whose title carries the workspace name.
  public static long FindByName(string processName, string name) {
    long found = 0;
    int count = 0;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (IsWindowVisible(h) && TitleHasName(h, name) && IsEditor(h, processName)) { found = h.ToInt64(); count++; }
      return true;
    }, IntPtr.Zero);
    return count == 1 ? found : 0;
  }

  public static bool Alive(long hwnd) { return hwnd != 0 && IsWindow(new IntPtr(hwnd)); }

  public static void Progress(long hwnd, string state) {
    if (!Alive(hwnd)) return;
    IntPtr h = new IntPtr(hwnd);
    if (state == "running") { List.SetProgressState(h, INDETERMINATE); }
    else if (state == "waiting") { List.SetProgressValue(h, 100, 100); List.SetProgressState(h, PAUSED); }
    else { List.SetProgressState(h, NOPROGRESS); }
  }

  public static void Flash(long hwnd) {
    if (!Alive(hwnd)) return;
    var info = new FLASHWINFO();
    info.cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO));
    info.hwnd = new IntPtr(hwnd);
    info.dwFlags = 2;   // FLASHW_TRAY: the button flashes, then stays highlighted until the window is activated
    info.uCount = 3;
    FlashWindowEx(ref info);
  }
}
"@

# Compiling takes a few seconds, so keep the compiled helper in %LOCALAPPDATA%\claude-queue.
$hash = [BitConverter]::ToString([Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($source))).Replace('-', '').Substring(0, 12)
$dll = Join-Path (Join-Path $env:LOCALAPPDATA 'claude-queue') ("CqTaskbar-" + $hash + ".dll")
try {
  if (-not (Test-Path $dll)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $dll) | Out-Null
    Add-Type -TypeDefinition $source -OutputAssembly $dll -OutputType Library
  }
  Add-Type -Path $dll
} catch {
  Add-Type -TypeDefinition $source
}

$processName = [IO.Path]::GetFileNameWithoutExtension($ExeName)
$script:aumid = $null
$script:progressHwnds = @{}

function Get-Aumid {
  if ($script:aumid) { return $script:aumid }
  $app = $null
  try { $app = Get-StartApps | Where-Object { $_.Name -eq $AppName } | Select-Object -First 1 } catch {}
  if ($app) { $script:aumid = $app.AppID }
  else { $script:aumid = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe' }
  return $script:aumid
}

function Show-Toast([string]$title, [string]$body, [string]$launch) {
  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $attrs = ''
  if ($launch) { $attrs = ' activationType="protocol" launch="' + [Security.SecurityElement]::Escape($launch) + '"' }
  $xml = '<toast' + $attrs + '><visual><binding template="ToastGeneric"><text>' + [Security.SecurityElement]::Escape($title) +
    '</text><text>' + [Security.SecurityElement]::Escape($body) + '</text></binding></visual></toast>'
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier((Get-Aumid)).Show($toast)
}

function Reply($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

$stdin = New-Object IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
try {
  while ($true) {
    $line = $stdin.ReadLine()
    if ($null -eq $line) { break }
    if (-not $line.Trim()) { continue }
    try {
      $m = $line | ConvertFrom-Json
      switch ($m.cmd) {
        'capture' { Reply @{ hwnd = [CqTaskbar]::Foreground($processName, [string]$m.name, [bool]$m.any) } }
        'find' { Reply @{ hwnd = [CqTaskbar]::FindByName($processName, [string]$m.name) } }
        'progress' {
          $hwnd = [long]$m.hwnd
          [CqTaskbar]::Progress($hwnd, [string]$m.state)
          if ($m.state -eq 'none') { $script:progressHwnds.Remove($hwnd) } else { $script:progressHwnds[$hwnd] = $true }
        }
        'flash' { [CqTaskbar]::Flash([long]$m.hwnd) }
        'toast' { Show-Toast ([string]$m.title) ([string]$m.body) ([string]$m.launch) }
        'ping' { Reply @{ pong = $true } }
      }
    } catch {
      [Console]::Error.WriteLine("claude-queue taskbar: " + $_.Exception.Message)
    }
  }
} finally {
  foreach ($h in @($script:progressHwnds.Keys)) { try { [CqTaskbar]::Progress([long]$h, 'none') } catch {} }
}
