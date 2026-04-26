# s03: TodoWrite

`s01 > s02 > [ s03 ] s04 > s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> *"An agent without a plan drifts"* -- list the steps first, then execute.
>
> **Harness layer**: Planning -- keeping the model on course without scripting the route.

## Problem

On multi-step tasks, the model loses track. It repeats work, skips steps, or wanders off. Long conversations make this worse -- the system prompt fades as tool results fill the context. A 10-step refactoring might complete steps 1-3, then the model starts improvising because it forgot steps 4-10.

## Solution

```
+--------+      +-------+      +---------+
|  User  | ---> |  LLM  | ---> | Tools   |
| prompt |      |       |      | + todo  |
+--------+      +---+---+      +----+----+
                    ^                |
                    |   tool_result  |
                    +----------------+
                          |
              +-----------+-----------+
              | TodoManager state     |
              | [ ] task A            |
              | [>] task B  <- doing  |
              | [x] task C            |
              +-----------------------+
                          |
              if rounds_since_todo >= 3:
                inject <reminder> into tool_result
```

## How It Works

1. TodoManager stores items with statuses. Only one item can be `in_progress` at a time.

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "TodoWrite",
  description: "todo reminder",
  input_schema: { type: "object", properties: {} }
};

async function handleS03Step(input: ToolInput) {
  todo.update(input.items);
  return tool.name;
}
```

2. The `todo` tool goes into the dispatch map like any other tool.

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "TodoWrite",
  description: "todo reminder",
  input_schema: { type: "object", properties: {} }
};

async function handleS03Step(input: ToolInput) {
  todo.update(input.items);
  return tool.name;
}
```

3. A nag reminder injects a nudge if the model goes 3+ rounds without calling `todo`.

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "TodoWrite",
  description: "todo reminder",
  input_schema: { type: "object", properties: {} }
};

async function handleS03Step(input: ToolInput) {
  todo.update(input.items);
  return tool.name;
}
```

The "one in_progress at a time" constraint forces sequential focus. The nag reminder creates accountability.

## What Changed From s02

| Component      | Before (s02)     | After (s03)                |
|----------------|------------------|----------------------------|
| Tools          | 4                | 5 (+todo)                  |
| Planning       | None             | TodoManager with statuses  |
| Nag injection  | None             | `<reminder>` after 3 rounds|
| Agent loop     | Simple dispatch  | + rounds_since_todo counter|

## Try It

```sh
cd learn-claude-code
tsx agents/s03_todo_write.ts
```

1. `Refactor the file hello.ts: add type hints, docstrings, and a main guard`
2. `Create a TypeScript package with __init__.ts, utils.ts, and tests/test_utils.ts`
3. `Review all TypeScript files and fix any style issues`
