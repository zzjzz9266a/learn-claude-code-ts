# s10: Team Protocols

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > s08 > s09 > [ s10 ] s11 > s12`

> *"Teammates need shared communication rules"* -- one request-response pattern drives all negotiation.
>
> **Harness layer**: Protocols -- structured handshakes between models.

## Problem

In s09, teammates work and communicate but lack structured coordination:

**Shutdown**: Killing a thread leaves files half-written and config.json stale. You need a handshake: the lead requests, the teammate approves (finish and exit) or rejects (keep working).

**Plan approval**: When the lead says "refactor the auth module," the teammate starts immediately. For high-risk changes, the lead should review the plan first.

Both share the same structure: one side sends a request with a unique ID, the other responds referencing that ID.

## Solution

```
Shutdown Protocol            Plan Approval Protocol
==================           ======================

Lead             Teammate    Teammate           Lead
  |                 |           |                 |
  |--shutdown_req-->|           |--plan_req------>|
  | {req_id:"abc"}  |           | {req_id:"xyz"}  |
  |                 |           |                 |
  |<--shutdown_resp-|           |<--plan_resp-----|
  | {req_id:"abc",  |           | {req_id:"xyz",  |
  |  approve:true}  |           |  approve:true}  |

Shared FSM:
  [pending] --approve--> [approved]
  [pending] --reject---> [rejected]

Trackers:
  shutdown_requests = {req_id: {target, status}}
  plan_requests     = {req_id: {from, plan, status}}
```

## How It Works

1. The lead initiates shutdown by generating a request_id and sending through the inbox.

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "plan_approval_request",
  description: "team protocol",
  input_schema: { type: "object", properties: {} }
};

async function handleS10Step(input: ToolInput) {
  return request(input.teammate, "plan_approval_request", input.plan);
  return tool.name;
}
```

2. The teammate receives the request and responds with approve/reject.

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "plan_approval_request",
  description: "team protocol",
  input_schema: { type: "object", properties: {} }
};

async function handleS10Step(input: ToolInput) {
  return request(input.teammate, "plan_approval_request", input.plan);
  return tool.name;
}
```

3. Plan approval follows the identical pattern. The teammate submits a plan (generating a request_id), the lead reviews (referencing the same request_id).

```typescript
type ToolInput = Record<string, any>;

type ToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

const tool: ToolSpec = {
  name: "plan_approval_request",
  description: "team protocol",
  input_schema: { type: "object", properties: {} }
};

async function handleS10Step(input: ToolInput) {
  return request(input.teammate, "plan_approval_request", input.plan);
  return tool.name;
}
```

One FSM, two applications. The same `pending -> approved | rejected` state machine handles any request-response protocol.

## What Changed From s09

| Component      | Before (s09)     | After (s10)                  |
|----------------|------------------|------------------------------|
| Tools          | 9                | 12 (+shutdown_req/resp +plan)|
| Shutdown       | Natural exit only| Request-response handshake   |
| Plan gating    | None             | Submit/review with approval  |
| Correlation    | None             | request_id per request       |
| FSM            | None             | pending -> approved/rejected |

## Try It

```sh
cd learn-claude-code
tsx agents/s10_team_protocols.ts
```

1. `Spawn alice as a coder. Then request her shutdown.`
2. `List teammates to see alice's status after shutdown approval`
3. `Spawn bob with a risky refactoring task. Review and reject his plan.`
4. `Spawn charlie, have him submit a plan, then approve it.`
5. Type `/team` to monitor statuses
