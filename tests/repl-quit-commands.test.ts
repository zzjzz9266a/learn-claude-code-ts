/**
 * Every chapter REPL quits only on an explicit command.
 *
 * An empty line used to exit with status 0. The banner only says "Type q to quit",
 * and a blank line injected into stdin made the chapter vanish after its banner.
 * A blank line is ignored and the prompt comes back. q and exit still quit.
 * EOF and Ctrl-C still end the loop. s17 already ignored blank input.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHAPTER_FILES = readdirSync(ROOT)
  .filter((name) => /^s\d{2}_/.test(name))
  .map((name) => join(ROOT, name, "code.ts"))
  .filter((path) => {
    try {
      readFileSync(path);
      return true;
    } catch {
      return false;
    }
  })
  .sort();

function quitChecks(source: string): string[][] {
  const array = /\[(\s*"(?:[^"\\]|\\.)*"\s*(?:,\s*"(?:[^"\\]|\\.)*"\s*)*)\]\.includes\(\s*\w+\.trim\(\)\.toLowerCase\(\)\s*\)/g;
  return [...source.matchAll(array)]
    .map((match) => [...match[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((literal) => literal[1]));
}

describe("chapter REPL quit commands", () => {
  test("every chapter has a repl quit check", () => {
    expect(CHAPTER_FILES.length).toBeGreaterThanOrEqual(17);
    for (const path of CHAPTER_FILES) {
      expect(quitChecks(readFileSync(path, "utf8")), path).not.toHaveLength(0);
    }
  });

  test("an empty line is never a quit command", () => {
    for (const path of CHAPTER_FILES) {
      for (const values of quitChecks(readFileSync(path, "utf8"))) {
        expect(values, path).not.toContain("");
        expect(values, path).toContain("q");
      }
    }
  });

  test("blank input is skipped before the quit check", () => {
    const pattern = /if\s*\(\s*!\s*(\w+)\.trim\(\)\s*\)\s*\{?\s*continue;\s*\}?\s*if\s*\(\s*\[\s*"q"\s*,\s*"exit"\s*\]\.includes\(\s*\1\.trim\(\)\.toLowerCase\(\)\s*\)/s;
    for (const path of CHAPTER_FILES) {
      if (path.includes("s17_")) continue;
      expect(readFileSync(path, "utf8"), path).toMatch(pattern);
    }
  });
});
