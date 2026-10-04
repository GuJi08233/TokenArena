type BarRadius = [number, number, number, number];

const SQUARE_RADIUS: BarRadius = [0, 0, 0, 0];
const TOP_RADIUS: BarRadius = [6, 6, 0, 0];

/**
 * Stacked token series shared by the trend chart, its legend and its tooltip.
 * Each token type takes its own categorical slot (`--chart-1`…`--chart-5`, see
 * globals.css); the stack follows the slot order so adjacent segments stay
 * distinguishable, including under colour-vision deficiencies.
 */
export const TOKEN_TREND_SERIES = [
  {
    dataKey: "cachedTokens",
    labelKey: "cache",
    color: "var(--chart-1)",
    radius: SQUARE_RADIUS,
  },
  {
    dataKey: "cacheCreationTokens",
    labelKey: "cacheCreation",
    color: "var(--chart-2)",
    radius: SQUARE_RADIUS,
  },
  {
    dataKey: "inputTokens",
    labelKey: "input",
    color: "var(--chart-3)",
    radius: SQUARE_RADIUS,
  },
  {
    dataKey: "outputTokens",
    labelKey: "output",
    color: "var(--chart-4)",
    radius: SQUARE_RADIUS,
  },
  {
    dataKey: "reasoningTokens",
    labelKey: "reasoning",
    color: "var(--chart-5)",
    radius: TOP_RADIUS,
  },
] as const;
