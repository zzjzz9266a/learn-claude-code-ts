/**
 * s03_permission/code.ts - Permission System
 *
 * Three gates inserted before tool execution:
 *
 *     Gate 1: Hard deny list (rm -rf /, sudo, ...)
 *     Gate 2: Rule matching (write outside workspace? destructive cmd?)
 *     Gate 3: User approval (pause and wait for confirmation)
 *
 *     +----------+      +-------+      +--------------+      +---------------+
 *     |   User   | ---> |  LLM  | ---> | Permission   | ---> | Tool Dispatch |
 *     |  prompt  |      |       |      | 1. deny list |      | execute       |
 *     +----------+      +---+---+      | 2. rules     |      +-------+-------+
 *                           ^          | 3. approval  |              |
 *                           |          +------+-------+              |
 *                           |                 | deny                 |
 *                           |                 v                      v
 *                           |          +-------------------------------+
 *                           +----------+ tool_result: denied or output |
 *                                      +-------------------------------+
 *
 * Only one line added to the agent loop:
 *
 *     if (!(await check_permission(block))) {
 *         continue
 *     }
 *
 * Builds on s02 (multi-tool). Usage:
 *
 *     npx tsx s03_permission/code.ts
 *     Needs: pip install anthropic python-dotenv + ANTHROPIC_API_KEY in .env
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
  "All destructive operations require user approval."
);


// -- From s02: tool implementations --

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
    let lines = split_lines(readFileSync(resolve(WORKDIR, path), "utf-8"));
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


// -- From s02 (unchanged): tool definitions and dispatch --

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


// -- New in s03: three-gate permission pipeline --

// Gate 1: Hard deny list - always forbidden
export const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda"];

export function check_deny_list(command: string): string | null {
  for (const pattern of DENY_LIST) {
    if (command.includes(pattern)) {
      return `Blocked: '${pattern}' is on the deny list`;
    }
  }
  return null;
}


// Gate 2: Rule matching - context-dependent checks
export const DESTRUCTIVE_COMMAND_WORD = new RegExp(
  "(?:^|[;&|()\\n])\\s*(?:rm|del)(?=\\s|$|[;&|()])",
  "i",
);


export function contains_destructive_command(command: string): boolean {
  return Boolean(DESTRUCTIVE_COMMAND_WORD.test(command));
}


export const PERMISSION_RULES: Array<{
  tools: string[];
  check: (args: any) => boolean;
  message: string;
}> = [
  {"tools": ["read_file", "write_file", "edit_file"],
   "check": (args: any) => {
     const rel = relative(WORKDIR, resolve(WORKDIR, args["path"] ?? ""));
     return rel.startsWith("..") || isAbsolute(rel);
   },
   "message": "Writing outside workspace"},
  {"tools": ["bash"],
   "check": (args: any) => contains_destructive_command(args["command"] ?? "") ||
     ["rm ", "> /etc/", "chmod 777"].some((kw) => (args["command"] ?? "").includes(kw)),
   "message": "Potentially destructive command"},
];

export function check_rules(tool_name: string, args: any): string | null {
  for (const rule of PERMISSION_RULES) {
    if (rule["tools"].includes(tool_name) && rule["check"](args)) {
      return rule["message"];
    }
  }
  return null;
}


// Python dict/list display, so approval prompts keep the same text.
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


// Gate 3: User approval - wait for confirmation after rule match
export async function ask_user(tool_name: string, args: any, reason: string): Promise<string> {
  console.log(`\n\x1b[33m[permission] ${reason}\x1b[0m`);
  console.log(`   Tool: ${tool_name}(${py_repr(args)})`);
  const choice = (await input("   Allow? [y/N] ")).trim().toLowerCase();
  return ["y", "yes"].includes(choice) ? "allow" : "deny";
}


// Pipeline: all three gates chained
export async function check_permission(block: any): Promise<boolean> {
  if (block.name === "bash") {
    const reason = check_deny_list(block.input["command"] ?? "");
    if (reason) {
      console.log(`\n\x1b[31m[blocked] ${reason}\x1b[0m`);
      return false;
    }
  }
  const reason = check_rules(block.name, block.input);
  if (reason) {
    const decision = await ask_user(block.name, block.input, reason);
    if (decision === "deny") {
      return false;
    }
  }
  return true;
}


// -- Agent loop: same as s02, with check_permission() inserted --

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
      console.log(`\x1b[36m> ${block.name}\x1b[0m`);

      // s03 change: run through permission pipeline before executing
      if (!(await check_permission(block))) {
        results.push({"type": "tool_result", "tool_use_id": block.id,
                      "content": "Permission denied."});
        continue;
      }

      const handler = TOOL_HANDLERS[block.name];
      const output = handler ? handler(block.input) : `Unknown: ${block.name}`;
      console.log(String(output).slice(0, 200));
      results.push({"type": "tool_result", "tool_use_id": block.id, "content": output});
    }

    messages.push({"role": "user", "content": results});
  }
}


export async function main(): Promise<void> {
  console.log("s03: Permission");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const history: any[] = [];
  try {
    while (true) {
      let query: string;
      try {
        // Prompt shows the visible ANSI text; Node readline has no libedit width markers.
        query = await input("\x1b[36ms03 >> \x1b[0m");
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
