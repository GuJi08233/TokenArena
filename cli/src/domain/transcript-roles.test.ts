import { describe, expect, it } from "vitest";
import { isHumanPromptRecord } from "./transcript-roles";

describe("isHumanPromptRecord", () => {
  it("accepts a typed prompt, with or without attachments", () => {
    expect(
      isHumanPromptRecord({ type: "user", message: { content: "hello" } }),
    ).toBe(true);
    expect(
      isHumanPromptRecord({
        type: "user",
        message: {
          content: [
            { type: "text", text: "see screenshot" },
            { type: "image", source: {} },
          ],
        },
      }),
    ).toBe(true);
    // Older records carry no content at all.
    expect(isHumanPromptRecord({ type: "user" })).toBe(true);
  });

  it("rejects what the agent loop and the client write as user records", () => {
    for (const record of [
      {
        type: "user",
        message: { content: [{ type: "tool_result", content: "ok" }] },
      },
      { type: "user", toolUseResult: { stdout: "ok" } },
      { type: "user", isMeta: true, message: { content: "Caveat" } },
      { type: "user", isCompactSummary: true, message: { content: "Summary" } },
      {
        type: "user",
        isSidechain: true,
        message: { content: "Subagent task" },
      },
      { type: "assistant", message: { content: "reply" } },
    ]) {
      expect(isHumanPromptRecord(record), JSON.stringify(record)).toBe(false);
    }
  });
});
