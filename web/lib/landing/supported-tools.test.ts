import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SUPPORTED_TOOLS } from "./supported-tools";

const parsersDir = fileURLToPath(
  new URL("../../../cli/src/parsers/", import.meta.url),
);

const parserFiles = readdirSync(parsersDir).filter(
  (file) =>
    file.endsWith(".ts") &&
    !file.endsWith(".test.ts") &&
    file !== "registry.ts" &&
    file !== "types.ts",
);

describe("SUPPORTED_TOOLS", () => {
  it("lists every CLI parser exactly once", () => {
    const ids = SUPPORTED_TOOLS.map((tool) => tool.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.toSorted()).toEqual(
      parserFiles.map((file) => file.replace(/\.ts$/, "")).sort(),
    );
  });

  it("uses each parser's own display name", () => {
    for (const tool of SUPPORTED_TOOLS) {
      const source = readFileSync(`${parsersDir}${tool.id}.ts`, "utf8");

      expect(source, tool.id).toContain(`"${tool.name}"`);
    }
  });
});
