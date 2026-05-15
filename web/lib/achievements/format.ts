import {
  formatDuration,
  formatPercentage,
  formatTokenCount,
} from "@/lib/usage/format";
import type { AchievementProgressUnit, AchievementTier } from "./types";

const currencyFormatterCache = new Map<
  string,
  Map<string, Intl.NumberFormat>
>();

function getCurrencyFormatter(locale: string, maximumFractionDigits: number) {
  let byDigits = currencyFormatterCache.get(locale);
  if (!byDigits) {
    byDigits = new Map();
    currencyFormatterCache.set(locale, byDigits);
  }
  const cacheKey = String(maximumFractionDigits);
  let formatter = byDigits.get(cacheKey);
  if (!formatter) {
    formatter = Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits,
    });
    byDigits.set(cacheKey, formatter);
  }
  return formatter;
}

const achievementDateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getAchievementDateFormatter(locale: string, timezone: string) {
  const cacheKey = `${locale}:${timezone}`;
  let formatter = achievementDateFormatterCache.get(cacheKey);
  if (!formatter) {
    formatter = Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    achievementDateFormatterCache.set(cacheKey, formatter);
  }
  return formatter;
}

export function formatAchievementMetric(input: {
  value: number;
  unit: AchievementProgressUnit;
  locale: string;
}) {
  switch (input.unit) {
    case "tokens":
      return formatTokenCount(input.value, input.locale);
    case "seconds":
      return formatDuration(Math.round(input.value));
    case "percent":
      return formatPercentage(input.value, input.locale);
    case "usd":
      return getCurrencyFormatter(
        input.locale,
        input.value >= 1000 ? 0 : 2,
      ).format(input.value);
    default:
      return Math.floor(input.value).toLocaleString(input.locale);
  }
}

export function formatAchievementProgress(input: {
  current: number;
  target: number;
  unit: AchievementProgressUnit;
  locale: string;
}) {
  return `${formatAchievementMetric({
    value: Math.min(input.current, input.target),
    unit: input.unit,
    locale: input.locale,
  })} / ${formatAchievementMetric({
    value: input.target,
    unit: input.unit,
    locale: input.locale,
  })}`;
}

export function formatAchievementDate(input: {
  value: string;
  locale: string;
  timezone: string;
}) {
  return getAchievementDateFormatter(input.locale, input.timezone).format(
    new Date(input.value),
  );
}

export function getTierTone(tier: AchievementTier) {
  switch (tier) {
    case "special":
      return "bg-violet-500/12 text-violet-700 dark:text-violet-300";
    case "gold":
      return "bg-amber-500/12 text-amber-700 dark:text-amber-300";
    case "silver":
      return "bg-slate-500/12 text-slate-700 dark:text-slate-300";
    default:
      return "bg-orange-500/12 text-orange-700 dark:text-orange-300";
  }
}
