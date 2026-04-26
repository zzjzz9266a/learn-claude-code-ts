# s08: Background Tasks

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > [ s08 ] s09 > s10 > s11 > s12`

> *"Run slow operations in the background; the agent keeps thinking"* -- daemon threads run commands, inject notifications on completion.
>
> **Harness layer**: Background execution -- the model thinks while the harness waits.

## Problem

Some commands take minutes: `npm install`, `pytest`, `docker build`. With a blocking loop, the model sits idle waiting. If the user asks "install dependencies and while that runs, create the config file," the agent does them sequentially, not in parallel.

## Solution

```
Main thread                Background thread
+-----------------+        +-----------------+
| agent loop      |        | subprocess runs |
| ...             |        | ...             |
| [LLM call] <---+------- | enqueue(result) |
|  ^drain queue   |        +-----------------+
+-----------------+

Timeline:
Agent --[spawn A]--[spawn B]--[other work]----
             |          |
             v          v
          [A runs]   [B runs]      (parallel)
             |          |
             +-- results injected before next LLM call --+
```

## How It Works

1. BackgroundManager tracks tasks with a thread-safe notification queue.

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "background_run",
  description: "background task",
  input_schema: { type: "object", properties: {} }
};

async function handleS08Step(input: ToolInput) {
  return background.run(input.command, input.timeout);
  return tool.name;
}
```

2. `run()` starts a daemon thread and returns immediately.

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "background_run",
  description: "background task",
  input_schema: { type: "object", properties: {} }
};

async function handleS08Step(input: ToolInput) {
  return background.run(input.command, input.timeout);
  return tool.name;
}
```

3. When the subprocess finishes, its result goes into the notification queue.

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "background_run",
  description: "background task",
  input_schema: { type: "object", properties: {} }
};

async function handleS08Step(input: ToolInput) {
  return background.run(input.command, input.timeout);
  return tool.name;
}
```

4. The agent loop drains notifications before each LLM call.

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "background_run",
  description: "background task",
  input_schema: { type: "object", properties: {} }
};

async function handleS08Step(input: ToolInput) {
  return background.run(input.command, input.timeout);
  return tool.name;
}
```

The loop stays single-threaded. Only subprocess I/O is parallelized.

## What Changed From s07

| Component      | Before (s07)     | After (s08)                |
|----------------|------------------|----------------------------|
| Tools          | 8                | 6 (base + background_run + check)|
| Execution      | Blocking only    | Blocking + background threads|
| Notification   | None             | Queue drained per loop     |
| Concurrency    | None             | Daemon threads             |

## Try It

```sh
cd learn-claude-code
tsx agents/s08_background_tasks.ts
```

1. `Run "sleep 5 && echo done" in the background, then create a file while it runs`
2. `Start 3 background tasks: "sleep 2", "sleep 4", "sleep 6". Check their status.`
3. `Run pytest in the background and keep working on other things`
