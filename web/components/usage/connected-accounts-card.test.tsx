// @vitest-environment jsdom

import type * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginProvider } from "@/lib/auth-providers";
import { ConnectedAccountsCard } from "./connected-accounts-card";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  assign: vi.fn(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    ({
      empty: "No sign-in providers are connected yet.",
      credentialLabel: "Email & Password",
      connect: "Connect",
      connecting: "Connecting...",
      disconnect: "Disconnect",
      disconnecting: "Disconnecting...",
      lastProviderHelp: "At least one sign-in method must remain connected.",
      "errors.connect": "Unable to connect this provider right now.",
      "errors.disconnect": "Unable to disconnect this provider right now.",
    })[key] ?? key,
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({
    refresh: mocks.refresh,
  }),
}));

vi.mock("next/image", () => ({
  default: () => <span data-slot="next-image" />,
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: React.ComponentProps<"button"> & { children?: React.ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

type ConnectedAccountRecord = React.ComponentProps<
  typeof ConnectedAccountsCard
>["accounts"];
type ConnectedAccount = NonNullable<ConnectedAccountRecord>[number];

function account(
  providerId: string,
  overrides: Partial<ConnectedAccount> = {},
): ConnectedAccount {
  return {
    id: `account_${providerId}`,
    providerId,
    accountId: `remote_${providerId}`,
    createdAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-08T00:00:00.000Z",
    scopes: [],
    ...overrides,
  };
}

const githubProvider: LoginProvider = {
  id: "github",
  kind: "social",
  label: "GitHub",
};

describe("ConnectedAccountsCard", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.clearAllMocks();
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
        fetch: typeof fetch;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.fetch = fetchMock;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        assign: mocks.assign,
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    delete (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT;
    container.remove();
  });

  function findButton(label: string) {
    return Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === label,
    );
  }

  it("shows connected providers even when they are not currently available to connect", () => {
    act(() => {
      root.render(
        <ConnectedAccountsCard
          accounts={[account("credential"), account("github")]}
          availableProviders={[]}
        />,
      );
    });

    expect(container.textContent).toContain("Email & Password");
    expect(container.textContent).toContain("GitHub");
  });

  it("keeps the final sign-in method visible but not disconnectable", () => {
    act(() => {
      root.render(
        <ConnectedAccountsCard
          accounts={[account("github")]}
          availableProviders={[githubProvider]}
        />,
      );
    });

    const disconnectButton = Array.from(
      container.querySelectorAll("button"),
    ).find((button) => button.textContent === "Disconnect");

    expect(disconnectButton).not.toBeUndefined();
    expect(disconnectButton?.disabled).toBe(true);
    expect(disconnectButton?.getAttribute("title")).toBe(
      "At least one sign-in method must remain connected.",
    );
  });

  it("starts social provider linking and redirects to the provider URL", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ url: "https://github.com/login/oauth" }),
    } as Response);

    await act(async () => {
      root.render(
        <ConnectedAccountsCard
          accounts={[account("credential")]}
          availableProviders={[githubProvider]}
        />,
      );
    });

    await act(async () => {
      findButton("Connect")?.click();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/link-social",
      expect.objectContaining({
        body: JSON.stringify({
          provider: "github",
          callbackURL: "/settings/authentication",
          errorCallbackURL: "/settings/authentication",
        }),
        method: "POST",
      }),
    );
    expect(mocks.assign).toHaveBeenCalledWith("https://github.com/login/oauth");
  });

  it("starts generic OAuth provider linking with providerId", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ url: "https://gitlab.example/oauth" }),
    } as Response);

    await act(async () => {
      root.render(
        <ConnectedAccountsCard
          accounts={[account("credential")]}
          availableProviders={[
            { id: "gitlab", kind: "oauth2", label: "GitLab" },
          ]}
        />,
      );
    });

    await act(async () => {
      findButton("Connect")?.click();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/oauth2/link",
      expect.objectContaining({
        body: JSON.stringify({
          providerId: "gitlab",
          callbackURL: "/settings/authentication",
          errorCallbackURL: "/settings/authentication",
        }),
        method: "POST",
      }),
    );
    expect(mocks.assign).toHaveBeenCalledWith("https://gitlab.example/oauth");
  });

  it("disconnects an OAuth account when another sign-in method remains", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ status: true }),
    } as Response);

    await act(async () => {
      root.render(
        <ConnectedAccountsCard
          accounts={[account("credential"), account("github")]}
          availableProviders={[githubProvider]}
        />,
      );
    });

    await act(async () => {
      findButton("Disconnect")?.click();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/unlink-account",
      expect.objectContaining({
        body: JSON.stringify({
          providerId: "github",
          accountId: "remote_github",
        }),
        method: "POST",
      }),
    );
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("shows request errors from provider actions", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ message: "Provider unavailable" }),
    } as Response);

    await act(async () => {
      root.render(
        <ConnectedAccountsCard
          accounts={[account("credential")]}
          availableProviders={[githubProvider]}
        />,
      );
    });

    await act(async () => {
      findButton("Connect")?.click();
    });

    expect(container.textContent).toContain("Provider unavailable");
  });
});
