import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MuseParser } from "../parsers/muse";
import type { MuseExportRecord } from "../services/muse-export";
import { useTempDirs } from "../testing/temp-dir";
import {
  createPsqlRunner,
  defaultMuseCommandDeps,
  type ExecFileAsync,
  type MuseCommandDeps,
  runMuseExportCommand,
  runMuseQueryCommand,
} from "./muse";

const makeTempDir = useTempDirs();

const BASE_TS = 1_793_000_000;

const ROWS_JSONL = [
  {
    ts: BASE_TS,
    messageId: "m1",
    sessionId: "s1",
    agentId: "a1",
    model: "ipnext/avocado-5.16-v1",
    inputTokens: 100,
    outputTokens: 10,
  },
  {
    ts: BASE_TS + 60,
    messageId: "m2",
    sessionId: "s1",
    agentId: "a1",
    inputTokens: 150,
    outputTokens: 12,
  },
]
  .map((r) => JSON.stringify(r))
  .join("\n");

function stubDeps(overrides: Partial<MuseCommandDeps> = {}): {
  deps: MuseCommandDeps;
  written: { records: MuseExportRecord[]; targetPath: string }[];
  printed: string[];
} {
  const written: { records: MuseExportRecord[]; targetPath: string }[] = [];
  const printed: string[] = [];
  const deps: MuseCommandDeps = {
    readStdin: async () => ROWS_JSONL,
    readFile: () => ROWS_JSONL,
    runPsql: async () => ROWS_JSONL,
    writeExport: (records, targetPath) => {
      written.push({ records, targetPath });
    },
    stdinIsTTY: () => false,
    print: (text) => printed.push(text),
    log: () => {},
    ...overrides,
  };
  return { deps, written, printed };
}

describe("runMuseQueryCommand", () => {
  it("prints only the rows query, terminated for direct execution", async () => {
    const { deps, printed } = stubDeps();
    await runMuseQueryCommand({}, deps);
    const output = printed.join("");
    expect(output).toContain("agent.agent_message_token_usage");
    expect(output).toContain("json_build_object");
    expect(output).not.toContain("sum(input_tokens)");
    expect(output.trimEnd()).toMatch(/;$/);
  });

  it("prints only the totals query with --totals", async () => {
    const { deps, printed } = stubDeps();
    await runMuseQueryCommand({ totals: true }, deps);
    const output = printed.join("");
    expect(output).toContain("sum(input_tokens)");
    expect(output).not.toContain("json_build_object");
    expect(output.trimEnd()).toMatch(/;$/);
  });
});

describe("runMuseExportCommand", () => {
  it("builds the export from stdin rows", async () => {
    const { deps, written } = stubDeps();
    const summary = await runMuseExportCommand(
      { output: "/tmp/out/token-usage.jsonl" },
      deps,
    );
    expect(summary).toEqual({
      records: 2,
      inputTokens: 250,
      outputTokens: 22,
      targetPath: "/tmp/out/token-usage.jsonl",
    });
    expect(written).toHaveLength(1);
    const [first] = written[0]?.records ?? [];
    // Ids are hashed and the internal model id is normalized.
    expect(first?.messageId).toMatch(/^[0-9a-f]{64}$/);
    expect(first?.messageId).not.toBe("m1");
    expect(first?.model).toBe("muse-spark");
  });

  it("reads rows from an input file when --input is given", async () => {
    let readPath = "";
    const { deps } = stubDeps({
      readFile: (path) => {
        readPath = path;
        return ROWS_JSONL;
      },
      readStdin: async () => {
        throw new Error("stdin must not be read");
      },
    });
    await runMuseExportCommand(
      { input: "/tmp/rows.json", output: "/tmp/o" },
      deps,
    );
    expect(readPath).toBe("/tmp/rows.json");
  });

  it("runs the canonical query through psql when --db is given", async () => {
    let query = "";
    const { deps } = stubDeps({
      runPsql: async (q) => {
        query = q;
        return ROWS_JSONL;
      },
    });
    const summary = await runMuseExportCommand(
      { db: true, output: "/tmp/o" },
      deps,
    );
    expect(query).toContain("agent_message_token_usage");
    expect(summary.records).toBe(2);
  });

  it("rejects --db together with --input", async () => {
    const { deps, written } = stubDeps();
    await expect(
      runMuseExportCommand(
        { db: true, input: "/tmp/rows.json", output: "/tmp/o" },
        deps,
      ),
    ).rejects.toThrow(/cannot be used together/);
    expect(written).toHaveLength(0);
  });

  it("refuses to wait on a terminal stdin", async () => {
    const { deps } = stubDeps({
      stdinIsTTY: () => true,
      readStdin: async () => {
        throw new Error("stdin must not be read");
      },
    });
    await expect(
      runMuseExportCommand({ output: "/tmp/o" }, deps),
    ).rejects.toThrow(/no input/);
  });

  it("reports an empty --db result as a connection problem, not as no input", async () => {
    const { deps } = stubDeps({ runPsql: async () => "  \n" });
    await expect(
      runMuseExportCommand({ db: true, output: "/tmp/o" }, deps),
    ).rejects.toThrow(/query returned no rows/);
  });

  it("aborts without writing when the input is malformed", async () => {
    const { deps, written } = stubDeps({
      readStdin: async () => "{not rows",
    });
    await expect(
      runMuseExportCommand({ output: "/tmp/o" }, deps),
    ).rejects.toThrow(/not valid JSON/);
    expect(written).toHaveLength(0);
  });

  it("reports an unreadable input file with its cause", async () => {
    const { deps } = stubDeps({
      readFile: () => {
        throw new Error("ENOENT: no such file or directory");
      },
    });
    await expect(
      runMuseExportCommand({ input: "/nope.json", output: "/tmp/o" }, deps),
    ).rejects.toThrow(/cannot read input file \/nope\.json: ENOENT/);
  });

  it("writes an export the Muse parser can read, end to end", async () => {
    const dir = makeTempDir();
    const target = join(dir, "token-usage.jsonl");
    const deps: MuseCommandDeps = {
      ...defaultMuseCommandDeps,
      readStdin: async () => ROWS_JSONL,
      stdinIsTTY: () => false,
      log: () => {},
    };
    await runMuseExportCommand({ output: target }, deps);
    expect(readFileSync(target, "utf-8")).toContain('"v":1');

    const result = await new MuseParser({ filePath: target }).parse();
    expect(result.partial).toBeUndefined();
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]?.inputTokens).toBe(250);
    expect(result.buckets[0]?.outputTokens).toBe(22);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.messageCount).toBe(2);
  });
});

describe("createPsqlRunner", () => {
  function fakeExecFile(
    impl: ExecFileAsync = async () => ({ stdout: "rows", stderr: "" }),
  ): {
    execFile: ExecFileAsync;
    calls: { file: string; args: readonly string[]; options: unknown }[];
  } {
    const calls: {
      file: string;
      args: readonly string[];
      options: unknown;
    }[] = [];
    const execFile: ExecFileAsync = async (file, args, options) => {
      calls.push({ file, args, options });
      return impl(file, args, options);
    };
    return { execFile, calls };
  }

  it("runs psql with the query, a timeout and a hidden window", async () => {
    const { execFile, calls } = fakeExecFile();
    const run = createPsqlRunner({
      execFile,
      resolvePath: (command) => `/usr/bin/${command}`,
    });
    await expect(run("SELECT 1")).resolves.toBe("rows");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.file).toBe("/usr/bin/psql");
    expect(calls[0]?.args).toContain("-c");
    expect(calls[0]?.args).toContain("SELECT 1");
    const options = calls[0]?.options as {
      timeout: number;
      windowsHide: boolean;
    };
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.windowsHide).toBe(true);
  });

  it("reports psql as missing when no candidate resolves", async () => {
    const { execFile, calls } = fakeExecFile();
    const run = createPsqlRunner({ execFile, resolvePath: () => null });
    await expect(run("SELECT 1")).rejects.toThrow(/psql not found/);
    expect(calls).toHaveLength(0);
  });

  it("maps an ENOENT from exec to the not-found guidance", async () => {
    const { execFile } = fakeExecFile(async () => {
      const error = new Error("spawn psql ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    });
    const run = createPsqlRunner({
      execFile,
      resolvePath: (command) => command,
    });
    await expect(run("SELECT 1")).rejects.toThrow(/psql not found/);
  });

  it("keeps psql's stderr in the failure message", async () => {
    const { execFile } = fakeExecFile(async () => {
      throw Object.assign(new Error("exit 1"), {
        stderr: "psql: connection refused",
      });
    });
    const run = createPsqlRunner({
      execFile,
      resolvePath: (command) => command,
    });
    await expect(run("SELECT 1")).rejects.toThrow(/connection refused/);
  });

  it("keeps the error message when stderr is empty (timeout, maxBuffer)", async () => {
    const { execFile } = fakeExecFile(async () => {
      throw Object.assign(new Error("stdout maxBuffer length exceeded"), {
        stderr: "",
      });
    });
    const run = createPsqlRunner({
      execFile,
      resolvePath: (command) => command,
    });
    await expect(run("SELECT 1")).rejects.toThrow(/maxBuffer/);
  });
});
