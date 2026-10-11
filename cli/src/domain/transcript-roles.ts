function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Whether a Claude-format transcript record is a prompt a person sent.
 *
 * Claude Code, and Qoder which writes the same format, store more than
 * prompts as `type: "user"` records: every tool result, system-injected meta
 * messages, compaction summaries, and the task a parent agent hands a
 * subagent. Counted as prompts, one agentic turn became dozens of prompts,
 * and each tool result ended the turn, so active time shrank to the model's
 * first response after each tool call.
 */
export function isHumanPromptRecord(record: Record<string, unknown>) {
  if (record.type !== "user") return false;

  if (
    record.isMeta === true ||
    record.isCompactSummary === true ||
    record.isSidechain === true ||
    record.toolUseResult !== undefined
  ) {
    return false;
  }

  const content = asRecord(record.message)?.content;

  // A prompt can carry text or images beside tool results; only a record of
  // nothing but tool results is the agent's own loop.
  return Array.isArray(content)
    ? content.some((part) => asRecord(part)?.type !== "tool_result")
    : true;
}
