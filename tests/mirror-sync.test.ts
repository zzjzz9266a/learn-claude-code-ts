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

const expectedToolSets: Record<string, string[]> = {
  "s06_context_compact.ts": ["bash", "read_file", "write_file", "edit_file", "compact"],
  "s08_background_tasks.ts": ["bash", "read_file", "write_file", "edit_file", "background_run", "check_background"],
  "s09_agent_teams.ts": ["bash", "read_file", "write_file", "edit_file", "spawn_teammate", "list_teammates", "send_message", "read_inbox", "broadcast"],
  "s10_team_protocols.ts": ["bash", "read_file", "write_file", "edit_file", "spawn_teammate", "list_teammates", "send_message", "read_inbox", "broadcast", "shutdown_request", "shutdown_response", "plan_approval"],
  "s11_autonomous_agents.ts": ["bash", "read_file", "write_file", "edit_file", "spawn_teammate", "list_teammates", "send_message", "read_inbox", "broadcast", "shutdown_request", "shutdown_response", "plan_approval", "idle", "claim_task"],
  "s12_worktree_task_isolation.ts": ["bash", "read_file", "write_file", "edit_file", "task_create", "task_list", "task_get", "task_update", "task_bind_worktree", "worktree_create", "worktree_list", "worktree_status", "worktree_run", "worktree_remove", "worktree_keep", "worktree_events"],
  "s_full.ts": ["bash", "read_file", "write_file", "edit_file", "TodoWrite", "task", "load_skill", "compress", "background_run", "check_background", "task_create", "task_get", "task_update", "task_list", "spawn_teammate", "list_teammates", "send_message", "read_inbox", "broadcast", "shutdown_request", "plan_approval", "idle", "claim_task"],
};

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    if (entry === "node_modules" || entry === ".next" || entry === "out") return [];
    if (statSync(fullPath).isDirectory()) return walkFiles(fullPath);
    return [fullPath];
  });
}

function extractToolNames(source: string): string[] {
  const tools = new Set<string>();
  for (const match of source.matchAll(/(?:["']name["']|name)\s*:\s*"(\w+)"/g)) {
    tools.add(match[1]);
  }
  return [...tools];
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

  test("translated chapter tool sets match upstream semantics", () => {
    for (const [filename, expectedTools] of Object.entries(expectedToolSets)) {
      const source = readFileSync(join("agents", filename), "utf8");
      expect(extractToolNames(source), filename).toEqual(expectedTools);
    }
  });

  test("public mirror content does not expose Python code or filenames", () => {
    const checkedFiles = [
      "README.md",
      "README-zh.md",
      "README-ja.md",
      ...walkFiles("docs"),
      ...walkFiles("skills"),
      ...walkFiles("web/src/data/annotations"),
      ...walkFiles("web/src/data/scenarios"),
      ...walkFiles("web/src/data/generated")
    ].filter((file) => file.endsWith(".md") || file.endsWith(".json"));

    const leaks = checkedFiles.flatMap((file) => {
      const content = readFileSync(file, "utf8");
      return content.includes("```python") || content.includes(".py")
        ? [relative(".", file)]
        : [];
    });

    expect(leaks).toEqual([]);
  });
});
