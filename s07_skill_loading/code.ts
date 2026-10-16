/**
 * s07_skill_loading.ts - Skill Loading
 *
 * The system prompt contains a catalog of skill names and descriptions.
 * The model loads the full SKILL.md only when it calls load_skill.
 *
 *     skills/                    Startup
 *     +------------------+       +------------------+
 *     | code-review/     | ----> | SkillLoader      |
 *     |   SKILL.md       |       | name + summary   |
 *     | pdf/             |       +--------+---------+
 *     |   SKILL.md       |                |
 *     +------------------+                v
 *                                  system prompt catalog
 *
 *     LLM -- load_skill(name) --> full SKILL.md
 *      ^                              |
 *      +--------- tool_result --------+
 *
 * Run: npx tsx s07_skill_loading/code.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import Anthropic from "@anthropic-ai/sdk";
import { config as loadDotenv } from "dotenv";

loadDotenv({ override: true });
if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

export const WORKDIR = process.cwd();
export const SKILLS_DIR = resolve(WORKDIR, "skills");
export const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const modelId = process.env.MODEL_ID;
if (!modelId) {
  throw new Error("MODEL_ID is required");
}
export const MODEL = modelId;
export const ENVIRONMENT_PROMPT =
  process.platform === "win32"
    ? "Windows: the bash tool runs through cmd.exe; use cmd.exe syntax, not Unix " +
      "Bash or PowerShell syntax, and prefer dedicated file tools for file operations"
    : "Unix-like: the bash tool runs the system shell";

let rl: Interface | null = null;

function input(prompt = ""): Promise<string> {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
  }
  const reader = rl;
  return new Promise((resolve, reject) => {
    const onClose = () => reject(new Error("EOF"));
    reader.once("close", onClose);
    reader.question(prompt).then(
      (answer) => {
        reader.off("close", onClose);
        resolve(answer);
      },
      (error) => {
        reader.off("close", onClose);
        reject(error);
      },
    );
  });
}

class YamlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YamlError";
  }
}

function is_plain_object(value: any): boolean {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function is_relative_to(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return !rel.split(sep).includes("..");
}

function is_file(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function error_text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function py_repr(value: any): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return Object.is(value, -0) ? "-0.0" : String(value);
  if (typeof value === "string") {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (Array.isArray(value)) return `[${value.map(py_repr).join(", ")}]`;
  if (is_plain_object(value)) {
    const parts = Object.entries(value).map(([key, item]) => `${py_repr(key)}: ${py_repr(item)}`);
    return `{${parts.join(", ")}}`;
  }
  return String(value);
}

function py_str(value: any): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) || is_plain_object(value)) return py_repr(value);
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return Object.is(value, -0) ? "-0.0" : String(value);
  return String(value);
}

function splitlines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\r|\n|\v|\f|\u001c|\u001d|\u001e|\u0085|\u2028|\u2029/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function splitlines_keepends(text: string): string[] {
  if (text === "") return [];
  const lines: string[] = [];
  const re = /\r\n|\r|\n|\v|\f|\u001c|\u001d|\u001e|\u0085|\u2028|\u2029/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    const end = (match.index ?? 0) + match[0].length;
    lines.push(text.slice(last, end));
    last = end;
  }
  if (last < text.length) lines.push(text.slice(last));
  return lines;
}

function rstrip_crlf(line: string): string {
  return line.replace(/[\r\n]+$/, "");
}

function param_list(fn: Function): { name: string; required: boolean }[] {
  const src = fn.toString();
  const open = src.indexOf("(");
  if (open < 0) throw new TypeError(`Cannot parse parameters for ${fn.name}`);
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  const raw = src.slice(open + 1, close).trim();
  if (!raw) return [];
  return raw.split(",").map((part) => {
    const eq = part.indexOf("=");
    const name = (eq === -1 ? part : part.slice(0, eq)).trim();
    return { name, required: eq === -1 };
  });
}

async function call_kwargs(fn: Function, kwargs: any): Promise<any> {
  const params = param_list(fn);
  const known = new Set(params.map((param) => param.name));
  for (const key of Object.keys(kwargs ?? {})) {
    if (!known.has(key)) {
      throw new TypeError(`${fn.name || "function"}() got an unexpected keyword argument '${key}'`);
    }
  }
  for (const param of params) {
    if (param.required && (kwargs == null || !Object.prototype.hasOwnProperty.call(kwargs, param.name))) {
      throw new TypeError(`${fn.name || "function"}() missing 1 required positional argument: '${param.name}'`);
    }
  }
  return await fn(...params.map((param) => kwargs?.[param.name]));
}

function strip_inline_comment(text: string): string {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trim();
    }
  }
  return text.trim();
}

function parse_scalar(text: string): any {
  const value = strip_inline_comment(text);
  if (value === "" || value === "~" || value === "null" || value === "Null" || value === "NULL") return null;
  if (["true", "True", "TRUE", "yes", "Yes", "YES", "on", "On", "ON", "y", "Y"].includes(value)) return true;
  if (["false", "False", "FALSE", "no", "No", "NO", "off", "Off", "OFF", "n", "N"].includes(value)) return false;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return unquote(value);
  }
  if (/^[+-]?\d+$/.test(value)) return Number(value);
  if (/^[+-]?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || /^[+-]?\d+[eE][+-]?\d+$/.test(value)) {
    return Number(value);
  }
  return value;
}

function unquote(value: string): string {
  const quote = value[0];
  const body = value.slice(1, -1);
  if (quote === "'") return body.replace(/''/g, "'");
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      out += body[i];
      continue;
    }
    const next = body[++i];
    const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
    if (next === undefined) break;
    if (simple[next] !== undefined) out += simple[next];
    else if (next === "u") {
      out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16));
      i += 4;
    } else out += next;
  }
  return out;
}

function yaml_safe_load(source: string): any {
  const lines = splitlines(source);
  let i = 0;

  function blank(line: string): boolean {
    const trimmed = line.trim();
    return trimmed === "" || trimmed.startsWith("#");
  }

  function skip_blanks(): void {
    while (i < lines.length && blank(lines[i])) i++;
  }

  skip_blanks();
  if (i >= lines.length) return null;
  if (lines[i].startsWith("- ") || lines[i].trim() === "-") return parse_seq(0);
  if (lines[i].startsWith(" ") || lines[i].startsWith("\t")) throw new YamlError("bad indent");
  return parse_map(0);

  function parse_map(indent: number): Record<string, any> {
    const result: Record<string, any> = {};
    while (i < lines.length) {
      skip_blanks();
      if (i >= lines.length) break;
      const line = lines[i];
      const line_indent = line.match(/^ */)?.[0].length ?? 0;
      if (line_indent < indent) break;
      if (line_indent > indent) throw new YamlError("bad indent");
      if (line.trim().startsWith("- ")) break;
      const colon = line.indexOf(":");
      if (colon === -1) throw new YamlError("expected key");
      const key = line.slice(indent, colon).trim();
      if (!key) throw new YamlError("expected key");
      const rest = line.slice(colon + 1).trim();
      i++;
      if (rest === "|" || rest === "|-" || rest === "|+" || rest === ">" || rest === ">-" || rest === ">+") {
        result[key] = read_block(rest, indent);
      } else if (rest === "") {
        skip_blanks();
        if (i < lines.length) {
          const next_indent = lines[i].match(/^ */)?.[0].length ?? 0;
          const next = lines[i].trim();
          if (next_indent > indent && (next.startsWith("- ") || next === "-")) {
            result[key] = parse_seq(next_indent);
            continue;
          }
          if (next_indent > indent && next.includes(":")) {
            result[key] = parse_map(next_indent);
            continue;
          }
        }
        result[key] = null;
      } else {
        result[key] = parse_scalar(rest);
      }
    }
    return result;
  }

  function parse_seq(indent: number): any[] {
    const items: any[] = [];
    while (i < lines.length) {
      skip_blanks();
      if (i >= lines.length) break;
      const line = lines[i];
      const line_indent = line.match(/^ */)?.[0].length ?? 0;
      if (line_indent < indent) break;
      if (line_indent !== indent || !(line.trim().startsWith("- ") || line.trim() === "-")) break;
      const trimmed = line.trim();
      const rest = trimmed === "-" ? "" : trimmed.slice(2);
      i++;
      if (rest === "") {
        skip_blanks();
        if (i < lines.length && (lines[i].match(/^ */)?.[0].length ?? 0) > indent) {
          const next = lines[i].trim();
          const next_indent = lines[i].match(/^ */)?.[0].length ?? 0;
          items.push(next.startsWith("- ") || next === "-" ? parse_seq(next_indent) : parse_map(next_indent));
        } else {
          items.push(null);
        }
      } else if (rest.includes(":") && !rest.startsWith("'") && !rest.startsWith('"') && !rest.startsWith("|") && !rest.startsWith(">")) {
        const colon = rest.indexOf(":");
        const key = rest.slice(0, colon).trim();
        const value = rest.slice(colon + 1).trim();
        const item: Record<string, any> = {};
        if (value === "") item[key] = null;
        else item[key] = parse_scalar(value);
        items.push(item);
      } else {
        items.push(parse_scalar(rest));
      }
    }
    return items;
  }

  function read_block(header: string, parent_indent: number): string {
    const style = header[0];
    const chomp = header.length > 1 ? header[1] : "";
    const collected: string[] = [];
    let content_indent: number | null = null;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        collected.push("");
        i++;
        continue;
      }
      const indent = line.match(/^ */)?.[0].length ?? 0;
      if (indent <= parent_indent) break;
      if (content_indent === null) content_indent = indent;
      if (indent < content_indent) break;
      collected.push(line.slice(content_indent));
      i++;
    }
    while (collected.length > 0 && collected[0] === "") collected.shift();
    let trailing = 0;
    while (collected.length > 0 && collected[collected.length - 1] === "") {
      collected.pop();
      trailing++;
    }
    let text = style === "|" ? collected.join("\n") : fold_lines(collected);
    if (chomp === "-") return text;
    if (chomp === "+") return `${text}${text ? "\n" : ""}${"\n".repeat(trailing)}`;
    return text ? `${text}\n` : "";
  }
}

function fold_lines(lines: string[]): string {
  const parts: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) parts.push(buf.join(" "));
    buf = [];
  };
  for (const line of lines) {
    if (line === "") {
      flush();
      parts.push("");
    } else buf.push(line);
  }
  flush();
  return parts.join("\n");
}

// -- Skill catalog --

export class SkillLoader {
  skills_dir: string;
  skills: Record<string, { name: string; description: string; content: string }> = {};

  constructor(skills_dir: string) {
    this.skills_dir = skills_dir;
    this.skills = {};
    this.scan();
  }

  parse_frontmatter(text: string): [any, string] {
    const lines = splitlines_keepends(text);
    if (lines.length === 0 || rstrip_crlf(lines[0]) !== "---") {
      return [{}, text];
    }

    let closing_index: number | null = null;
    for (let index = 1; index < lines.length; index++) {
      if (rstrip_crlf(lines[index]) === "---") {
        closing_index = index;
        break;
      }
    }
    if (closing_index === null) {
      return [{}, text];
    }

    const frontmatter = lines.slice(1, closing_index).join("");
    const body = lines.slice(closing_index + 1).join("").trim();
    let metadata: any;
    try {
      metadata = yaml_safe_load(frontmatter) ?? {};
    } catch (e) {
      if (e instanceof YamlError) metadata = {};
      else throw e;
    }
    if (!is_plain_object(metadata)) {
      metadata = {};
    }
    return [metadata, body];
  }

  scan(): void {
    this.skills = {};
    if (!existsSync(this.skills_dir)) {
      return;
    }

    const skills_root = resolve(this.skills_dir);
    const manifests = [...globSync("*/SKILL.md", { cwd: this.skills_dir })].sort();
    for (const match of manifests) {
      const manifest = resolve(this.skills_dir, match);
      if (!is_file(manifest) || !is_relative_to(skills_root, resolve(manifest))) {
        continue;
      }
      const content = readFileSync(manifest, "utf8");
      const [metadata, body] = this.parse_frontmatter(content);
      const raw_name = metadata["name"];
      let name = typeof raw_name === "string" ? raw_name.trim() : "";
      name = name || basename(dirname(manifest));
      const raw_description = metadata["description"];
      let description = typeof raw_description === "string" ? raw_description.trim() : "";
      description = description || body.split("\n", 1)[0];
      description = py_str(description).replace(/^[# ]+/, "").split(/\s+/).filter((part) => part !== "").join(" ");
      this.skills[name] = {
        "name": name,
        "description": description,
        "content": content,
      };
    }
  }

  catalog(): string {
    const skills = Object.values(this.skills);
    if (skills.length === 0) {
      return "(no skills found)";
    }
    return skills.map((skill) => `- ${skill["name"]}: ${skill["description"]}`).join("\n");
  }

  load(name: string): string {
    const skill = this.skills[name];
    if (skill) {
      return skill["content"];
    }
    const available = Object.keys(this.skills).join(", ") || "none";
    return `Error: Unknown skill '${name}'. Available: ${available}`;
  }
}

export const SKILL_LOADER = new SkillLoader(SKILLS_DIR);

export function build_system_prompt(): string {
  return (
    `You are a coding agent at ${WORKDIR}. Environment: ${ENVIRONMENT_PROMPT}. ` +
    "Use tools to solve tasks. " +
    "Act, don't explain.\n\n" +
    `Skills available:\n${SKILL_LOADER.catalog()}\n\n` +
    "Use load_skill to read the full instructions when a skill applies."
  );
}

export const SYSTEM = build_system_prompt();

// -- Tools --

export function run_bash(command: string): string {
  const result = spawnSync(command, {
    shell: true,
    cwd: WORKDIR,
    encoding: "utf8",
    timeout: 120000,
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return "Error: Timeout (120s)";
    }
    throw result.error;
  }
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return output ? output.slice(0, 50000) : "(no output)";
}

export function run_read(path: string, limit: number | null = null): string {
  try {
    const lines = splitlines(readFileSync(resolve(WORKDIR, path), "utf8"));
    if (limit && limit < lines.length) {
      const omitted = lines.length - limit;
      lines.splice(limit, lines.length, `... (${omitted} more lines)`);
    }
    return lines.join("\n");
  } catch (e) {
    return `Error: ${error_text(e)}`;
  }
}

export function run_write(path: string, content: string): string {
  try {
    const file_path = resolve(WORKDIR, path);
    mkdirSync(dirname(file_path), { recursive: true });
    writeFileSync(file_path, content, "utf8");
    return `Wrote ${content.length} bytes to ${path}`;
  } catch (e) {
    return `Error: ${error_text(e)}`;
  }
}

export function run_edit(path: string, old_text: string, new_text: string): string {
  try {
    const file_path = resolve(WORKDIR, path);
    const text = readFileSync(file_path, "utf8");
    if (!text.includes(old_text)) {
      return `Error: text not found in ${path}`;
    }
    writeFileSync(file_path, text.replace(old_text, () => new_text), "utf8");
    return `Edited ${path}`;
  } catch (e) {
    return `Error: ${error_text(e)}`;
  }
}

export function run_glob(pattern: string): string {
  try {
    const matches = [...new Set(
      globSync(pattern, { cwd: WORKDIR }).filter((match) => is_relative_to(WORKDIR, resolve(WORKDIR, match))),
    )].sort();
    const shown = matches.slice(0, 200);
    if (matches.length > 200) {
      shown.push("... (more matches omitted; narrow the pattern)");
    }
    return shown.length ? shown.join("\n") : "(no matches)";
  } catch (e) {
    return `Error: ${error_text(e)}`;
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
  {"name": "load_skill", "description": "Load the full SKILL.md content by skill name.",
   "input_schema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}},
];

export function load_skill(name: string): string {
  return SKILL_LOADER.load(name);
}

export const TOOL_HANDLERS: Record<string, Function> = {
  "bash": run_bash,
  "read_file": run_read,
  "write_file": run_write,
  "edit_file": run_edit,
  "glob": run_glob,
  "load_skill": load_skill,
};

// -- Hooks --

export const HOOKS: Record<string, Function[]> = {"UserPromptSubmit": [], "PreToolUse": [], "PostToolUse": [], "Stop": []};

export function register_hook(event: string, callback: Function): void {
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

export const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="];
export const DESTRUCTIVE_COMMAND_WORD = /(?:^|[;&|()\n])\s*(?:rm|del)(?=\s|$|[;&|()])/i;
export const DESTRUCTIVE = ["rm ", "> /etc/", "chmod 777"];

export function contains_destructive_command(command: string): boolean {
  return DESTRUCTIVE_COMMAND_WORD.test(command);
}

export async function permission_hook(block: any): Promise<string | null> {
  /** PreToolUse: block denied operations and ask about risky ones. */
  if (block.name === "bash") {
    const command = block.input?.command ?? "";
    for (const pattern of DENY_LIST) {
      if (String(command).includes(pattern)) {
        console.log(`\n\x1b[31m[blocked] '${pattern}'\x1b[0m`);
        return "Permission denied by deny list";
      }
    }
    if (contains_destructive_command(String(command)) || DESTRUCTIVE.some((keyword) => String(command).includes(keyword))) {
      console.log("\n\x1b[33m[permission] Potentially destructive command\x1b[0m");
      console.log(`   Tool: ${block.name}(${py_repr(block.input)})`);
      const choice = (await input("   Allow? [y/N] ")).trim().toLowerCase();
      if (choice !== "y" && choice !== "yes") {
        return "Permission denied by user";
      }
    }
  }

  if (["read_file", "write_file", "edit_file"].includes(block.name)) {
    const path = block.input?.path ?? "";
    if (!is_relative_to(WORKDIR, resolve(WORKDIR, path))) {
      console.log("\n\x1b[33m[permission] Access outside workspace\x1b[0m");
      console.log(`   Tool: ${block.name}(${py_repr(block.input)})`);
      const choice = (await input("   Allow? [y/N] ")).trim().toLowerCase();
      if (choice !== "y" && choice !== "yes") {
        return "Permission denied by user";
      }
    }
  }
  return null;
}

export function log_hook(block: any): null {
  /** PreToolUse: log every tool call. */
  const args_preview = py_repr(Object.values(block.input ?? {}).slice(0, 2)).slice(0, 60);
  console.log(`\x1b[90m[HOOK] ${block.name}(${args_preview})\x1b[0m`);
  return null;
}

export function large_output_hook(block: any, output: any): null {
  /** PostToolUse: warn on large output. */
  const text = py_str(output);
  if (text.length > 100000) {
    console.log(`\x1b[33m[HOOK] Large output from ${block.name}: ${text.length} chars\x1b[0m`);
  }
  return null;
}

export function context_inject_hook(query: string): null {
  /** UserPromptSubmit: log the working directory. */
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${WORKDIR}\x1b[0m`);
  return null;
}

export function summary_hook(messages: any[]): null {
  /** Stop: print the number of tool results in this message list. */
  let tool_count = 0;
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (is_plain_object(block) && block.type === "tool_result") tool_count += 1;
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

export async function execute_tool(block: any): Promise<string> {
  const blocked = await trigger_hooks("PreToolUse", block);
  if (blocked) {
    return String(blocked);
  }

  const handler = TOOL_HANDLERS[block.name];
  let output: any;
  try {
    output = handler ? await call_kwargs(handler, block.input ?? {}) : `Unknown: ${block.name}`;
  } catch (e) {
    output = `Error: ${error_text(e)}`;
  }

  await trigger_hooks("PostToolUse", block, output);
  return String(output);
}

export async function agent_loop(messages: any[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: messages,
      tools: TOOLS,
      max_tokens: 8000,
    });
    messages.push({"role": "assistant", "content": response.content});

    const tool_calls = (response.content as any[]).filter((block) => block.type === "tool_use");
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
      const output = await execute_tool(block);
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
  console.log("s07: Skill Loading - catalog first, full content on demand");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const history: any[] = [];
  while (true) {
    let query: string;
    try {
      // Visible ANSI prompt. node:readline does not use zero-width markers.
      query = await input("\x1b[36ms07 >> \x1b[0m");
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
  rl?.close();
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
