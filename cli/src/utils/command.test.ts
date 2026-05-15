import { describe, expect, it } from "vitest";
import { isCommandAvailable } from "./command";

describe("isCommandAvailable", () => {
  it("returns true for commands that exist", () => {
    // 'ls' should exist on macOS/Linux
    expect(isCommandAvailable("ls")).toBe(true);
  });

  it("returns false for commands that do not exist", () => {
    expect(isCommandAvailable("nonexistent_command_xyz_12345")).toBe(false);
  });
});
