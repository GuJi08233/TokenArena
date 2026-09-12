import { z } from "zod";
import { dashboardDateParamSchema } from "@/lib/usage/contracts";
import { resolveDashboardRange } from "@/lib/usage/date-range";
import type { DashboardRange } from "@/lib/usage/types";

export const profileRangePresets = [
  "all",
  "1d",
  "7d",
  "30d",
  "custom",
] as const;

export type ProfileRangePreset = (typeof profileRangePresets)[number];

export const defaultProfileRangePreset: ProfileRangePreset = "all";

export const profileRangeQuerySchema = z.object({
  preset: z.enum(profileRangePresets).optional(),
  from: dashboardDateParamSchema.optional(),
  to: dashboardDateParamSchema.optional(),
});

export type ProfileRangeQuery = z.infer<typeof profileRangeQuerySchema>;

export type ProfileRangeSelection = {
  preset: ProfileRangePreset;
  /** `null` means all-time: the queries run without any date bounds. */
  range: DashboardRange | null;
};

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Parse the range search params of a public profile. Unlike the dashboard,
 * a malformed query falls back to the default range instead of redirecting:
 * profile URLs get shared around and should never dead-end on a bad param.
 */
export function parseProfileRangeQuery(
  params: Record<string, string | string[] | undefined>,
): ProfileRangeQuery {
  const parsed = profileRangeQuerySchema.safeParse({
    preset: firstValue(params.preset),
    from: firstValue(params.from),
    to: firstValue(params.to),
  });

  return parsed.success ? parsed.data : {};
}

/**
 * Public profiles default to all-time so a shared link keeps showing the
 * lifetime totals that the arena level is built on. Every other preset reuses
 * the dashboard resolver so both pages agree on timezone edges.
 */
export function resolveProfileRange(input: {
  query?: ProfileRangeQuery;
  timezone: string;
  now?: Date;
}): ProfileRangeSelection {
  const preset = input.query?.preset ?? defaultProfileRangePreset;

  if (preset === "all") {
    return { preset, range: null };
  }

  if (preset === "custom" && !(input.query?.from && input.query?.to)) {
    return { preset: defaultProfileRangePreset, range: null };
  }

  return {
    preset,
    range: resolveDashboardRange({
      preset,
      from: input.query?.from,
      to: input.query?.to,
      timezone: input.timezone,
      now: input.now,
    }),
  };
}
