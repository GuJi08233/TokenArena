import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MuseParser } from "../parsers/muse";
import type { MuseExportRecord } from "../parsers/muse-export";
import { useTempDirs } from "../testing/temp-dir";
import {
  defaultMuseCommandDeps,
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
    print: (text) => printed.push(text),
    log: () => {},
    ...overrides,
  };
  return { deps, written, printed };
}

describe("runMuseQueryCommand", () => {
  it("prints the rows query and the totals cross-check", async () => {
    const { deps, printed } = stubDeps();
    await runMuseQueryCommand(deps);
    const output = printed.join("");
    expect(output).toContain("agent.agent_message_token_usage");
    expect(output).toContain("sum(input_tokens)");
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

  it("aborts without writing when the input is malformed", async () => {
    const { deps, written } = stubDeps({
      readStdin: async () => "{not rows",
    });
    await expect(
      runMuseExportCommand({ output: "/tmp/o" }, deps),
    ).rejects.toThrow(/not valid JSON/);
    expect(written).toHaveLength(0);
  });

  it("reports an unreadable input file", async () => {
    const { deps } = stubDeps({
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    await expect(
      runMuseExportCommand({ input: "/nope.json", output: "/tmp/o" }, deps),
    ).rejects.toThrow(/cannot read input file/);
  });

  it("writes an export the Muse parser can read, end to end", async () => {
    const dir = makeTempDir();
    const target = join(dir, "token-usage.jsonl");
    const deps: MuseCommandDeps = {
      ...defaultMuseCommandDeps,
      readStdin: async () => ROWS_JSONL,
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
