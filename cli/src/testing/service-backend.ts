import { type Mock, vi } from "vitest";
import type { ServiceBackend } from "../infrastructure/service/types";

/** A `ServiceBackend` whose every method is a vitest mock. */
export type MockServiceBackend = ServiceBackend & {
  canSetup: Mock<ServiceBackend["canSetup"]>;
  isInstalled: Mock<ServiceBackend["isInstalled"]>;
  getDefinitionPath: Mock<ServiceBackend["getDefinitionPath"]>;
  getStatusHint: Mock<ServiceBackend["getStatusHint"]>;
  setup: Mock<ServiceBackend["setup"]>;
  start: Mock<ServiceBackend["start"]>;
  stop: Mock<ServiceBackend["stop"]>;
  restart: Mock<ServiceBackend["restart"]>;
  status: Mock<ServiceBackend["status"]>;
  uninstall: Mock<ServiceBackend["uninstall"]>;
};

/**
 * Builds a fully populated `ServiceBackend` double.
 *
 * Tests used to hand-roll partial object literals, so every member added to
 * `ServiceBackend` broke type checking in a dozen places at once — and went
 * unnoticed, because vitest transpiles without type checking. Overriding only
 * what a test cares about keeps that failure in one place.
 */
export function createMockServiceBackend(
  overrides: Partial<MockServiceBackend> = {},
): MockServiceBackend {
  return {
    displayName: "test",
    canSetup: vi.fn(() => ({ ok: true })),
    isInstalled: vi.fn(() => false),
    getDefinitionPath: vi.fn(() => "/tmp/tokenarena.service"),
    getStatusHint: vi.fn(() => ""),
    setup: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    status: vi.fn(async () => {}),
    uninstall: vi.fn(async () => {}),
    ...overrides,
  };
}
