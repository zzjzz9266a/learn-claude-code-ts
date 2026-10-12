/**
 * s14: MCP Tools - discover external tools and add them to the agent loop.
 *
 * Run:  npx tsx s14_mcp_plugin/code.ts
 * Need: npm install @anthropic-ai/sdk dotenv + .env with ANTHROPIC_API_KEY
 *
 *     connect_mcp("docs")
 *               |
 *               v
 *     +------------------+     tools/list     +------------------+
 *     | Agent Harness    | <----------------- | MCP server       |
 *     |                  |                    | docs             |
 *     | built-in tools   |     tools/call     |                  |
 *     | + MCP tools      | -----------------> | search           |
 *     +--------+---------+                    | get_version      |
 *              |                              +------------------+
 *              v
 *     +-----------------------------------------------+
 *     | bash | read | write | edit | glob | connect  |
 *     | mcp__docs__search | mcp__docs__get_version   |
 *     +-----------------------------------------------+
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
export const BASE_SYSTEM = (
  `You are a coding agent at ${WORKDIR}. Environment: ${ENVIRONMENT_PROMPT}. ` +
  "Use built-in and connected MCP " +
  "tools to solve tasks. Call connect_mcp before using a server."
);


// -- From s04: base tools --

function split_lines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]/);
  if (/[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]$/.test(text)) {
    lines.pop();
  }
  return lines;
}

function count_substrings(text: string, needle: string): number {
  if (needle === "") return text.length + 1;
  let count = 0;
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

function inside_workdir(path: string): boolean {
  const rel = relative(resolve(WORKDIR), resolve(WORKDIR, path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function run_bash(command: string): string {
  try {
    const result = spawnSync(command, {
      shell: true,
      cwd: WORKDIR,
      encoding: "utf8",
      timeout: 120000,
    });
    if (result.error) {
      throw result.error;
    }
    const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    const output = raw ? raw.slice(0, 50000) : "(no output)";
    if (result.status) {
      return `Error: command exited with status ${result.status}\n${output}`;
    }
    if (result.signal) {
      return `Error: command exited with status ${result.signal}\n${output}`;
    }
    return output;
  } catch (exc) {
    const error = exc as NodeJS.ErrnoException;
    if (error.code === "ETIMEDOUT") {
      return "Error: Timeout (120s)";
    }
    return `Error: ${error.name}: ${error.message}`;
  }
}

export function run_read(path: string, limit: number | null = null): string {
  try {
    let lines = split_lines(readFileSync(resolve(WORKDIR, path), "utf-8"));
    if (limit && limit < lines.length) {
      const omitted = lines.length - limit;
      lines = lines.slice(0, limit).concat([`... (${omitted} more lines)`]);
    }
    return lines.join("\n");
  } catch (exc) {
    return `Error: ${exc instanceof Error ? exc.message : exc}`;
  }
}

export function run_write(path: string, content: string): string {
  try {
    const target = resolve(WORKDIR, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf-8");
    return `Wrote ${content.length} bytes to ${path}`;
  } catch (exc) {
    return `Error: ${exc instanceof Error ? exc.message : exc}`;
  }
}

export function run_edit(path: string, old_text: string, new_text: string): string {
  try {
    const target = resolve(WORKDIR, path);
    const content = readFileSync(target, "utf-8");
    const count = count_substrings(content, old_text);
    if (count !== 1) {
      return `Error: Expected 1 occurrence, found ${count}`;
    }
    writeFileSync(target, content.replace(old_text, () => new_text), "utf-8");
    return `Edited ${path}`;
  } catch (exc) {
    return `Error: ${exc instanceof Error ? exc.message : exc}`;
  }
}

export function run_glob(pattern: string): string {
  try {
    const matches = [...new Set(
      globSync(pattern, { cwd: WORKDIR }).filter((match) => inside_workdir(match)),
    )].sort();
    const shown = matches.slice(0, 200);
    if (matches.length > 200) {
      shown.push("... (more matches omitted; narrow the pattern)");
    }
    return shown.length ? shown.join("\n") : "(no matches)";
  } catch (exc) {
    return `Error: ${exc instanceof Error ? exc.message : exc}`;
  }
}

export const BASE_TOOLS: any[] = [
  {"name": "bash", "description": "Run a shell command.",
   "input_schema": {"type": "object",
                    "properties": {"command": {"type": "string"}},
                    "required": ["command"]}},
  {"name": "read_file", "description": "Read file contents.",
   "input_schema": {"type": "object",
                    "properties": {"path": {"type": "string"},
                                   "limit": {"type": "integer"}},
                    "required": ["path"]}},
  {"name": "write_file", "description": "Write content to a file.",
   "input_schema": {"type": "object",
                    "properties": {"path": {"type": "string"},
                                   "content": {"type": "string"}},
                    "required": ["path", "content"]}},
  {"name": "edit_file", "description": "Replace exact text once.",
   "input_schema": {"type": "object",
                    "properties": {"path": {"type": "string"},
                                   "old_text": {"type": "string"},
                                   "new_text": {"type": "string"}},
                    "required": ["path", "old_text", "new_text"]}},
  {"name": "glob", "description": "Find files by glob pattern; ** matches recursively.",
   "input_schema": {"type": "object",
                    "properties": {"pattern": {"type": "string"}},
                    "required": ["pattern"]}},
];

export const BASE_HANDLERS: Record<string, (input: any) => string> = {
  "bash": (input: any) => run_bash(input["command"]),
  "read_file": (input: any) => run_read(input["path"], input["limit"] ?? null),
  "write_file": (input: any) => run_write(input["path"], input["content"]),
  "edit_file": (input: any) => run_edit(input["path"], input["old_text"], input["new_text"]),
  "glob": (input: any) => run_glob(input["pattern"]),
};


// -- New in s14: MCP discovery and dispatch --

export class MCPClient {
  /** Small in-process stand-in for MCP tools/list and tools/call. */
  name: string;
  tools: any[] = [];
  _handlers: Record<string, (args: any) => any> = {};

  constructor(name: string) {
    this.name = name;
  }

  register(tool_defs: any[], handlers: Record<string, (args: any) => any>): void {
    const names = tool_defs.map((tool) => tool["name"]);
    if (names.some((name) => typeof name !== "string" || !name)) {
      throw new Error("Every MCP tool needs a non-empty name");
    }
    if (new Set(names).size !== names.length) {
      throw new Error(`Duplicate MCP tool name on server '${this.name}'`);
    }
    const missing = names.filter((name) => !(name in handlers));
    if (missing.length) {
      throw new Error(`Missing MCP handlers: ${missing.join(", ")}`);
    }
    this.tools = [...tool_defs];
    this._handlers = { ...handlers };
  }

  call_tool(tool_name: string, args: Record<string, any>): string {
    const handler = this._handlers[tool_name];
    if (!handler) {
      return `MCP error: unknown tool '${tool_name}'`;
    }
    try {
      return String(handler(args));
    } catch (exc) {
      const error = exc as Error;
      return `MCP error: ${error.name}: ${error.message}`;
    }
  }
}

export const mcp_clients: Record<string, MCPClient> = {};
export let mcp_tool_policies: Record<string, string> = {};

// Authorization comes from host configuration, never server descriptions.
export const MCP_HOST_POLICY: Record<string, Record<string, string>> = {
  docs: {
    search: "allow",
    get_version: "allow",
  },
  deploy: {
    status: "allow",
    trigger: "confirm",
  },
};

export function normalize_mcp_name(name: string): string {
  /** Replace characters outside the model tool-name alphabet. */
  const normalized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!normalized) {
    throw new Error("MCP names cannot normalize to an empty string");
  }
  return normalized;
}

export function _mock_server_docs(): MCPClient {
  const server = new MCPClient("docs");
  server.register(
    [
      {
        "name": "search",
        "description": "Search the documentation.",
        "inputSchema": {
          "type": "object",
          "properties": {"query": {"type": "string"}},
          "required": ["query"],
        },
        "annotations": {"readOnlyHint": true},
      },
      {
        "name": "get_version",
        "description": "Get the documentation API version.",
        "inputSchema": {"type": "object", "properties": {}},
        "annotations": {"readOnlyHint": true},
      },
    ],
    {
      "search": (args: any) => `[docs] Found 3 results for '${args["query"]}'`,
      "get_version": () => "[docs] API v2.1.0",
    },
  );
  return server;
}

export function _mock_server_deploy(): MCPClient {
  const server = new MCPClient("deploy");
  server.register(
    [
      {
        "name": "trigger",
        "description": "Trigger a deployment.",
        "inputSchema": {
          "type": "object",
          "properties": {"service": {"type": "string"}},
          "required": ["service"],
        },
        "annotations": {"destructiveHint": true},
      },
      {
        "name": "status",
        "description": "Check deployment status.",
        "inputSchema": {
          "type": "object",
          "properties": {"service": {"type": "string"}},
          "required": ["service"],
        },
        "annotations": {"readOnlyHint": true},
      },
    ],
    {
      "trigger": (args: any) => `[deploy] Triggered: ${args["service"]}`,
      "status": (args: any) => `[deploy] ${args["service"]}: running (v1.4.2)`,
    },
  );
  return server;
}

export const MOCK_SERVERS: Record<string, () => MCPClient> = {
  "docs": _mock_server_docs,
  "deploy": _mock_server_deploy,
};

export function connect_mcp(name: string): string {
  if (name in mcp_clients) {
    return `MCP server '${name}' already connected`;
  }
  const factory = MOCK_SERVERS[name];
  if (!factory) {
    return `Unknown server '${name}'. Available: ${Object.keys(MOCK_SERVERS).join(", ")}`;
  }
  const server = factory();
  mcp_clients[name] = server;
  const names = server.tools.map((tool) => tool["name"]).join(", ");
  console.log(`  [mcp] connected: ${name} -> ${names}`);
  return (
    `Connected to MCP server '${name}'. ` +
    `Discovered ${server.tools.length} tools: ${names}`
  );
}

export function run_connect_mcp(name: string): string {
  return connect_mcp(name);
}

export const BUILTIN_TOOLS: any[] = [
  ...BASE_TOOLS,
  {"name": "connect_mcp",
   "description": "Connect to an MCP server and discover its tools.",
   "input_schema": {
     "type": "object",
     "properties": {"name": {"type": "string", "enum": ["docs", "deploy"]}},
     "required": ["name"],
   }},
];
export const CONNECT_TOOL = BUILTIN_TOOLS[BASE_TOOLS.length];
export const BUILTIN_HANDLERS: Record<string, (input: any) => string> = {
  ...BASE_HANDLERS,
  "connect_mcp": (input: any) => run_connect_mcp(input["name"]),
};

export function assemble_tool_pool(): [any[], Record<string, (input: any) => string>] {
  /** Combine built-in tools with every connected server tool. */
  const tools = [...BUILTIN_TOOLS];
  const handlers: Record<string, (input: any) => string> = { ...BUILTIN_HANDLERS };
  const policies: Record<string, string> = {};
  const origins: Record<string, string> = {};
  for (const tool of tools) {
    origins[tool["name"]] = `built-in tool '${tool["name"]}'`;
  }

  for (const [server_name, server] of Object.entries(mcp_clients)) {
    const safe_server = normalize_mcp_name(server_name);
    for (const tool_def of server.tools) {
      const raw_name = tool_def["name"];
      const safe_tool = normalize_mcp_name(raw_name);
      const prefixed = `mcp__${safe_server}__${safe_tool}`;
      if (prefixed.length > 64) {
        throw new Error(`MCP tool name is longer than 64 characters: ${prefixed}`);
      }
      const origin = `MCP tool '${server_name}'/'${raw_name}'`;
      if (prefixed in origins) {
        throw new Error(
          "MCP tool name collision after normalization: " +
          `'${prefixed}' maps both ${origins[prefixed]} and ${origin}`,
        );
      }
      const schema = tool_def["inputSchema"] ?? {};
      if (
        schema === null ||
        typeof schema !== "object" ||
        Array.isArray(schema) ||
        (schema["type"] ?? "object") !== "object"
      ) {
        throw new Error(`Invalid input schema for ${origin}`);
      }
      origins[prefixed] = origin;
      tools.push({
        "name": prefixed,
        "description": tool_def["description"] ?? "",
        "input_schema": schema,
      });
      const client = server;
      const tool = raw_name;
      handlers[prefixed] = (kwargs: any = {}) => client.call_tool(tool, kwargs);
      policies[prefixed] = MCP_HOST_POLICY[server_name]?.[raw_name] ?? "confirm";
    }
  }

  mcp_tool_policies = policies;
  return [tools, handlers];
}

export function assemble_system_prompt(): string {
  if (Object.keys(mcp_clients).length === 0) {
    return BASE_SYSTEM;
  }
  return BASE_SYSTEM + "\n\nConnected MCP servers: " + Object.keys(mcp_clients).join(", ");
}


// -- From s04: hooks and permission checks --

export const HOOKS: Record<string, Array<(...args: any[]) => any>> = {
  "UserPromptSubmit": [],
  "PreToolUse": [],
  "PostToolUse": [],
  "Stop": [],
};
export const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="];
export const DESTRUCTIVE_COMMAND_WORD = new RegExp(
  "(?:^|[;&|()\\n])\\s*(?:rm|del)(?=\\s|$|[;&|()])",
  "i",
);
export const DESTRUCTIVE = ["rm ", "> /etc/", "chmod 777"];

export function contains_destructive_command(command: string): boolean {
  return Boolean(DESTRUCTIVE_COMMAND_WORD.test(command));
}

export function register_hook(event: string, callback: (...args: any[]) => any): void {
  HOOKS[event].push(callback);
}

export async function trigger_hooks(event: string, ...args: any[]): Promise<any> {
  for (const callback of HOOKS[event]) {
    const result = await callback(...args);
    if (result != null) {
      return result;
    }
  }
  return null;
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
  if (block.name === "bash") {
    const command = block.input["command"] ?? "";
    for (const pattern of DENY_LIST) {
      if (command.includes(pattern)) {
        return `Permission denied by deny list: ${pattern}`;
      }
    }
    if (
      contains_destructive_command(command) ||
      DESTRUCTIVE.some((keyword) => command.includes(keyword))
    ) {
      console.log(`\n[permission] ${block.name}(${py_repr(block.input)})`);
      const choice = (await input("Allow? [y/N] ")).trim().toLowerCase();
      if (!["y", "yes"].includes(choice)) {
        return "Permission denied by user";
      }
    }
  }

  if (["read_file", "write_file", "edit_file"].includes(block.name)) {
    const raw_path = block.input["path"] ?? "";
    if (!inside_workdir(raw_path)) {
      console.log(`\n[permission] ${block.name}(${py_repr(block.input)})`);
      const choice = (await input("Allow? [y/N] ")).trim().toLowerCase();
      if (!["y", "yes"].includes(choice)) {
        return "Permission denied by user";
      }
    }
  }

  if (String(block.name).startsWith("mcp__")) {
    const policy = mcp_tool_policies[block.name] ?? "confirm";
    if (policy !== "allow") {
      console.log(`\n[permission] External tool ${block.name}(${py_repr(block.input)})`);
      const choice = (await input("Allow? [y/N] ")).trim().toLowerCase();
      if (!["y", "yes"].includes(choice)) {
        return "Permission denied by user";
      }
    }
  }
  return null;
}

export function log_hook(block: any): null {
  const preview = py_repr(Object.values(block.input).slice(0, 2)).slice(0, 60);
  console.log(`[hook] ${block.name}(${preview})`);
  return null;
}

export function large_output_hook(block: any, output: any): null {
  if (String(output).length > 100000) {
    console.log(`[hook] Large output from ${block.name}: ${String(output).length} chars`);
  }
  return null;
}

export function context_hook(query: string): null {
  console.log(`[hook] UserPromptSubmit: working in ${WORKDIR}`);
  return null;
}

export function summary_hook(messages: any[]): null {
  let tool_count = 0;
  for (const message of messages) {
    const content = message["content"];
    const blocks = Array.isArray(content) ? content : [];
    for (const block of blocks) {
      if (block !== null && typeof block === "object" && !Array.isArray(block) && block["type"] === "tool_result") {
        tool_count += 1;
      }
    }
  }
  console.log(`[hook] Stop: session used ${tool_count} tool calls`);
  return null;
}

register_hook("UserPromptSubmit", context_hook);
register_hook("PreToolUse", permission_hook);
register_hook("PreToolUse", log_hook);
register_hook("PostToolUse", large_output_hook);
register_hook("Stop", summary_hook);

export async function execute_tool(block: any, handlers: Record<string, (input: any) => any>): Promise<string> {
  const blocked = await trigger_hooks("PreToolUse", block);
  if (blocked) {
    return String(blocked);
  }
  const handler = handlers[block.name];
  if (!handler) {
    return `Unknown tool: ${block.name}`;
  }
  let output: string;
  try {
    output = String(handler(block.input));
  } catch (exc) {
    const error = exc as Error;
    output = `Error: ${error.name}: ${error.message}`;
  }
  await trigger_hooks("PostToolUse", block, output);
  return output;
}


// -- Agent loop with a dynamic tool pool --

export async function agent_loop(messages: any[]): Promise<void> {
  while (true) {
    let tools: any[];
    let handlers: Record<string, (input: any) => any>;
    let response: any;
    try {
      [tools, handlers] = assemble_tool_pool();
      response = await client.messages.create({
        model: MODEL,
        system: assemble_system_prompt(),
        messages,
        tools,
        max_tokens: 8000,
      });
    } catch (exc) {
      const error = exc as Error;
      messages.push({
        "role": "assistant",
        "content": [{
          "type": "text",
          "text": `[Error] ${error.name}: ${error.message}`,
        }],
      });
      await trigger_hooks("Stop", messages);
      return;
    }

    messages.push({"role": "assistant", "content": response.content});
    const tool_calls = response.content.filter((block: any) => block.type === "tool_use");
    if (tool_calls.length === 0) {
      await trigger_hooks("Stop", messages);
      return;
    }

    const results: any[] = [];
    for (const block of tool_calls) {
      console.log(`> ${block.name}`);
      const output = await execute_tool(block, handlers);
      console.log(output.slice(0, 300));
      results.push({
        "type": "tool_result",
        "tool_use_id": block.id,
        "content": output,
      });
    }
    messages.push({"role": "user", "content": results});
  }
}

export async function main(): Promise<void> {
  console.log("s14: MCP tools");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");
  const history: any[] = [];

  try {
    while (true) {
      let query: string;
      try {
        // Prompt shows the visible ANSI text; Node readline has no libedit width markers.
        query = await input("\x1b[36ms14 >> \x1b[0m");
      } catch {
        break;
      }
      if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
        break;
      }
      await trigger_hooks("UserPromptSubmit", query);
      history.push({"role": "user", "content": query});
      await agent_loop(history);
      const content = history[history.length - 1]["content"];
      if (Array.isArray(content)) {
        for (const block of content) {
          const type = block?.type ?? block?.["type"];
          if (type === "text") {
            console.log(block.text ?? block["text"] ?? "");
          }
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
