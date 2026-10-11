import { NextResponse } from "next/server";
import type { z } from "zod";

/** Ceiling for the JSON bodies of the settings, key and follow routes. */
export const JSON_BODY_MAX_BYTES = 64 * 1024;

type JsonBodyRead = { tooLarge: true } | { tooLarge: false; value: unknown };

/**
 * Read a JSON body, giving up as soon as it exceeds `maxBytes`.
 *
 * `request.json()` buffers whatever arrives. A declared length over the limit
 * is refused up front, and a body without one is cut off once it passes the
 * limit. A missing or malformed body reads as `undefined`, for the caller's
 * schema to accept or reject.
 */
export async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<JsonBodyRead> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength < 0 ||
      contentLength > maxBytes
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
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- a stream yields its chunks one at a time
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      size += value.byteLength;
      if (size > maxBytes) {
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

type ParsedJsonBody<Schema extends z.ZodType> =
  | { success: true; data: z.output<Schema> }
  | { success: false; response: NextResponse };

/**
 * Read and validate a JSON body: 413 when it is too large, 400 with the
 * issues when it does not match `schema`.
 *
 * `schema.parse(await request.json())` threw on malformed JSON and on every
 * schema violation alike, so each bad request surfaced as a 500.
 */
export async function parseJsonBody<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
  maxBytes = JSON_BODY_MAX_BYTES,
): Promise<ParsedJsonBody<Schema>> {
  const body = await readJsonBody(request, maxBytes);

  if (body.tooLarge) {
    return {
      success: false,
      response: NextResponse.json(
        { error: "PAYLOAD_TOO_LARGE", maxBytes },
        { status: 413 },
      ),
    };
  }

  const parsed = schema.safeParse(body.value);

  if (!parsed.success) {
    return {
      success: false,
      response: NextResponse.json(
        { error: "INVALID_PAYLOAD", issues: parsed.error.flatten() },
        { status: 400 },
      ),
    };
  }

  return { success: true, data: parsed.data };
}
