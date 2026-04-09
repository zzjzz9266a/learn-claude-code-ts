# TypeScript Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the repository's Python-first root learning project with a TypeScript-first Node.js project, including runnable session files, tests, and three-language documentation.

**Architecture:** Keep the `s01` to `s12` learning sequence and `agents/` entrypoints, but move reusable runtime logic into a small shared TypeScript core. Session files stay focused on the mechanism each chapter teaches, while docs and the web extraction script are updated to expect `.ts` sources and Node tooling.

**Tech Stack:** Node.js, npm, TypeScript, tsx, vitest, Anthropic TypeScript SDK, dotenv

---

### Task 1: Bootstrap Root TypeScript Tooling

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Modify: `.gitignore`
- Delete: `requirements.txt`

- [ ] **Step 1: Add a failing tooling test scaffold**

```ts
import { describe, expect, test } from "vitest";

describe("tooling scaffold", () => {
  test("root package metadata exists", async () => {
    const pkg = await import("../package.json");
    expect(pkg.name).toBe("learn-claude-code");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/tooling.test.ts`
Expected: FAIL because root `package.json` and Vitest config do not exist yet

- [ ] **Step 3: Add minimal root Node.js project files**

```json
{
  "name": "learn-claude-code",
  "private": true,
  "type": "module",
  "scripts": {
    "s01": "tsx agents/s01_agent_loop.ts",
    "s12": "tsx agents/s12_worktree_task_isolation.ts",
    "s_full": "tsx agents/s_full.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.40.1",
    "dotenv": "^17.2.3"
  },
  "devDependencies": {
    "@types/node": "^24.6.0",
    "tsx": "^4.21.0",
    "typescript": "^5.9.3",
    "vitest": "^3.2.4"
  }
}
```

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["agents/**/*.ts", "src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/tooling.test.ts`
Expected: PASS

### Task 2: Build Shared Runtime Helpers

**Files:**
- Create: `src/core/reference-agent.ts`
- Create: `src/core/repl.ts`
- Create: `src/core/index.ts`
- Test: `tests/background-manager.test.ts`

- [ ] **Step 1: Write the failing background manager regression test**

```ts
import { describe, expect, test } from "vitest";
import { BackgroundManager } from "../src/core/reference-agent";

describe("BackgroundManager", () => {
  test("check returns running placeholder when result is null", () => {
    const manager = new BackgroundManager();
    manager.tasks.set("abc123", {
      status: "running",
      command: "sleep 1",
      result: null,
    });

    expect(manager.check("abc123")).toBe("[running] (running)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/background-manager.test.ts`
Expected: FAIL because shared TypeScript runtime does not exist yet

- [ ] **Step 3: Implement shared runtime primitives**

```ts
export class BackgroundManager {
  tasks = new Map<string, { status: string; command: string; result: string | null }>();

  check(id: string): string {
    const task = this.tasks.get(id);
    if (!task) return "Error: Unknown background task";
    if (task.status === "running" && task.result == null) return "[running] (running)";
    return task.result ?? "[running] (running)";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/background-manager.test.ts`
Expected: PASS

### Task 3: Replace Agent Entry Points

**Files:**
- Create: `agents/s01_agent_loop.ts`
- Create: `agents/s02_tool_use.ts`
- Create: `agents/s03_todo_write.ts`
- Create: `agents/s04_subagent.ts`
- Create: `agents/s05_skill_loading.ts`
- Create: `agents/s06_context_compact.ts`
- Create: `agents/s07_task_system.ts`
- Create: `agents/s08_background_tasks.ts`
- Create: `agents/s09_agent_teams.ts`
- Create: `agents/s10_team_protocols.ts`
- Create: `agents/s11_autonomous_agents.ts`
- Create: `agents/s12_worktree_task_isolation.ts`
- Create: `agents/s_full.ts`
- Delete: `agents/*.ts`
- Delete: `agents/__init__.py`
- Test: `tests/agents-smoke.test.ts`

- [ ] **Step 1: Write the failing import smoke test**

```ts
import { describe, expect, test } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";

describe("agent entrypoints", () => {
  test("all session files exist as TypeScript modules", () => {
    const files = readdirSync(join(process.cwd(), "agents")).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/agents-smoke.test.ts`
Expected: FAIL because no TypeScript session files exist yet

- [ ] **Step 3: Implement TypeScript session files backed by the shared runtime**

```ts
export const SESSION_ID = "s01";
export const SYSTEM = createSystemPrompt("Use bash to solve tasks. Act, don't explain.");

if (isMain(import.meta.url)) {
  startRepl({ sessionId: SESSION_ID, createAgent: () => createAgentHarness({ tools: [bashTool] }) });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/agents-smoke.test.ts`
Expected: PASS

### Task 4: Rewrite README and Chapter Docs

**Files:**
- Modify: `README.md`
- Modify: `README-zh.md`
- Modify: `README-ja.md`
- Modify: `docs/en/*.md`
- Modify: `docs/zh/*.md`
- Modify: `docs/ja/*.md`
- Modify: `web/scripts/extract-content.ts`
- Modify: `web/src/app/[locale]/page.tsx`
- Modify: `web/src/data/scenarios/*.json` where examples mention Python-specific files or commands

- [ ] **Step 1: Add a failing docs regression test**

```ts
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

describe("documentation", () => {
  test("README quick start points at TypeScript entrypoints", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("npm install");
    expect(readme).toContain("npm run s01");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/docs-smoke.test.ts`
Expected: FAIL because README still uses Python instructions

- [ ] **Step 3: Rewrite docs and extraction assumptions for TypeScript**

```ts
const agentFiles = fs
  .readdirSync(AGENTS_DIR)
  .filter((f) => f.startsWith("s") && f.endsWith(".ts"));

function filenameToVersionId(filename: string): string | null {
  const base = path.basename(filename, ".ts");
  if (base === "s_full") return null;
  const match = base.match(/^(s\\d+[a-c]?)_/);
  return match?.[1] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/docs-smoke.test.ts`
Expected: PASS

### Task 5: Full Verification

**Files:**
- Modify: `tests/tooling.test.ts`
- Modify: `tests/agents-smoke.test.ts`
- Modify: `tests/docs-smoke.test.ts`
- Modify: `tests/background-manager.test.ts`

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`
Expected: PASS with all Vitest suites green

- [ ] **Step 2: Run the type checker**

Run: `npm run typecheck`
Expected: PASS with zero TypeScript errors

- [ ] **Step 3: Run web extraction once to verify root compatibility**

Run: `cd web && npm run extract`
Expected: PASS and regenerate web data from `.ts` sources

- [ ] **Step 4: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts agents src tests README.md README-zh.md README-ja.md docs web/scripts/extract-content.ts web/src/app/[locale]/page.tsx web/src/data/scenarios requirements.txt
git commit -m "feat: migrate learning project from Python to TypeScript"
```
