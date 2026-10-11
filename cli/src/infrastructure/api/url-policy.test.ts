import { describe, expect, it } from "vitest";
import { getInsecureApiUrlReason } from "./url-policy";

describe("getInsecureApiUrlReason", () => {
  it("allows HTTPS anywhere", () => {
    expect(getInsecureApiUrlReason("https://token.guji.uno")).toBeNull();
    expect(getInsecureApiUrlReason("https://203.0.113.7:8443/sub")).toBeNull();
  });

  it("allows plain HTTP on loopback and private networks", () => {
    for (const url of [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
      "http://10.0.0.5",
      "http://172.20.1.2",
      "http://192.168.1.10:3000",
      "http://100.100.1.1",
      "http://[fd12:3456::1]",
      "http://nas:3000",
      "http://tokenarena.local",
      "http://arena.home.arpa",
    ]) {
      expect(getInsecureApiUrlReason(url), url).toBeNull();
    }
  });

  it("refuses to send the key over plain HTTP to a public host", () => {
    expect(getInsecureApiUrlReason("http://token.guji.uno")).toBe(
      "Refusing to send the API key over plain HTTP to token.guji.uno. Use https://token.guji.uno instead.",
    );
    expect(getInsecureApiUrlReason("http://203.0.113.7/arena")).toContain(
      "https://203.0.113.7/arena",
    );
    expect(getInsecureApiUrlReason("http://172.32.0.1")).not.toBeNull();
  });

  it("rejects other protocols and malformed URLs", () => {
    expect(getInsecureApiUrlReason("ftp://token.guji.uno")).toContain(
      "Unsupported",
    );
    expect(getInsecureApiUrlReason("not a url")).toContain("Invalid API URL");
  });
});
