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
} from "../parsers/muse-export";
import { logger } from "../utils/logger";

const execFileAsync = promisify(execFile);

/**
 * `tokenarena muse` — build the Muse usage export from the Muse
 * runtime database (see parsers/muse-export.ts for the design).
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

export interface MuseExportSummary {
  records: number;
  inputTokens: number;
  outputTokens: number;
  targetPath: string;
}

export interface MuseCommandDeps {
  readStdin: () => Promise<string>;
  readFile: (path: string) => string;
  runPsql: (query: string) => Promise<string>;
  writeExport: (records: MuseExportRecord[], targetPath: string) => void;
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

async function runPsqlQuery(query: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "psql",
      ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", query],
      { env: process.env, maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        "muse export: psql not found — run `tokenarena muse query` through the Muse host's database tool and pipe the result to `tokenarena muse export` instead",
      );
    }
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(
      `muse export: psql failed${stderr ? `: ${stderr}` : ""} — check the libpq environment (PGHOST, PGPORT, PGUSER, PGDATABASE)`,
    );
  }
}

export const defaultMuseCommandDeps: MuseCommandDeps = {
  readStdin: readStdinText,
  readFile: (path) => readFileSync(path, "utf-8"),
  runPsql: runPsqlQuery,
  writeExport: writeMuseExportFile,
  print: (text) => process.stdout.write(text),
  log: (message) => logger.info(message),
};

/** Print the canonical SQL: the rows query, then the totals cross-check. */
export async function runMuseQueryCommand(
  deps: MuseCommandDeps = defaultMuseCommandDeps,
): Promise<void> {
  deps.print(
    [
      "-- Muse usage rows: one JSON object per message, in export order.",
      MUSE_USAGE_ROWS_QUERY,
      "",
      "-- Cross-check: the export's record count and token sums must match.",
      MUSE_USAGE_TOTALS_QUERY,
      "",
    ].join("\n"),
  );
}

export async function runMuseExportCommand(
  opts: MuseExportCommandOptions = {},
  deps: MuseCommandDeps = defaultMuseCommandDeps,
): Promise<MuseExportSummary> {
  let input: string;
  if (opts.db) {
    input = await deps.runPsql(MUSE_USAGE_ROWS_QUERY);
  } else if (opts.input) {
    try {
      input = deps.readFile(opts.input);
    } catch {
      throw new Error(`muse export: cannot read input file ${opts.input}`);
    }
  } else {
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
