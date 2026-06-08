// @vitest-environment jsdom

import type * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USERNAME_TAKEN_ERROR_MESSAGE } from "@/lib/auth-username";
import { AccountIdentityCard } from "./account-identity-card";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    updateUser: mocks.updateUser,
  },
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({
    push: mocks.push,
    refresh: mocks.refresh,
  }),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    ({
      bio: "Bio",
      bioPlaceholder: "What are you building with AI?",
      saved: "Saved",
      saveFailed: "Unable to save preferences.",
      "identity.name": "Display name",
      "identity.username": "Username",
      "identity.nameHint": "Shown on your public profile.",
      "identity.usernameHint": "Used for your profile URL.",
      "identity.usernamePreview": `Profile link preview: @${values?.value ?? ""}`,
      "identity.setupNotice": "Confirm your username.",
      "identity.save": "Save profile",
      "identity.saving": "Saving profile...",
      "identity.saved": "Profile updated.",
      "identity.errors.default": "Unable to save your profile right now.",
      "identity.errors.nameRequired": "Name is required.",
      "identity.errors.nameTooLong": "Name is too long.",
      "identity.errors.usernameRequired": "Username is required.",
      "identity.errors.usernameTooShort": "Username is too short.",
      "identity.errors.usernameTooLong": "Username is too long.",
      "identity.errors.usernameInvalid": "Username is invalid.",
      "identity.errors.usernameTaken": "Username is taken.",
      "deleteAccount.title": "Delete account",
      "deleteAccount.description":
        "Permanently delete your account and all Token Arena data.",
      "deleteAccount.trigger": "Delete account",
      "deleteAccount.dialogTitle": "Delete account?",
      "deleteAccount.dialogDescription":
        "This permanently deletes your account and cannot be undone.",
      "deleteAccount.confirmLabel": `Type ${values?.value ?? ""} to confirm.`,
      "deleteAccount.confirmPlaceholder": values?.value ?? "",
      "deleteAccount.cancel": "Cancel",
      "deleteAccount.confirm": "Delete account",
      "deleteAccount.deleting": "Deleting...",
      "deleteAccount.error": "Unable to delete your account right now.",
    })[key] ?? key,
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

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open?: boolean;
  }) => (open ? <div data-slot="dialog">{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({
    children,
  }: React.ComponentProps<"label"> & { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

describe("AccountIdentityCard account deletion", () => {
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

  async function renderCard(
    props: Partial<React.ComponentProps<typeof AccountIdentityCard>> = {},
  ) {
    await act(async () => {
      root.render(
        <AccountIdentityCard
          initialName={props.initialName ?? "Alice"}
          initialUsername={props.initialUsername ?? "alice"}
          initialBio={null}
          preferenceSnapshot={{
            timezone: "UTC",
            projectMode: "hashed",
            publicProfileEnabled: true,
          }}
          {...props}
        />,
      );
    });
  }

  function setInputValue(input: HTMLInputElement, value: string) {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function setTextAreaValue(textarea: HTMLTextAreaElement, value: string) {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    valueSetter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function submitProfileForm() {
    const form = container.querySelector("form");
    form?.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    );
  }

  it("validates profile fields before saving", async () => {
    await renderCard();

    const nameInput =
      container.querySelector<HTMLInputElement>("#settings-name");

    await act(async () => {
      if (nameInput) {
        setInputValue(nameInput, "");
      }
      submitProfileForm();
    });

    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Name is required.");
  });

  it("saves identity changes through Better Auth", async () => {
    mocks.updateUser.mockResolvedValue({});
    await renderCard();

    const nameInput =
      container.querySelector<HTMLInputElement>("#settings-name");

    await act(async () => {
      if (nameInput) {
        setInputValue(nameInput, "Alice Cooper");
      }
      submitProfileForm();
    });

    expect(mocks.updateUser).toHaveBeenCalledWith({
      name: "Alice Cooper",
      username: "alice",
    });
    expect(mocks.refresh).toHaveBeenCalled();
    expect(container.textContent).toContain("Profile updated.");
  });

  it("shows username errors returned by Better Auth", async () => {
    mocks.updateUser.mockResolvedValue({
      error: { message: USERNAME_TAKEN_ERROR_MESSAGE },
    });
    await renderCard();

    const usernameInput =
      container.querySelector<HTMLInputElement>("#settings-username");

    await act(async () => {
      if (usernameInput) {
        setInputValue(usernameInput, "bob");
      }
      submitProfileForm();
    });

    expect(container.textContent).toContain("Username is taken.");
  });

  it("saves bio-only changes through usage preferences", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ bio: "Building with AI" }),
    } as Response);
    await renderCard();

    const bioTextarea =
      container.querySelector<HTMLTextAreaElement>("#settings-bio");

    await act(async () => {
      if (bioTextarea) {
        setTextAreaValue(bioTextarea, "Building with AI");
      }
      submitProfileForm();
    });

    expect(mocks.updateUser).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/usage/preferences",
      expect.objectContaining({
        body: JSON.stringify({ bio: "Building with AI" }),
        method: "PATCH",
      }),
    );
    expect(container.textContent).toContain("Saved");
  });

  it("redirects setup users after confirming a username", async () => {
    mocks.updateUser.mockResolvedValue({});
    await renderCard({ requireUsernameSetup: true });

    await act(async () => {
      submitProfileForm();
    });

    expect(mocks.push).toHaveBeenCalledWith("/usage");
    expect(container.textContent).not.toContain("Delete account");
  });

  it("requires typing the current username before deleting the account", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, message: "User deleted" }),
    } as Response);

    await renderCard();

    const deleteTrigger = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Delete account",
    );

    expect(deleteTrigger).not.toBeUndefined();

    await act(async () => {
      deleteTrigger?.click();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Delete account?");

    const dialog = container.querySelector('[data-slot="dialog"]');
    const confirmButton = Array.from(
      dialog?.querySelectorAll("button") ?? [],
    ).find((button) => button.textContent === "Delete account");

    expect(confirmButton?.disabled).toBe(true);

    const confirmationInput = dialog?.querySelector("input");

    await act(async () => {
      if (!confirmationInput) {
        return;
      }
      setInputValue(confirmationInput, "alice");
    });

    expect(confirmButton?.disabled).toBe(false);

    await act(async () => {
      confirmButton?.click();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/delete-user",
      expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(mocks.push).toHaveBeenCalledWith("/login?deleted=1");
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("shows an error when account deletion fails", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: "Session expired" } }),
    } as Response);

    await renderCard();

    const deleteTrigger = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Delete account",
    );

    await act(async () => {
      deleteTrigger?.click();
    });

    const dialog = container.querySelector('[data-slot="dialog"]');
    const confirmationInput = dialog?.querySelector("input");
    const confirmButton = Array.from(
      dialog?.querySelectorAll("button") ?? [],
    ).find((button) => button.textContent === "Delete account");

    await act(async () => {
      if (confirmationInput) {
        setInputValue(confirmationInput, "alice");
      }
    });

    await act(async () => {
      confirmButton?.click();
    });

    expect(container.textContent).toContain("Session expired");
    expect(mocks.push).not.toHaveBeenCalledWith("/login?deleted=1");
  });
});
