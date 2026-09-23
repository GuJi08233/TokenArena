import { describe, expect, it } from "vitest";
import { getCommandCheck, isCommandAvailable } from "./command";

describe("getCommandCheck", () => {
  it("starts where.exe directly on Windows", () => {
    expect(getCommandCheck("node", "win32")).toEqual({
      command: "where",
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
