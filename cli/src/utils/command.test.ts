import { describe, expect, it } from "vitest";
import {
  getCommandCheck,
  getWindowsSystemCommand,
  isCommandAvailable,
  resolveCommandPath,
} from "./command";

describe("getCommandCheck", () => {
  it("starts where.exe by its full path on Windows", () => {
    expect(getCommandCheck("node", "win32")).toEqual({
      command: getWindowsSystemCommand("where.exe"),
      args: ["node"],
    });
  });

  it("passes the name to the command -v builtin as an argument elsewhere", () => {
    for (const currentPlatform of ["linux", "darwin"] as const) {
      expect(getCommandCheck("systemctl", currentPlatform)).toEqual({
        command: "/bin/sh",
        args: ["-c", 'command -v "$1"', "sh", "systemctl"],
      });
    }
  });
});

describe("isCommandAvailable", () => {
  it("returns true for commands that exist", () => {
    // Use 'node' which exists on all platforms in CI
    expect(isCommandAvailable("node")).toBe(true);
  });

  it("returns false for commands that do not exist", () => {
    expect(isCommandAvailable("nonexistent_command_xyz_12345")).toBe(false);
  });

  it("does not let a shell interpret the command name", () => {
    expect(isCommandAvailable("node && exit 0")).toBe(false);
  });
});

describe("getWindowsSystemCommand", () => {
  it("builds the path under SystemRoot", () => {
    expect(getWindowsSystemCommand("cmd.exe", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\cmd.exe",
    );
    expect(getWindowsSystemCommand("cmd.exe", {})).toBe(
      "C:\\Windows\\System32\\cmd.exe",
    );
  });
});

describe("resolveCommandPath", () => {
  const existing = new Set([
    "c:\\tools\\sqlite3.exe",
    "c:\\program files\\powershell\\7\\pwsh.exe",
    "sqlite3.exe",
  ]);
  // Windows file names match case-insensitively; PATHEXT is upper case.
  const exists = (path: string) => existing.has(path.toLowerCase());

  it("finds a bare name on PATH and never in the current directory", () => {
    // A relative entry such as "." would search the current directory again,
    // and "sqlite3.exe" exists there in this fixture.
    expect(
      resolveCommandPath("sqlite3", {
        platform: "win32",
        env: { PATH: ".;C:\\missing;C:\\tools", PATHEXT: ".COM;.EXE" },
        exists,
      }),
    ).toBe("C:\\tools\\sqlite3.EXE");
  });

  it("accepts quoted PATH entries and names with an extension", () => {
    expect(
      resolveCommandPath("pwsh.exe", {
        platform: "win32",
        env: { Path: '"C:\\Program Files\\PowerShell\\7"' },
        exists,
      }),
    ).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  });

  it("returns null instead of falling back to the current directory", () => {
    expect(
      resolveCommandPath("sqlite3", {
        platform: "win32",
        env: { PATH: "." },
        exists,
      }),
    ).toBeNull();
  });

  it("leaves names alone elsewhere and paths everywhere", () => {
    expect(resolveCommandPath("sqlite3", { platform: "linux", exists })).toBe(
      "sqlite3",
    );
    expect(
      resolveCommandPath("C:\\bin\\sqlite3.exe", { platform: "win32", exists }),
    ).toBe("C:\\bin\\sqlite3.exe");
  });
});
