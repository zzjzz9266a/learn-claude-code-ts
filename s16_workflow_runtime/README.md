# s16: Workflow Runtime — The Model Decides Each Step; a Script Decides the Orchestration

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md)

s01 → ... → s14 → [s15](../s15_integrated_harness/) → `s16` → [s17](../s17_goal_loop/)

> *"One tool_use runs an entire orchestration"* — The `Workflow` tool starts a recoverable script runtime that coordinates many agent calls.
>
> **Harness layer**: Orchestration — run saved multi-agent scripts above the single-agent loop.

---

From s01 through s15, the model decides which tools to call in each round. Their results enter `messages[]`, and the model decides the next step from the updated context. This works well when the path depends on what the previous step discovers.

Some tasks repeat a fixed sequence. A code review may inspect several dimensions concurrently, verify each finding, combine duplicates, and sort the result. The sequence and dependencies are known before execution. Here the host needs three things:

- **Parallelism**, rather than waiting for one item at a time;
- **A stable result structure**, even when individual agent answers vary;
- **Recoverability**, so an interruption does not rerun work that is already complete.

If this orchestration exists only in conversation history, its ordering and checkpoints also exist only in that history. A saved workflow puts the fixed sequence in code and records completed calls in a journal.

## Put the Plan in Code, Not in a Sequence of Chat Turns

Add a `Workflow` tool to the harness tool pool. The host registers trusted scripts built from `agent()`, `parallel()`, `pipeline()`, and `phase()`. The model supplies only a saved workflow name, arguments, and an optional run ID to resume; it does not send executable code or metadata.

The workflow enters the main loop as one `tool_use`. As the script runs, the runtime emits lifecycle and progress events and records every step in a journal on disk. When the script finishes, the call returns the launch envelope, result, and task state. Intermediate script results live in variables instead of taking space in conversation history. When restarted with `resume_from_run_id`, unchanged `agent()` calls hit the journal cache and reuse previous results.

![Workflow Runtime Overview](images/workflow-runtime-overview.svg)

```typescript
const SAMPLE_META = {"name": "review-changes", "description": "Review code changes", "phases": ["Review", "Verify"]};

async function sample_workflow(ctx: any, args: any): Promise<any> {
  ctx.phase("Review");
  const results = await ctx.pipeline(DIMENSIONS, audit, verify);   // Each dimension independently runs audit → verify
  const confirmed = results.filter((r: any) => r).flatMap((r: any) => r["confirmed"]);
  ctx.log(`Confirmed ${confirmed.length} real issues`);
  return {"confirmed": confirmed};
}
```

## The Workflow Tool: One Call, One Complete Run

`Workflow` is added to the s15 host's existing tool pool. The user can request a saved workflow, or the model can select it when a task matches a known orchestration. The adapter resolves the name through the host-owned `WORKFLOWS` registry, then passes its trusted metadata and function to the runtime. The other s15 tools remain available in the same loop.

The model-facing schema accepts `name`, `args`, and `resume_from_run_id`. Unknown names and malformed arguments become an error tool result instead of ending the host loop. The runtime then validates the registered metadata, checks permissions, registers a local workflow task, and emits `async_launched` before running the script. Progress events follow, then the final `task_notification`; the call returns JSON-safe launch information, result, and task state.

```typescript
const WORKFLOW_TOOL = {
  "name": "Workflow",
  "input_schema": {
    "type": "object",
    "properties": {
      "name": {"type": "string"},
      "args": {"type": "object"},
      "resume_from_run_id": {"type": "string"},
    },
    "required": ["name"],
    "additionalProperties": false,
  },
};

async function run_workflow(name: string, args: any = null, resume_from_run_id: string | null = null): Promise<any> {
  const [meta, script_fn] = WORKFLOWS[name];
  const out = await new WorkflowTool().call(
    meta, script_fn,
    args,
    resume_from_run_id,
  );
  return {"launched": out["launched"], "result": out["result"],
          "task": serialize_task(out["task"])};
}
```

## Workflow Metadata: Validate Before Launch

Each saved workflow registers trusted metadata with `name`, `description`, and optional `phases`. The runtime validates it before executing workflow code. `name` and `description` identify the task in the UI, while `phases` names groups in the progress display. These fields belong to the host registry, not to model input.

Invalid registration raises `WorkflowInputError` before launch. This is the same idea as validating cron expressions in s12: do not wait until execution to discover a bad saved workflow.

Because the runtime uses `meta.name` in local artifact filenames, it also requires a 1-64 character safe slug containing letters, numbers, `.`, `_`, or `-`.

```typescript
function validate_meta(meta: any): any {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    throw new WorkflowInputError("meta must be an object literal");
  }
  if (!meta["name"] || !meta["description"]) {
    throw new WorkflowInputError("meta requires name and description");
  }
  if (typeof meta["name"] !== "string" || !WORKFLOW_NAME_RE.test(meta["name"])) {
    throw new WorkflowInputError("meta.name must be a safe 1-64 character slug");
  }
  if ("phases" in meta && (
    !Array.isArray(meta["phases"]) ||
    !meta["phases"].every((p: any) => typeof p === "string" && p)
  )) {
    throw new WorkflowInputError("meta.phases must contain non-empty strings");
  }
  return meta;
}
```

## Orchestration Primitives

A script receives an `ExecutionState` exposing a small set of orchestration primitives. It does not read files or run shell commands directly. The default interactive mode connects `agent()` to the same real API client as the host, and each workflow agent reads only the content supplied through workflow arguments. `demo` and unit tests use `MockAgentRunner` so events and journal replay are repeatable.

| Primitive | Purpose |
|------|------|
| `agent(prompt, {schema, label, phase})` | Dispatch one subagent |
| `parallel(thunks)` | **Barrier**: run every task concurrently and wait until all results return |
| `pipeline(items, *stages)` | Run each item through stages **without a barrier**; finished items proceed immediately |
| `phase(title)` | Mark the current progress phase and update the progress display |
| `log(message)` | Emit a progress log line |
| `workflow(name, args)` | Run a nested sub-workflow, one level only |

Use `pipeline` when each item independently crosses the same stages. Item A may reach stage three while item B is still in stage one. Use `parallel` when the next step needs every result from the preceding group.

```typescript
async function pipeline(items: any[], ...stages: Array<(value: any, item: any, index: number) => Promise<any>>): Promise<any[]> {
  const run_item = async (item: any, idx: number) => {
    let value = item;
    for (const stage of stages) {                       // Each item independently completes every stage
      value = await stage(value, item, idx);
    }
    return value;
  };
  return await Promise.all(items.map((it, i) => run_item(it, i)));
}
```

## Structured Output: Do Not Let Subagents Return Essays

`agent({schema})` asks a workflow agent to return only a JSON object matching the schema. The runtime parses and validates the result, then retries once if it does not match. Downstream code receives an object instead of extracting fields from prose.

s05 warned that tool arguments cannot be trusted completely. This is the same lesson in reverse: subagent output cannot be trusted completely either. Validate at the orchestration boundary, give one retry, and keep uncertainty out of the rest of the flow.

```typescript
let run = await this.runner.run(prompt, schema, label);
let result = run.value;
if (schema !== null) {
  let [ok, err] = new SimpleJsonSchema(schema).validate(result);
  if (!ok) {                                       // Retry once with a reminder, then fail
    const retry = await this.runner.run(
      prompt + "\n\nReturn valid JSON.", schema, label,
    );
    result = retry.value;
    [ok, err] = new SimpleJsonSchema(schema).validate(result);
    if (!ok) {
      throw new WorkflowInputError(`agent({schema}) returned invalid output: ${err}`);
    }
  }
}
```

## Task State and Progress Events

`LocalWorkflowTask` maintains status and token usage and emits an SDK-style event stream: `task_started` → a sequence of `task_progress` events containing phase changes, subagent starts, and log batches → one final `task_notification` reporting completion or failure, plus the output file and agent and token counts.

The demo prints these events in order and returns the task state after the final notification.

```typescript
class LocalWorkflowTask {
  progress: any[] = [];

  progress_event(ptype: string, data: Record<string, any> = {}): void {         // Phase/subagent/log
    this.progress.push({"type": ptype, ...data});
    console.log(`  progress   ${ptype} ...`);
  }
}
```

## Storage: Snapshot + Journal for Resuming after Interruptions

The runtime stores each run under `s16_workflow_runtime/.runtime/`: a `<runId>.json` snapshot, `<runId>.output.json` output, `<runId>.journal.jsonl` journal, and `<runId>.lock` coordination file. Every fresh run reserves a new `runId` with exclusive file creation before opening its journal. The run lock stays held through execution and final persistence, so another process cannot resume the same run at the same time. Its snapshot records the workflow name, arguments, and task state; resume validates the saved snapshot and journal before changing either successful artifact.

The journal is the core of checkpointed resume. It records every `agent()` result one line at a time:

```typescript
class WorkflowJournal {
  record(key: string, value: any): void {
    writeSync(this._fd, json_dumps({"key": key, "value": value}) + "\n");
    this.cache.set(key, value);
  }
}
```

## Resume: Continue by runId and Reuse Everything Unchanged

Calling the workflow again with `resume_from_run_id` reruns the script, but every `agent()` computes a deterministic semantic key. If that key is present in the journal, it returns the cached result without executing again. Every unchanged call hits the cache; only a changed call and the downstream steps that depend on it actually rerun.

The key detail is that keys cannot depend on concurrency order. Agents in `parallel` and `pipeline` finish in nondeterministic order. If "the nth completion" became the key, cache entries would map to the wrong calls on the next run. A key therefore uses a stable hash of call content, including type, label, prompt, and schema, rather than a shared counter:

```typescript
function key(kind: string, label: string, prompt: string, schema: any): string {
  const basis = `${kind}|${label}|${prompt}|${json_dumps(schema, true)}`;
  const n = _stable_hash(basis) % (10n ** 10n);
  return `${kind}-${n.toString().padStart(10, "0")}`;
}

// Inside agent():
const cached = this.journal.cached(key);
if (cached !== MISS) {
  this.task.progress_event("workflow_agent", { label, status: "cached" });
  return cached;
}
```

## Stable Call Keys

On resume, the runtime must match each current `agent()` call with its earlier journal record. A stable hash gives unchanged workflow code and arguments the same call key. Real model output may vary; when the call content has not changed, resume uses the result already saved in the journal.

## See It Run

The sample `review-changes` workflow uses `pipeline` to send each review dimension independently through audit → verify. Interactive mode uses the real API and reads the material to review from `args.changes`. `demo` uses fixed runner data to show pipeline, validation, journal, and resume behavior.

```typescript
async function sample_workflow(ctx: any, args: any): Promise<any> {
  ctx.phase("Review");
  const changes = Object.prototype.hasOwnProperty.call(args, "changes") ? args["changes"] : "";

  const audit = async (_v: any, dimension: string, _i: number) => {
    const out = await ctx.agent(`Inspect this change for ${dimension} issues:\n${changes}`,
                                FINDINGS_SCHEMA, `audit:${dimension}`, "Review");
    return {"dimension": dimension, "findings": out["findings"]};
  };

  const verify = async (audited: any, dimension: string, _i: number) => {
    ctx.phase("Verify");
    const verdicts = await ctx.parallel(                       // Verify every finding independently
      audited["findings"].map((f: any) => () => ctx.agent(
        `Verify this finding against the change:\n${changes}\n\n${f}`,
        VERDICT_SCHEMA, `verify:${dimension}:${f["title"]}`)));
    return {"dimension": dimension,
            "confirmed": audited["findings"].filter((_f: any, i: number) => verdicts[i] && verdicts[i]["isReal"])};
  };

  const results = await ctx.pipeline(DIMENSIONS, audit, verify);
  // ...
}
```

## Changes from s15

| | s15 Integrated Harness | s16 Workflow Runtime |
|--|-----------|---------------------|
| Loop | One model-driven loop | Main loop unchanged; a tool runs scripted orchestration |
| Who decides the next step | Model decides each round | Script declares the orchestration in advance |
| Multiple agents | One-shot s06 subagents | Scripted, resumable calls through an agent-runner boundary |
| New mechanisms | — | Script primitives, host registry and tool adapter, task lifecycle, progress events, journal/resume, structured output |

s16 does not replace the main loop. It exposes `Workflow` at the tool layer and starts a local workflow runtime behind it: one saved script coordinates N calls through an agent-runner boundary. An s06 subagent is dispatched once at the model's discretion; s16 turns the orchestration into resumable host code.

## Try It

```bash
npx tsx s16_workflow_runtime/code.ts          # Both the main model and Workflow agents use the real API
npx tsx s16_workflow_runtime/code.ts demo     # Deterministic review-changes fixture and event stream
npx tsx s16_workflow_runtime/code.ts resume   # Resume by the last runId; every agent() hits the journal cache
```

In the default command, ask the model to read the changes, place that text in `args.changes`, and run the saved `review-changes` workflow. Both the main model and workflow agents use the real API. The `demo` command uses fixed runner data so lifecycle and resume behavior can be observed repeatedly. A resumed demo reports `agents=0 tokens=0` when every call hits the cache.

## Next

[s17 Goal Loop](../s17_goal_loop/) uses a smaller, independent loop to check whether a stated goal has been reached and decide whether another turn is needed.

<!-- translation-sync: zh@v10, en@v10, ja@v10 -->
