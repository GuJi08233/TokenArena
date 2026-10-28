/**
 * The tools the CLI can collect from, as shown on the public landing page.
 *
 * The web app cannot import the CLI's parser registry, so this mirrors it by
 * hand: `id` is the parser's tool id (and its file name under
 * `cli/src/parsers`), `name` its display name. A test keeps the two in step.
 */
export const SUPPORTED_TOOLS = [
  { id: "claude-code", name: "Claude Code" },
  { id: "codex", name: "Codex CLI" },
  { id: "cursor", name: "Cursor" },
  { id: "gemini-cli", name: "Gemini CLI" },
  { id: "copilot-cli", name: "GitHub Copilot CLI" },
  { id: "opencode", name: "OpenCode" },
  { id: "cline", name: "Cline" },
  { id: "roo-code", name: "Roo Code" },
  { id: "kiro", name: "Kiro" },
  { id: "qwen-code", name: "Qwen Code" },
  { id: "kimi-code", name: "Kimi Code" },
  { id: "dsh", name: "DeepSeek Harness" },
  { id: "zcode", name: "ZCode" },
  { id: "mcode", name: "MiniMax Code" },
  { id: "mimocode", name: "MiMoCode" },
  { id: "qodercli", name: "Qoder CLI" },
  { id: "grok-build", name: "Grok Build" },
  { id: "droid", name: "Droid" },
  { id: "cherry-studio", name: "Cherry Studio" },
  { id: "openclaw", name: "OpenClaw" },
  { id: "hermes", name: "Hermes Agent" },
  { id: "qwenpaw", name: "QwenPaw" },
  { id: "pi-coding-agent", name: "pi" },
  { id: "oh-my-pi", name: "omp" },
  { id: "gsd", name: "GSD-2" },
  { id: "atomcode", name: "AtomCode" },
  { id: "letcode", name: "LetCode" },
  { id: "mirasim", name: "Mirasim" },
  { id: "snow", name: "Snow CLI" },
  { id: "snow-app", name: "Snow App" },
] as const;
