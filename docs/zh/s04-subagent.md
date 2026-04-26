# s04: Subagents (Subagent)

`s01 > s02 > s03 > [ s04 ] s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> *"大任务拆小, 每个小任务干净的上下文"* -- Subagent 用独立 messages[], 不污染主对话。
>
> **Harness 层**: 上下文隔离 -- 守护模型的思维清晰度。

## 问题

Agent 工作越久, messages 数组越臃肿。每次读文件、跑命令的输出都永久留在上下文里。"这个项目用什么测试框架?" 可能要读 5 个文件, 但父 Agent 只需要一个词: "pytest。"

## 解决方案

```
Parent agent                     Subagent
+------------------+             +------------------+
| messages=[...]   |             | messages=[]      | <-- fresh
|                  |  dispatch   |                  |
| tool: task       | ----------> | while tool_use:  |
|   prompt="..."   |             |   call tools     |
|                  |  summary    |   append results |
|   result = "..." | <---------- | return last text |
+------------------+             +------------------+

Parent context stays clean. Subagent context is discarded.
```

## 工作原理

1. 父 Agent 有一个 `task` 工具。Subagent 拥有除 `task` 外的所有基础工具 (禁止递归生成)。

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "delegate",
  description: "subagent boundary",
  input_schema: { type: "object", properties: {} }
};

async function handleS04Step(input: ToolInput) {
  return runSubagent(input.prompt, input.agentType);
  return tool.name;
}
```

2. Subagent 以 `messages=[]` 启动, 运行自己的循环。只有最终文本返回给父 Agent。

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "delegate",
  description: "subagent boundary",
  input_schema: { type: "object", properties: {} }
};

async function handleS04Step(input: ToolInput) {
  return runSubagent(input.prompt, input.agentType);
  return tool.name;
}
```

Subagent 可能跑了 30+ 次工具调用, 但整个消息历史直接丢弃。父 Agent 收到的只是一段摘要文本, 作为普通 `tool_result` 返回。

## 相对 s03 的变更

| 组件           | 之前 (s03)       | 之后 (s04)                    |
|----------------|------------------|-------------------------------|
| Tools          | 5                | 5 (基础) + task (仅父端)      |
| 上下文         | 单一共享         | 父 + 子隔离                   |
| Subagent       | 无               | `run_subagent()` 函数         |
| 返回值         | 不适用           | 仅摘要文本                    |

## 试一试

```sh
cd learn-claude-code
tsx agents/s04_subagent.ts
```

试试这些 prompt (英文 prompt 对 LLM 效果更好, 也可以用中文):

1. `Use a subtask to find what testing framework this project uses`
2. `Delegate: read all .ts files and summarize what each one does`
3. `Use a task to create a new module, then verify it from here`
