import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseJsonBody, readJsonBody } from "./json-body";

function streamedRequest(text: string) {
  // No content-length header: the size is only known while reading.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

  return new Request("https://example.com/api", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit);
}

describe("readJsonBody", () => {
  it("refuses a declared length over the limit without reading", async () => {
    const request = new Request("https://example.com/api", {
      method: "POST",
      headers: { "content-length": "2048" },
      body: "{}",
    });

    await expect(readJsonBody(request, 1024)).resolves.toEqual({
      tooLarge: true,
    });
  });

  it("cuts off a stream once it passes the limit", async () => {
    await expect(
      readJsonBody(streamedRequest(JSON.stringify("x".repeat(2048))), 1024),
    ).resolves.toEqual({ tooLarge: true });
  });

  it("reads a missing or malformed body as undefined", async () => {
    await expect(
      readJsonBody(new Request("https://example.com/api"), 1024),
    ).resolves.toEqual({ tooLarge: false, value: undefined });
    await expect(
      readJsonBody(streamedRequest("{not json"), 1024),
    ).resolves.toEqual({ tooLarge: false, value: undefined });
  });
});

describe("parseJsonBody", () => {
  const schema = z.object({ name: z.string().min(1) });

  it("returns the parsed data", async () => {
    await expect(
      parseJsonBody(streamedRequest(JSON.stringify({ name: "ok" })), schema),
    ).resolves.toEqual({ success: true, data: { name: "ok" } });
  });

  it("answers 400 for malformed JSON and schema violations", async () => {
    for (const text of ["{not json", JSON.stringify({ name: "" })]) {
      const result = await parseJsonBody(streamedRequest(text), schema);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.response.status).toBe(400);
        await expect(result.response.json()).resolves.toMatchObject({
          error: "INVALID_PAYLOAD",
        });
      }
    }
  });

  it("answers 413 for a body over the limit", async () => {
    const result = await parseJsonBody(
      streamedRequest(JSON.stringify({ name: "x".repeat(100) })),
      schema,
      64,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.response.status).toBe(413);
    }
  });
});
