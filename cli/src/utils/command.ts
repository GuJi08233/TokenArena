import { execFileSync } from "node:child_process";
import { platform } from "node:os";

export interface CommandCheck {
  command: string;
  args: string[];
}

/**
 * Build the process that checks whether a command is available in PATH.
 * Uses `where` on Windows and the `command -v` builtin elsewhere.
 */
export function getCommandCheck(
  command: string,
  currentPlatform: NodeJS.Platform = platform(),
): CommandCheck {
  if (currentPlatform === "win32") {
    // 直接启动 where.exe；经 cmd.exe 转一道会多建一个进程，CI 高负载时曾因此超过 5 秒。
    return { command: "where", args: [command] };
  }

  // command -v 是 shell 内建命令，只能交给 sh；命令名作为位置参数传入，不拼进脚本。
  return { command: "/bin/sh", args: ["-c", 'command -v "$1"', "sh", command] };
}

/**
 * Check if a command is available in PATH.
 *
 * @param command - The command name to check (e.g., 'systemctl', 'git')
 * @returns true if the command exists, false otherwise
 */
export function isCommandAvailable(command: string): boolean {
  const check = getCommandCheck(command);

  try {
    execFileSync(check.command, check.args, { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
