type PricingProviderRule = {
  providerId: string;
  matches: (candidate: string) => boolean;
};

export const OFFICIAL_PRICING_PROVIDER_RULES: PricingProviderRule[] = [
  {
    providerId: "anthropic",
    matches: (candidate) => candidate.startsWith("claude-"),
  },
  {
    providerId: "openai",
    matches: (candidate) =>
      candidate.startsWith("gpt-") ||
      candidate.startsWith("gpt-oss-") ||
      candidate.startsWith("o1") ||
      candidate.startsWith("o3") ||
      candidate.startsWith("o4") ||
      candidate.startsWith("text-embedding-") ||
      candidate.startsWith("text-moderation-") ||
      candidate.startsWith("omni-moderation-"),
  },
  {
    providerId: "google",
    matches: (candidate) => candidate.startsWith("gemini-"),
  },
  {
    providerId: "deepseek",
    matches: (candidate) => candidate.startsWith("deepseek-"),
  },
  {
    providerId: "moonshotai",
    matches: (candidate) => candidate.startsWith("kimi-"),
  },
  {
    providerId: "zai",
    matches: (candidate) => candidate.startsWith("glm-"),
  },
  {
    providerId: "alibaba",
    matches: (candidate) =>
      candidate.startsWith("qwen") ||
      candidate.startsWith("qwq-") ||
      candidate.startsWith("qvq-"),
  },
  {
    providerId: "minimax",
    matches: (candidate) => candidate.startsWith("minimax-"),
  },
  {
    providerId: "xai",
    matches: (candidate) => candidate.startsWith("grok-"),
  },
  {
    providerId: "mistral",
    matches: (candidate) =>
      candidate.startsWith("mistral-") ||
      candidate.startsWith("ministral-") ||
      candidate.startsWith("magistral-") ||
      candidate.startsWith("codestral-") ||
      candidate.startsWith("pixtral-") ||
      candidate.startsWith("devstral-"),
  },
  {
    providerId: "cohere",
    matches: (candidate) =>
      candidate.startsWith("command-") || candidate.startsWith("embed-"),
  },
];

/**
 * Providers whose prices are ever read. The snapshot keeps only these: the
 * upstream catalog lists hundreds of resellers, and caching all of them used
 * over half of the 2 MB data cache entry limit.
 */
export const OFFICIAL_PRICING_PROVIDER_IDS: ReadonlySet<string> = new Set(
  OFFICIAL_PRICING_PROVIDER_RULES.map((rule) => rule.providerId),
);
