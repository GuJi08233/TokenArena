import { formatTokenCount } from "@/lib/usage/format";

export type HeatmapLevel = 0 | 1 | 2 | 3 | 4;

/** 第 1–4 档各自的最低单日 token 数，严格递增。 */
export type HeatmapLevelThresholds = readonly [number, number, number, number];

// 每档的硬性下限：低于第 1 档的日子只是零星调用，与没用同色。
const ABSOLUTE_MINIMUMS = [100_000, 1_000_000, 10_000_000, 50_000_000];

// 相对峰值的下限，按对数等分峰值以下两个数量级：每深一档约多 3.2 倍。
const RELATIVE_FLOORS = [0, 10 ** -1.5, 10 ** -1, 10 ** -0.5];

// 超过 p95 这么多倍的日子视为异常，不参与定峰值，以免把其余日子压暗。
const OUTLIER_FACTOR = 4;

/**
 * 按一年内各天的 token 数算出四档门槛。门槛取绝对下限与相对峰值下限中
 * 较大者：重度用户靠相对门槛拉开层次，轻度用户靠绝对门槛避免小用量也
 * 显示成最深色。
 */
export function getHeatmapLevelThresholds(
  dailyTokens: readonly number[],
): HeatmapLevelThresholds {
  const counted = dailyTokens
    .filter((tokens) => tokens >= ABSOLUTE_MINIMUMS[0])
    .sort((a, b) => a - b);

  let peak = 0;

  if (counted.length > 0) {
    const p95 =
      counted[Math.min(counted.length - 1, Math.floor(counted.length * 0.95))];
    const fence = p95 * OUTLIER_FACTOR;

    // counted 升序，第一个不超过 fence 的值从尾部找起；p95 本身必然不超过。
    for (let index = counted.length - 1; index >= 0; index -= 1) {
      if (counted[index] <= fence) {
        peak = counted[index];
        break;
      }
    }
  }

  return ABSOLUTE_MINIMUMS.map((minimum, index) =>
    Math.max(minimum, peak * RELATIVE_FLOORS[index]),
  ) as unknown as HeatmapLevelThresholds;
}

/** 图例色块的说明，例如 "≥ 540.2M tokens"；门槛因人而异，需要标出数值。 */
export function getHeatmapLevelLabel(
  level: HeatmapLevel,
  thresholds: HeatmapLevelThresholds,
) {
  return level === 0
    ? `< ${formatTokenCount(thresholds[0])} tokens`
    : `≥ ${formatTokenCount(thresholds[level - 1])} tokens`;
}

export function getHeatmapLevel(
  tokens: number,
  thresholds: HeatmapLevelThresholds,
): HeatmapLevel {
  for (let index = thresholds.length - 1; index >= 0; index -= 1) {
    if (tokens >= thresholds[index]) {
      return (index + 1) as HeatmapLevel;
    }
  }

  return 0;
}
