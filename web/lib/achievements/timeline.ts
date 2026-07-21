import type {
  AchievementDistinctTimelinePoint,
  AchievementTimelinePoint,
} from "./evaluate";

function compareIsoTimestamp(left: string, right: string) {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

export function addTimelineValue(
  valuesByTimestamp: Map<string, number>,
  at: string,
  value: number,
) {
  valuesByTimestamp.set(at, (valuesByTimestamp.get(at) ?? 0) + value);
}

export function finalizeTimeline(
  valuesByTimestamp: ReadonlyMap<string, number>,
): AchievementTimelinePoint[] {
  return Array.from(valuesByTimestamp, ([at, value]) => ({ at, value })).sort(
    (left, right) => compareIsoTimestamp(left.at, right.at),
  );
}

export function recordDistinctTimelineKey(
  firstTimestampByKey: Map<string, string>,
  key: string | null | undefined,
  at: string,
) {
  if (!key) {
    return;
  }

  const existing = firstTimestampByKey.get(key);
  if (!existing || compareIsoTimestamp(at, existing) < 0) {
    firstTimestampByKey.set(key, at);
  }
}

export function finalizeDistinctTimeline(
  firstTimestampByKey: ReadonlyMap<string, string>,
): AchievementDistinctTimelinePoint[] {
  return Array.from(firstTimestampByKey, ([key, at]) => ({ at, key })).sort(
    (left, right) => compareIsoTimestamp(left.at, right.at),
  );
}
