import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../infrastructure/service", () => ({
  getServiceBackend: vi.fn(),
}));

vi.mock("../utils/logger", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { getServiceBackend } from "../infrastructure/service";
import { createMockServiceBackend } from "../testing/service-backend";
import { logger } from "../utils/logger";
import { runServiceCommand } from "./service";

describe("runServiceCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("warns when backend is null", async () => {
    vi.mocked(getServiceBackend).mockReturnValue(null);
    await runServiceCommand({ action: "status" });
    expect(logger.info).toHaveBeenCalled();
  });

  it("prints usage when no action", async () => {
    vi.mocked(getServiceBackend).mockReturnValue(createMockServiceBackend());
    await runServiceCommand({});
    expect(logger.info).toHaveBeenCalled();
  });

  it("prints usage with reason when canSetup fails", async () => {
    vi.mocked(getServiceBackend).mockReturnValue(
      createMockServiceBackend({
        canSetup: vi.fn(() => ({ ok: false, reason: "no systemd" })),
      }),
    );
    await runServiceCommand({});
    expect(logger.info).toHaveBeenCalled();
  });

  it.each([
    ["setup", "setup"],
    ["start", "start"],
    ["stop", "stop"],
    ["restart", "restart"],
    ["status", "status"],
    ["uninstall", "uninstall"],
  ] as const)("dispatches %s", async (action, method) => {
    const mockBackend = createMockServiceBackend();
    vi.mocked(getServiceBackend).mockReturnValue(mockBackend);

    await runServiceCommand({ action });

    expect(mockBackend[method]).toHaveBeenCalled();
  });

  it("exits with error for unknown action", async () => {
    vi.mocked(getServiceBackend).mockReturnValue(createMockServiceBackend());
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    await expect(runServiceCommand({ action: "unknown" })).rejects.toThrow(
      "exit",
    );
    expect(logger.error).toHaveBeenCalled();
    mockExit.mockRestore();
  });
});
