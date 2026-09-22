import type {
  ParseResult,
  SessionEvent,
  TokenUsageEntry,
} from "../domain/types";

/**
 * Tool definition for parser registration
 */
export interface ToolDefinition {
  id: string;
  name: string;
  dataDir: string;
}

/**
 * Parser interface - all parsers must implement this
 */
export interface IParser {
  readonly tool: ToolDefinition;
  parse(): Promise<ParseResult>;
  isInstalled?(): boolean;
  /**
   * Every file `parse()` would read, for change detection.
   *
   * Implementing this lets the sync skip re-parsing a tool whose files have not
   * moved since the last run. The list must be exhaustive — a file that
   * `parse()` reads but this omits would let a stale result be replayed, and the
   * upload treats each tool's buckets as a full snapshot. Parsers that cannot
   * cheaply enumerate their inputs simply leave it off and are parsed every
   * time, as before.
   */
  listSourceFiles?(): string[];
}

/**
 * Raw parse result before aggregation (for backward compatibility with ref implementation)
 */
export interface RawParseResult {
  entries: TokenUsageEntry[];
  sessionEvents: SessionEvent[];
}
