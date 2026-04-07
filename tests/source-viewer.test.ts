import { describe, expect, test } from "vitest";
import { highlightSourceToHtml, inferCodeLanguage } from "../web/src/components/code/source-viewer";

describe("source viewer highlighting", () => {
  test("infers tsx from filename", () => {
    expect(inferCodeLanguage("client.tsx")).toBe("tsx");
  });

  test("renders highlighted html for TypeScript source", () => {
    const html = highlightSourceToHtml('export async function run() { return "ok"; }', "agent.ts");
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("hljs-string");
  });
});
