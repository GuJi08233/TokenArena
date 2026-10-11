import { isIP } from "node:net";

/**
 * Whether `hostname` stays on this machine or the local network, where plain
 * HTTP to a self-hosted server is a reasonable choice.
 */
function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost")) return true;

  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }

  if (isIP(host) === 6) {
    return (
      host === "::1" ||
      /^f[cd][0-9a-f]{2}:/.test(host) ||
      /^fe[89ab][0-9a-f]:/.test(host)
    );
  }

  // A single-label name or a local-only suffix resolves on the LAN.
  return (
    !host.includes(".") ||
    [".local", ".lan", ".internal", ".home.arpa"].some((suffix) =>
      host.endsWith(suffix),
    )
  );
}

/**
 * Why the API key must not be sent to `apiUrl`, or `null` when it may be.
 *
 * Every request carries the key as a bearer token. Plain HTTP to a public host
 * sent it readable to anyone on the path, and a typo such as
 * `http://token.guji.uno` did so on every daemon run, because the redirect to
 * HTTPS is never followed. HTTP stays allowed for loopback and private network
 * addresses, where self-hosted servers often run without TLS.
 */
export function getInsecureApiUrlReason(apiUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return `Invalid API URL: ${apiUrl}`;
  }

  if (url.protocol === "https:") return null;

  if (url.protocol !== "http:") {
    return `Unsupported API URL protocol "${url.protocol}". Use https://.`;
  }

  return isLocalHost(url.hostname)
    ? null
    : `Refusing to send the API key over plain HTTP to ${url.host}. Use https://${url.host}${url.pathname === "/" ? "" : url.pathname} instead.`;
}
