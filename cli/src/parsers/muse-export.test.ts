import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../testing/temp-dir";
import { parseMuseRecord } from "./muse";
import {
  MUSE_USAGE_ROWS_QUERY,
  MUSE_USAGE_TOTALS_QUERY,
  type MuseRawRow,
  parseMuseRawRows,
  serializeMuseExport,
  summarizeMuseExport,
  transformMuseRows,
  writeMuseExportFile,
} from "./muse-export";

const makeTempDir = useTempDirs();

const BASE_TS = 1_793_000_000; // 2026-10-27, arbitrary fixed point

// sha256("abc"), the well-known FIPS test vector.
const SHA256_ABC =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function row(overrides: Partial<MuseRawRow> = {}): MuseRawRow {
  return {
    ts: BASE_TS,
    messageId: "m1",
    sessionId: "s1",
    agentId: "a1",
    model: "muse-spark",
    inputTokens: 100,
    outputTokens: 10,
    ...overrides,
  };
}

describe("canonical queries", () => {
  it("reads the runtime usage table joined with agents", () => {
    expect(MUSE_USAGE_ROWS_QUERY).toContain("agent.agent_message_token_usage");
    expect(MUSE_USAGE_ROWS_QUERY).toContain("agent.agents");
    expect(MUSE_USAGE_ROWS_QUERY).toContain("root_session_id");
    expect(MUSE_USAGE_TOTALS_QUERY).toContain(
      "agent.agent_message_token_usage",
    );
  });
});

describe("parseMuseRawRows", () => {
  it("parses a JSONL stream of bare row objects", () => {
    const input = [row(), row({ messageId: "m2", ts: BASE_TS + 1 })]
      .map((r) => JSON.stringify(r))
      .join("\n");
    const rows = parseMuseRawRows(input);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.messageId).toBe("m1");
    expect(rows[1]?.inputTokens).toBe(100);
  });

  it("parses line-wrapped rows, as the database tool returns them", () => {
    const input = [
      { line: JSON.stringify(row()) },
      { line: JSON.stringify(row({ messageId: "m2" })) },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n");
    expect(parseMuseRawRows(input).map((r) => r.messageId)).toEqual([
      "m1",
      "m2",
    ]);
  });

  it("parses a JSON array and the host tool envelope", () => {
    expect(parseMuseRawRows(JSON.stringify([row()]))).toHaveLength(1);
    const envelope = JSON.stringify({
      ok: true,
      result: { rows: [{ line: JSON.stringify(row()) }] },
    });
    expect(parseMuseRawRows(envelope)).toHaveLength(1);
    expect(parseMuseRawRows(JSON.stringify(row()))).toHaveLength(1);
  });

  it("rejects empty input and inputs without rows", () => {
    expect(() => parseMuseRawRows("")).toThrow(/no input/);
    expect(() => parseMuseRawRows("[]")).toThrow(/no rows/);
  });

  it("rejects malformed rows instead of dropping them", () => {
    const good = JSON.stringify(row());
    expect(() => parseMuseRawRows("{not json")).toThrow(/not valid JSON/);
    expect(() =>
      parseMuseRawRows(
        [good, JSON.stringify(row({ inputTokens: -1 }))].join("\n"),
      ),
    ).toThrow(/row 2 is invalid/);
    expect(() =>
      parseMuseRawRows(JSON.stringify(row({ ts: BASE_TS * 1000 }))),
    ).toThrow(/outside the accepted range/);
    expect(() =>
      parseMuseRawRows(JSON.stringify({ ...row(), inputTokens: "100" })),
    ).toThrow(/non-negative integers/);
    expect(() =>
      parseMuseRawRows(JSON.stringify({ ...row(), agentId: "" })),
    ).toThrow(/non-empty strings/);
    expect(() => parseMuseRawRows(JSON.stringify({ line: "{broken" }))).toThrow(
      /not valid JSON/,
    );
  });
});

describe("transformMuseRows", () => {
  it("hashes every id with SHA-256", () => {
    const [record] = transformMuseRows([
      row({ messageId: "abc", sessionId: "abc", agentId: "abc" }),
    ]);
    expect(record?.messageId).toBe(SHA256_ABC);
    expect(record?.sessionId).toBe(SHA256_ABC);
    expect(record?.agentId).toBe(SHA256_ABC);
    expect(record?.v).toBe(1);
  });

  it("dedupes by message, keeping the first row", () => {
    const records = transformMuseRows([
      row({ messageId: "m1", inputTokens: 100 }),
      row({ messageId: "m1", inputTokens: 999 }),
      row({ messageId: "m2", inputTokens: 40 }),
    ]);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.inputTokens)).toEqual([100, 40]);
  });

  it("normalizes internal model ids and defaults a missing model", () => {
    const [leaked, missing] = transformMuseRows([
      row({ messageId: "m1", model: "ipnext/avocado-5.16-v1" }),
      row({ messageId: "m2", model: undefined }),
    ]);
    expect(leaked?.model).toBe("muse-spark");
    expect(missing?.model).toBe("muse-spark");
  });

  it("orders records by time", () => {
    const records = transformMuseRows([
      row({ messageId: "m2", ts: BASE_TS + 60 }),
      row({ messageId: "m1", ts: BASE_TS }),
    ]);
    expect(records.map((r) => r.ts)).toEqual([BASE_TS, BASE_TS + 60]);
  });
});

describe("serializeMuseExport and summarizeMuseExport", () => {
  it("round-trips through the parser's record validation", () => {
    const records = transformMuseRows([
      row(),
      row({ messageId: "m2", ts: BASE_TS + 5 }),
    ]);
    const text = serializeMuseExport(records);
    expect(text.endsWith("\n")).toBe(true);
    const parsed = text
      .trim()
      .split("\n")
      .map((line) => parseMuseRecord(JSON.parse(line)));
    expect(parsed).toEqual(records.map(({ v, ...rest }) => rest));
    expect(summarizeMuseExport(records)).toEqual({
      records: 2,
      inputTokens: 200,
      outputTokens: 20,
    });
  });

  it("serializes an empty export to an empty string", () => {
    expect(serializeMuseExport([])).toBe("");
  });
});

describe("writeMuseExportFile", () => {
  it("writes the export atomically, creating parent directories", () => {
    const target = join(makeTempDir(), "nested", "token-usage.jsonl");
    const records = transformMuseRows([row()]);
    writeMuseExportFile(records, target);
    expect(readFileSync(target, "utf-8")).toBe(serializeMuseExport(records));
    // No temp file is left behind after the rename.
    const siblings = readdirSync(join(target, ".."));
    expect(siblings).toEqual(["token-usage.jsonl"]);
    expect(existsSync(target)).toBe(true);
  });
});
