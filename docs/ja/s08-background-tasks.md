# s08: Background Tasks

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > [ s08 ] s09 > s10 > s11 > s12`

> *"遅い操作はバックグラウンドへ、エージェントは次を考え続ける"* -- デーモンスレッドがコマンド実行、完了後に通知を注入。
>
> **Harness 層**: バックグラウンド実行 -- モデルが考え続ける間、Harness が待つ。

## 問題

一部のコマンドは数分かかる: `npm install`、`pytest`、`docker build`。ブロッキングループでは、モデルはサブプロセスの完了を待って座っている。ユーザーが「依存関係をインストールして、その間にconfigファイルを作って」と言っても、エージェントは並列ではなく逐次的に処理する。

## 解決策

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

## 仕組み

1. BackgroundManagerがスレッドセーフな通知キューでタスクを追跡する。

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

2. `run()`がデーモンスレッドを開始し、即座にリターンする。

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

3. サブプロセス完了時に、結果を通知キューへ。

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

4. エージェントループが各LLM呼び出しの前に通知をドレインする。

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

ループはシングルスレッドのまま。サブプロセスI/Oだけが並列化される。

## s07からの変更点

| Component      | Before (s07)     | After (s08)                |
|----------------|------------------|----------------------------|
| Tools          | 8                | 6 (base + background_run + check)|
| Execution      | Blocking only    | Blocking + background threads|
| Notification   | None             | Queue drained per loop     |
| Concurrency    | None             | Daemon threads             |

## 試してみる

```sh
cd learn-claude-code
tsx agents/s08_background_tasks.ts
```

1. `Run "sleep 5 && echo done" in the background, then create a file while it runs`
2. `Start 3 background tasks: "sleep 2", "sleep 4", "sleep 6". Check their status.`
3. `Run pytest in the background and keep working on other things`
