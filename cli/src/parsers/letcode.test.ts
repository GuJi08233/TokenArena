import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../testing/temp-dir";
import { LetcodeParser } from "./letcode";

const makeTempDir = useTempDirs();

describe("LetcodeParser", () => {
  it("parses completed provider telemetry and session messages", async () => {
    const sessionsDir = makeTempDir("tokenarena-letcode-");
    mkdirSync(sessionsDir, { recursive: true });

    const sessionId = "1784394966015-53219-0";
    writeFileSync(
      join(sessionsDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          kind: "session_started",
          session_id: sessionId,
          timestamp_ms: 1_784_394_966_016,
          model: "gpt-5.6-terra",
        }),
        JSON.stringify({
          kind: "user_message",
          session_id: sessionId,
          timestamp_ms: 1_784_394_967_000,
          content: { text: "hello" },
        }),
        JSON.stringify({
          kind: "llm_request_telemetry",
          phase: "prepared",
          usage_completeness: "usage_missing",
          session_id: sessionId,
          timestamp_ms: 1_784_394_978_038,
          model: "gpt-5.6-terra",
          provider_input_tokens: 0,
          provider_output_tokens: 0,
        }),
        JSON.stringify({
          kind: "llm_request_telemetry",
          phase: "completed",
          usage_completeness: "complete",
          session_id: sessionId,
          timestamp_ms: 1_784_394_980_000,
          model: "gpt-5.6-terra",
          provider_input_tokens: 10638,
          provider_output_tokens: 79,
          provider_cached_tokens: 0,
          provider_total_tokens: 10717,
        }),
        JSON.stringify({
          kind: "llm_request_telemetry",
          phase: "completed",
          usage_completeness: "complete",
          session_id: sessionId,
          timestamp_ms: 1_784_395_000_000,
          model: "gpt-5.6-terra",
          provider_input_tokens: 10766,
          provider_output_tokens: 65,
          provider_cached_tokens: 10240,
          provider_total_tokens: 10831,
        }),
        JSON.stringify({
          kind: "assistant_message",
          session_id: sessionId,
          timestamp_ms: 1_784_395_088_833,
          content: "done",
        }),
        "not-json",
        JSON.stringify({
          kind: "llm_request_telemetry",
          phase: "completed",
          usage_completeness: "usage_missing",
          session_id: sessionId,
          timestamp_ms: 1_784_395_100_000,
          model: "gpt-5.6-terra",
          provider_input_tokens: 999,
          provider_output_tokens: 9,
        }),
      ].join("\n"),
      "utf-8",
    );

    const parser = new LetcodeParser(sessionsDir);
    const result = await parser.parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      source: "letcode",
      model: "gpt-5.6-terra",
      project: "unknown",
      // The second request's input already includes its 10,240 cached
      // tokens: its provider total is input + output.
      inputTokens: 10638 + (10766 - 10240),
      outputTokens: 79 + 65,
      reasoningTokens: 0,
      cachedTokens: 0 + 10240,
      // The two provider totals, 10,717 + 10,831.
      totalTokens: 10717 + 10831,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      source: "letcode",
      project: "unknown",
      messageCount: 2,
      userMessageCount: 1,
      inputTokens: 10638 + (10766 - 10240),
      outputTokens: 79 + 65,
      reasoningTokens: 0,
      cachedTokens: 10240,
      totalTokens: 10717 + 10831,
      primaryModel: "gpt-5.6-terra",
    });
  });

  it("reads which subsets the provider total already includes", async () => {
    const sessionsDir = makeTempDir("tokenarena-letcode-");
    const sessionId = "split-1";
    const telemetry = (timestampMs: number, usage: Record<string, number>) =>
      JSON.stringify({
        kind: "llm_request_telemetry",
        phase: "completed",
        usage_completeness: "complete",
        session_id: sessionId,
        timestamp_ms: timestampMs,
        model: "gpt-5.6-terra",
        ...usage,
      });
    writeFileSync(
      join(sessionsDir, `${sessionId}.jsonl`),
      [
        // Reasoning inside the output: total = input + output.
        telemetry(1_784_394_980_000, {
          provider_input_tokens: 1000,
          provider_output_tokens: 300,
          provider_reasoning_tokens: 200,
          provider_total_tokens: 1300,
        }),
        // Cached outside the input: total = input + output + cached.
        telemetry(1_784_394_981_000, {
          provider_input_tokens: 50,
          provider_output_tokens: 100,
          provider_cached_tokens: 5000,
          provider_total_tokens: 5150,
        }),
        // Reasoning outside the output: total = input + output + reasoning.
        telemetry(1_784_394_982_000, {
          provider_input_tokens: 1000,
          provider_output_tokens: 100,
          provider_reasoning_tokens: 50,
          provider_total_tokens: 1150,
        }),
      ].join("\n"),
      "utf-8",
    );

    const result = await new LetcodeParser(sessionsDir).parse();

    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0]).toMatchObject({
      inputTokens: 1000 + 50 + 1000,
      outputTokens: 100 + 100 + 100,
      reasoningTokens: 200 + 50,
      cachedTokens: 5000,
      totalTokens: 1300 + 5150 + 1150,
    });
  });

  it("isInstalled returns true when sessions directory exists", () => {
    const sessionsDir = makeTempDir("tokenarena-letcode-installed-");
    mkdirSync(sessionsDir, { recursive: true });

    const parser = new LetcodeParser(sessionsDir);
    expect(parser.isInstalled()).toBe(true);
    expect(parser.tool.id).toBe("letcode");
    expect(parser.tool.name).toBe("LetCode");
  });
});
