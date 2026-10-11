import { after, NextResponse } from "next/server";

import { synchronizeAchievementsInBackground } from "@/lib/achievements/queries";
import { readJsonBody } from "@/lib/json-body";
import { findUsageApiKeyByRaw } from "@/lib/usage/api-keys";
import {
  INGEST_MAX_PAYLOAD_BYTES,
  ingestRequestSchema,
  usageDeleteQuerySchema,
} from "@/lib/usage/contracts";
import {
  deleteUsageDeviceSnapshot,
  ingestUsagePayload,
} from "@/lib/usage/ingest";

function getBearerToken(request: Request) {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
}

async function getAuthenticatedApiKey(request: Request) {
  const rawKey = getBearerToken(request);

  if (!rawKey) {
    return null;
  }

  return findUsageApiKeyByRaw(rawKey);
}

export async function POST(request: Request) {
  const apiKey = await getAuthenticatedApiKey(request);

  if (!apiKey) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const body = await readJsonBody(request, INGEST_MAX_PAYLOAD_BYTES);
  if (body.tooLarge) {
    return NextResponse.json(
      {
        error: "PAYLOAD_TOO_LARGE",
        maxBytes: INGEST_MAX_PAYLOAD_BYTES,
      },
      { status: 413 },
    );
  }

  const parsed = ingestRequestSchema.safeParse(body.value);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "INVALID_PAYLOAD",
        issues: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  const result = await ingestUsagePayload({
    userId: apiKey.userId,
    apiKeyId: apiKey.id,
    payload: parsed.data,
  });

  // The upload has committed; the award pass behind it runs after the
  // response, so its failure cannot make the CLI re-send the batch.
  if (parsed.data.syncAchievements) {
    after(() => synchronizeAchievementsInBackground(apiKey.userId, "ingest"));
  }

  return NextResponse.json(result);
}

export async function DELETE(request: Request) {
  const apiKey = await getAuthenticatedApiKey(request);

  if (!apiKey) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const url = new URL(request.url);
  const parsed = usageDeleteQuerySchema.safeParse({
    deviceId: url.searchParams.get("deviceId") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "INVALID_QUERY",
        issues: parsed.error.flatten(),
      },
      { status: 400 },
    );
  }

  const result = await deleteUsageDeviceSnapshot({
    userId: apiKey.userId,
    deviceId: parsed.data.deviceId,
  });

  if (result.deletedBuckets > 0 || result.deletedSessions > 0) {
    after(() => synchronizeAchievementsInBackground(apiKey.userId, "ingest"));
  }

  return NextResponse.json(result);
}
