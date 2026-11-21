import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

process.env.MODEL_ID ??= "test-model";

const s03 = await import("../s03_permission/code.ts");
const s14 = await import("../s14_mcp_plugin/code.ts");
const s15 = await import("../s15_integrated_harness/code.ts");
const workflow = await import("../s16_workflow_runtime/code.ts");

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "upstream-nov15-"));
  tempDirs.push(dir);
  return dir;
}

async function waitUntil(predicate: () => boolean, timeout = 2): Promise<boolean> {
  const deadline = Date.now() + timeout * 1000;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

async function loadLesson(specifier: string, cwd: string): Promise<any> {
  const previous = process.cwd();
  process.chdir(cwd);
  vi.resetModules();
  try {
    return await import(specifier);
  } finally {
    process.chdir(previous);
  }
}

async function readTask(lesson: any, taskId: string): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return lesson.load_task(taskId);
    } catch (exc: any) {
      last = exc;
      if (!String(exc?.message ?? exc).includes("sync lock contended")) throw exc;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw last;
}

function endTurn(text: string): any {
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
  };
}

async function withTeammate(
  specifier: string,
  run: (lesson: any) => Promise<void>,
): Promise<void> {
  const lesson = await loadLesson(specifier, tempDir());
  try {
    await run(lesson);
  } finally {
    if (lesson.active_teammates?.alice) {
      lesson.run_request_shutdown("alice");
      expect(await waitUntil(() => !("alice" in lesson.active_teammates), 4)).toBe(true);
    }
  }
}

describe("s03 permission scenario", () => {
  test("uses a destructive command that asks instead of hard-denying", () => {
    const scenario = JSON.parse(readFileSync("web/src/data/scenarios/s03.json", "utf8"));
    const command = scenario.steps.find((step: any) => step.type === "tool_call").content;

    expect(command).toBe("rm -rf ./tmp/build-cache");
    expect(s03.check_deny_list(command)).toBeNull();
    expect(s03.check_rules("bash", { command })).toBe("Potentially destructive command");
    expect(s03.check_deny_list("rm -rf /tmp/build-cache")).toContain("rm -rf /");
  });
});

describe("MCP handlers keep the bound server tool", () => {
  test("a tool key in the input cannot redirect an approved call", () => {
    for (const lesson of [s14, s15]) {
      expect(lesson.connect_mcp("deploy")).toContain("Connected to MCP server 'deploy'");
      const [, handlers] = lesson.assemble_tool_pool();
      const output = handlers["mcp__deploy__status"]({ service: "web", tool: "trigger" });

      expect(output).not.toContain("Triggered");
      expect(output).toContain("unexpected keyword argument 'tool'");
      expect(handlers["mcp__deploy__status"]({ service: "web" })).toBe(
        "[deploy] web: running (v1.4.2)",
      );
    }
  });
});

describe("idle teammates recover owned work", () => {
  test("does not resume while plan approval is pending", async () => {
    for (const specifier of ["../s13_agent_teams/code.ts", "../s15_integrated_harness/code.ts"]) {
      await withTeammate(specifier, async (lesson) => {
        const owned = lesson.create_task("Plan before implementation");
        const calls: string[] = [];
        lesson.client.messages = {
          create: async (request: any) => {
            calls.push(String(request.messages.at(-1).content));
            lesson.plan_gates.alice = "pending";
            return endTurn("Waiting for approval.");
          },
        };

        const spawned = lesson.spawn_teammate_thread(
          "alice", "writer", "Prepare a plan.", owned.id, true,
        );
        expect(spawned).toContain("spawned");
        expect(await waitUntil(() => calls.length === 1, 3)).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 2500));
        expect(calls).toHaveLength(1);
        expect(lesson.active_teammates.alice).toBe("waiting_approval");
        expect((await readTask(lesson, owned.id)).owner).toBe("alice");
      });
    }
  }, 45000);

  test("resumes an owned task before claiming new work", async () => {
    for (const specifier of ["../s13_agent_teams/code.ts", "../s15_integrated_harness/code.ts"]) {
      await withTeammate(specifier, async (lesson) => {
        const owned = lesson.create_task("Finish the report");
        const pending = lesson.create_task("Start a different task");
        const calls: string[] = [];
        lesson.client.messages = {
          create: async (request: any) => {
            calls.push(String(request.messages.at(-1).content));
            return endTurn("Work is not complete yet.");
          },
        };

        const spawned = lesson.spawn_teammate_thread(
          "alice", "writer", "Continue your work.", owned.id,
        );
        expect(spawned).toContain("spawned");
        expect(await waitUntil(() => calls.length >= 2, 4)).toBe(true);
        expect(calls[1]).toContain(`[Resume task ${owned.id}]`);
        const stillOwned = await readTask(lesson, owned.id);
        expect(stillOwned.status).toBe("in_progress");
        expect(stillOwned.owner).toBe("alice");
        expect(lesson.teammate_assignments.alice.task_id).toBe(owned.id);
        const untouched = await readTask(lesson, pending.id);
        expect(untouched.status).toBe("pending");
        expect(untouched.owner).toBeNull();
      });
    }
  }, 45000);
});

function stableStringify(value: any): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalWorkflowResult(result: any): any {
  const task = { ...result.task };
  const progress = task.progress as any[];
  delete task.progress;
  task.progress = {
    ordered: progress.filter((event) => event.type !== "workflow_agent"),
    agents: progress.filter((event) => event.type === "workflow_agent").sort((a, b) => {
      const key = (event: any) => JSON.stringify([
        event.phase ?? "",
        event.label ?? "",
        event.status ?? "",
        stableStringify(event),
      ]);
      return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
    }),
  };
  return { ...result, task };
}

describe("workflow discovery", () => {
  test("lists registered workflows in the tool description and schema", async () => {
    vi.resetModules();
    const isolated = await import("../s16_workflow_runtime/code.ts");
    const host = {
      client: {},
      MODEL: "test-model",
      assemble_tool_pool: (): [any[], Record<string, any>] => [
        [{ name: "bash", input_schema: {} }],
        { bash: () => "ok" },
      ],
    };
    isolated.install_workflow_tool(host);
    const [tools, handlers] = host.assemble_tool_pool();
    expect(tools.map((tool: any) => tool.name)).toEqual(["bash", "Workflow"]);
    expect(handlers.Workflow).toBe(isolated.run_workflow_sync);
    const description = tools[1].description as string;
    for (const [name, [meta]] of Object.entries(isolated.WORKFLOWS)) {
      expect(description).toContain(`${name}: ${meta.description}`);
    }

    const schema = new isolated.SimpleJsonSchema(isolated.WORKFLOW_TOOL.input_schema);
    for (const name of Object.keys(isolated.WORKFLOWS)) {
      expect(schema.validate({ name })).toEqual([true, null]);
      expect(schema.validate({
        name,
        args: { changes: "example change" },
        resume_from_run_id: "wf_review-changes_0000000000001a7b",
      })).toEqual([true, null]);
    }
    expect(schema.validate({ name: "not-registered" })[0]).toBe(false);
  });

  test("compares concurrent workflow agent events as a multiset", async () => {
    const scenario = JSON.parse(readFileSync("web/src/data/scenarios/s16.json", "utf8"));
    const workflowCall = scenario.steps.find((step: any) => (
      step.toolName === "Workflow" && step.type === "tool_call"
    ));
    const workflowResult = scenario.steps.find((step: any) => (
      step.toolName === "Workflow" && step.type === "tool_result"
    ));
    const callInput = JSON.parse(workflowCall.content);
    const shown = JSON.parse(workflowResult.content);
    const allowed = new Set(Object.keys(workflow.WORKFLOW_TOOL.input_schema.properties));
    expect(Object.keys(callInput).every((key) => allowed.has(key))).toBe(true);

    const lastRunPath = join(workflow.STORE, "last_run.txt");
    const previousLastRun = existsSync(lastRunPath) ? readFileSync(lastRunPath, "utf8") : null;
    const actual = await workflow.run_workflow(
      callInput.name,
      callInput.args,
      callInput.resume_from_run_id,
    );
    const runId = actual.task.runId;
    try {
      // Agent completion order is not part of the contract. Shuffling those
      // events must not change the canonical result, while phase and log
      // events keep their positions.
      const agents = actual.task.progress.filter((event: any) => event.type === "workflow_agent");
      const ordered = actual.task.progress.filter((event: any) => event.type !== "workflow_agent");
      const shuffled = {
        ...actual,
        task: {
          ...actual.task,
          progress: [ordered[0], ...agents.slice().reverse(), ...ordered.slice(1)],
        },
      };
      expect(canonicalWorkflowResult(shuffled)).toEqual(canonicalWorkflowResult(actual));

      for (const progress of [actual.task.progress, shown.task.progress]) {
        expect(progress[0]).toEqual({ type: "workflow_phase", title: "Review" });
        const log = progress.find((event: any) => event.type === "workflow_log");
        expect(progress.filter((event: any) => event.type !== "workflow_agent")).toEqual([
          { type: "workflow_phase", title: "Review" },
          { type: "workflow_phase", title: "Verify" },
          log,
        ]);
        expect(progress.at(-1).type).toBe("workflow_log");
        expect(String(log.message)).toMatch(/^confirmed \d+ real finding\(s\)$/);
        const verifyPhaseIndex = progress.findIndex((event: any) => (
          event.type === "workflow_phase" && event.title === "Verify"
        ));
        progress.forEach((event: any, index: number) => {
          if (event.type !== "workflow_agent") return;
          if (String(event.label).startsWith("audit:")) {
            expect(event.phase).toBe("Review");
          } else {
            expect(event.phase).toBe("Verify");
            expect(index).toBeGreaterThan(verifyPhaseIndex);
          }
        });
      }
    } finally {
      for (const name of [
        `${runId}.json`,
        `${runId}.output.json`,
        `${runId}.journal.jsonl`,
        `${runId}.lock`,
      ]) {
        rmSync(join(workflow.STORE, name), { force: true });
      }
      if (previousLastRun === null) rmSync(lastRunPath, { force: true });
      else writeFileSync(lastRunPath, previousLastRun);
    }
  });

  test("generated s16 metadata keeps workflow names out of the tool list", () => {
    const versions = JSON.parse(readFileSync("web/src/data/generated/versions.json", "utf8"));
    const byId = Object.fromEntries(versions.versions.map((version: any) => [version.id, version]));
    expect(byId.s16.newTools).toEqual(["Workflow"]);
    expect(byId.s16.tools).toContain("Workflow");
    expect(byId.s16.tools).not.toContain("review-changes");
    expect(byId.s16.source).toBe(readFileSync("s16_workflow_runtime/code.ts", "utf8"));
    expect(byId.s14.source).toBe(readFileSync("s14_mcp_plugin/code.ts", "utf8"));
    expect(byId.s13.source).toBe(readFileSync("s13_agent_teams/code.ts", "utf8"));
    expect(byId.s15.source).toBe(readFileSync("s15_integrated_harness/code.ts", "utf8"));
  });
});
