import type { LeaderboardPeriod, LeaderboardWindow } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * HOUR_MS;

export const SHANGHAI_TIMEZONE = "Asia/Shanghai";

type ShanghaiDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

type FinalizableLeaderboardWindow = LeaderboardWindow & {
  finalizeAt: Date;
};

function toShanghaiDateParts(value: Date): ShanghaiDateParts {
  const shifted = new Date(value.getTime() + SHANGHAI_OFFSET_MS);

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    millisecond: shifted.getUTCMilliseconds(),
  };
}

function fromShanghaiDateParts(input: {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  millisecond?: number;
}) {
  return new Date(
    Date.UTC(
      input.year,
      input.month - 1,
      input.day,
      input.hour ?? 0,
      input.minute ?? 0,
      input.second ?? 0,
      input.millisecond ?? 0,
    ) - SHANGHAI_OFFSET_MS,
  );
}

function addDays(value: Date, days: number) {
  return new Date(value.getTime() + days * DAY_MS);
}

function startOfShanghaiWeek(value: Date) {
  const day = new Date(value.getTime());
  const shifted = new Date(day.getTime() + SHANGHAI_OFFSET_MS);
  const weekday = shifted.getUTCDay();
  const deltaToMonday = weekday === 0 ? -6 : 1 - weekday;

  return addDays(startOfShanghaiDay(value), deltaToMonday);
}

function startOfShanghaiMonth(value: Date) {
  const parts = toShanghaiDateParts(value);
  return fromShanghaiDateParts({
    year: parts.year,
    month: parts.month,
    day: 1,
  });
}

function formatLabelDate(value: Date) {
  const parts = toShanghaiDateParts(value);
  return `${parts.year}.${String(parts.month).padStart(2, "0")}.${String(parts.day).padStart(2, "0")}`;
}

export function startOfShanghaiDay(value: Date) {
  const parts = toShanghaiDateParts(value);
  return fromShanghaiDateParts({
    year: parts.year,
    month: parts.month,
    day: parts.day,
  });
}

export function getShanghaiDateKey(value: Date) {
  const parts = toShanghaiDateParts(value);

  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function resolveLeaderboardWindow(
  period: LeaderboardPeriod,
  now = new Date(),
): LeaderboardWindow {
  if (period === "all_time") {
    return {
      start: null,
      end: null,
    };
  }

  if (period === "day") {
    const start = startOfShanghaiDay(now);
    return {
      start,
      end: addDays(start, 1),
    };
  }

  if (period === "week") {
    const start = startOfShanghaiWeek(now);
    return {
      start,
      end: addDays(start, 7),
    };
  }

  const start = startOfShanghaiMonth(now);
  const parts = toShanghaiDateParts(now);

  return {
    start,
    end: fromShanghaiDateParts({
      year: parts.month === 12 ? parts.year + 1 : parts.year,
      month: parts.month === 12 ? 1 : parts.month + 1,
      day: 1,
    }),
  };
}

export function resolveLatestFinalizableLeaderboardWindow(
  period: LeaderboardPeriod,
  now = new Date(),
): FinalizableLeaderboardWindow | null {
  if (period === "all_time") {
    return null;
  }

  const currentWindow = resolveLeaderboardWindow(period, now);

  if (!currentWindow.start || !currentWindow.end) {
    return null;
  }

  const finalizeAt = new Date(currentWindow.start.getTime() + 4 * HOUR_MS);

  if (now.getTime() < finalizeAt.getTime()) {
    return null;
  }

  if (period === "day") {
    return {
      start: addDays(currentWindow.start, -1),
      end: currentWindow.start,
      finalizeAt,
    };
  }

  if (period === "week") {
    return {
      start: addDays(currentWindow.start, -7),
      end: currentWindow.start,
      finalizeAt,
    };
  }

  const previousReference = addDays(currentWindow.start, -1);
  const start = startOfShanghaiMonth(previousReference);

  return {
    start,
    end: currentWindow.start,
    finalizeAt,
  };
}

/**
 * The most recent `count` finalizable windows of a period, oldest first.
 *
 * Finalization only runs when a request triggers it, so a window whose pass
 * failed, or that no request reached in time, would never be revisited once a
 * newer window became the latest.
 */
export function resolveFinalizableLeaderboardWindows(
  period: LeaderboardPeriod,
  now = new Date(),
  count = 1,
): Array<{ start: Date; end: Date }> {
  const latest = resolveLatestFinalizableLeaderboardWindow(period, now);

  if (!latest?.start || !latest.end) {
    return [];
  }

  const windows = [{ start: latest.start, end: latest.end }];

  while (windows.length < count) {
    const end = windows[0].start;
    const start =
      period === "day"
        ? addDays(end, -1)
        : period === "week"
          ? addDays(end, -7)
          : startOfShanghaiMonth(addDays(end, -1));

    windows.unshift({ start, end });
  }

  return windows;
}

export function formatLeaderboardWindowLabel(input: {
  period: LeaderboardPeriod;
  windowStart: string | null;
  windowEnd: string | null;
  locale: string;
  timezone?: string;
}) {
  if (
    input.period === "all_time" ||
    !input.windowStart ||
    !input.windowEnd ||
    input.timezone === null
  ) {
    return null;
  }

  const start = new Date(input.windowStart);
  const inclusiveEnd = new Date(new Date(input.windowEnd).getTime() - DAY_MS);

  if (input.period === "day") {
    return formatLabelDate(start);
  }

  return `${formatLabelDate(start)} - ${formatLabelDate(inclusiveEnd)}`;
}

export function sameLeaderboardWindow(
  left: LeaderboardWindow,
  right: LeaderboardWindow,
) {
  return (
    left.start?.getTime() === right.start?.getTime() &&
    left.end?.getTime() === right.end?.getTime()
  );
}
