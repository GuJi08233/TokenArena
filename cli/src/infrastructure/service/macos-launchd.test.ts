import { describe, expect, it } from "vitest";
import {
  buildLaunchdPlist,
  getMacosLaunchAgentFile,
  getMacosLaunchdLogPaths,
  getMacosLaunchdServiceTarget,
  MACOS_LAUNCHD_LABEL,
} from "./macos-launchd";

describe("buildLaunchdPlist", () => {
  it("writes a launch agent plist for daemon service mode", () => {
    const plist = buildLaunchdPlist({
      label: MACOS_LAUNCHD_LABEL,
      programArguments: [
        "/opt/homebrew/bin/node",
        "/tmp/tokenarena/dist/index.js",
        "daemon",
        "--service",
      ],
      environment: {
        PATH: "/opt/homebrew/bin:/usr/bin",
      },
      workingDirectory: "/Users/tester",
      standardOutPath:
        "/Users/tester/.local/state/tokenarena/launchd.stdout.log",
      standardErrorPath:
        "/Users/tester/.local/state/tokenarena/launchd.stderr.log",
    });

    expect(plist).toContain(`<string>${MACOS_LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<false/>");
    expect(plist).toContain("<string>Background</string>");
    expect(plist).toContain("<string>--service</string>");
  });
});

describe("launchd path helpers", () => {
  it("builds the expected agent file and service target", () => {
    expect(getMacosLaunchAgentFile("/Users/tester")).toBe(
      "/Users/tester/Library/LaunchAgents/com.guji.tokenarena.plist",
    );
    expect(getMacosLaunchdServiceTarget(501)).toBe(
      "gui/501/com.guji.tokenarena",
    );
    expect(
      getMacosLaunchdLogPaths("/Users/tester/.local/state/tokenarena"),
    ).toEqual({
      stdoutPath: "/Users/tester/.local/state/tokenarena/launchd.stdout.log",
      stderrPath: "/Users/tester/.local/state/tokenarena/launchd.stderr.log",
    });
  });
});
