import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { normalizeArgv } from "./index";

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SPAWN_TIMEOUT_MS = 60_000;

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
  const stateDir = mkdtempSync(join(tmpdir(), "tokenarena-entry-"));

  afterAll(() => {
    rmSync(stateDir, { force: true, recursive: true });
  });

  // Guards the `isMainModule` wiring: the unbundled sources must behave like the
  // bundled dist/index.js, otherwise `pnpm dev:cli` silently does nothing.
  it(
    "runs the CLI when executed directly through tsx",
    () => {
      const require = createRequire(import.meta.url);
      // The same entry `pnpm dev:cli` runs, so this inherits tsx's own Node
      // version gating instead of hard-requiring `--import` (Node >= 20.6.0).
      const tsxCli = require.resolve("tsx/cli");
      const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
      const { version } = JSON.parse(
        readFileSync(join(CLI_ROOT, "package.json"), "utf-8"),
      ) as { version: string };

      const output = execFileSync(
        process.execPath,
        [tsxCli, entry, "--version"],
        {
          cwd: CLI_ROOT,
          encoding: "utf-8",
          timeout: SPAWN_TIMEOUT_MS,
          killSignal: "SIGKILL",
          windowsHide: true,
          // This spawns the real CLI, which binds its config/state paths at
          // module load. Redirect them at a throwaway directory so the test can
          // never touch the developer's own ~/.tokenarena.
          env: {
            ...process.env,
            TOKEN_ARENA_DEV: "1",
            XDG_CONFIG_HOME: join(stateDir, "config"),
            XDG_STATE_HOME: join(stateDir, "state"),
            XDG_DATA_HOME: join(stateDir, "data"),
            XDG_CACHE_HOME: join(stateDir, "cache"),
            XDG_RUNTIME_DIR: join(stateDir, "runtime"),
          },
        },
      );

      // Exact match: a negative assertion would still pass if the lookup walked
      // past cli/package.json into the workspace root, whose version release
      // tooling keeps identical.
      expect(output.trim()).toBe(version);
    },
    SPAWN_TIMEOUT_MS + 5_000,
  );
});
