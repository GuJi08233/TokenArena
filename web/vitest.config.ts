import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      "server-only": fileURLToPath(
        new URL("./node_modules/server-only/empty.js", import.meta.url),
      ),
    },
  },
  test: {
    env: {
      DATABASE_URL: "postgresql://test:test@localhost:5432/tokenarena_test",
    },
    environment: "node",
    // Every tree that can hold a test is listed. `app/` and `hooks/` used to be
    // absent, so a test written there was silently never collected.
    include: [
      "*.test.{ts,tsx}",
      "app/**/*.test.{ts,tsx}",
      "components/**/*.test.{ts,tsx}",
      "hooks/**/*.test.{ts,tsx}",
      "i18n/**/*.test.{ts,tsx}",
      "lib/**/*.test.{ts,tsx}",
    ],
    passWithNoTests: true,
    coverage: {
      // Without this, Vitest only counts files a test happened to import, so
      // every untested file — all of `app/`, `hooks/` and `proxy.ts` — was
      // invisible and the reported percentage overstated real coverage by
      // roughly twenty points.
      include: [
        "app/**/*.{ts,tsx}",
        "components/**/*.{ts,tsx}",
        "hooks/**/*.{ts,tsx}",
        "i18n/**/*.{ts,tsx}",
        "lib/**/*.{ts,tsx}",
        // The auth middleware. Lives outside the four trees above, and is the
        // one file where an untested change is an authentication bypass.
        "proxy.ts",
      ],
      reporter: ["text", "json-summary", "lcov"],
      // Set just under the measured values so the gate can still fail, and
      // ratchet up as coverage improves. Equality with today's numbers would
      // make it permanently green and therefore permanently ignorable; the
      // previous 75/70/75/75 was unreachable only because it was never applied
      // to the files it claimed to cover.
      thresholds: {
        statements: 62,
        branches: 55,
        functions: 60,
        lines: 62,
      },
    },
  },
});
