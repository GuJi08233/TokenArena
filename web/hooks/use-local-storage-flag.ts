"use client";

import { useCallback, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const memory = new Map<string, boolean>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);

  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function read(key: string) {
  try {
    const stored = window.localStorage.getItem(key);

    if (stored !== null) {
      return stored === "1";
    }
  } catch {
    // Storage can be blocked (private mode, disabled cookies); fall through.
  }

  return memory.get(key) ?? false;
}

/**
 * A boolean the browser remembers under `key` in `localStorage`.
 *
 * Read through `useSyncExternalStore`, so the server and the hydrating client
 * both see `false` and the stored value arrives in the next render without a
 * state update inside an effect. When storage is unavailable the flag lives in
 * memory for the rest of the page's life.
 */
export function useLocalStorageFlag(key: string) {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => false,
  );
  const setValue = useCallback(
    (next: boolean) => {
      memory.set(key, next);

      try {
        window.localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // Keep the in-memory value when storage rejects the write.
      }

      for (const listener of listeners) {
        listener();
      }
    },
    [key],
  );

  return [value, setValue] as const;
}
