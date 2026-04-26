# s01: The Agent Loop

`[ s01 ] s02 > s03 > s04 > s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> *"One loop & Bash is all you need"* -- 1つのツール + 1つのループ = エージェント。
>
> **Harness 層**: ループ -- モデルと現実世界を繋ぐ最初の接点。

## 問題

言語モデルはコードについて推論できるが、現実世界に触れられない。ファイルを読めず、テストを実行できず、エラーを確認できない。ループがなければ、ツール呼び出しのたびにユーザーが手動で結果をコピーペーストする必要がある。つまりユーザー自身がループになる。

## 解決策

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

1つの終了条件がフロー全体を制御する。モデルがツール呼び出しを止めるまでループが回り続ける。

## 仕組み

1. ユーザーのプロンプトが最初のメッセージになる。

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

2. メッセージとツール定義をLLMに送信する。

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

3. アシスタントのレスポンスを追加し、`stop_reason`を確認する。ツールが呼ばれなければ終了。

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

4. 各ツール呼び出しを実行し、結果を収集してuserメッセージとして追加。ステップ2に戻る。

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

1つの関数にまとめると:

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

これでエージェント全体が30行未満に収まる。本コースの残りはすべてこのループの上に積み重なる -- ループ自体は変わらない。

## 変更点

| Component     | Before     | After                          |
|---------------|------------|--------------------------------|
| Agent loop    | (none)     | `while True` + stop_reason     |
| Tools         | (none)     | `bash` (one tool)              |
| Messages      | (none)     | Accumulating list              |
| Control flow  | (none)     | `stop_reason != "tool_use"`    |

## 試してみる

```sh
cd learn-claude-code
tsx agents/s01_s01_agent_loop.ts
```

1. `Create a file called hello.ts that prints "Hello, World!"`
2. `List all TypeScript files in this directory`
3. `What is the current git branch?`
4. `Create a directory called test_output and write 3 files in it`
