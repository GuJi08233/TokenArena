import { describe, expect, it } from "vitest";
import {
  getManagedServiceEnvironment,
  resolveManagedDaemonCommand,
} from "./utils";

describe("resolveManagedDaemonCommand", () => {
  it("appends daemon service mode arguments", () => {
    expect(
      resolveManagedDaemonCommand("/usr/local/bin/node", [
        "node",
        "/tmp/tokenarena/dist/index.js",
      ]),
    ).toEqual({
      execPath: "/usr/local/bin/node",
      args: ["/tmp/tokenarena/dist/index.js", "daemon", "--service"],
    });
  });

  it("throws when the CLI entry path is missing", () => {
    expect(() =>
      resolveManagedDaemonCommand("/usr/local/bin/node", ["node"]),
    ).toThrowError(/无法解析 CLI 入口路径/);
  });

  it.each([
    "/repo/cli/src/index.ts",
    "/repo/cli/src/index.mts",
    "/repo/cli/src/index.tsx",
  ])("refuses to install a service for the unbundled entry %s", (entry) => {
    // The unit file runs plain `node <entry>`, which cannot load TypeScript.
    expect(() =>
      resolveManagedDaemonCommand("/usr/local/bin/node", ["node", entry]),
    ).toThrowError(/未打包的 TypeScript 入口/);
  });
});

describe("getManagedServiceEnvironment", () => {
  it("merges path fallbacks and preserves supported XDG variables", () => {
    expect(
      getManagedServiceEnvironment({
        PATH: "/custom/bin:/usr/local/bin",
        TOKEN_ARENA_DEV: "1",
        XDG_CONFIG_HOME: "/tmp/config",
      }),
    ).toEqual({
      PATH: "/custom/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      TOKEN_ARENA_DEV: "1",
      XDG_CONFIG_HOME: "/tmp/config",
    });
  });
});
