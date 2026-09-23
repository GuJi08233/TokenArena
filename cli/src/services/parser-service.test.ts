import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../parsers/registry", () => ({
  getAllParsers: vi.fn(() => [
    {
      tool: { id: "test-tool", name: "Test Tool", dataDir: "/tmp/test" },
      parse: vi.fn().mockResolvedValue({ buckets: [], sessions: [] }),
    },
    {
      tool: {
        id: "tool-with-data",
        name: "Tool With Data",
        dataDir: "/tmp/test2",
      },
      parse: vi.fn().mockResolvedValue({
        buckets: [
          {
            source: "test",
            model: "gpt-4",
            project: "p",
            bucketStart: "2026-01-01",
            inputTokens: 100,
            outputTokens: 50,
            reasoningTokens: 0,
            cachedTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: 150,
          },
        ],
        sessions: [
          {
            source: "test",
            project: "p",
            sessionHash: "h1",
            firstMessageAt: "2026-01-01T00:00:00Z",
            lastMessageAt: "2026-01-01T01:00:00Z",
            durationSeconds: 3600,
            activeSeconds: 1800,
            messageCount: 2,
            userMessageCount: 1,
            inputTokens: 100,
            outputTokens: 50,
            reasoningTokens: 0,
            cachedTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: 150,
            primaryModel: "gpt-4",
            modelUsages: [],
          },
        ],
      }),
    },
    {
      tool: { id: "failing-tool", name: "Failing Tool", dataDir: "/tmp/test3" },
      parse: vi.fn().mockRejectedValue(new Error("parse error")),
    },
  ]),
  detectInstalledTools: vi.fn(() => []),
}));

vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const cacheMocks = vi.hoisted(() => ({
  computeScanFingerprint: vi.fn((): string | null => "fingerprint"),
  loadCachedParseResult: vi.fn(
    (): { buckets: unknown[]; sessions: unknown[] } | null => null,
  ),
  saveCachedParseResult: vi.fn(),
}));

vi.mock("./parse-cache", () => cacheMocks);

import { getAllParsers } from "../parsers/registry";
import { getDetectedTools, runAllParsers } from "./parser-service";

describe("parser-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("runAllParsers", () => {
    it("collects results from all parsers", async () => {
      const result = await runAllParsers();
      expect(result.buckets).toHaveLength(1);
      expect(result.sessions).toHaveLength(1);
      expect(result.parserResults).toHaveLength(1);
      expect(result.parserResults[0].source).toBe("tool-with-data");
    });

    it("handles parser failures gracefully", async () => {
      const result = await runAllParsers();
      // failing-tool should be skipped, others should work
      expect(getAllParsers()).toHaveLength(3);
      expect(result.parserResults).toHaveLength(1);
      expect(result.failedSources).toEqual(["failing-tool"]);
    });

    it("does not upload partial snapshots over complete remote data", async () => {
      const parsers = getAllParsers();
      const partial = await parsers[1].parse();
      vi.mocked(getAllParsers).mockReturnValueOnce([
        {
          tool: parsers[1].tool,
          parse: vi.fn().mockResolvedValue({ ...partial, incomplete: true }),
        },
      ]);
      const result = await runAllParsers();
      expect(result.failedSources).toEqual(["tool-with-data"]);
      expect(result.buckets).toHaveLength(0);
      expect(result.sessions).toHaveLength(0);
      expect(result.parserResults).toHaveLength(0);
    });

    it("runs parsers concurrently instead of one after another", async () => {
      let running = 0;
      let peak = 0;
      const slowParser = (id: string) => ({
        tool: { id, name: id, dataDir: `/tmp/${id}` },
        parse: vi.fn(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 5));
          running -= 1;
          return { buckets: [], sessions: [] };
        }),
      });
      vi.mocked(getAllParsers).mockReturnValueOnce([
        slowParser("a"),
        slowParser("b"),
        slowParser("c"),
      ]);

      await runAllParsers();

      expect(peak).toBeGreaterThan(1);
    });

    it("keeps registration order regardless of which parser finishes first", async () => {
      const bucket = (source: string) => ({
        source,
        model: "m",
        project: "p",
        bucketStart: "2026-01-01",
        hostname: "h",
        inputTokens: 1,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        totalTokens: 1,
      });
      const parserOf = (id: string, delayMs: number) => ({
        tool: { id, name: id, dataDir: `/tmp/${id}` },
        parse: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return { buckets: [bucket(id)], sessions: [] };
        }),
      });
      // The first parser finishes last, so completion order is the reverse of
      // registration order.
      vi.mocked(getAllParsers).mockReturnValueOnce([
        parserOf("slow", 20),
        parserOf("medium", 10),
        parserOf("fast", 0),
      ]);

      const result = await runAllParsers();

      expect(result.buckets.map((entry) => entry.source)).toEqual([
        "slow",
        "medium",
        "fast",
      ]);
      expect(result.parserResults.map((entry) => entry.source)).toEqual([
        "slow",
        "medium",
        "fast",
      ]);
    });

    it("isolates a failing parser from the ones running alongside it", async () => {
      const ok = {
        tool: { id: "ok", name: "ok", dataDir: "/tmp/ok" },
        parse: vi.fn().mockResolvedValue({
          buckets: [],
          sessions: [],
        }),
      };
      const boom = {
        tool: { id: "boom", name: "boom", dataDir: "/tmp/boom" },
        parse: vi.fn().mockRejectedValue(new Error("nope")),
      };
      vi.mocked(getAllParsers).mockReturnValueOnce([boom, ok, boom]);

      const result = await runAllParsers();

      expect(result.failedSources).toEqual(["boom"]);
      expect(ok.parse).toHaveBeenCalledOnce();
    });
  });

  describe("parse cache", () => {
    const bucket = {
      source: "cached",
      model: "m",
      project: "p",
      bucketStart: "2026-01-01",
      hostname: "h",
      inputTokens: 1,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 1,
    };

    function cacheableParser() {
      return {
        tool: { id: "cacheable", name: "Cacheable", dataDir: "/tmp/c" },
        listSourceFiles: vi.fn(() => ["/tmp/c/a.jsonl"]),
        parse: vi.fn().mockResolvedValue({ buckets: [bucket], sessions: [] }),
      };
    }

    beforeEach(() => {
      cacheMocks.computeScanFingerprint.mockReturnValue("fingerprint");
      cacheMocks.loadCachedParseResult.mockReturnValue(null);
    });

    it("skips parsing when the cached result matches the inputs", async () => {
      const parser = cacheableParser();
      cacheMocks.loadCachedParseResult.mockReturnValueOnce({
        buckets: [bucket],
        sessions: [],
      });
      vi.mocked(getAllParsers).mockReturnValueOnce([parser]);

      const result = await runAllParsers();

      expect(parser.parse).not.toHaveBeenCalled();
      expect(result.buckets).toHaveLength(1);
      expect(result.parserResults[0]).toMatchObject({
        source: "cacheable",
        cached: true,
      });
    });

    it("parses and stores the result on a cache miss", async () => {
      const parser = cacheableParser();
      vi.mocked(getAllParsers).mockReturnValueOnce([parser]);

      const result = await runAllParsers();

      expect(parser.parse).toHaveBeenCalledOnce();
      expect(cacheMocks.saveCachedParseResult).toHaveBeenCalledWith(
        "cacheable",
        "fingerprint",
        expect.objectContaining({ buckets: [bucket] }),
      );
      expect(result.parserResults[0].cached).toBeUndefined();
    });

    it.each([
      "file listing",
      "fingerprinting",
    ])("isolates %s failures from other parsers", async (stage) => {
      const broken = cacheableParser();
      const healthy = {
        ...cacheableParser(),
        tool: { id: "healthy", name: "Healthy", dataDir: "/tmp/h" },
      };
      if (stage === "file listing") {
        broken.listSourceFiles.mockImplementationOnce(() => {
          throw new Error("cannot list files");
        });
      } else {
        cacheMocks.computeScanFingerprint.mockImplementationOnce(() => {
          throw new Error("cannot stat file");
        });
      }
      vi.mocked(getAllParsers).mockReturnValueOnce([broken, healthy]);

      const result = await runAllParsers();

      expect(result.failedSources).toEqual(["cacheable"]);
      expect(broken.parse).not.toHaveBeenCalled();
      expect(healthy.parse).toHaveBeenCalledOnce();
      expect(result.parserResults.map((entry) => entry.source)).toEqual([
        "healthy",
      ]);
      expect(result.buckets).toEqual([bucket]);
    });

    it("leaves parsers without listSourceFiles uncached", async () => {
      const parser = {
        tool: { id: "plain", name: "Plain", dataDir: "/tmp/p" },
        parse: vi.fn().mockResolvedValue({ buckets: [bucket], sessions: [] }),
      };
      vi.mocked(getAllParsers).mockReturnValueOnce([parser]);

      await runAllParsers();

      expect(cacheMocks.computeScanFingerprint).not.toHaveBeenCalled();
      expect(parser.parse).toHaveBeenCalledOnce();
      // A null fingerprint makes the store a no-op, so nothing is retained.
      expect(cacheMocks.saveCachedParseResult).toHaveBeenCalledWith(
        "plain",
        null,
        expect.anything(),
      );
    });
  });

  describe("getDetectedTools", () => {
    it("delegates to detectInstalledTools", () => {
      const tools = getDetectedTools();
      expect(tools).toEqual([]);
    });
  });
});
