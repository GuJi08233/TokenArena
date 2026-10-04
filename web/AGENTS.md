<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Test Coverage Requirements

All changes must pass `pnpm test:web` with the minimum coverage thresholds defined in
`vitest.config.ts`:

| Metric      | Threshold |
|-------------|-----------|
| Statements  | 62%       |
| Branches    | 55%       |
| Functions   | 60%       |
| Lines       | 62%       |

These are deliberately below the original 75/70/75/75. That target was never met —
`coverage.include` was missing, so Vitest only counted files a test happened to import
and reported ~83% while real coverage was ~62%. The thresholds are now enforced over
every source file and should be ratcheted up as coverage improves, not lowered.

`proxy.ts` is the auth middleware: it is covered, and its cases are the ones to extend
before changing any protected-route rule.

- Place `*.test.ts` or `*.test.tsx` files beside the source they cover.
- `include` in `vitest.config.ts` lists every test tree. Adding a test under a tree
  that is not listed means it never runs — silently.
- Treat `pnpm check`, `pnpm build`, and `pnpm test:web` as required gates before merging.
