import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../../testing/temp-dir";

describe("config/manager", () => {
  const originalConfigHome = process.env.XDG_CONFIG_HOME;
  const originalDev = process.env.TOKEN_ARENA_DEV;
  const originalApiUrl = process.env.TOKEN_ARENA_API_URL;
  const makeTempDir = useTempDirs();

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalConfigHome !== undefined) {
      process.env.XDG_CONFIG_HOME = originalConfigHome;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    if (originalDev !== undefined) {
      process.env.TOKEN_ARENA_DEV = originalDev;
    } else {
      delete process.env.TOKEN_ARENA_DEV;
    }
    if (originalApiUrl !== undefined) {
      process.env.TOKEN_ARENA_API_URL = originalApiUrl;
    } else {
      delete process.env.TOKEN_ARENA_API_URL;
    }
  });

  async function importManager() {
    return await import("./manager");
  }

  describe("validateApiKey", () => {
    it("accepts keys starting with ta_", async () => {
      const { validateApiKey } = await importManager();
      expect(validateApiKey("ta_abc123")).toBe(true);
    });

    it("rejects other keys", async () => {
      const { validateApiKey } = await importManager();
      expect(validateApiKey("sk_abc")).toBe(false);
      expect(validateApiKey("abc")).toBe(false);
    });
  });

  describe("isValidConfigKey", () => {
    it("accepts valid keys", async () => {
      const { isValidConfigKey } = await importManager();
      expect(isValidConfigKey("apiKey")).toBe(true);
      expect(isValidConfigKey("apiUrl")).toBe(true);
      expect(isValidConfigKey("syncInterval")).toBe(true);
      expect(isValidConfigKey("logLevel")).toBe(true);
      expect(isValidConfigKey("deviceId")).toBe(true);
    });

    it("rejects invalid keys", async () => {
      const { isValidConfigKey } = await importManager();
      expect(isValidConfigKey("invalid")).toBe(false);
    });
  });

  describe("getDefaultApiUrl", () => {
    it("returns default when env not set", async () => {
      delete process.env.TOKEN_ARENA_API_URL;
      const { getDefaultApiUrl } = await importManager();
      expect(getDefaultApiUrl()).toBe("https://token.guji.uno");
    });

    it("returns env var when set", async () => {
      process.env.TOKEN_ARENA_API_URL = "https://custom.api.com";
      const { getDefaultApiUrl } = await importManager();
      expect(getDefaultApiUrl()).toBe("https://custom.api.com");
    });
  });

  describe("file system operations", () => {
    it("loadConfig returns null when file does not exist", async () => {
      const tmp = makeTempDir("ta-cfg-");
      process.env.XDG_CONFIG_HOME = tmp;
      delete process.env.TOKEN_ARENA_DEV;
      const { loadConfig } = await importManager();
      expect(loadConfig()).toBeNull();
    });

    it("saveConfig and loadConfig round-trip", async () => {
      const tmp = makeTempDir("ta-cfg-");
      process.env.XDG_CONFIG_HOME = tmp;
      delete process.env.TOKEN_ARENA_DEV;
      const { saveConfig, loadConfig } = await importManager();
      const config = { apiKey: "ta_test123", apiUrl: "https://example.com" };
      saveConfig(config);
      const loaded = loadConfig();
      expect(loaded).not.toBeNull();
      expect(loaded?.apiKey).toBe("ta_test123");
      expect(loaded?.apiUrl).toBe("https://example.com");
    });

    it.skipIf(process.platform === "win32")(
      "keeps the API key readable by its owner only",
      async () => {
        const tmp = makeTempDir("ta-cfg-");
        process.env.XDG_CONFIG_HOME = tmp;
        delete process.env.TOKEN_ARENA_DEV;
        const { getConfigDir, getConfigPath, saveConfig } =
          await importManager();

        saveConfig({ apiKey: "ta_secret", apiUrl: "https://example.com" });

        expect(statSync(getConfigDir()).mode & 0o777).toBe(0o700);
        expect(statSync(getConfigPath()).mode & 0o777).toBe(0o600);
      },
    );

    it.skipIf(process.platform === "win32")(
      "tightens a config an older version wrote world-readable",
      async () => {
        const tmp = makeTempDir("ta-cfg-");
        process.env.XDG_CONFIG_HOME = tmp;
        delete process.env.TOKEN_ARENA_DEV;
        const { getConfigDir, getConfigPath, loadConfig } =
          await importManager();
        mkdirSync(getConfigDir(), { recursive: true, mode: 0o755 });
        writeFileSync(
          getConfigPath(),
          JSON.stringify({ apiKey: "ta_secret", apiUrl: "https://x.test" }),
          { mode: 0o644 },
        );

        expect(loadConfig()?.apiKey).toBe("ta_secret");
        expect(statSync(getConfigDir()).mode & 0o777).toBe(0o700);
        expect(statSync(getConfigPath()).mode & 0o777).toBe(0o600);
      },
    );

    it("loadConfig defaults apiUrl when missing", async () => {
      const tmp = makeTempDir("ta-cfg-");
      process.env.XDG_CONFIG_HOME = tmp;
      delete process.env.TOKEN_ARENA_DEV;
      const { saveConfig, loadConfig } = await importManager();
      saveConfig({ apiKey: "ta_test", apiUrl: "" });
      const loaded = loadConfig();
      expect(loaded?.apiUrl).toBe("https://token.guji.uno");
    });

    it("loadConfig returns null on invalid JSON", async () => {
      const tmp = makeTempDir("ta-cfg-");
      process.env.XDG_CONFIG_HOME = tmp;
      delete process.env.TOKEN_ARENA_DEV;
      const { getConfigPath, loadConfig } = await importManager();
      const configPath = getConfigPath();
      mkdirSync(join(tmp, "tokenarena"), { recursive: true });
      writeFileSync(configPath, "not json{{{");
      expect(loadConfig()).toBeNull();
    });

    it("deleteConfig removes the file", async () => {
      const tmp = makeTempDir("ta-cfg-");
      process.env.XDG_CONFIG_HOME = tmp;
      delete process.env.TOKEN_ARENA_DEV;
      const { saveConfig, deleteConfig, loadConfig, getConfigPath } =
        await importManager();
      saveConfig({ apiKey: "ta_test", apiUrl: "https://example.com" });
      expect(existsSync(getConfigPath())).toBe(true);
      deleteConfig();
      expect(existsSync(getConfigPath())).toBe(false);
      expect(loadConfig()).toBeNull();
    });

    it("getOrCreateDeviceId returns existing id", async () => {
      const tmp = makeTempDir("ta-cfg-");
      process.env.XDG_CONFIG_HOME = tmp;
      delete process.env.TOKEN_ARENA_DEV;
      const { getOrCreateDeviceId } = await importManager();
      const config = {
        apiKey: "ta_test",
        apiUrl: "https://example.com",
        deviceId: "existing-id",
      };
      const id = getOrCreateDeviceId(config);
      expect(id).toBe("existing-id");
    });

    it("getOrCreateDeviceId generates and persists new id", async () => {
      const tmp = makeTempDir("ta-cfg-");
      process.env.XDG_CONFIG_HOME = tmp;
      delete process.env.TOKEN_ARENA_DEV;
      const { getOrCreateDeviceId, loadConfig } = await importManager();
      const config = { apiKey: "ta_test", apiUrl: "https://example.com" };
      const id = getOrCreateDeviceId(config);
      expect(id).toBeTruthy();
      expect(id).not.toBe("");
      const loaded = loadConfig();
      expect(loaded?.deviceId).toBe(id);
    });
  });
});
