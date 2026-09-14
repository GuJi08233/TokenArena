import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { normalizeArgv } from "./index";

describe("normalizeArgv", () => {
  it("removes standalone pnpm separators before commander parsing", () => {
    expect(normalizeArgv(["node", "tokenarena", "--", "--help"])).toEqual([
      "node",
      "tokenarena",
      "--help",
    ]);
  });
});

describe("entry point", () => {
  // Guards the `isMainModule` wiring: the unbundled sources must behave like the
  // bundled dist/index.js, otherwise `pnpm dev:cli` silently does nothing.
  it("runs the CLI when executed directly through tsx", () => {
    const cliRoot = fileURLToPath(new URL("..", import.meta.url));
    const entry = fileURLToPath(new URL("./index.ts", import.meta.url));

    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", entry, "--version"],
      { cwd: cliRoot, encoding: "utf-8" },
    );

    expect(output.trim()).not.toBe("");
    expect(output.trim()).not.toBe("0.0.0");
  });
});
