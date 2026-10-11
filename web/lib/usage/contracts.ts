import { z } from "zod";
import { supportedLocales } from "@/lib/i18n";
import { themeModes } from "@/lib/theme";
import { PG_INTEGER_MAX } from "@/lib/token-counts";
import { normalizeUsageSource } from "./sources";
import {
  dashboardPresets,
  projectModes,
  schemaVersion,
  usageApiKeyStatuses,
} from "./types";

const projectModeSchema = z.enum(projectModes);
const usageApiKeyStatusSchema = z.enum(usageApiKeyStatuses);
const dashboardPresetSchema = z.enum(dashboardPresets);
const localeSchema = z.enum(supportedLocales);
const themeModeSchema = z.enum(themeModes);

// Keep these limits aligned with the CLI upload batches. Apart from protecting
// the database transaction, the bounds prevent a single request from creating
// an unnecessarily large set of Prisma query objects in memory.
export const INGEST_MAX_BUCKETS = 100;
export const INGEST_MAX_SESSIONS = 500;
export const INGEST_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

/**
 * Ceiling for one reported token count.
 *
 * A bucket is one model's usage on one device in half an hour, so a trillion
 * tokens is far beyond any real value, yet small enough that leaderboard sums
 * stay meaningful. Counts are client-reported: without a bound, a few uploads
 * pushed sums past what the shared rank queries could hold.
 */
export const INGEST_MAX_TOKEN_COUNT = 1_000_000_000_000;

/** How far ahead of the server clock a reported timestamp may be. */
export const INGEST_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

// Byte budgets for uploaded strings. The keys share one unique index whose
// entries Postgres caps at about 2.7 kB, so they must stay well below it.
const INGEST_SOURCE_MAX_BYTES = 64;
const INGEST_ID_MAX_BYTES = 128;
const INGEST_MODEL_MAX_BYTES = 256;
const INGEST_PROJECT_MAX_BYTES = 1024;
const INGEST_HOSTNAME_MAX_BYTES = 255;

const utf8 = new TextEncoder();

/** Cut `value` to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(value: string, maxBytes: number) {
  // A UTF-16 code unit never encodes to more than three bytes.
  if (value.length * 3 <= maxBytes) {
    return value;
  }

  let bytes = 0;
  let end = 0;

  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    const size =
      codePoint < 0x80
        ? 1
        : codePoint < 0x800
          ? 2
          : codePoint < 0x10000
            ? 3
            : 4;

    if (bytes + size > maxBytes) {
      break;
    }

    bytes += size;
    end += char.length;
  }

  return value.slice(0, end);
}

/** An identifier that must arrive intact: reject rather than shorten it. */
function boundedId(maxBytes: number) {
  return z.string().refine((value) => utf8.encode(value).length <= maxBytes, {
    message: `Must be at most ${maxBytes} bytes.`,
  });
}

/**
 * A name or label: shorten an oversized one deterministically, so the same
 * upload keeps mapping to the same row instead of failing the whole batch.
 */
function truncatedText(maxBytes: number) {
  return z.string().transform((value) => truncateUtf8(value, maxBytes));
}

const tokenCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(INGEST_MAX_TOKEN_COUNT);

/** Seconds and message counts are stored in `integer` columns. */
const integerCountSchema = z.number().int().nonnegative().max(PG_INTEGER_MAX);

const reportedAtSchema = z
  .string()
  .datetime()
  .refine(
    (value) => Date.parse(value) <= Date.now() + INGEST_FUTURE_TOLERANCE_MS,
    { message: "Timestamp is in the future." },
  );

export function isValidTimezone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

const timezoneByLowerCase = new Map(
  ["UTC", ...Intl.supportedValuesOf("timeZone")].map(
    (name) => [name.toLowerCase(), name] as const,
  ),
);

/**
 * Spell a valid zone the way `Intl` lists it.
 *
 * Zone names match case-insensitively, so `asia/shanghai` passes validation.
 * Stored as typed, each casing became a separate formatter cache key and
 * missed the `Asia/Shanghai` fast paths. Names `Intl` does not list, such as
 * the `Asia/Kolkata` alias the settings form offers, are kept as entered:
 * resolving aliases would no longer match the form's options.
 */
export function normalizeTimezone(timezone: string) {
  return timezoneByLowerCase.get(timezone.toLowerCase()) ?? timezone;
}

const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(isValidTimezone, {
    message: "Invalid timezone. Use IANA format like Asia/Shanghai.",
  })
  .transform(normalizeTimezone);

export const dashboardDateParamSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isNaN(new Date(value).getTime()),
    {
      message: "Invalid date value.",
    },
  );

export const usageSettingsSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  projectMode: projectModeSchema,
  projectHashSalt: z.string().min(1),
  timezone: z.string().trim().min(1),
});

export const usageDeleteQuerySchema = z.object({
  deviceId: z.string().trim().min(8),
});

const ingestBucketSchema = z.object({
  source: boundedId(INGEST_SOURCE_MAX_BYTES),
  model: truncatedText(INGEST_MODEL_MAX_BYTES),
  projectKey: truncatedText(INGEST_PROJECT_MAX_BYTES),
  projectLabel: truncatedText(INGEST_PROJECT_MAX_BYTES),
  bucketStart: reportedAtSchema,
  inputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  reasoningTokens: tokenCountSchema,
  cachedTokens: tokenCountSchema,
  cacheCreationTokens: tokenCountSchema.default(0),
  totalTokens: tokenCountSchema,
});

const ingestSessionSchema = z.object({
  source: boundedId(INGEST_SOURCE_MAX_BYTES),
  projectKey: truncatedText(INGEST_PROJECT_MAX_BYTES),
  projectLabel: truncatedText(INGEST_PROJECT_MAX_BYTES),
  sessionHash: boundedId(INGEST_ID_MAX_BYTES),
  firstMessageAt: reportedAtSchema,
  lastMessageAt: reportedAtSchema,
  durationSeconds: integerCountSchema,
  activeSeconds: integerCountSchema,
  messageCount: integerCountSchema,
  userMessageCount: integerCountSchema,
  inputTokens: tokenCountSchema.optional(),
  outputTokens: tokenCountSchema.optional(),
  reasoningTokens: tokenCountSchema.optional(),
  cachedTokens: tokenCountSchema.optional(),
  cacheCreationTokens: tokenCountSchema.optional(),
  totalTokens: tokenCountSchema.optional(),
  primaryModel: truncatedText(INGEST_MODEL_MAX_BYTES).optional(),
  modelUsages: z
    .array(
      z.object({
        model: truncatedText(INGEST_MODEL_MAX_BYTES),
        inputTokens: tokenCountSchema,
        outputTokens: tokenCountSchema,
        reasoningTokens: tokenCountSchema,
        cachedTokens: tokenCountSchema,
        cacheCreationTokens: tokenCountSchema.default(0),
        totalTokens: tokenCountSchema,
      }),
    )
    .optional(),
});

export const ingestRequestSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  device: z.object({
    deviceId: boundedId(INGEST_ID_MAX_BYTES).min(8),
    hostname: z
      .string()
      .min(1)
      .transform((value) => truncateUtf8(value, INGEST_HOSTNAME_MAX_BYTES)),
  }),
  buckets: z
    .array(ingestBucketSchema)
    .max(
      INGEST_MAX_BUCKETS,
      `A maximum of ${INGEST_MAX_BUCKETS} buckets is allowed.`,
    ),
  sessions: z
    .array(ingestSessionSchema)
    .max(
      INGEST_MAX_SESSIONS,
      `A maximum of ${INGEST_MAX_SESSIONS} sessions is allowed.`,
    ),
  // Multi-batch clients can defer the expensive full-user achievement scan
  // until their final batch. Direct API callers retain the old behavior.
  syncAchievements: z.boolean().default(true),
});

export const dashboardQuerySchema = z
  .object({
    preset: dashboardPresetSchema.optional(),
    from: dashboardDateParamSchema.optional(),
    to: dashboardDateParamSchema.optional(),
    apiKeyId: z.string().trim().min(1).optional(),
    deviceId: z.string().trim().min(1).optional(),
    source: z.string().trim().min(1).transform(normalizeUsageSource).optional(),
    model: z.string().trim().min(1).optional(),
    projectKey: z.string().trim().min(1).optional(),
  })
  .refine(
    (input) => input.preset !== "custom" || Boolean(input.from && input.to),
    {
      message: "Custom ranges require both from and to.",
      path: ["from"],
    },
  );

export const usageKeyCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(80),
});

export const usageKeyUpdateSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required.").max(80).optional(),
    status: usageApiKeyStatusSchema.optional(),
  })
  .refine((input) => input.name !== undefined || input.status !== undefined, {
    message: "At least one field is required.",
  });

export const usagePreferenceUpdateSchema = z
  .object({
    locale: localeSchema.optional(),
    theme: themeModeSchema.optional(),
    timezone: timezoneSchema.optional(),
    projectMode: projectModeSchema.optional(),
    publicProfileEnabled: z.boolean().optional(),
    bio: z.string().trim().max(160).nullable().optional(),
  })
  .refine(
    (input) =>
      input.locale !== undefined ||
      input.theme !== undefined ||
      input.timezone !== undefined ||
      input.projectMode !== undefined ||
      input.publicProfileEnabled !== undefined ||
      input.bio !== undefined,
    {
      message: "At least one field is required.",
    },
  );
