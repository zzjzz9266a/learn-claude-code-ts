/**
 * s02_tool_use/code.ts - Tools
 *
 * The agent loop from s01 does not change. This lesson adds four tools
 * and a dispatch map:
 *
 *     +----------+      +-------+      +--------------------------+
 *     |   User   | ---> |  LLM  | ---> | Tool Dispatch            |
 *     |  prompt  |      |       |      | bash       -> run_bash   |
 *     +----------+      +---+---+      | read_file  -> run_read   |
 *                           ^          | write_file -> run_write  |
 *                           |          | edit_file  -> run_edit   |
 *                           +----------+ glob       -> run_glob   |
 *                           tool_result+--------------------------+
 *
 *   + run_read / run_write / run_edit / run_glob
 *   + TOOL_HANDLERS instead of a hard-coded run_bash call
 *   + safe_path to keep file tools inside the workspace
 *
 * Key insight: the loop stays the same; only tool registration and dispatch grow.
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


// -- From s01 (unchanged) --

export function run_bash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
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
    return `Error: ${e instanceof Error ? e.message : e}`;
  }
}


// -- New in s02: four tools --

export function safe_path(p: string): string {
  const path = resolve(WORKDIR, p);
  const rel = relative(WORKDIR, path);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return path;
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
    let lines = split_lines(readFileSync(safe_path(path), "utf-8"));
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
    const file_path = safe_path(path);
    mkdirSync(dirname(file_path), { recursive: true });
    writeFileSync(file_path, content, "utf-8");
    return `Wrote ${content.length} bytes to ${path}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : e}`;
  }
}


export function run_edit(path: string, old_text: string, new_text: string): string {
  try {
    const file_path = safe_path(path);
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


// -- New in s02: tool definitions (one tool in s01, five in s02) --

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

// -- New in s02: dispatch map (replaces s01's hard-coded run_bash call) --
// JS has no keyword-argument spread, so each handler takes the tool input object.

export const TOOL_HANDLERS: Record<string, (input: any) => string> = {
  "bash": (input: any) => run_bash(input["command"]),
  "read_file": (input: any) => run_read(input["path"], input["limit"] ?? null),
  "write_file": (input: any) => run_write(input["path"], input["content"]),
  "edit_file": (input: any) => run_edit(input["path"], input["old_text"], input["new_text"]),
  "glob": (input: any) => run_glob(input["pattern"]),
};


// -- The agent loop keeps the same shape as s01; only dispatch changes --
// s01: output = run_bash(block.input["command"])
// s02: output = TOOL_HANDLERS[block.name](block.input)

export async function agent_loop(messages: any[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL, system: SYSTEM, messages: messages,
      tools: TOOLS, max_tokens: 8000,
    });
    messages.push({"role": "assistant", "content": response.content});

    const tool_calls: any[] = response.content.filter((block: any) => block.type === "tool_use");
    if (tool_calls.length === 0) {
      return;
    }

    const results: any[] = [];
    for (const block of tool_calls) {
      console.log(`\x1b[33m> ${block.name}\x1b[0m`);
      const handler = TOOL_HANDLERS[block.name];
      const output = handler ? handler(block.input) : `Unknown: ${block.name}`;
      console.log(String(output).slice(0, 200));
      results.push({"type": "tool_result", "tool_use_id": block.id, "content": output});
    }

    messages.push({"role": "user", "content": results});
  }
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


export async function main(): Promise<void> {
  console.log("s02: Tool Use - four tools added to s01");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const history: any[] = [];
  try {
    while (true) {
      let query: string;
      try {
        // Prompt shows the visible ANSI text; Node readline has no libedit width markers.
        query = await input("\x1b[36ms02 >> \x1b[0m");
      } catch {
        break;
      }
      if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
        break;
      }
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
