import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import type {
  ApiSettings,
  DeviceMetadata,
  IngestResponse,
  UploadSessionMetadata,
  UploadTokenBucket,
} from "../../domain/types";
import { getInsecureApiUrlReason } from "./url-policy";

const MAX_RETRIES = 3;
const INITIAL_DELAY = 1000;
const TIMEOUT_MS = 60_000;
/** A real response is a few hundred bytes; stop reading anything far beyond. */
const MAX_RESPONSE_BYTES = 1024 * 1024;
/** How much of an error response is kept for messages and `status.json`. */
const MAX_ERROR_TEXT_LENGTH = 500;

/** OSC strings, CSI sequences and two-byte escapes, parameters included. */
const ESCAPE_SEQUENCE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
  /\u001b(?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * Make server-provided text safe to print and store.
 *
 * Error responses were echoed into messages verbatim, so a hostile or
 * compromised server could send terminal escape sequences (retitle the
 * window, write the clipboard, clear the screen) that the CLI printed, saved
 * in `status.json`, and printed again with `status`.
 */
export function sanitizeServerText(
  text: string,
  maxLength = MAX_ERROR_TEXT_LENGTH,
): string {
  // Whole sequences first, so their parameters do not survive as text.
  const printable = text
    .replace(ESCAPE_SEQUENCE, "")
    .replace(CONTROL_CHARACTERS, " ")
    .trim();

  return printable.length > maxLength
    ? `${printable.slice(0, maxLength)}…`
    : printable;
}

/**
 * Collect a response body, failing once it passes `MAX_RESPONSE_BYTES`
 * instead of buffering whatever the server sends.
 */
function collectBody(
  res: http.IncomingMessage,
  onDone: (data: string) => void,
  onTooLarge: () => void,
) {
  const chunks: Buffer[] = [];
  let size = 0;

  res.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) {
      res.destroy();
      onTooLarge();
      return;
    }
    chunks.push(chunk);
  });
  res.on("end", () => {
    if (size <= MAX_RESPONSE_BYTES) {
      onDone(Buffer.concat(chunks).toString("utf-8"));
    }
  });
}

/** A request refused before anything was sent; retrying cannot help. */
class InsecureApiUrlError extends Error {}

function httpError(statusCode: number | undefined, data: string) {
  const err = new Error(
    `HTTP ${statusCode}: ${sanitizeServerText(data)}`,
  ) as Error & {
    statusCode?: number;
  };
  err.statusCode = statusCode;
  return err;
}

export interface IngestOptions {
  /** Defer the full achievement scan for intermediate upload batches. */
  syncAchievements?: boolean;
}

function buildIngestPayload(
  device: DeviceMetadata,
  buckets: UploadTokenBucket[],
  sessions?: UploadSessionMetadata[],
  options?: IngestOptions,
) {
  return {
    schemaVersion: 2 as const,
    device,
    buckets,
    sessions: sessions ?? [],
    ...(options?.syncAchievements === undefined
      ? {}
      : { syncAchievements: options.syncAchievements }),
  };
}

export function getIngestPayloadSize(
  device: DeviceMetadata,
  buckets: UploadTokenBucket[],
  sessions?: UploadSessionMetadata[],
  options?: IngestOptions,
): number {
  return Buffer.byteLength(
    JSON.stringify(buildIngestPayload(device, buckets, sessions, options)),
  );
}

export class ApiClient {
  constructor(
    private apiUrl: string,
    private apiKey: string,
  ) {}

  /** Endpoint URL, refusing one the key must not be sent to. */
  private endpoint(path: string) {
    const reason = getInsecureApiUrlReason(this.apiUrl);
    if (reason) {
      throw new InsecureApiUrlError(reason);
    }

    return new URL(path, this.apiUrl);
  }

  /**
   * Ingest buckets and sessions to server
   */
  async ingest(
    device: DeviceMetadata,
    buckets: UploadTokenBucket[],
    sessions?: UploadSessionMetadata[],
    onProgress?: (sent: number, total: number) => void,
    options?: IngestOptions,
  ): Promise<{ ingested?: number; sessions?: number }> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.sendIngest(
          device,
          buckets,
          sessions,
          onProgress,
          options,
        );
      } catch (err) {
        lastError = err as Error;
        const httpErr = err as { statusCode?: number; message: string };
        // Don't retry auth errors, client errors or a refused URL
        if (
          err instanceof InsecureApiUrlError ||
          httpErr.message === "UNAUTHORIZED" ||
          (httpErr.statusCode &&
            httpErr.statusCode >= 400 &&
            httpErr.statusCode < 500)
        ) {
          throw err;
        }
        if (attempt < MAX_RETRIES - 1) {
          const delay = INITIAL_DELAY * 2 ** attempt;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
  }

  private sendIngest(
    device: DeviceMetadata,
    buckets: UploadTokenBucket[],
    sessions?: UploadSessionMetadata[],
    onProgress?: (sent: number, total: number) => void,
    options?: IngestOptions,
  ): Promise<{ ingested?: number; sessions?: number }> {
    return new Promise((resolve, reject) => {
      const url = this.endpoint("/api/usage/ingest");
      const body = Buffer.from(
        JSON.stringify(buildIngestPayload(device, buckets, sessions, options)),
      );
      const totalBytes = body.length;
      const mod = url.protocol === "https:" ? https : http;

      const req = mod.request(
        url,
        {
          method: "POST",
          timeout: TIMEOUT_MS,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Length": totalBytes,
          },
        },
        (res) => {
          collectBody(
            res,
            (data) => {
              if (res.statusCode === 401) {
                reject(new Error("UNAUTHORIZED"));
                return;
              }
              if (
                !res.statusCode ||
                res.statusCode < 200 ||
                res.statusCode >= 300
              ) {
                reject(httpError(res.statusCode, data));
                return;
              }
              try {
                const response = JSON.parse(data) as IngestResponse;
                resolve({
                  ingested: response.bucketCount ?? response.ingested,
                  sessions: response.sessionCount ?? response.sessions,
                });
              } catch {
                reject(
                  new Error(
                    `Invalid JSON response: ${sanitizeServerText(data)}`,
                  ),
                );
              }
            },
            () => reject(new Error("Response too large")),
          );
        },
      );

      req.on("error", (err) => reject(err));
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timed out (60s)"));
      });

      // Write body in chunks to report upload progress
      const CHUNK = 16 * 1024;
      let sent = 0;

      const writeNext = () => {
        let ok = true;
        while (ok && sent < totalBytes) {
          const slice = body.subarray(sent, sent + CHUNK);
          sent += slice.length;
          if (onProgress) onProgress(sent, totalBytes);
          ok = req.write(slice);
        }
        if (sent < totalBytes) {
          req.once("drain", writeNext);
        } else {
          req.end();
        }
      };

      writeNext();
    });
  }

  /**
   * Fetch user settings from server
   */
  async fetchSettings(): Promise<ApiSettings | null> {
    return new Promise((resolve, reject) => {
      const url = this.endpoint("/api/usage/settings");
      const mod = url.protocol === "https:" ? https : http;

      const req = mod.request(
        url,
        {
          method: "GET",
          timeout: 10_000,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        },
        (res) => {
          collectBody(
            res,
            (data) => {
              if (res.statusCode === 401) {
                reject(new Error("UNAUTHORIZED"));
                return;
              }
              if (
                !res.statusCode ||
                res.statusCode < 200 ||
                res.statusCode >= 300
              ) {
                resolve(null);
                return;
              }
              try {
                const settings = JSON.parse(data) as ApiSettings;
                if (
                  settings.schemaVersion !== 2 ||
                  !settings.projectMode ||
                  !settings.projectHashSalt ||
                  !settings.timezone
                ) {
                  resolve(null);
                  return;
                }

                resolve(settings);
              } catch {
                resolve(null);
              }
            },
            () => resolve(null),
          );
        },
      );

      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
      req.end();
    });
  }

  async deleteDeviceData(deviceId: string): Promise<{
    deletedBuckets: number;
    deletedSessions: number;
  }> {
    return new Promise((resolve, reject) => {
      const url = this.endpoint("/api/usage/ingest");
      url.searchParams.set("deviceId", deviceId);
      const mod = url.protocol === "https:" ? https : http;

      const req = mod.request(
        url,
        {
          method: "DELETE",
          timeout: TIMEOUT_MS,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
          },
        },
        (res) => {
          collectBody(
            res,
            (data) => {
              if (res.statusCode === 401) {
                reject(new Error("UNAUTHORIZED"));
                return;
              }
              if (
                !res.statusCode ||
                res.statusCode < 200 ||
                res.statusCode >= 300
              ) {
                reject(httpError(res.statusCode, data));
                return;
              }
              try {
                resolve(JSON.parse(data));
              } catch {
                reject(
                  new Error(
                    `Invalid JSON response: ${sanitizeServerText(data)}`,
                  ),
                );
              }
            },
            () => reject(new Error("Response too large")),
          );
        },
      );

      req.on("error", (err) => reject(err));
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timed out (60s)"));
      });
      req.end();
    });
  }
}
