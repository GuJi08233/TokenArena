// Import parsers to register them before CLI setup
import "./parsers/claude-code.js";
import "./parsers/codex.js";
import "./parsers/gsd.js";
import "./parsers/gemini-cli.js";
import "./parsers/hermes.js";
import "./parsers/mimocode.js";
import "./parsers/mirasim.js";
import "./parsers/copilot-cli.js";
import "./parsers/oh-my-pi.js";
import "./parsers/opencode.js";
import "./parsers/openclaw.js";
import "./parsers/qwen-code.js";
import "./parsers/kimi-code.js";
import "./parsers/letcode.js";
import "./parsers/droid.js";
import "./parsers/pi-coding-agent.js";
import "./parsers/qwenpaw.js";
import "./parsers/cline.js";
import "./parsers/kiro.js";
import "./parsers/roo-code.js";
import "./parsers/snow.js";
import "./parsers/cursor.js";
import "./parsers/zcode.js";
import "./parsers/qodercli.js";
import "./parsers/grok-build.js";
import "./parsers/atomcode.js";
import "./parsers/dsh.js";
import "./parsers/cherry-studio.js";

import { createCli } from "./cli.js";
import { isMainModule } from "./infrastructure/runtime/main-module.js";

export function normalizeArgv(argv: string[]) {
  return argv.filter((arg, index) => index < 2 || arg !== "--");
}

export async function run(argv = process.argv) {
  const program = createCli();
  await program.parseAsync(normalizeArgv(argv));
}

// NOTE: pass this module's own URL explicitly — `isMainModule` defaults to the
// URL of its own file, which only matches the entry point once tsup has inlined
// everything into dist/index.js. Without it, `tsx src/index.ts` silently no-ops.
if (isMainModule(process.argv[1], import.meta.url)) {
  void run();
}
