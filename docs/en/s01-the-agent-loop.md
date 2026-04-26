# s01: The Agent Loop

`[ s01 ] s02 > s03 > s04 > s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> *"One loop & Bash is all you need"* -- one tool + one loop = an agent.
>
> **Harness layer**: The loop -- the model's first connection to the real world.

## Problem

A language model can reason about code, but it can't *touch* the real world -- can't read files, run tests, or check errors. Without a loop, every tool call requires you to manually copy-paste results back. You become the loop.

## Solution

```
+--------+      +-------+      +---------+
|  User  | ---> |  LLM  | ---> |  Tool   |
| prompt |      |       |      | execute |
+--------+      +---+---+      +----+----+
                    ^                |
                    |   tool_result  |
                    +----------------+
                    (loop until stop_reason != "tool_use")
```

One exit condition controls the entire flow. The loop runs until the model stops calling tools.

## How It Works

1. User prompt becomes the first message.

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "bash",
  description: "agent loop",
  input_schema: { type: "object", properties: {} }
};

async function handleS01Step(input: ToolInput) {
  await runCommand(input.command);
  return tool.name;
}
```

2. Send messages + tool definitions to the LLM.

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "bash",
  description: "agent loop",
  input_schema: { type: "object", properties: {} }
};

async function handleS01Step(input: ToolInput) {
  await runCommand(input.command);
  return tool.name;
}
```

3. Append the assistant response. Check `stop_reason` -- if the model didn't call a tool, we're done.

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "bash",
  description: "agent loop",
  input_schema: { type: "object", properties: {} }
};

async function handleS01Step(input: ToolInput) {
  await runCommand(input.command);
  return tool.name;
}
```

4. Execute each tool call, collect results, append as a user message. Loop back to step 2.

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "bash",
  description: "agent loop",
  input_schema: { type: "object", properties: {} }
};

async function handleS01Step(input: ToolInput) {
  await runCommand(input.command);
  return tool.name;
}
```

Assembled into one function:

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "bash",
  description: "agent loop",
  input_schema: { type: "object", properties: {} }
};

async function handleS01Step(input: ToolInput) {
  await runCommand(input.command);
  return tool.name;
}
```

That's the entire agent in under 30 lines. Everything else in this course layers on top -- without changing the loop.

## What Changed

| Component     | Before     | After                          |
|---------------|------------|--------------------------------|
| Agent loop    | (none)     | `while True` + stop_reason     |
| Tools         | (none)     | `bash` (one tool)              |
| Messages      | (none)     | Accumulating list              |
| Control flow  | (none)     | `stop_reason != "tool_use"`    |

## Try It

```sh
cd learn-claude-code
tsx agents/s01_s01_agent_loop.ts
```

1. `Create a file called hello.ts that prints "Hello, World!"`
2. `List all TypeScript files in this directory`
3. `What is the current git branch?`
4. `Create a directory called test_output and write 3 files in it`
