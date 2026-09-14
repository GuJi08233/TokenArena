import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../testing/temp-dir";
import {
  findJsonFiles,
  findJsonlFiles,
  parseJsonl,
  readFileSafe,
} from "./utils";

describe("fs/utils", () => {
  const makeTempDir = useTempDirs("ta-utils-");

  describe("parseJsonl", () => {
    it("parses valid JSONL content", () => {
      const result = parseJsonl<{ a: number }>('{"a":1}\n{"a":2}\n');
      expect(result).toEqual([{ a: 1 }, { a: 2 }]);
    });

    it("skips empty lines", () => {
      const result = parseJsonl('{"a":1}\n\n\n{"a":2}\n');
      expect(result).toEqual([{ a: 1 }, { a: 2 }]);
    });

    it("skips malformed lines", () => {
      const result = parseJsonl('{"a":1}\nbad json\n{"a":2}\n');
      expect(result).toEqual([{ a: 1 }, { a: 2 }]);
    });

    it("returns empty array for empty content", () => {
      expect(parseJsonl("")).toEqual([]);
      expect(parseJsonl("\n\n")).toEqual([]);
    });
  });

  describe("readFileSafe", () => {
    it("returns null for non-existent file", () => {
      expect(readFileSafe("/nonexistent/file.txt")).toBeNull();
    });

    it("returns content for existing file", () => {
      const tmp = makeTempDir();
      const filePath = join(tmp, "test.txt");

      writeFileSync(filePath, "hello");

      expect(readFileSafe(filePath)).toBe("hello");
    });
  });

  describe("findJsonFiles", () => {
    it("returns empty array for non-existent directory", () => {
      expect(findJsonFiles("/nonexistent", /\.json$/)).toEqual([]);
    });

    it("finds matching JSON files", () => {
      const tmp = makeTempDir();

      writeFileSync(join(tmp, "data.json"), "{}");
      writeFileSync(join(tmp, "other.txt"), "text");

      const result = findJsonFiles(tmp, /\.json$/);
      expect(result).toHaveLength(1);
      expect(result[0]).toContain("data.json");
    });
  });

  describe("findJsonlFiles", () => {
    it("returns empty array for non-existent directory", () => {
      expect(findJsonlFiles("/nonexistent")).toEqual([]);
    });

    it("recursively finds .jsonl files", () => {
      const tmp = makeTempDir();

      mkdirSync(join(tmp, "subdir"), { recursive: true });
      writeFileSync(join(tmp, "a.jsonl"), "line1");
      writeFileSync(join(tmp, "subdir", "b.jsonl"), "line2");
      writeFileSync(join(tmp, "c.txt"), "text");

      expect(findJsonlFiles(tmp)).toHaveLength(2);
    });
  });
});
