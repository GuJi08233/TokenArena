import { NextResponse } from "next/server";

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

type IngestBodyResult =
  | { tooLarge: true }
  | { tooLarge: false; value: unknown };

async function readIngestBody(request: Request): Promise<IngestBodyResult> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength < 0 ||
      contentLength > INGEST_MAX_PAYLOAD_BYTES
    ) {
      return { tooLarge: true };
    }
  }

  if (!request.body) {
    return { tooLarge: false, value: undefined };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      size += value.byteLength;
      if (size > INGEST_MAX_PAYLOAD_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size violation still takes precedence over a cancellation error.
        }
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { tooLarge: false, value: undefined };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return {
      tooLarge: false,
      value: JSON.parse(new TextDecoder().decode(bytes)),
    };
  } catch {
    return { tooLarge: false, value: undefined };
  }
}

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

  const body = await readIngestBody(request);
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

  return NextResponse.json(result);
}
