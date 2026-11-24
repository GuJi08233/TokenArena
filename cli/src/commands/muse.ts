import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { getMuseExportPath } from "../parsers/muse";
import {
  MUSE_USAGE_ROWS_QUERY,
  MUSE_USAGE_TOTALS_QUERY,
  type MuseExportRecord,
  parseMuseRawRows,
  summarizeMuseExport,
  transformMuseRows,
  writeMuseExportFile,
} from "../services/muse-export";
import { resolveCommandPath } from "../utils/command";
import { logger } from "../utils/logger";

const execFileAsync = promisify(execFile);

/** Upper bound for one psql export run; a stuck socket must not hang forever. */
const PSQL_TIMEOUT_MS = 120_000;
const PSQL_MAX_BUFFER = 64 * 1024 * 1024;

const PSQL_NOT_FOUND_MESSAGE =
  "muse export: psql not found — run `tokenarena muse query` through the Muse host's database tool and pipe the result to `tokenarena muse export` instead";

/**
 * `tokenarena muse` — build the Muse usage export from the Muse
 * runtime database (see services/muse-export.ts for the design).
 *
 * The database is reachable only through the Muse host, so the export
 * takes the canonical query's result from wherever the operator ran it:
 * stdin (the default), a file (`--input`), or `psql` itself (`--db`,
 * for hosts where the database socket is exposed and the libpq
 * environment — PGHOST, PGPORT, PGUSER, PGDATABASE — is configured).
 */

export interface MuseExportCommandOptions {
  input?: string;
  output?: string;
  db?: boolean;
}

export interface MuseQueryCommandOptions {
  totals?: boolean;
}

export interface MuseExportSummary {
  records: number;
  inputTokens: number;
  outputTokens: number;
  targetPath: string;
}

/** The slice of the promisified `execFile` the psql runner relies on. */
export type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    timeout: number;
    windowsHide: boolean;
  },
) => Promise<{ stdout: string; stderr: string }>;

export interface MuseCommandDeps {
  readStdin: () => Promise<string>;
  readFile: (path: string) => string;
  runPsql: (query: string) => Promise<string>;
  writeExport: (records: MuseExportRecord[], targetPath: string) => void;
  stdinIsTTY: () => boolean;
  print: (text: string) => void;
  log: (message: string) => void;
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

const defaultExecFileAsync: ExecFileAsync = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, [...args], options);
  return { stdout: String(stdout), stderr: String(stderr) };
};

/**
 * Build the `--db` query runner around an `execFile` implementation.
 * The program name goes through `resolveCommandPath`, like the sqlite3
 * runner, so a planted `psql` in the current directory is never picked
 * up on Windows.
 */
export function createPsqlRunner(deps: {
  execFile: ExecFileAsync;
  resolvePath: (command: string) => string | null;
}): (query: string) => Promise<string> {
  return async (query: string): Promise<string> => {
    let file: string | null = null;
    for (const candidate of ["psql", "psql.exe"]) {
      file = deps.resolvePath(candidate);
      if (file) break;
    }
    if (!file) throw new Error(PSQL_NOT_FOUND_MESSAGE);

    try {
      const { stdout } = await deps.execFile(
        file,
        ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", query],
        {
          env: process.env,
          maxBuffer: PSQL_MAX_BUFFER,
          timeout: PSQL_TIMEOUT_MS,
          windowsHide: true,
        },
      );
      return stdout;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new Error(PSQL_NOT_FOUND_MESSAGE);
      const stderr = (error as { stderr?: unknown }).stderr;
      const detail =
        typeof stderr === "string" && stderr.trim()
          ? stderr.trim()
          : error instanceof Error
            ? error.message
            : String(error);
      throw new Error(`muse export: psql failed: ${detail}`);
    }
  };
}

export const defaultMuseCommandDeps: MuseCommandDeps = {
  readStdin: readStdinText,
  readFile: (path) => readFileSync(path, "utf-8"),
  runPsql: createPsqlRunner({
    execFile: defaultExecFileAsync,
    resolvePath: resolveCommandPath,
  }),
  writeExport: writeMuseExportFile,
  stdinIsTTY: () => Boolean(process.stdin.isTTY),
  print: (text) => process.stdout.write(text),
  log: (message) => logger.info(message),
};

/**
 * Print one canonical query, terminated so the output runs as-is
 * (`psql -c "$(tokenarena muse query)"`). The default is the rows
 * query; `--totals` prints the cross-check query instead. Printing
 * both together would make the output unexecutable and would pollute
 * the rows stream with totals output.
 */
export async function runMuseQueryCommand(
  opts: MuseQueryCommandOptions = {},
  deps: MuseCommandDeps = defaultMuseCommandDeps,
): Promise<void> {
  if (opts.totals) {
    deps.print(
      [
        "-- Muse usage totals: the export's record count and token sums must match.",
        `${MUSE_USAGE_TOTALS_QUERY};`,
        "",
      ].join("\n"),
    );
    return;
  }
  deps.print(
    [
      "-- Muse usage rows: one JSON object per message, in export order.",
      `${MUSE_USAGE_ROWS_QUERY};`,
      "",
    ].join("\n"),
  );
}

export async function runMuseExportCommand(
  opts: MuseExportCommandOptions = {},
  deps: MuseCommandDeps = defaultMuseCommandDeps,
): Promise<MuseExportSummary> {
  if (opts.db && opts.input) {
    throw new Error("muse export: --db and --input cannot be used together");
  }

  let input: string;
  if (opts.db) {
    input = await deps.runPsql(MUSE_USAGE_ROWS_QUERY);
    if (!input.trim()) {
      throw new Error(
        "muse export: the database query returned no rows — check the libpq environment (PGHOST, PGPORT, PGUSER, PGDATABASE) and that the Muse database is reachable",
      );
    }
  } else if (opts.input) {
    try {
      input = deps.readFile(opts.input);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `muse export: cannot read input file ${opts.input}: ${detail}`,
      );
    }
  } else {
    if (deps.stdinIsTTY()) {
      throw new Error(
        "muse export: no input — pipe the `tokenarena muse query` result on stdin, pass --input <file>, or use --db",
      );
    }
    input = await deps.readStdin();
  }

  // Parse and transform before touching the target: a malformed input
  // aborts here and leaves the previous export in place.
  const records = transformMuseRows(parseMuseRawRows(input));
  const targetPath = opts.output ?? getMuseExportPath();
  deps.writeExport(records, targetPath);

  const summary = { ...summarizeMuseExport(records), targetPath };
  deps.log(
    `Muse usage export written: ${summary.records} records, ` +
      `${summary.inputTokens} input / ${summary.outputTokens} output tokens → ${targetPath}`,
  );
  return summary;
}
