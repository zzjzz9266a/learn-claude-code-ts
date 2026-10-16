/**
 * s04_hooks/code.ts - Hooks
 *
 * Hooks run callbacks at fixed points in the agent loop:
 *
 *     User prompt
 *          |
 *          v
 *     UserPromptSubmit
 *          |
 *          v
 *     +----------+      +-------+      +------------+      +-------+
 *     | messages | ---> |  LLM  | ---> | PreToolUse | ---> | Tool  |
 *     +----------+      +---+---+      | permission |      +---+---+
 *          ^                | stop     | log        |          |
 *          |                v          +------------+          v
 *          |            Stop hook                         PostToolUse
 *          |                                               |
 *          +---------------- tool_result ------------------+
 */

import { spawnSync } from "node:child_process";
import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import Anthropic from "@anthropic-ai/sdk";
import { config as loadDotenv } from "dotenv";

loadDotenv({ override: true });
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

export const WORKDIR = process.cwd();
export const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const modelId = process.env.MODEL_ID;
if (!modelId) throw new Error("MODEL_ID is required");
export const MODEL: string = modelId;

export const ENVIRONMENT_PROMPT =
  process.platform === "win32"
    ? "Windows: the bash tool runs through cmd.exe; use cmd.exe syntax, not Unix Bash or PowerShell syntax, and prefer dedicated file tools for file operations"
    : "Unix-like: the bash tool runs the system shell";
export const SYSTEM = (
  `You are a coding agent at ${WORKDIR}. Environment: ${ENVIRONMENT_PROMPT}. ` +
  "Use tools to solve tasks. Act, don't explain."
);


// -- From s02-s03: tool implementations --

export function run_bash(command: string): string {
  try {
    const r = spawnSync(command, {
      shell: true,
      cwd: WORKDIR,
      encoding: "utf8",
      timeout: 120000,
    });
    if (r.error) {
      throw r.error;
    }
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    return out ? out.slice(0, 50000) : "(no output)";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return "Error: Timeout (120s)";
    }
    throw e;
  }
}

export function run_read(path: string, limit: number | null = null): string {
  function split_lines(text: string): string[] {
    if (text === "") return [];
    const lines = text.split(/\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]/);
    if (/[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]$/.test(text)) {
      lines.pop();
    }
    return lines;
  }
  try {
    const file_path = resolve(WORKDIR, path);
    let lines = split_lines(readFileSync(file_path, "utf-8"));
    if (limit && limit < lines.length) {
      lines = lines.slice(0, limit).concat([`... (${lines.length - limit} more lines)`]);
    }
    return lines.join("\n");
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : e}`;
  }
}

export function run_write(path: string, content: string): string {
  try {
    const file_path = resolve(WORKDIR, path);
    mkdirSync(dirname(file_path), { recursive: true });
    writeFileSync(file_path, content, "utf-8");
    return `Wrote ${content.length} bytes to ${path}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : e}`;
  }
}

export function run_edit(path: string, old_text: string, new_text: string): string {
  try {
    const file_path = resolve(WORKDIR, path);
    const text = readFileSync(file_path, "utf-8");
    if (!text.includes(old_text)) {
      return `Error: text not found in ${path}`;
    }
    writeFileSync(file_path, text.replace(old_text, () => new_text), "utf-8");
    return `Edited ${path}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : e}`;
  }
}

export function run_glob(pattern: string): string {
  try {
    const matches = [...new Set(
      globSync(pattern, { cwd: WORKDIR }).filter((match) => {
        const rel = relative(WORKDIR, resolve(WORKDIR, match));
        return !rel.startsWith("..") && !isAbsolute(rel);
      }),
    )].sort();
    const shown = matches.slice(0, 200);
    if (matches.length > 200) {
      shown.push("... (more matches omitted; narrow the pattern)");
    }
    return shown.length ? shown.join("\n") : "(no matches)";
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : e}`;
  }
}

export const TOOLS: any[] = [
  {"name": "bash", "description": "Run a shell command.",
   "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}},
  {"name": "read_file", "description": "Read file contents.",
   "input_schema": {"type": "object", "properties": {"path": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["path"]}},
  {"name": "write_file", "description": "Write content to a file.",
   "input_schema": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}},
  {"name": "edit_file", "description": "Replace exact text in a file once.",
   "input_schema": {"type": "object", "properties": {"path": {"type": "string"}, "old_text": {"type": "string"}, "new_text": {"type": "string"}}, "required": ["path", "old_text", "new_text"]}},
  {"name": "glob", "description": "Find files matching a glob pattern; ** matches recursively.",
   "input_schema": {"type": "object", "properties": {"pattern": {"type": "string"}}, "required": ["pattern"]}},
];

export const TOOL_HANDLERS: Record<string, (input: any) => string> = {
  "bash": (input: any) => run_bash(input["command"]),
  "read_file": (input: any) => run_read(input["path"], input["limit"] ?? null),
  "write_file": (input: any) => run_write(input["path"], input["content"]),
  "edit_file": (input: any) => run_edit(input["path"], input["old_text"], input["new_text"]),
  "glob": (input: any) => run_glob(input["pattern"]),
};


// -- New in s04: hook system (s03 permission logic now uses hooks) --

export const HOOKS: Record<string, Array<(...args: any[]) => any>> = {
  "UserPromptSubmit": [],
  "PreToolUse": [],
  "PostToolUse": [],
  "Stop": [],
};

export function register_hook(event: string, callback: (...args: any[]) => any): void {
  HOOKS[event].push(callback);
}

export async function trigger_hooks(event: string, ...args: any[]): Promise<any> {
  for (const callback of HOOKS[event]) {
    const result = await callback(...args);
    if (result != null) { // A hook result blocks this tool call.
      return result;
    }
  }
  return null;
}


// s03 permission check logic, now wrapped as a hook
export const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="];
export const DESTRUCTIVE_COMMAND_WORD = new RegExp(
  "(?:^|[;&|()\\n])\\s*(?:rm|del)(?=\\s|$|[;&|()])",
  "i",
);
export const DESTRUCTIVE = ["rm ", "> /etc/", "chmod 777"];


export function contains_destructive_command(command: string): boolean {
  return Boolean(DESTRUCTIVE_COMMAND_WORD.test(command));
}


export function py_repr(value: any): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "string") {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => py_repr(item)).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value).map(([key, item]) => `${py_repr(key)}: ${py_repr(item)}`).join(", ")}}`;
  }
  return String(value);
}


let rl: Interface | undefined;
let pendingAbort: AbortController | undefined;

export function get_rl(): Interface {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on("SIGINT", () => {
      pendingAbort?.abort();
    });
    rl.on("close", () => {
      pendingAbort?.abort();
    });
  }
  return rl;
}

export async function input(prompt: string): Promise<string> {
  const ac = new AbortController();
  pendingAbort = ac;
  try {
    return await get_rl().question(prompt, { signal: ac.signal });
  } finally {
    if (pendingAbort === ac) {
      pendingAbort = undefined;
    }
  }
}

export function close_input(): void {
  rl?.close();
  rl = undefined;
}


export async function permission_hook(block: any): Promise<string | null> {
  // PreToolUse: s03 check_permission() logic moved here.
  if (block.name === "bash") {
    const command = block.input["command"] ?? "";
    for (const pattern of DENY_LIST) {
      if (command.includes(pattern)) {
        console.log(`\n\x1b[31m[blocked] '${pattern}'\x1b[0m`);
        return "Permission denied by deny list";
      }
    }
    if (contains_destructive_command(command) || DESTRUCTIVE.some((kw) => command.includes(kw))) {
      console.log(`\n\x1b[33m[permission] Potentially destructive command\x1b[0m`);
      console.log(`   Tool: ${block.name}(${py_repr(block.input)})`);
      const choice = (await input("   Allow? [y/N] ")).trim().toLowerCase();
      if (!["y", "yes"].includes(choice)) {
        return "Permission denied by user";
      }
    }
  }
  if (["read_file", "write_file", "edit_file"].includes(block.name)) {
    const path = block.input["path"] ?? "";
    const rel = relative(WORKDIR, resolve(WORKDIR, path));
    if (rel.startsWith("..") || isAbsolute(rel)) {
      console.log(`\n\x1b[33m[permission] Access outside workspace\x1b[0m`);
      console.log(`   Tool: ${block.name}(${py_repr(block.input)})`);
      const choice = (await input("   Allow? [y/N] ")).trim().toLowerCase();
      if (!["y", "yes"].includes(choice)) {
        return "Permission denied by user";
      }
    }
  }
  return null;
}

export function log_hook(block: any): null {
  // PreToolUse: log every tool call.
  const args_preview = py_repr(Object.values(block.input).slice(0, 2)).slice(0, 60);
  console.log(`\x1b[90m[HOOK] ${block.name}(${args_preview})\x1b[0m`);
  return null;
}

export function large_output_hook(block: any, output: any): null {
  // PostToolUse: warn on large output.
  if (String(output).length > 100000) {
    console.log(`\x1b[33m[HOOK] Large output from ${block.name}: ${String(output).length} chars\x1b[0m`);
  }
  return null;
}

// UserPromptSubmit hook: log user input before it reaches the LLM
export function context_inject_hook(query: string): null {
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${WORKDIR}\x1b[0m`);
  return null;
}

// Stop hook: print summary when loop is about to exit
export function summary_hook(messages: any[]): null {
  let tool_count = 0;
  for (const m of messages) {
    const content = m["content"];
    const blocks = Array.isArray(content) ? content : [];
    for (const b of blocks) {
      if (b !== null && typeof b === "object" && !Array.isArray(b) && b["type"] === "tool_result") {
        tool_count += 1;
      }
    }
  }
  console.log(`\x1b[90m[HOOK] Stop: session used ${tool_count} tool calls\x1b[0m`);
  return null;
}

register_hook("UserPromptSubmit", context_inject_hook);
register_hook("PreToolUse", permission_hook);
register_hook("PreToolUse", log_hook);
register_hook("PostToolUse", large_output_hook);
register_hook("Stop", summary_hook);


// -- Agent loop: same structure as s03, but no hard-coded check --
// s03: if (!(await check_permission(block))) { ... }
// s04: if (await trigger_hooks("PreToolUse", block)) { ... }

export async function agent_loop(messages: any[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL, system: SYSTEM, messages: messages,
      tools: TOOLS, max_tokens: 8000,
    });
    messages.push({"role": "assistant", "content": response.content});

    const tool_calls: any[] = response.content.filter((block: any) => block.type === "tool_use");
    if (tool_calls.length === 0) {
      const force = await trigger_hooks("Stop", messages);
      if (force) {
        messages.push({"role": "user", "content": force});
        continue;
      }
      return;
    }

    const results: any[] = [];
    for (const block of tool_calls) {
      // s04 change: hook replaces hard-coded check_permission()
      const blocked = await trigger_hooks("PreToolUse", block);
      if (blocked) {
        results.push({"type": "tool_result", "tool_use_id": block.id,
                      "content": String(blocked)});
        continue;
      }

      const handler = TOOL_HANDLERS[block.name];
      const output = handler ? handler(block.input) : `Unknown: ${block.name}`;

      await trigger_hooks("PostToolUse", block, output); // s04: post hook

      results.push({"type": "tool_result", "tool_use_id": block.id, "content": output});
    }

    messages.push({"role": "user", "content": results});
  }
}


export async function main(): Promise<void> {
  console.log("s04: Hooks - extension logic on hooks, loop stays clean");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const history: any[] = [];
  try {
    while (true) {
      let query: string;
      try {
        // Prompt shows the visible ANSI text; Node readline has no libedit width markers.
        query = await input("\x1b[36ms04 >> \x1b[0m");
      } catch {
        break;
      }
      if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
        break;
      }
      await trigger_hooks("UserPromptSubmit", query);
      history.push({"role": "user", "content": query});
      await agent_loop(history);
      for (const block of history[history.length - 1]["content"]) {
        if (block?.type === "text") {
          console.log(block.text);
        }
      }
      console.log();
    }
  } finally {
    close_input();
  }
}

const isMain = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
if (isMain) {
  void main();
}
