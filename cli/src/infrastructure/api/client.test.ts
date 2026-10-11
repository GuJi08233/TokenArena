import http, {
  createServer,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiClient, getIngestPayloadSize, sanitizeServerText } from "./client";

describe("ApiClient helpers", () => {
  describe("getIngestPayloadSize", () => {
    it("computes payload size in bytes", () => {
      const device = { deviceId: "dev1", hostname: "test" };
      const buckets = [
        {
          source: "test",
          model: "gpt-4",
          projectKey: "proj1",
          projectLabel: "Project 1",
          bucketStart: "2026-01-01T00:00:00Z",
          deviceId: "dev1",
          hostname: "test",
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 0,
          cachedTokens: 0,
          totalTokens: 150,
        },
      ];

      const size = getIngestPayloadSize(device, buckets);
      expect(size).toBeGreaterThan(0);

      const payload = { schemaVersion: 2, device, buckets, sessions: [] };
      expect(size).toBe(Buffer.byteLength(JSON.stringify(payload)));
    });

    it("includes sessions when provided", () => {
      const device = { deviceId: "dev1", hostname: "test" };
      const sessions = [
        {
          source: "test",
          projectKey: "proj1",
          projectLabel: "Project 1",
          sessionHash: "hash1",
          deviceId: "dev1",
          hostname: "test",
          firstMessageAt: "2026-01-01T00:00:00Z",
          lastMessageAt: "2026-01-01T01:00:00Z",
          durationSeconds: 3600,
          activeSeconds: 1800,
          messageCount: 10,
          userMessageCount: 5,
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 0,
          cachedTokens: 0,
          totalTokens: 150,
          primaryModel: "gpt-4",
          modelUsages: [],
        },
      ];

      const withSessions = getIngestPayloadSize(device, [], sessions);
      const withoutSessions = getIngestPayloadSize(device, []);
      expect(withSessions).toBeGreaterThan(withoutSessions);
    });

    it("accounts for deferred achievement synchronization metadata", () => {
      const device = { deviceId: "dev1", hostname: "test" };
      const withoutOption = getIngestPayloadSize(device, []);
      const deferred = getIngestPayloadSize(device, [], undefined, {
        syncAchievements: false,
      });

      expect(deferred).toBeGreaterThan(withoutOption);
    });
  });
});

describe("sanitizeServerText", () => {
  it("strips terminal control sequences from server text", () => {
    // Window title, clipboard write and screen clear, as a hostile server
    // could send them in an error body.
    const hostile =
      "\u001b]0;pwned\u0007\u001b]52;c;ZWNobyBoaQ==\u0007\u001b[2Jbad gateway";

    const cleaned = sanitizeServerText(hostile);

    expect(
      [...cleaned].some((char) => {
        const code = char.charCodeAt(0);
        return code < 0x20 || (code >= 0x7f && code <= 0x9f);
      }),
    ).toBe(false);
    expect(cleaned).toBe("bad gateway");
  });

  it("caps the length kept for messages", () => {
    expect(sanitizeServerText("x".repeat(2_000))).toHaveLength(501);
  });
});

describe("ApiClient transport", () => {
  const device = { deviceId: "device-1234", hostname: "host" };
  let server: Server;
  let baseUrl: string;
  let respond: (res: ServerResponse) => void = () => {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => respond(res));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("never sends the key over plain HTTP to a public host", async () => {
    const request = vi.spyOn(http, "request");
    const client = new ApiClient("http://token.guji.uno", "ta_secret");

    try {
      // Refused at once rather than after the retry backoff.
      await expect(client.ingest(device, [])).rejects.toThrow(
        "Refusing to send the API key over plain HTTP",
      );
      await expect(client.fetchSettings()).rejects.toThrow("plain HTTP");
      await expect(client.deleteDeviceData("device-1234")).rejects.toThrow(
        "plain HTTP",
      );
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
    }
  }, 1_000);

  it("puts only printable server text into the error", async () => {
    respond = (res) => {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("\u001b]0;pwned\u0007rejected");
    };

    const error = await new ApiClient(baseUrl, "ta_secret")
      .ingest(device, [])
      .catch((err: Error) => err);

    expect((error as Error).message).toBe("HTTP 400: rejected");
  });

  it("stops reading a response that will not end", async () => {
    respond = (res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("x".repeat(2 * 1024 * 1024));
    };

    await expect(
      new ApiClient(baseUrl, "ta_secret").deleteDeviceData("device-1234"),
    ).rejects.toThrow("Response too large");
  });
});
