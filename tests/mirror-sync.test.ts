import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const expectedSessions = [
  "s01_agent_loop.ts",
  "s02_tool_use.ts",
  "s03_todo_write.ts",
  "s04_subagent.ts",
  "s05_skill_loading.ts",
  "s06_context_compact.ts",
  "s07_task_system.ts",
  "s08_background_tasks.ts",
  "s09_agent_teams.ts",
  "s10_team_protocols.ts",
  "s11_autonomous_agents.ts",
  "s12_worktree_task_isolation.ts",
  "s_full.ts",
];

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    if (entry === "node_modules" || entry === ".next" || entry === "out") return [];
    if (statSync(fullPath).isDirectory()) return walkFiles(fullPath);
    return [fullPath];
  });
}

describe("mirror sync invariants", () => {
  test("session implementations match the upstream chapter set", () => {
    const sessions = readdirSync("agents")
      .filter((name) => name.startsWith("s") && name.endsWith(".ts"))
      .sort();

    expect(sessions).toEqual([...expectedSessions].sort());
  });

  test("repository does not keep Python source files", () => {
    const pythonFiles = walkFiles(".")
      .map((file) => relative(".", file))
      .filter((file) => file.endsWith(".py"));

    expect(pythonFiles).toEqual([]);
  });

  test("docs and generated web data do not expose Python code or filenames", () => {
    const checkedFiles = walkFiles("docs")
      .concat(walkFiles("web/src/data/generated"))
      .filter((file) => file.endsWith(".md") || file.endsWith(".json"));

    const leaks = checkedFiles.flatMap((file) => {
      const content = readFileSync(file, "utf8");
      return content.includes("```python") || content.includes(".py")
        ? [relative(".", file)]
        : [];
    });

    expect(leaks).toEqual([]);
  });
});
