# s07: Task System

`s01 > s02 > s03 > s04 > s05 > s06 | [ s07 ] s08 > s09 > s10 > s11 > s12`

> *"大きな目標を小タスクに分解し、順序付けし、ディスクに記録する"* -- ファイルベースのタスクグラフ、マルチエージェント協調の基盤。
>
> **Harness 層**: 永続タスク -- どの会話よりも長く生きる目標。

## 問題

s03のTodoManagerはメモリ上のフラットなチェックリストに過ぎない: 順序なし、依存関係なし、ステータスは完了か未完了のみ。実際の目標には構造がある -- タスクBはタスクAに依存し、タスクCとDは並行実行でき、タスクEはCとDの両方を待つ。

明示的な関係がなければ、エージェントは何が実行可能で、何がブロックされ、何が同時に走れるかを判断できない。しかもリストはメモリ上にしかないため、コンテキスト圧縮(s06)で消える。

## 解決策

フラットなチェックリストをディスクに永続化する**タスクグラフ**に昇格させる。各タスクは1つのJSONファイルで、ステータス・前方依存(`blockedBy`)を持つ。タスクグラフは常に3つの問いに答える:

- **何が実行可能か?** -- `pending`ステータスで`blockedBy`が空のタスク。
- **何がブロックされているか?** -- 未完了の依存を待つタスク。
- **何が完了したか?** -- `completed`のタスク。完了時に後続タスクを自動的にアンブロックする。

```
.tasks/
  task_1.json  {"id":1, "status":"completed"}
  task_2.json  {"id":2, "blockedBy":[1], "status":"pending"}
  task_3.json  {"id":3, "blockedBy":[1], "status":"pending"}
  task_4.json  {"id":4, "blockedBy":[2,3], "status":"pending"}

タスクグラフ (DAG):
                 +----------+
            +--> | task 2   | --+
            |    | pending  |   |
+----------+     +----------+    +--> +----------+
| task 1   |                          | task 4   |
| completed| --> +----------+    +--> | blocked  |
+----------+     | task 3   | --+     +----------+
                 | pending  |
                 +----------+

順序:       task 1 は 2 と 3 より先に完了する必要がある
並行:       task 2 と 3 は同時に実行できる
依存:       task 4 は 2 と 3 の両方を待つ
ステータス: pending -> in_progress -> completed
```

このタスクグラフは s07 以降の全メカニズムの協調バックボーンとなる: バックグラウンド実行(s08)、マルチエージェントチーム(s09+)、worktree分離(s12)はすべてこの同じ構造を読み書きする。

## 仕組み

1. **TaskManager**: タスクごとに1つのJSONファイル、依存グラフ付きCRUD。

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "task_create",
  description: "task graph",
  input_schema: { type: "object", properties: {} }
};

async function handleS07Step(input: ToolInput) {
  return tasks.create(input.subject, input.description);
  return tool.name;
}
```

2. **依存解除**: タスク完了時に、他タスクの`blockedBy`リストから完了IDを除去し、後続タスクをアンブロックする。

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "task_create",
  description: "task graph",
  input_schema: { type: "object", properties: {} }
};

async function handleS07Step(input: ToolInput) {
  return tasks.create(input.subject, input.description);
  return tool.name;
}
```

3. **ステータス遷移 + 依存配線**: `update`がステータス変更と依存エッジを担う。

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "task_create",
  description: "task graph",
  input_schema: { type: "object", properties: {} }
};

async function handleS07Step(input: ToolInput) {
  return tasks.create(input.subject, input.description);
  return tool.name;
}
```

4. 4つのタスクツールをディスパッチマップに追加する。

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "task_create",
  description: "task graph",
  input_schema: { type: "object", properties: {} }
};

async function handleS07Step(input: ToolInput) {
  return tasks.create(input.subject, input.description);
  return tool.name;
}
```

s07以降、タスクグラフがマルチステップ作業のデフォルト。s03のTodoは軽量な単一セッション用チェックリストとして残る。

## s06からの変更点

| コンポーネント | Before (s06) | After (s07) |
|---|---|---|
| Tools | 5 | 8 (`task_create/update/list/get`) |
| 計画モデル | フラットチェックリスト (メモリ) | 依存関係付きタスクグラフ (ディスク) |
| 関係 | なし | `blockedBy` エッジ |
| ステータス追跡 | 完了か未完了 | `pending` -> `in_progress` -> `completed` |
| 永続性 | 圧縮で消失 | 圧縮・再起動後も存続 |

## 試してみる

```sh
cd learn-claude-code
tsx agents/s07_task_system.ts
```

1. `Create 3 tasks: "Setup project", "Write code", "Write tests". Make them depend on each other in order.`
2. `List all tasks and show the dependency graph`
3. `Complete task 1 and then list tasks to see task 2 unblocked`
4. `Create a task board for refactoring: parse -> transform -> emit -> test, where transform and emit can run in parallel after parse`
