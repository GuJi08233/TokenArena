import { describe, expect, it } from "vitest";

import {
  dashboardQuerySchema,
  INGEST_FUTURE_TOLERANCE_MS,
  INGEST_MAX_BUCKETS,
  INGEST_MAX_SESSIONS,
  INGEST_MAX_TOKEN_COUNT,
  ingestRequestSchema,
  isValidTimezone,
  normalizeTimezone,
  truncateUtf8,
  usageDeleteQuerySchema,
  usageKeyCreateSchema,
  usageKeyUpdateSchema,
  usagePreferenceUpdateSchema,
  usageSettingsSchema,
} from "./contracts";

const INGEST_DEVICE = {
  deviceId: "device-1234",
  hostname: "macbook-pro",
};

function ingestBucket(overrides: Record<string, unknown> = {}) {
  return {
    source: "codex",
    model: "gpt-5.4",
    projectKey: "abc123",
    projectLabel: "Project abc123",
    bucketStart: "2026-03-26T10:00:00.000Z",
    inputTokens: 100,
    outputTokens: 60,
    reasoningTokens: 10,
    cachedTokens: 25,
    cacheCreationTokens: 0,
    totalTokens: 195,
    ...overrides,
  };
}

function ingestSession(overrides: Record<string, unknown> = {}) {
  return {
    source: "codex",
    projectKey: "abc123",
    projectLabel: "Project abc123",
    sessionHash: "session-hash",
    firstMessageAt: "2026-03-26T10:00:00.000Z",
    lastMessageAt: "2026-03-26T10:10:00.000Z",
    durationSeconds: 600,
    activeSeconds: 420,
    messageCount: 8,
    userMessageCount: 3,
    ...overrides,
  };
}

function parseIngest(input: {
  buckets?: unknown[];
  sessions?: unknown[];
  device?: Record<string, unknown>;
}) {
  return ingestRequestSchema.safeParse({
    schemaVersion: 2,
    device: input.device ?? INGEST_DEVICE,
    buckets: input.buckets ?? [],
    sessions: input.sessions ?? [],
  });
}

describe("ingestRequestSchema bounds", () => {
  it("rejects token counts above the per-field ceiling", () => {
    expect(
      parseIngest({
        buckets: [ingestBucket({ cachedTokens: INGEST_MAX_TOKEN_COUNT })],
      }).success,
    ).toBe(true);
    expect(
      parseIngest({
        buckets: [ingestBucket({ cachedTokens: INGEST_MAX_TOKEN_COUNT + 1 })],
      }).success,
    ).toBe(false);
    expect(
      parseIngest({
        sessions: [
          ingestSession({
            modelUsages: [
              {
                model: "gpt-5.4",
                inputTokens: Number.MAX_SAFE_INTEGER,
                outputTokens: 0,
                reasoningTokens: 0,
                cachedTokens: 0,
                totalTokens: 0,
              },
            ],
          }),
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects seconds and counts that an integer column cannot hold", () => {
    expect(
      parseIngest({
        sessions: [ingestSession({ activeSeconds: 2_147_483_647 })],
      }).success,
    ).toBe(true);
    for (const field of [
      "durationSeconds",
      "activeSeconds",
      "messageCount",
      "userMessageCount",
    ]) {
      expect(
        parseIngest({
          sessions: [ingestSession({ [field]: 2_147_483_648 })],
        }).success,
      ).toBe(false);
    }
  });

  it("rejects timestamps more than a day ahead of the server clock", () => {
    const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const tooFar = new Date(
      Date.now() + INGEST_FUTURE_TOLERANCE_MS + 60 * 60 * 1000,
    ).toISOString();

    expect(
      parseIngest({ buckets: [ingestBucket({ bucketStart: soon })] }).success,
    ).toBe(true);
    expect(
      parseIngest({ buckets: [ingestBucket({ bucketStart: tooFar })] }).success,
    ).toBe(false);
    expect(
      parseIngest({ sessions: [ingestSession({ lastMessageAt: tooFar })] })
        .success,
    ).toBe(false);
  });

  it("shortens oversized names instead of failing the batch", () => {
    const result = parseIngest({
      device: { deviceId: "device-1234", hostname: "h".repeat(400) },
      buckets: [
        ingestBucket({
          model: "m".repeat(5_000),
          projectKey: "项".repeat(2_000),
          projectLabel: "p".repeat(5_000),
        }),
      ],
      sessions: [ingestSession({ primaryModel: "m".repeat(5_000) })],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      const [bucket] = result.data.buckets;
      expect(bucket?.model).toHaveLength(256);
      // Three bytes per character: 341 whole characters fit in 1024 bytes.
      expect(bucket?.projectKey).toBe("项".repeat(341));
      expect(bucket?.projectLabel).toHaveLength(1024);
      expect(result.data.device.hostname).toHaveLength(255);
      expect(result.data.sessions[0]?.primaryModel).toHaveLength(256);
    }
  });

  it("rejects identifiers too long to be real", () => {
    expect(
      parseIngest({ buckets: [ingestBucket({ source: "s".repeat(65) })] })
        .success,
    ).toBe(false);
    expect(
      parseIngest({
        sessions: [ingestSession({ sessionHash: "h".repeat(129) })],
      }).success,
    ).toBe(false);
    expect(
      parseIngest({
        device: { deviceId: "d".repeat(129), hostname: "macbook-pro" },
      }).success,
    ).toBe(false);
  });
});

describe("truncateUtf8", () => {
  it("never splits a multi-byte character", () => {
    expect(truncateUtf8("ab😀cd", 5)).toBe("ab");
    expect(truncateUtf8("ab😀cd", 6)).toBe("ab😀");
    expect(truncateUtf8("short", 64)).toBe("short");
  });
});

describe("ingestRequestSchema", () => {
  it("requires schemaVersion and device metadata", () => {
    const result = ingestRequestSchema.safeParse({
      buckets: [],
      sessions: [],
    });

    expect(result.success).toBe(false);
  });

  it("accepts date-only custom dashboard queries", () => {
    const result = dashboardQuerySchema.safeParse({
      preset: "custom",
      from: "2026-03-26",
      to: "2026-03-27",
    });

    expect(result.success).toBe(true);
  });

  it("rejects invalid custom dashboard dates", () => {
    const result = dashboardQuerySchema.safeParse({
      preset: "custom",
      from: "not-a-date",
      to: "2026-03-27",
    });

    expect(result.success).toBe(false);
  });

  it("preserves reasoning tokens as a separate field", () => {
    const result = ingestRequestSchema.safeParse({
      schemaVersion: 2,
      device: {
        deviceId: "device-1234",
        hostname: "macbook-pro",
      },
      buckets: [
        {
          source: "codex",
          model: "gpt-5.4",
          projectKey: "abc123",
          projectLabel: "Project abc123",
          bucketStart: "2026-03-26T10:00:00.000Z",
          inputTokens: 100,
          outputTokens: 60,
          reasoningTokens: 10,
          cachedTokens: 25,
          cacheCreationTokens: 0,
          totalTokens: 185,
        },
      ],
      sessions: [
        {
          source: "codex",
          projectKey: "abc123",
          projectLabel: "Project abc123",
          sessionHash: "session-hash",
          firstMessageAt: "2026-03-26T10:00:00.000Z",
          lastMessageAt: "2026-03-26T10:10:00.000Z",
          durationSeconds: 600,
          activeSeconds: 420,
          messageCount: 8,
          userMessageCount: 3,
          inputTokens: 100,
          outputTokens: 60,
          reasoningTokens: 10,
          cachedTokens: 25,
          cacheCreationTokens: 0,
          totalTokens: 195,
          primaryModel: "gpt-5.4",
          modelUsages: [
            {
              model: "gpt-5.4",
              inputTokens: 100,
              outputTokens: 60,
              reasoningTokens: 10,
              cachedTokens: 25,
              cacheCreationTokens: 0,
              totalTokens: 195,
            },
          ],
        },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.syncAchievements).toBe(true);
      expect(result.data.buckets[0]?.reasoningTokens).toBe(10);
      expect(result.data.sessions[0]?.reasoningTokens).toBe(10);
      expect(result.data.sessions[0]?.primaryModel).toBe("gpt-5.4");
      expect(result.data.sessions[0]?.modelUsages?.[0]?.totalTokens).toBe(195);
    }
  });

  it("allows multi-batch clients to defer achievement synchronization", () => {
    const result = ingestRequestSchema.safeParse({
      schemaVersion: 2,
      device: {
        deviceId: "device-1234",
        hostname: "macbook-pro",
      },
      buckets: [],
      sessions: [],
      syncAchievements: false,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.syncAchievements).toBe(false);
    }
  });

  it("enforces the CLI bucket and session batch limits", () => {
    const bucket = {
      source: "codex",
      model: "gpt-5.4",
      projectKey: "abc123",
      projectLabel: "Project abc123",
      bucketStart: "2026-03-26T10:00:00.000Z",
      inputTokens: 100,
      outputTokens: 60,
      reasoningTokens: 10,
      cachedTokens: 25,
      cacheCreationTokens: 0,
      totalTokens: 195,
    };
    const session = {
      source: "codex",
      projectKey: "abc123",
      projectLabel: "Project abc123",
      sessionHash: "session-hash",
      firstMessageAt: "2026-03-26T10:00:00.000Z",
      lastMessageAt: "2026-03-26T10:10:00.000Z",
      durationSeconds: 600,
      activeSeconds: 420,
      messageCount: 8,
      userMessageCount: 3,
    };
    const basePayload = {
      schemaVersion: 2,
      device: {
        deviceId: "device-1234",
        hostname: "macbook-pro",
      },
    };

    expect(
      ingestRequestSchema.safeParse({
        ...basePayload,
        buckets: Array.from({ length: INGEST_MAX_BUCKETS }, () => bucket),
        sessions: Array.from({ length: INGEST_MAX_SESSIONS }, () => session),
      }).success,
    ).toBe(true);
    expect(
      ingestRequestSchema.safeParse({
        ...basePayload,
        buckets: Array.from({ length: INGEST_MAX_BUCKETS + 1 }, () => bucket),
        sessions: [],
      }).success,
    ).toBe(false);
    expect(
      ingestRequestSchema.safeParse({
        ...basePayload,
        buckets: [],
        sessions: Array.from(
          { length: INGEST_MAX_SESSIONS + 1 },
          () => session,
        ),
      }).success,
    ).toBe(false);
  });

  it("accepts locale and theme updates in usage preferences", () => {
    const result = usagePreferenceUpdateSchema.safeParse({
      locale: "zh",
      theme: "dark",
    });

    expect(result.success).toBe(true);
  });

  it("requires a device id when deleting a device snapshot", () => {
    expect(
      usageDeleteQuerySchema.safeParse({
        deviceId: "device-1234",
      }).success,
    ).toBe(true);
    expect(
      usageDeleteQuerySchema.safeParse({
        deviceId: "",
      }).success,
    ).toBe(false);
  });
});

describe("isValidTimezone", () => {
  it("returns true for UTC", () => {
    expect(isValidTimezone("UTC")).toBe(true);
  });

  it("returns true for Asia/Shanghai", () => {
    expect(isValidTimezone("Asia/Shanghai")).toBe(true);
  });

  it("returns false for an invalid timezone string", () => {
    expect(isValidTimezone("Invalid/Timezone")).toBe(false);
  });
});

describe("normalizeTimezone", () => {
  it("stores one spelling for every casing of a listed zone", () => {
    expect(normalizeTimezone("asia/shanghai")).toBe("Asia/Shanghai");
    expect(normalizeTimezone("ASIA/SHANGHAI")).toBe("Asia/Shanghai");
    expect(normalizeTimezone("utc")).toBe("UTC");
  });

  it("keeps an alias the settings form offers as entered", () => {
    expect(normalizeTimezone("Asia/Kolkata")).toBe("Asia/Kolkata");
  });

  it("normalizes the timezone of a preference update", () => {
    const result = usagePreferenceUpdateSchema.safeParse({
      timezone: " aSiA/sHaNgHaI ",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timezone).toBe("Asia/Shanghai");
    }
  });
});

describe("usageKeyCreateSchema", () => {
  it("accepts a valid name", () => {
    const result = usageKeyCreateSchema.safeParse({ name: "My API Key" });
    expect(result.success).toBe(true);
  });

  it("rejects an empty name", () => {
    const result = usageKeyCreateSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a name exceeding 80 characters", () => {
    const result = usageKeyCreateSchema.safeParse({
      name: "a".repeat(81),
    });
    expect(result.success).toBe(false);
  });
});

describe("usageKeyUpdateSchema", () => {
  it("accepts update with only name", () => {
    const result = usageKeyUpdateSchema.safeParse({ name: "New Name" });
    expect(result.success).toBe(true);
  });

  it("accepts update with only status", () => {
    const result = usageKeyUpdateSchema.safeParse({ status: "disabled" });
    expect(result.success).toBe(true);
  });

  it("rejects update with neither name nor status", () => {
    const result = usageKeyUpdateSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("dashboardQuerySchema additional cases", () => {
  it("accepts a preset without from/to", () => {
    const result = dashboardQuerySchema.safeParse({ preset: "7d" });
    expect(result.success).toBe(true);
  });

  it("rejects custom preset without from and to", () => {
    const result = dashboardQuerySchema.safeParse({ preset: "custom" });
    expect(result.success).toBe(false);
  });

  it("accepts custom preset with valid from and to", () => {
    const result = dashboardQuerySchema.safeParse({
      preset: "custom",
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(result.success).toBe(true);
  });
});

describe("usageSettingsSchema", () => {
  it("accepts a valid settings object", () => {
    const result = usageSettingsSchema.safeParse({
      schemaVersion: 2,
      projectMode: "raw",
      projectHashSalt: "some-salt-value",
      timezone: "UTC",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid schemaVersion", () => {
    const result = usageSettingsSchema.safeParse({
      schemaVersion: 99,
      projectMode: "raw",
      projectHashSalt: "some-salt-value",
      timezone: "UTC",
    });
    expect(result.success).toBe(false);
  });
});

describe("dashboardQuerySchema wall-clock custom edges", () => {
  it("accepts datetime-local values without an offset", () => {
    const result = dashboardQuerySchema.safeParse({
      preset: "custom",
      from: "2026-03-26T10:00",
      to: "2026-03-26T18:00",
    });

    expect(result.success).toBe(true);
  });

  it("rejects an impossible wall-clock time", () => {
    const result = dashboardQuerySchema.safeParse({
      preset: "custom",
      from: "2026-03-26T25:00",
      to: "2026-03-26T18:00",
    });

    expect(result.success).toBe(false);
  });
});
