import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AtomCodeParser } from "./atomcode";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeSession(
  sessionsDir: string,
  sessionId: string,
  jsonlLines: unknown[],
  meta: object,
): void {
  writeFileSync(
    join(sessionsDir, `${sessionId}.jsonl`),
    jsonlLines.map((line) => JSON.stringify(line)).join("\n"),
  );
  writeFileSync(join(sessionsDir, `${sessionId}.meta`), JSON.stringify(meta));
}

const meta = {
  v: 1,
  id: "sess-1",
  name: "test",
  user_renamed: false,
  ai_named: false,
  owner: "native",
  import_info: null,
  fork_info: null,
  working_dir: "/home/user/my-project",
  created_at: 1_785_739_543_243,
  updated_at: 1_785_739_545_274,
  turn_count: 1,
  message_count: 5,
  turn_stats: [
    {
      after_message: 5,
      position_valid: true,
      turn_id: 1,
      round_count: 1,
      tool_call_count: 0,
      duration_ms: 2011,
      total_tokens: 14831,
      errored: false,
      used_tokens: 14762,
      ctx_window: 1000000,
      model_usage: [
        {
          provider_id: "AtomGit-deepseek-v4-flash",
          model_id: "deepseek-v4-flash",
          tokens: { input: 42, output: 69, cached_input: 14720 },
          pricing: {
            input_per_million: 0,
            output_per_million: 0,
            cached_input_per_million: 0,
          },
        },
      ],
    },
  ],
};

describe("AtomCodeParser", () => {
  it("parses usage entries and session events from jsonl + meta", async () => {
    const sessionsDir = makeTempDir("tokenarena-atomcode-");
    mkdirSync(sessionsDir, { recursive: true });

    writeSession(
      sessionsDir,
      "sess-1",
      [
        {
          v: 1,
          ts: 1_785_739_543_281,
          session_id: "sess-1",
          turn_id: 1,
          user: "hi",
          assistant: "Hello!",
          tools: [],
          usage: { prompt: 14762, completion: 69, cached: 14720 },
        },
      ],
      meta,
    );

    const parser = new AtomCodeParser(sessionsDir);
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    const bucket = result.buckets[0];
    expect(bucket.source).toBe("atomcode");
    expect(bucket.model).toBe("deepseek-v4-flash");
    // usage.prompt includes the cached portion, so input = prompt - cached
    expect(bucket.inputTokens).toBe(42);
    expect(bucket.outputTokens).toBe(69);
    expect(bucket.cachedTokens).toBe(14720);
    expect(bucket.project).toBe("my-project");

    expect(result.sessions).toHaveLength(1);
    const session = result.sessions[0];
    expect(session.source).toBe("atomcode");
    expect(session.primaryModel).toBe("deepseek-v4-flash");
    expect(session.inputTokens).toBe(42);
    expect(session.outputTokens).toBe(69);
    expect(session.cachedTokens).toBe(14720);
    expect(session.userMessageCount).toBe(1);
  });

  it("emits both user and assistant session events", async () => {
    const sessionsDir = makeTempDir("tokenarena-atomcode-");
    mkdirSync(sessionsDir, { recursive: true });

    writeSession(
      sessionsDir,
      "sess-2",
      [
        {
          v: 1,
          ts: 1_785_739_543_281,
          session_id: "sess-2",
          turn_id: 1,
          user: "what model are you?",
        },
        {
          v: 1,
          ts: 1_785_739_545_000,
          session_id: "sess-2",
          turn_id: 1,
          assistant: "I run deepseek-v4-flash.",
          usage: { prompt: 100, completion: 10, cached: 0 },
        },
      ],
      meta,
    );

    const parser = new AtomCodeParser(sessionsDir);
    const result = await parser.parse();

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].messageCount).toBe(2);
    expect(result.sessions[0].userMessageCount).toBe(1);
    expect(result.buckets[0].inputTokens).toBe(100);
    expect(result.buckets[0].outputTokens).toBe(10);
  });

  it("handles missing meta file with unknown project and model", async () => {
    const sessionsDir = makeTempDir("tokenarena-atomcode-");
    mkdirSync(sessionsDir, { recursive: true });

    writeFileSync(
      join(sessionsDir, "sess-3.jsonl"),
      JSON.stringify({
        v: 1,
        ts: 1_785_739_543_281,
        session_id: "sess-3",
        turn_id: 1,
        user: "hi",
        usage: { prompt: 50, completion: 5, cached: 0 },
      }),
    );

    const parser = new AtomCodeParser(sessionsDir);
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].project).toBe("unknown");
    expect(result.buckets[0].model).toBe("unknown");
    expect(result.sessions).toHaveLength(1);
  });

  it("skips entries with no usage", async () => {
    const sessionsDir = makeTempDir("tokenarena-atomcode-");
    mkdirSync(sessionsDir, { recursive: true });

    writeSession(
      sessionsDir,
      "sess-4",
      [{ v: 1, ts: 1_785_739_543_281, session_id: "sess-4", user: "hi" }],
      meta,
    );

    const parser = new AtomCodeParser(sessionsDir);
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(0);
    expect(result.sessions).toHaveLength(1);
  });

  it("skips malformed jsonl lines", async () => {
    const sessionsDir = makeTempDir("tokenarena-atomcode-");
    mkdirSync(sessionsDir, { recursive: true });

    writeFileSync(join(sessionsDir, "sess-5.jsonl"), "not json\n");
    writeFileSync(
      join(sessionsDir, "sess-5.meta"),
      JSON.stringify({ working_dir: "/tmp" }),
    );

    const parser = new AtomCodeParser(sessionsDir);
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(0);
    expect(result.sessions).toHaveLength(0);
  });

  it("reports not installed when dir is missing", () => {
    const sessionsDir = makeTempDir("tokenarena-atomcode-");
    const parser = new AtomCodeParser(join(sessionsDir, "nope"));
    expect(parser.isInstalled()).toBe(false);
  });

  it("uses default sessions dir when constructed without argument", () => {
    const parser = new AtomCodeParser();
    expect(parser.tool.id).toBe("atomcode");
    expect(parser.tool.name).toBe("AtomCode");
    expect(parser.tool.dataDir.endsWith(".atomcode/sessions")).toBe(true);
  });
});
