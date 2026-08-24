import { execFileSync } from "node:child_process";

const WINDOWS_CLIPBOARD_FILE_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "[System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { $_ }",
].join("; ");

export function readClipboardFilePaths({
  platform = process.platform,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (platform !== "win32") return [];
  try {
    const result = execFileSyncImpl("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_CLIPBOARD_FILE_SCRIPT,
    ], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
    return String(result || "")
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

