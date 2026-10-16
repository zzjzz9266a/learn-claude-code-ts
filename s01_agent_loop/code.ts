/**
 * s01_agent_loop/code.ts - The Agent Loop
 *
 * The entire secret of an AI coding agent in one pattern:
 *
 *     while (true) {
 *         response = LLM(messages, tools)
 *         if response contains no tool_use:
 *             break
 *         execute tools
 *         append results
 *     }
 *
 *     +----------+      +-------+      +---------+
 *     |   User   | ---> |  LLM  | ---> |  Tool   |
 *     |  prompt  |      |       |      | execute |
 *     +----------+      +---+---+      +----+----+
 *                           ^               |
 *                           |   tool_result |
 *                           +---------------+
 *                           (loop continues)
 *
 * This is the core loop: feed tool results back to the model
 * until the model decides to stop. Later chapters add policy,
 * hooks, and lifecycle controls around it.
 *
 * Usage:
 *     npm install
 *     ANTHROPIC_API_KEY=... npx tsx s01_agent_loop/code.ts
 */

import { spawnSync } from "node:child_process";
import { createInterface, type Interface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import Anthropic from "@anthropic-ai/sdk";
import { config as loadDotenv } from "dotenv";

loadDotenv({ override: true });

if (process.env.ANTHROPIC_BASE_URL) {
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}

export const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL });
const modelId = process.env.MODEL_ID;
if (!modelId) throw new Error("MODEL_ID is required");
export const MODEL: string = modelId;

export const ENVIRONMENT_PROMPT =
  process.platform === "win32"
    ? "Windows: the bash tool runs through cmd.exe; use cmd.exe syntax, not Unix Bash or PowerShell syntax"
    : "Unix-like: the bash tool runs the system shell";
export const SYSTEM = (
  `You are a coding agent at ${process.cwd()}. Environment: ${ENVIRONMENT_PROMPT}. ` +
  "Use bash to solve tasks. Act, don't explain."
);

// -- Tool definition: just bash --
export const TOOLS: any[] = [{
  "name": "bash",
  "description": "Run a shell command.",
  "input_schema": {
    "type": "object",
    "properties": {"command": {"type": "string"}},
    "required": ["command"],
  },
}];


// -- Tool execution --
export function run_bash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const r = spawnSync(command, {
      shell: true,
      cwd: process.cwd(),
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


// -- The core pattern: a while loop that calls tools until the model stops --
export async function agent_loop(messages: any[]): Promise<void> {
  while (true) {
    const response = await client.messages.create({
      model: MODEL, system: SYSTEM, messages: messages,
      tools: TOOLS, max_tokens: 8000,
    });

    // Append assistant turn
    messages.push({"role": "assistant", "content": response.content});

    // If the model didn't call a tool, we're done
    const tool_calls: any[] = response.content.filter((block: any) => block.type === "tool_use");
    if (tool_calls.length === 0) {
      return;
    }

    // Execute each tool call, collect results
    const results: any[] = [];
    for (const block of tool_calls) {
      console.log(`\x1b[33m$ ${block.input["command"]}\x1b[0m`);
      const output = run_bash(block.input["command"]);
      console.log(output.slice(0, 200));
      results.push({
        "type": "tool_result",
        "tool_use_id": block.id,
        "content": output,
      });
    }

    // Feed tool results back, loop continues
    messages.push({"role": "user", "content": results});
  }
}


// -- REPL input. Node readline has no libedit width markers. --
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


// -- Entry point --
export async function main(): Promise<void> {
  console.log("s01: Agent Loop");
  console.log("Enter a question, press Enter to send. Type q to quit.\n");

  const history: any[] = [];
  try {
    while (true) {
      let query: string;
      try {
        // Prompt shows the visible ANSI text; Node readline has no libedit width markers.
        query = await input("\x1b[36ms01 >> \x1b[0m");
      } catch {
        break;
      }
      if (["q", "exit", ""].includes(query.trim().toLowerCase())) {
        break;
      }
      history.push({"role": "user", "content": query});
      await agent_loop(history);
      // Print the model's final text response
      const response_content = history[history.length - 1]["content"];
      if (Array.isArray(response_content)) {
        for (const block of response_content) {
          if (block?.type === "text") {
            console.log(block.text);
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
