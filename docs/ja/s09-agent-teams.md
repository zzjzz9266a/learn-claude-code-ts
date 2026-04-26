# s09: Agent Teams

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > s08 > [ s09 ] s10 > s11 > s12`

> *"一人で終わらないなら、チームメイトに任せる"* -- 永続チームメイト + 非同期メールボックス。
>
> **Harness 層**: チームメールボックス -- 複数モデルをファイルで協調。

## 問題

サブエージェント(s04)は使い捨てだ: 生成し、作業し、要約を返し、消滅する。アイデンティティもなく、呼び出し間の記憶もない。バックグラウンドタスク(s08)はシェルコマンドを実行するが、LLM誘導の意思決定はできない。

本物のチームワークには: (1)単一プロンプトを超えて存続する永続エージェント、(2)アイデンティティとライフサイクル管理、(3)エージェント間の通信チャネルが必要だ。

## 解決策

```
Teammate lifecycle:
  spawn -> WORKING -> IDLE -> WORKING -> ... -> SHUTDOWN

Communication:
  .team/
    config.json           <- team roster + statuses
    inbox/
      alice.jsonl         <- append-only, drain-on-read
      bob.jsonl
      lead.jsonl

              +--------+    send("alice","bob","...")    +--------+
              | alice  | -----------------------------> |  bob   |
              | loop   |    bob.jsonl << {json_line}    |  loop  |
              +--------+                                +--------+
                   ^                                         |
                   |        BUS.read_inbox("alice")          |
                   +---- alice.jsonl -> read + drain ---------+
```

## 仕組み

1. TeammateManagerがconfig.jsonでチーム名簿を管理する。

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "spawn_teammate",
  description: "agent team",
  input_schema: { type: "object", properties: {} }
};

async function handleS09Step(input: ToolInput) {
  return team.spawn(input.name, input.role);
  return tool.name;
}
```

2. `spawn()`がチームメイトを作成し、そのエージェントループをスレッドで開始する。

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "spawn_teammate",
  description: "agent team",
  input_schema: { type: "object", properties: {} }
};

async function handleS09Step(input: ToolInput) {
  return team.spawn(input.name, input.role);
  return tool.name;
}
```

3. MessageBus: 追記専用のJSONLインボックス。`send()`がJSON行を追記し、`read_inbox()`がすべて読み取ってドレインする。

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "spawn_teammate",
  description: "agent team",
  input_schema: { type: "object", properties: {} }
};

async function handleS09Step(input: ToolInput) {
  return team.spawn(input.name, input.role);
  return tool.name;
}
```

4. 各チームメイトは各LLM呼び出しの前にインボックスを確認し、受信メッセージをコンテキストに注入する。

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "spawn_teammate",
  description: "agent team",
  input_schema: { type: "object", properties: {} }
};

async function handleS09Step(input: ToolInput) {
  return team.spawn(input.name, input.role);
  return tool.name;
}
```

## s08からの変更点

| Component      | Before (s08)     | After (s09)                |
|----------------|------------------|----------------------------|
| Tools          | 6                | 9 (+spawn/send/read_inbox) |
| Agents         | Single           | Lead + N teammates         |
| Persistence    | None             | config.json + JSONL inboxes|
| Threads        | Background cmds  | Full agent loops per thread|
| Lifecycle      | Fire-and-forget  | idle -> working -> idle    |
| Communication  | None             | message + broadcast        |

## 試してみる

```sh
cd learn-claude-code
tsx agents/s09_agent_teams.ts
```

1. `Spawn alice (coder) and bob (tester). Have alice send bob a message.`
2. `Broadcast "status update: phase 1 complete" to all teammates`
3. `Check the lead inbox for any messages`
4. `/team`と入力してステータス付きのチーム名簿を確認する
5. `/inbox`と入力してリーダーのインボックスを手動確認する
