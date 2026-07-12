import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SnowParser } from "./snow";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("SnowParser", () => {
  it("parses usage JSONL and ignores malformed records", async () => {
    const root = mkdtempSync(join(tmpdir(), "tokenarena-snow-"));
    dirs.push(root);
    const day = join(root, "2026-07-11");
    mkdirSync(day);
    writeFileSync(
      join(day, "usage-001.jsonl"),
      [
        JSON.stringify({
          model: "gpt-5",
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 30,
          timestamp: "2026-07-11T13:10:00Z",
        }),
        "not-json",
        JSON.stringify({
          model: "gpt-5",
          inputTokens: -1,
          outputTokens: 5,
          timestamp: "2026-07-11T13:15:00Z",
        }),
      ].join("\n"),
    );
    const result = await new SnowParser(root).parse();
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      source: "snow",
      model: "gpt-5",
      inputTokens: 100,
      outputTokens: 25,
      cachedTokens: 30,
      totalTokens: 155,
    });
    expect(result.sessions).toEqual([]);
  });
});
