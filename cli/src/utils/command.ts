import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { win32 } from "node:path";

export interface CommandCheck {
  command: string;
  args: string[];
}

/**
 * A Windows system program, by its full path under `%SystemRoot%`.
 *
 * Starting a bare name makes Windows look in the current directory first.
 */
export function getWindowsSystemCommand(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  return win32.join(
    env.SystemRoot || env.SYSTEMROOT || "C:\\Windows",
    "System32",
    name,
  );
}

/**
 * Resolve a bare program name through `PATH` alone on Windows.
 *
 * Windows looks in the current directory before `PATH` when it starts a bare
 * name, so `tokenarena sync` run inside a folder holding a planted
 * `sqlite3.exe` ran that file, and the daemon ran it again on every interval.
 * libuv honors `NoDefaultCurrentDirectoryInExePath` only from 1.48, which is
 * newer than early Node 20 releases. Returns `null` when the program is not on
 * `PATH`. Off Windows, or for a name that already holds a path, the name is
 * returned unchanged.
 */
export function resolveCommandPath(
  command: string,
  options: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    exists?: (path: string) => boolean;
  } = {},
): string | null {
  if ((options.platform ?? platform()) !== "win32" || /[\\/]/.test(command)) {
    return command;
  }

  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const extensions = win32.extname(command)
    ? [""]
    : (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);

  for (const entry of (env.PATH || env.Path || "").split(";")) {
    const dir = entry.trim().replaceAll('"', "");

    // A relative entry would search the current directory after all.
    if (!dir || !win32.isAbsolute(dir)) continue;

    for (const extension of extensions) {
      const candidate = win32.join(dir, `${command}${extension}`);
      if (exists(candidate)) return candidate;
    }
  }

  return null;
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
    return { command: getWindowsSystemCommand("where.exe"), args: [command] };
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
