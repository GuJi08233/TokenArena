import { execSync } from "node:child_process";
import { platform } from "node:os";

/**
 * Check if a command is available in PATH.
 * Uses `command -v` on Unix and `where` on Windows.
 *
 * @param command - The command name to check (e.g., 'systemctl', 'git')
 * @returns true if the command exists, false otherwise
 */
export function isCommandAvailable(command: string): boolean {
  try {
    const check =
      platform() === "win32" ? `where ${command}` : `command -v ${command}`;
    execSync(check, { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
