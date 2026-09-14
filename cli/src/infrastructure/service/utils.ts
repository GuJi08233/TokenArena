const SERVICE_PATH_FALLBACKS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

const SERVICE_ENV_KEYS = [
  "TOKEN_ARENA_DEV",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
] as const;

export interface ManagedDaemonCommand {
  execPath: string;
  args: string[];
}

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))];
}

export function getManagedServiceEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const pathEntries = dedupePaths([
    ...(env.PATH?.split(":") ?? []),
    ...SERVICE_PATH_FALLBACKS,
  ]);
  const next: Record<string, string> = {
    PATH: pathEntries.join(":"),
  };

  for (const key of SERVICE_ENV_KEYS) {
    const value = env[key];
    if (value) {
      next[key] = value;
    }
  }

  return next;
}

/** `.ts`, `.tsx`, `.mts`, `.cts` — anything plain `node` cannot load. */
const TYPESCRIPT_ENTRY_PATTERN = /\.[cm]?tsx?$/i;

export function resolveManagedDaemonCommand(
  execPath = process.execPath,
  argv = process.argv,
): ManagedDaemonCommand {
  const scriptPath = argv[1];
  if (!scriptPath) {
    throw new Error("无法解析 CLI 入口路径，请通过 tokenarena 命令重新执行。");
  }

  // The generated unit runs `node <scriptPath>` with no TypeScript loader, so an
  // unbundled entry (`pnpm dev:cli service setup`) would install a service that
  // can never start. Refuse instead of writing a permanently broken unit file.
  if (TYPESCRIPT_ENTRY_PATTERN.test(scriptPath)) {
    throw new Error(
      "无法通过未打包的 TypeScript 入口安装服务，请先执行 pnpm build:cli，再使用打包后的 tokenarena 命令。",
    );
  }

  return {
    execPath,
    args: [scriptPath, "daemon", "--service"],
  };
}

export function escapeDoubleQuotedValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
