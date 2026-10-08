import { formatDateTimeInput } from "@/lib/usage/format";

const MINUTE_MS = 60 * 1000;

/**
 * Value of a custom-range `datetime-local` input for one edge of the resolved
 * range, in the account timezone.
 *
 * A resolved end is exclusive and sits 1 ms before the instant the user picked,
 * so it rounds up to the minute: `23:59:59.999` reopens as the `00:00` that was
 * chosen, and applying the popover again reproduces the same range.
 */
export function toCustomRangeInputValue(
  iso: string,
  timezone: string,
  edge: "start" | "end",
) {
  const ms = new Date(iso).getTime();
  const minute =
    edge === "end"
      ? Math.ceil(ms / MINUTE_MS) * MINUTE_MS
      : Math.floor(ms / MINUTE_MS) * MINUTE_MS;

  return formatDateTimeInput(new Date(minute), timezone);
}

/**
 * Both edges set and the start before the end. The inputs share the
 * fixed-width `YYYY-MM-DDTHH:mm` form, so string order is time order.
 */
export function isCustomRangeValid(from: string, to: string) {
  return from.length > 0 && to.length > 0 && from < to;
}
