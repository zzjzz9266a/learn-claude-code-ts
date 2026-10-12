/**
 * s16: Workflow Runtime - run a saved orchestration through one tool call.
 *
 * Run:
 *   npx tsx s16_workflow_runtime/code.ts
 *   npx tsx s16_workflow_runtime/code.ts demo
 *   npx tsx s16_workflow_runtime/code.ts resume
 *
 *     +-------------+       +--------------------------------+
 *     | Agent loop  | ----> | Workflow(name, args, run_id)  |
 *     +-------------+       +---------------+----------------+
 *                                           |
 *                            +--------------+--------------+
 *                            | agent | parallel | pipeline  |
 *                            +--------------+--------------+
 *                                           |
 *                                    journal + result
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const WORKFLOW_AGENT_ENVIRONMENT =
  process.platform === "win32"
    ? "Host OS: Windows. This workflow agent only responds to its supplied step; it has no direct shell or file tools."
    : "Host OS: Unix-like. This workflow agent only responds to its supplied step; it has no direct shell or file tools.";

// -- Runtime Guards --
export const AGENT_CAP = 1000;                       // hard cap on agent() calls per run
export const CONCURRENCY = 8;                        // parallelism cap (semaphore)
const HERE = dirname(fileURLToPath(import.meta.url));
export const STORE = join(HERE, ".runtime");         // snapshots + journals live here
export const MISS = Symbol("MISS");                  // journal cache miss sentinel
export const WORKFLOW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const RUN_ID_RE = /^wf_[A-Za-z0-9][A-Za-z0-9._-]{0,63}_[0-9a-f]{16}$/;

export function _stable_hash(s: string): bigint {
  /** Process-stable hash (Python's hash() is salted per process, which would
   * break resume keys across `run` and `resume`). */
  return BigInt(`0x${createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex")}`);
}

export function create_run_id(meta: any): string {
  return `wf_${meta["name"]}_${randomBytes(8).toString("hex")}`;
}

export function reserve_run_id(meta: any): string {
  /** Reserve a fresh run identity before any journal can be truncated. */
  mkdirSync(STORE, { recursive: true });
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const run_id = validate_run_id(create_run_id(meta));
    const snapshot_path = join(STORE, `${run_id}.json`);
    try {
      const fd = openSync(snapshot_path, "wx", 0o600);
      closeSync(fd);
      return run_id;
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw exc;
    }
  }
  throw new WorkflowInputError("could not allocate a unique workflow runId");
}

export function create_task_id(run_id: string): string {
  return `local_workflow_${run_id}`;
}

export function validate_run_id(run_id: any): string {
  if (typeof run_id !== "string" || !RUN_ID_RE.test(run_id)) {
    throw new WorkflowInputError("invalid workflow runId");
  }
  return run_id;
}


// -- Errors --
export class WorkflowInputError extends Error {
  /** Bad workflow, metadata, or schema input. */
  constructor(message: string) {
    super(message);
    this.name = "WorkflowInputError";
  }
}

const _runLockDepth = new AsyncLocalStorage<Map<string, number>>();

export async function workflow_run_lock<T>(run_id: string, body: () => Promise<T>): Promise<T> {
  /** Hold one run across tasks and host processes for its full lifecycle. */
  const parent = _runLockDepth.getStore();
  const depths = parent ?? new Map<string, number>();
  const depth = depths.get(run_id) ?? 0;
  const lockPath = join(STORE, `${run_id}.lock`);
  if (depth === 0) {
    mkdirSync(STORE, { recursive: true });
    try {
      const fd = openSync(lockPath, "wx"); // stand-in for fcntl.flock
      closeSync(fd);
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException).code === "EEXIST") {
        throw new WorkflowInputError(`workflow run ${run_id} is already active`);
      }
      throw exc;
    }
  }
  depths.set(run_id, depth + 1);
  const run = async () => {
    try {
      return await body();
    } finally {
      const next = (depths.get(run_id) ?? 1) - 1;
      if (next <= 0) {
        depths.delete(run_id);
        try {
          unlinkSync(lockPath);
        } catch (exc) {
          if ((exc as NodeJS.ErrnoException).code !== "ENOENT") throw exc;
        }
      } else {
        depths.set(run_id, next);
      }
    }
  };
  if (parent) return await run();
  return await _runLockDepth.run(depths, run);
}


// -- Metadata Validation --
export function validate_meta(meta: any): any {
  /** Validate name, description, and optional phases before launch. */
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    throw new WorkflowInputError("meta must be an object literal");
  }
  if (!meta["name"] || !meta["description"]) {
    throw new WorkflowInputError("meta requires `name` and `description`");
  }
  if (typeof meta["name"] !== "string" || !WORKFLOW_NAME_RE.test(meta["name"])) {
    throw new WorkflowInputError(
      "meta.name must be a 1-64 character slug using letters, numbers, '.', '_', or '-'",
    );
  }
  if (typeof meta["description"] !== "string") {
    throw new WorkflowInputError("meta.description must be a string");
  }
  if ("phases" in meta) {
    const phases = meta["phases"];
    if (!Array.isArray(phases) || !phases.every((phase) => typeof phase === "string" && phase)) {
      throw new WorkflowInputError("meta.phases must be a list of non-empty strings");
    }
  }
  return meta;
}

export function check_permission(meta: any, settings: any = null): string {
  /** Apply the s03 allow/deny gate before launching a workflow. */
  settings = settings || {};
  const deny = settings["deny"] ?? [];
  if (deny.includes(meta["name"])) {
    throw new WorkflowInputError(`workflow '${meta["name"]}' denied by settings`);
  }
  return "allow";
}


// -- Minimal JSON Schema --
export class SimpleJsonSchema {
  /** Tiny validator backing agent({schema}):
   * object/array/string/boolean/number + required keys. */
  schema: any;

  constructor(schema: any) {
    this.schema = schema;
  }

  validate(value: any, schema: any = null): [boolean, string | null] {
    schema = schema === null ? this.schema : schema;
    if ("enum" in schema && !schema["enum"].includes(value)) {
      return [false, `expected one of ${py_list(schema["enum"])}`];
    }
    const t = schema["type"];
    if (t === "object") {
      if (!is_dict(value)) return [false, "expected object"];
      for (const key of schema["required"] ?? []) {
        if (!(key in value)) return [false, `missing required key '${key}'`];
      }
      for (const [key, sub] of Object.entries(schema["properties"] ?? {})) {
        if (key in value) {
          const [ok, err] = this.validate(value[key], sub);
          if (!ok) return [false, `${key}: ${err}`];
        }
      }
      return [true, null];
    }
    if (t === "array") {
      if (!Array.isArray(value)) return [false, "expected array"];
      const items = schema["items"];
      if (items) {
        for (let i = 0; i < value.length; i += 1) {
          const [ok, err] = this.validate(value[i], items);
          if (!ok) return [false, `[${i}]: ${err}`];
        }
      }
      return [true, null];
    }
    if (t === "string") {
      return [typeof value === "string", typeof value === "string" ? null : "expected string"];
    }
    if (t === "boolean") {
      return [typeof value === "boolean", typeof value === "boolean" ? null : "expected boolean"];
    }
    if (t === "number" || t === "integer") {
      const ok = typeof value === "number";
      return [ok, ok ? null : "expected number"];
    }
    return [true, null];
  }
}

function is_dict(value: any): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function py_list(values: any[]): string {
  return `[${values.map((item) => typeof item === "string" ? `'${item}'` : String(item)).join(", ")}]`;
}

function sort_keys(value: any): any {
  if (Array.isArray(value)) return value.map(sort_keys);
  if (is_dict(value)) {
    const out: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) out[key] = sort_keys(value[key]);
    return out;
  }
  return value;
}

function ensure_ascii(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 128) {
      out += ch;
      continue;
    }
    if (cp <= 0xffff) {
      out += `\\u${cp.toString(16).padStart(4, "0")}`;
      continue;
    }
    const u = cp - 0x10000;
    const hi = 0xd800 + (u >> 10);
    const lo = 0xdc00 + (u & 0x3ff);
    out += `\\u${hi.toString(16).padStart(4, "0")}\\u${lo.toString(16).padStart(4, "0")}`;
  }
  return out;
}

function py_json(value: any): string {
  // Python json.dumps defaults: ", " / ": " separators, ensure_ascii=True.
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return ensure_ascii(JSON.stringify(value));
  if (Array.isArray(value)) return `[${value.map((item) => py_json(item)).join(", ")}]`;
  if (typeof value === "object") {
    const parts = Object.keys(value).map((key) => `${ensure_ascii(JSON.stringify(key))}: ${py_json(value[key])}`);
    return `{${parts.join(", ")}}`;
  }
  return ensure_ascii(JSON.stringify(String(value)));
}

function json_dumps(value: any, sortKeys = false): string {
  return py_json(sortKeys ? sort_keys(value) : value);
}

function py_str(value: any): string {
  if (value === true) return "True";
  if (value === false) return "False";
  if (value === null || value === undefined) return "None";
  return String(value);
}

export function _fill_schema(schema: any, seed: string): any {
  /** Deterministic generic filler used for schemas the mock doesn't special-case. */
  const t = schema["type"];
  if (t === "object") {
    const keys = schema["required"]?.length ? schema["required"] : Object.keys(schema["properties"] ?? {});
    const out: Record<string, any> = {};
    for (const key of keys) out[key] = _fill_schema(schema["properties"][key], `${seed}/${key}`);
    return out;
  }
  if (t === "array") {
    return [_fill_schema(schema["items"], `${seed}/0`)];
  }
  if (t === "boolean") {
    return _stable_hash(seed) % 4n !== 0n;
  }
  if (t === "number" || t === "integer") {
    return Number(_stable_hash(seed) % 5n);
  }
  const at = seed.lastIndexOf("/");
  return at < 0 ? seed : seed.slice(at + 1);
}


// -- Agent Runners --

export class RunnerOutput {
  constructor(
    public readonly value: any,
    public readonly tokens: number,
  ) {}
}

export class MockAgentRunner {
  /** Deterministic runner used by demo mode and unit tests. */
  async run(prompt: string, schema: any = null, label: string | null = null): Promise<RunnerOutput> {
    if (schema === null) {
      const value = `[mock] ${(label || prompt).slice(0, 60)}`;
      return new RunnerOutput(value, MockAgentRunner._tokens(prompt, value));
    }
    const props = schema["properties"] ?? {};
    let value: any;
    if ("findings" in props) {
      const n = 1 + Number(_stable_hash(prompt) % 2n);
      const sev = ["high", "medium", "low"];
      const findings: any[] = [];
      for (let i = 0; i < n; i += 1) {
        findings.push({
          "title": `${label || "audit"} #${i + 1}`,
          "severity": sev[Number(_stable_hash(prompt + String(i)) % 3n)],
        });
      }
      value = { "findings": findings };
    } else if ("isReal" in props) {
      const real = _stable_hash(prompt) % 4n !== 0n;
      value = {
        "isReal": real,
        "reason": real ? "reproduced" : "could not reproduce",
      };
    } else {
      value = _fill_schema(schema, prompt);
    }
    return new RunnerOutput(value, MockAgentRunner._tokens(prompt, value));
  }

  static _tokens(prompt: string, result: any): number {
    return Math.floor(prompt.length / 4) + Math.floor(json_dumps(result).length / 4);
  }
}

export function _response_text(response: any): string {
  const parts: string[] = [];
  for (const block of response?.content ?? []) {
    if ((block?.type ?? null) === "text") {
      parts.push(String(block.text ?? ""));
    }
  }
  return parts.join("\n").trim();
}

function raw_decode_object(text: string): any {
  let i = 0;
  while (i < text.length && " \n\r\t".includes(text[i])) i += 1;
  if (text[i] !== "{") throw new SyntaxError("expected object");
  let depth = 0;
  let quote = false;
  let escape = false;
  for (let index = i; index < text.length; index += 1) {
    const ch = text[index];
    if (quote) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') {
      quote = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(i, index + 1));
    }
  }
  throw new SyntaxError("unterminated object");
}

export function _parse_runner_json(text: string): any {
  let stripped = text.trim();
  if (stripped.startsWith("```")) {
    let lines = stripped.split(/\r?\n/);
    lines = lines.length ? lines.slice(1) : lines;
    if (lines.length && lines[lines.length - 1].trim() === "```") {
      lines = lines.slice(0, -1);
    }
    stripped = lines.join("\n").trim();
  }
  try {
    return JSON.parse(stripped);
  } catch {
    for (let position = 0; position < stripped.length; position += 1) {
      if (stripped[position] !== "{") continue;
      try {
        return raw_decode_object(stripped.slice(position));
      } catch {
        continue;
      }
    }
    throw new WorkflowInputError("workflow agent returned invalid JSON");
  }
}

export class AnthropicAgentRunner {
  /** Run workflow agents through the same API client as the host. */
  client: any;
  model: string;

  constructor(client: any, model: string) {
    this.client = client;
    this.model = model;
  }

  async run(prompt: string, schema: any = null, _label: string | null = null): Promise<RunnerOutput> {
    let request = prompt;
    if (schema !== null) {
      request += (
        "\n\nReturn only one JSON object matching this schema:\n" +
        json_dumps(schema, true)
      );
    }
    const response = await this.client.messages.create({
      model: this.model,
      system: (
        "You are a focused workflow agent. Complete only the supplied step. " +
        `${WORKFLOW_AGENT_ENVIRONMENT} ` +
        "Do not claim access to files or results not included in the prompt."
      ),
      messages: [{"role": "user", "content": request}],
      max_tokens: 2000,
    });
    const text = _response_text(response);
    let value: any;
    if (schema === null) {
      value = text;
    } else {
      try {
        value = _parse_runner_json(text);
      } catch (exc) {
        if (exc instanceof WorkflowInputError) {
          // Let ExecutionState's schema check trigger its single retry.
          value = text;
        } else {
          throw exc;
        }
      }
    }
    const usage = response?.usage;
    const tokens = Number(usage?.input_tokens || 0) + Number(usage?.output_tokens || 0);
    return new RunnerOutput(value, tokens);
  }
}

export let RUNNER_FACTORY: () => MockAgentRunner | AnthropicAgentRunner = () => new MockAgentRunner();


// -- Journal --
function split_lines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]/);
  if (/[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]$/.test(text)) lines.pop();
  return lines;
}

export class WorkflowJournal {
  /** Append-only <runId>.journal.jsonl. On resume, agent() calls whose
   * semantic key is already present are replayed from cache instead of re-run. */
  path: string;
  resume: boolean;
  cache: Map<string, any> = new Map();
  _fd: number;

  constructor(run_id: string, resume: boolean, store: string | null = null) {
    const root = store === null ? STORE : store;
    mkdirSync(root, { recursive: true });
    this.path = join(root, `${run_id}.journal.jsonl`);
    this.resume = resume;
    if (resume) {
      if (!exists(this.path)) {
        throw new WorkflowInputError(`resume journal not found for ${run_id}`);
      }
      const lines = split_lines(readFileSync(this.path, "utf-8"));
      lines.forEach((line, index) => {
        const line_number = index + 1;
        try {
          const rec = JSON.parse(line);
          if (!is_dict(rec) || typeof rec["key"] !== "string" || !("value" in rec)) {
            throw new Error("expected key/value record");
          }
          this.cache.set(rec["key"], rec["value"]);
        } catch (exc) {
          if (exc instanceof WorkflowInputError) throw exc;
          throw new WorkflowInputError(`invalid resume journal record at line ${line_number}`);
        }
      });
      this._fd = openSync(this.path, "a");
    } else {
      this._fd = openSync(this.path, "w");             // fresh run truncates
    }
  }

  key(kind: string, label: string, prompt: string, schema: any): string {
    // Deterministic semantic key, independent of concurrency order, so a
    // parallel/pipeline call gets the same key on resume.
    const basis = `${kind}|${label}|${prompt}|${json_dumps(schema, true)}`;
    const n = _stable_hash(basis) % (10n ** 10n);
    return `${kind}-${n.toString().padStart(10, "0")}`;
  }

  cached(key: string): any {
    return this.cache.has(key) ? this.cache.get(key) : MISS;
  }

  record(key: string, value: any): void {
    writeSync(this._fd, json_dumps({ "key": key, "value": value }) + "\n");
    this.cache.set(key, value);
  }

  close(): void {
    closeSync(this._fd);
  }
}

function exists(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw exc;
  }
}


// -- Token Budget --
export class Budget {
  /** budget.total / spent() / remaining(). Once spent reaches total, agent()
   * calls raise instead of silently overspending. */
  total: number | null;
  _spent = 0;

  constructor(total: number | null = null) {
    this.total = total;
  }

  add(n: number): void {
    if (this.total !== null && this._spent + n > this.total) {
      throw new WorkflowInputError(`token budget exceeded (${this._spent + n} > ${this.total})`);
    }
    this._spent += n;
  }

  spent(): number {
    return this._spent;
  }

  remaining(): number {
    return this.total === null ? Number.POSITIVE_INFINITY : Math.max(0, this.total - this._spent);
  }
}


// -- Workflow Task Lifecycle --
export class LocalWorkflowTask {
  /** Hold workflow status, usage, and progress events. */
  task_id: string;
  run_id: string;
  meta: any;
  status = "running";
  usage: { agents: number; tokens: number } = { agents: 0, tokens: 0 };
  progress: any[] = [];

  constructor(task_id: string, run_id: string, meta: any) {
    this.task_id = task_id;
    this.run_id = run_id;
    this.meta = meta;
  }

  event(name: string, data: Record<string, any> = {}): void {
    const line = Object.entries(data).map(([k, v]) => `${k}=${py_str(v)}`).join(" ");
    console.log(`  event      ${name.padEnd(18)} ${line}`);
  }

  progress_event(ptype: string, data: Record<string, any> = {}): void {
    this.progress.push({ "type": ptype, ...data });
    const line = Object.entries(data).map(([k, v]) => `${k}=${py_str(v)}`).join(" ");
    console.log(`  progress   ${ptype.padEnd(16)} ${line}`);
  }
}


// -- Workflow Primitives --
class AsyncSemaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolvePromise) => {
      this.queue.push(resolvePromise);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.permits += 1;
  }
}

export class ExecutionLimits {
  /** Shared run-wide limits, including nested workflows. */
  agents = 0;
  semaphore = new AsyncSemaphore(CONCURRENCY);

  claim_agent(): void {
    this.agents += 1;
    if (this.agents > AGENT_CAP) {
      throw new WorkflowInputError(`agent() cap reached (${AGENT_CAP})`);
    }
  }
}

export class ExecutionState {
  /** Injected into the workflow script with the orchestration primitives. */
  task: LocalWorkflowTask;
  journal: WorkflowJournal;
  runner: MockAgentRunner | AnthropicAgentRunner;
  budget: Budget;
  args: any;
  _depth: number;
  _phase: string | null = null;
  _phases_seen = new Set<string>();
  _limits: ExecutionLimits;

  constructor(
    task: LocalWorkflowTask,
    journal: WorkflowJournal,
    runner: MockAgentRunner | AnthropicAgentRunner,
    budget: Budget,
    args: any,
    depth = 0,
    limits: ExecutionLimits | null = null,
  ) {
    this.task = task;
    this.journal = journal;
    this.runner = runner;
    this.budget = budget;
    this.args = args;
    this._depth = depth;
    this._limits = limits ?? new ExecutionLimits();
  }

  phase(title: string): void {
    /** Start a phase; subsequent agent()s group under it. Upsert: emitting the
     * same phase again (e.g. from each pipeline item) does not re-announce it. */
    this._phase = title;
    if (!this._phases_seen.has(title)) {
      this._phases_seen.add(title);
      this.task.progress_event("workflow_phase", { title });
    }
  }

  log(message: string): void {
    /** Emit a workflow_log progress line. */
    this.task.progress_event("workflow_log", { message });
  }

  async agent(
    prompt: string,
    schema: any = null,
    label: string | null = null,
    phase: string | null = null,
  ): Promise<any> {
    /** Spawn one subagent. With a schema, force StructuredOutput + validate
     * (retry once). On resume, a cached key short-circuits the run. */
    label = label || (prompt.slice(0, 24) + "...");
    this._limits.claim_agent();
    if (this.budget.remaining() <= 0) {
      throw new WorkflowInputError("token budget exceeded");
    }

    const key = this.journal.key("agent", label, prompt, schema);
    const cached = this.journal.cached(key);
    if (cached !== MISS) {
      if (schema !== null) {
        const [ok, err] = new SimpleJsonSchema(schema).validate(cached);
        if (!ok) {
          throw new WorkflowInputError(`cached agent output failed schema validation: ${err}`);
        }
      }
      this.task.progress_event("workflow_agent", {
        label,
        phase: phase || this._phase,
        status: "cached",
      });
      return cached;
    }

    await this._limits.semaphore.acquire();
    let run: RunnerOutput;
    try {
      run = await this.runner.run(prompt, schema, label);
    } finally {
      this._limits.semaphore.release();
    }
    let result = run.value;
    let tokens = run.tokens;

    if (schema !== null) {
      let [ok, err] = new SimpleJsonSchema(schema).validate(result);
      if (!ok) {
        const retry = await this.runner.run(prompt + "\n\nReturn valid JSON.", schema, label);
        result = retry.value;
        tokens += retry.tokens;
        [ok, err] = new SimpleJsonSchema(schema).validate(result);
        if (!ok) {
          throw new WorkflowInputError(`agent({schema}) invalid output: ${err}`);
        }
      }
    }

    this.budget.add(tokens);
    this.task.usage["agents"] += 1;
    this.task.usage["tokens"] += tokens;
    this.journal.record(key, result);
    this.task.progress_event("workflow_agent", {
      label,
      phase: phase || this._phase,
      status: "done",
    });
    return result;
  }

  async parallel(thunks: Array<() => Promise<any>>): Promise<any[]> {
    /** BARRIER: run all thunks concurrently and fail if any thunk fails. */
    return await Promise.all(thunks.map((thunk) => thunk()));
  }

  async pipeline(
    items: any[],
    ...stages: Array<(value: any, item: any, index: number) => Promise<any>>
  ): Promise<any[]> {
    /** Per-item staged flow, NO barrier between stages: item A can be in
     * stage 3 while item B is still in stage 1. Each stage gets
     * (prev_result, original_item, index). A throwing stage fails the workflow. */
    const run_item = async (item: any, idx: number) => {
      let value = item;
      for (const stage of stages) {
        value = await stage(value, item, idx);
      }
      return value;
    };
    return await Promise.all(items.map((it, i) => run_item(it, i)));
  }

  async workflow(name: string, args: any = null): Promise<any> {
    /** Run a saved workflow inline as a child (one level), sharing this run's
     * journal + budget + agent counter. */
    if (this._depth >= 1) {
      throw new WorkflowInputError("workflow() nesting is one level only");
    }
    if (!(name in WORKFLOWS)) {
      throw new WorkflowInputError(`unknown workflow '${name}'`);
    }
    const [, fn] = WORKFLOWS[name];
    const child = new ExecutionState(
      this.task, this.journal, this.runner, this.budget,
      args || {}, this._depth + 1, this._limits,
    );
    return await fn(child, args || {});
  }
}


// -- Workflow Tool --
function deep_equal(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deep_equal(item, b[index]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deep_equal(a[key], b[key]));
}

export class WorkflowTool {
  /** The Workflow tool. .call() validates meta, runs the permission check,
   * creates runId/taskId, registers a LocalWorkflowTask, and emits lifecycle
   * events while executing the script. It returns the result and task state and
   * supports resume. */
  async call(
    meta: any,
    script_fn: (ctx: ExecutionState, args: any) => Promise<any>,
    args: any = null,
    resume_from_run_id: string | null = null,
  ): Promise<any> {
    validate_meta(meta);
    check_permission(meta);
    const resuming = resume_from_run_id !== null && resume_from_run_id !== undefined;
    const run_id = resuming ? validate_run_id(resume_from_run_id) : reserve_run_id(meta);
    return await workflow_run_lock(run_id, async () => {
      return await this._call_locked(meta, script_fn, args, run_id, resuming);
    });
  }

  async _call_locked(
    meta: any,
    script_fn: (ctx: ExecutionState, args: any) => Promise<any>,
    args: any,
    run_id: string,
    resuming: boolean,
  ): Promise<any> {
    let journal: WorkflowJournal;
    if (resuming) {
      const snapshot = _read_snapshot(run_id);
      if (snapshot["workflowName"] !== meta["name"]) {
        throw new WorkflowInputError("resume runId does not match workflow meta");
      }
      const saved_args = snapshot["args"] ?? {};
      if (args === null || args === undefined) {
        args = saved_args;
      } else if (!deep_equal(args, saved_args)) {
        throw new WorkflowInputError("resume args do not match the original run");
      }
      journal = new WorkflowJournal(run_id, true);
    } else {
      args = args || {};
      journal = new WorkflowJournal(run_id, false);
    }
    const task_id = create_task_id(run_id);

    const task = new LocalWorkflowTask(task_id, run_id, meta);
    // Record the launch envelope before workflow execution starts.
    const launched = {
      "status": "async_launched",
      "taskId": task_id,
      "taskType": "local_workflow",
      "runId": run_id,
      "workflowName": meta["name"],
    };
    task.event("async_launched", { runId: run_id, taskId: task_id });
    task.event("task_started", {
      workflow: meta["name"],
      phases: (meta["phases"] ?? []).join(",") || "-",
      resume: resuming,
    });
    _write_json(join(STORE, `${run_id}.json`), {
      "runId": run_id,
      "workflowName": meta["name"],
      "args": args,
      "task": serialize_task(task),
    });

    let result: any;
    try {
      const total = Object.prototype.hasOwnProperty.call(args, "budget") ? args["budget"] : null;
      const ctx = new ExecutionState(task, journal, RUNNER_FACTORY(), new Budget(total), args);
      result = await script_fn(ctx, args);
      task.status = "completed";
    } catch (exc) {                          // failed / stopped close the loop too
      task.status = "failed";
      result = { "error": exc instanceof Error ? exc.message : String(exc) };
    } finally {
      journal.close();
    }

    _write_json(join(STORE, `${run_id}.output.json`), result);
    _write_json(join(STORE, `${run_id}.json`), {
      "runId": run_id,
      "workflowName": meta["name"],
      "args": args,
      "task": serialize_task(task),
    });
    _save_last_run(run_id);
    task.event("task_notification", {
      status: task.status,
      agents: task.usage["agents"],
      tokens: task.usage["tokens"],
      outputFile: `.runtime/${run_id}.output.json`,
    });
    return { "launched": launched, "result": result, "task": task };
  }
}

function with_suffix(filePath: string, suffix: string): string {
  const dir = dirname(filePath);
  const base = filePath.slice(dir.length + (dir === "/" ? 0 : 1));
  const dot = base.lastIndexOf(".");
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  return join(dir, stem + suffix);
}

export function _write_json(path: string, value: any): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = with_suffix(path, `${extname_of(path)}.tmp`);
  writeFileSync(temporary, JSON.stringify(value, null, 2), "utf-8");
  renameSync(temporary, path);
}

function extname_of(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot) : "";
}

export function _read_snapshot(run_id: string): any {
  const path = join(STORE, `${run_id}.json`);
  if (!exists(path)) {
    throw new WorkflowInputError(`resume snapshot not found for ${run_id}`);
  }
  let snapshot: any;
  try {
    snapshot = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new WorkflowInputError(`invalid resume snapshot for ${run_id}`);
  }
  if (!is_dict(snapshot)) {
    throw new WorkflowInputError(`invalid resume snapshot for ${run_id}`);
  }
  return snapshot;
}

export function _save_last_run(run_id: string): void {
  writeFileSync(join(STORE, "last_run.txt"), run_id, "utf-8");
}

export function _read_last_run(): string | null {
  const p = join(STORE, "last_run.txt");
  if (!exists(p)) return null;
  return readFileSync(p, "utf-8").trim();
}


// -- Sample Workflow --
export const FINDINGS_SCHEMA = {
  "type": "object", "required": ["findings"],
  "properties": {"findings": {"type": "array", "items": {
    "type": "object", "required": ["title", "severity"],
    "properties": {
      "title": {"type": "string"},
      "severity": {
        "type": "string", "enum": ["high", "medium", "low"],
      },
    }}}},
};
export const VERDICT_SCHEMA = {
  "type": "object", "required": ["isReal", "reason"],
  "properties": {"isReal": {"type": "boolean"}, "reason": {"type": "string"}},
};

export const SAMPLE_META = {
  "name": "review-changes",
  "description": "Review changed files across dimensions, verify each finding",
  "phases": ["Review", "Verify"],
};

export const DIMENSIONS = ["correctness", "security", "performance", "style"];
export const DEMO_CHANGES = (
  "def load_user(user_id):\n" +
  "    query = f\"SELECT * FROM users WHERE id = {user_id}\"\n" +
  "    return db.execute(query).fetchone()\n"
);

export async function sample_workflow(ctx: ExecutionState, args: any): Promise<any> {
  /** pipeline over review dimensions (audit -> verify-each), then keep only the
   * findings a verifier confirms. The plan is code, not a chat turn. */
  ctx.phase("Review");
  const changes = Object.prototype.hasOwnProperty.call(args, "changes") ? args["changes"] : "";
  if (typeof changes !== "string") {
    throw new WorkflowInputError("args.changes must be a string");
  }
  const review_input = changes.trim() || "No change context was supplied.";

  const audit = async (_value: any, dimension: string, _idx: number) => {
    const out = await ctx.agent(
      `Review this change context for ${dimension} issues. ` +
      "Report only issues supported by the supplied text.\n\n" +
      `${review_input}`,
      FINDINGS_SCHEMA,
      `audit:${dimension}`,
      "Review",
    );
    return { "dimension": dimension, "findings": out["findings"] };
  };

  const verify = async (audited: any, dimension: string, _idx: number) => {
    ctx.phase("Verify");
    // Each finding is verified by its own adversarial subagent, concurrently.
    const verdicts = await ctx.parallel(
      audited["findings"].map((f: any) => () => ctx.agent(
        `Adversarially verify this ${dimension} finding against the ` +
        "supplied change context.\n\n" +
        `Change context:\n${review_input}\n\n` +
        `Finding:\n${json_dumps(f)}`,
        VERDICT_SCHEMA,
        `verify:${dimension}:${f["title"]}`,
        "Verify",
      )),
    );
    const confirmed: any[] = [];
    const count = Math.min(audited["findings"].length, verdicts.length);
    for (let i = 0; i < count; i += 1) {
      const f = audited["findings"][i];
      const v = verdicts[i];
      if (v && v["isReal"]) confirmed.push(f);
    }
    return { "dimension": dimension, "confirmed": confirmed };
  };

  const results = await ctx.pipeline(DIMENSIONS, audit, verify);
  const confirmed: any[] = [];
  for (const r of results) {
    if (!r) continue;
    for (const f of r["confirmed"]) {
      confirmed.push({ "dimension": r["dimension"], ...f });
    }
  }
  const rank: Record<string, number> = { "high": 0, "medium": 1, "low": 2 };
  confirmed.sort((a, b) => (rank[a["severity"]] ?? 3) - (rank[b["severity"]] ?? 3));
  ctx.log(`confirmed ${confirmed.length} real finding(s)`);
  return { "confirmed": confirmed };
}

// Saved workflow registry
export const WORKFLOWS: Record<string, [any, (ctx: ExecutionState, args: any) => Promise<any>]> = {
  [SAMPLE_META["name"]]: [SAMPLE_META, sample_workflow],
};

export const WORKFLOW_TOOL = {
  "name": "Workflow",
  "description": "Run a saved workflow by name. Pass input in args.",
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

export function serialize_task(task: LocalWorkflowTask): any {
  return {
    "taskId": task.task_id,
    "taskType": "local_workflow",
    "runId": task.run_id,
    "workflowName": task.meta["name"],
    "status": task.status,
    "usage": { ...task.usage },
    "progress": [...task.progress],
  };
}

export async function run_workflow(
  name: any = undefined,
  args: any = null,
  resume_from_run_id: any = null,
): Promise<any> {
  /** Model-facing adapter: resolve trusted code from the host registry. */
  if (typeof name !== "string") {
    throw new WorkflowInputError("workflow name must be a string");
  }
  if (!(name in WORKFLOWS)) {
    throw new WorkflowInputError(`unknown workflow '${name}'`);
  }
  if (args !== null && args !== undefined && !is_dict(args)) {
    throw new WorkflowInputError("workflow args must be an object");
  }
  const [meta, script_fn] = WORKFLOWS[name];
  const out = await new WorkflowTool().call(meta, script_fn, args, resume_from_run_id);
  return {
    "launched": out["launched"],
    "result": out["result"],
    "task": serialize_task(out["task"]),
  };
}

export const WORKFLOW_HANDLERS: Record<string, (...args: any[]) => Promise<any>> = {
  "Workflow": run_workflow,
};
export const INHERITS_TOOLS_FROM = "s15";

export async function run_workflow_sync(tool_input: Record<string, any> = {}): Promise<string> {
  /** Bridge the synchronous host dispatcher to the async workflow runtime. */
  try {
    const allowed = new Set(["name", "args", "resume_from_run_id"]);
    for (const key of Object.keys(tool_input)) {
      if (!allowed.has(key)) {
        throw new TypeError(`run_workflow() got an unexpected keyword argument '${key}'`);
      }
    }
    const value = await run_workflow(
      tool_input["name"],
      Object.prototype.hasOwnProperty.call(tool_input, "args") ? tool_input["args"] : null,
      Object.prototype.hasOwnProperty.call(tool_input, "resume_from_run_id")
        ? tool_input["resume_from_run_id"]
        : null,
    );
    return JSON.stringify(value);
  } catch (exc) {
    if (exc instanceof WorkflowInputError) return `Error: ${exc.message}`;
    throw exc;
  }
}

export function install_workflow_tool(host: any): void {
  /** Extend the s15 host tool pool without changing its dispatch loop. */
  RUNNER_FACTORY = () => new AnthropicAgentRunner(host.client, host.MODEL);
  if (host._workflow_tool_installed) return;
  const base_assemble = host.assemble_tool_pool.bind(host);

  function assemble_with_workflow(): [any[], Record<string, any>] {
    const assembled = base_assemble();
    const tools = assembled[0];
    const handlers = assembled[1];
    if (!tools.some((tool: any) => tool?.["name"] === "Workflow")) {
      tools.push(WORKFLOW_TOOL);
    }
    handlers["Workflow"] = run_workflow_sync;
    return [tools, handlers];
  }

  host.assemble_tool_pool = assemble_with_workflow;
  host._workflow_tool_installed = true;
}

export async function load_integrated_host(): Promise<any> {
  /** Load s15 lazily so deterministic workflow tests need no API key. */
  const loaded = await import("../s15_integrated_harness/code.ts");
  if (loaded == null || loaded.host == null) {
    throw new Error("unable to load integrated host from ../s15_integrated_harness/code.ts");
  }
  return loaded.host;
}


// -- CLI --
export async function run_demo(argv: string[]): Promise<void> {
  let resume_id: string | null = null;
  if (argv.length && argv[0] === "resume") {
    resume_id = _read_last_run();
    if (!resume_id) {
      console.log("nothing to resume; run `npx tsx code.ts demo` first.");
      return;
    }
    console.log(`resuming ${resume_id}; unchanged agent() calls use the journal cache\n`);
  } else {
    console.log("launching workflow `review-changes`\n");
  }

  const out = await WORKFLOW_HANDLERS["Workflow"](
    "review-changes",
    { "budget": null, "changes": DEMO_CHANGES },
    resume_id,
  );

  console.log("\nresult:");
  for (const f of out["result"]?.["confirmed"] ?? []) {
    console.log(`  [${String(f["severity"]).padEnd(6)}] ${f["dimension"]}: ${f["title"]}`);
  }
  const task = out["task"];
  const usage = task["usage"];
  console.log(
    `\nstatus=${task["status"]}  agents=${usage["agents"]}  ` +
    `tokens=${usage["tokens"]}  journal=.runtime/${task["runId"]}.journal.jsonl`,
  );
}

export const PROMPT = "\x1b[36ms16 >> \x1b[0m";
// \001/\002 tell Readline the ANSI escapes have zero display width.
export const READLINE_PROMPT = "\x01\x1b[36m\x02s16 >> \x01\x1b[0m\x02";

async function with_agent_lock(host: any, body: () => Promise<void>): Promise<void> {
  const lock = host.agent_lock;
  if (lock && typeof lock.acquire === "function") {
    await lock.acquire();
    try {
      await body();
    } finally {
      if (typeof lock.release === "function") lock.release();
    }
    return;
  }
  if (typeof lock === "function") {
    await lock(body);
    return;
  }
  await body();
}

export async function run_cli(): Promise<void> {
  /** Run the cumulative s15 host with Workflow added to its tool pool. */
  const host = await load_integrated_host();
  install_workflow_tool(host);
  host.CONSOLE.set_prompt(PROMPT, READLINE_PROMPT);
  host.CLI_ACTIVE = true;
  await host.start_runtime_services();
  console.log("s16: workflow runtime");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");
  const history: any[] = [];
  let context = await host.update_context({}, history);
  const session_state: Record<string, any> = { "active_user_request": "(no active user request)" };
  void Promise.resolve(host.async_event_loop(history, context, session_state));
  while (true) {
    let query: string;
    try {
      query = await host.CONSOLE.ask();
    } catch {
      break;
    }
    if (["q", "exit", ""].includes(query.trim().toLowerCase())) break;
    await with_agent_lock(host, async () => {
      await host.trigger_hooks("UserPromptSubmit", query);
      const turn_start = history.length;
      session_state["active_user_request"] = query;
      history.push({"role": "user", "content": query});
      await host.agent_loop(history, context, query);
      context = await host.update_context(context, history);
      await host.print_turn_assistants(history, turn_start);
    });
    console.log();
  }
}

const isMain = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.length && (argv[0] === "demo" || argv[0] === "resume")) {
    void run_demo(argv);
  } else {
    void run_cli().then(() => {
      process.exit(0);
    });
  }
}
