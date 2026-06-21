import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

type SqliteDatabaseSync<TRow> = {
  close(): void;
  prepare(sql: string): {
    all(): TRow[];
  };
};

export type SqliteQueryRows = <TRow>(
  dbPath: string,
  query: string,
) => Promise<TRow[]>;

function withSuppressedSqliteWarning<T>(fn: () => Promise<T>): Promise<T> {
  const originalEmitWarning = process.emitWarning;

  process.emitWarning = ((
    warning: string | Error,
    ...args: unknown[]
  ): void => {
    const warningName =
      typeof warning === "string"
        ? typeof args[0] === "string"
          ? args[0]
          : ""
        : warning.name;
    const warningMessage =
      typeof warning === "string" ? warning : warning.message;

    if (
      warningName === "ExperimentalWarning" &&
      warningMessage.includes("SQLite")
    ) {
      return;
    }

    (
      originalEmitWarning as (
        warning: string | Error,
        ...warningArgs: unknown[]
      ) => void
    ).call(process, warning, ...args);
  }) as typeof process.emitWarning;

  return fn().finally(() => {
    process.emitWarning = originalEmitWarning;
  });
}

async function readSqliteRowsWithBuiltin<TRow>(
  dbPath: string,
  query: string,
): Promise<TRow[] | null> {
  try {
    return await withSuppressedSqliteWarning(async () => {
      const sqliteModuleId = "node:sqlite";
      const sqlite = (await import(sqliteModuleId)) as {
        DatabaseSync: new (location: string) => SqliteDatabaseSync<TRow>;
      };

      const locations = [
        dbPath,
        `${pathToFileURL(dbPath).href}?mode=ro&immutable=1`,
      ];
      let lastError: unknown = null;

      for (const location of locations) {
        let db: SqliteDatabaseSync<TRow> | null = null;
        try {
          db = new sqlite.DatabaseSync(location);
          return db.prepare(query).all() as TRow[];
        } catch (err) {
          lastError = err;
          const error = err as NodeJS.ErrnoException;
          const message = (err as Error).message;
          if (
            error.code === "ERR_SQLITE_ERROR" &&
            message.includes("unable to open database file")
          ) {
            continue;
          }

          throw err;
        } finally {
          db?.close();
        }
      }

      throw lastError;
    });
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    const message = (err as Error).message;
    if (
      error.code === "ERR_UNKNOWN_BUILTIN_MODULE" ||
      message.includes("node:sqlite")
    ) {
      return null;
    }

    throw err;
  }
}

function readSqliteRowsWithCli<TRow>(dbPath: string, query: string): TRow[] {
  const candidates = [
    process.env.TOKEN_ARENA_SQLITE3,
    "sqlite3",
    "sqlite3.exe",
  ].filter((value): value is string => Boolean(value));

  let lastError: Error | null = null;

  for (const command of candidates) {
    try {
      const output = execFileSync(command, ["-json", dbPath, query], {
        encoding: "utf-8",
        maxBuffer: 100 * 1024 * 1024,
        timeout: 30000,
        windowsHide: true,
      }).trim();

      if (!output || output === "[]") {
        return [];
      }

      return JSON.parse(output) as TRow[];
    } catch (err) {
      lastError = err as Error;
      const nodeError = err as NodeJS.ErrnoException & { status?: number };
      if (nodeError.status === 127 || nodeError.message?.includes("ENOENT")) {
        continue;
      }

      throw err;
    }
  }

  throw new Error(
    `sqlite3 CLI not found. Install sqlite3 or set TOKEN_ARENA_SQLITE3 to its full path. Last error: ${lastError?.message || "not found"}`,
  );
}

export async function readSqliteRows<TRow>(
  dbPath: string,
  query: string,
): Promise<TRow[]> {
  const builtinRows = await readSqliteRowsWithBuiltin<TRow>(dbPath, query);
  return builtinRows ?? readSqliteRowsWithCli<TRow>(dbPath, query);
}
