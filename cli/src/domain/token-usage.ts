import type { TokenUsageEntry } from "./types";

const TOKEN_COUNT_KEYS = [
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cachedTokens",
] as const;

export function hasInvalidTokenCounts(
  entry: Pick<
    TokenUsageEntry,
    (typeof TOKEN_COUNT_KEYS)[number] | "cacheCreationTokens"
  >,
): boolean {
  const cacheCreation = entry.cacheCreationTokens ?? 0;
  if (!Number.isSafeInteger(cacheCreation) || cacheCreation < 0) return true;
  return TOKEN_COUNT_KEYS.some((key) => {
    const value = entry[key];
    return !Number.isSafeInteger(value) || value < 0;
  });
}
