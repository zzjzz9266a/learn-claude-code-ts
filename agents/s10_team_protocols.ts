import {
  MessageBus,
  TEAM_DIR,
  VALID_MSG_TYPES,
  createSystemPrompt,
  editWorkspaceFile,
  isMainModule,
  readWorkspaceFile,
  runAgentLoop,
  runCommand,
  startRepl,
  type Message,
  writeWorkspaceFile
} from "../src/core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const bus = new MessageBus();
const requestsDir = join(TEAM_DIR, "requests");
mkdirSync(requestsDir, { recursive: true });
const system = createSystemPrompt(`Use shared request-response protocols. Valid message types: ${[...VALID_MSG_TYPES].join(", ")}.`);
const tools = [
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "send_message", description: "Send a typed message.", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, type: { type: "string" } }, required: ["to", "content"] } },
  { name: "plan_approval_request", description: "Ask a teammate for plan approval.", input_schema: { type: "object", properties: { teammate: { type: "string" }, plan: { type: "string" } }, required: ["teammate", "plan"] } },
  { name: "shutdown_request", description: "Request teammate shutdown.", input_schema: { type: "object", properties: { teammate: { type: "string" }, reason: { type: "string" } }, required: ["teammate"] } },
  { name: "read_inbox", description: "Read the lead inbox.", input_schema: { type: "object", properties: {} } }
];

function request(to: string, type: string, content: string) {
  const requestId = `req_${randomUUID().slice(0, 8)}`;
  const payload = { request_id: requestId, to, type, content, status: "pending" };
  writeFileSync(join(requestsDir, `${requestId}.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  bus.send("lead", to, content, type, { request_id: requestId });
  return JSON.stringify(payload, null, 2);
}

export async function runS10(history: Message[]) {
  await runAgentLoop({
    system,
    tools,
    handlers: {
      bash: ({ command }) => runCommand(command),
      read_file: ({ path, limit }) => readWorkspaceFile(path, limit),
      write_file: ({ path, content }) => writeWorkspaceFile(path, content),
      edit_file: ({ path, old_text, new_text }) => editWorkspaceFile(path, old_text, new_text),
      send_message: ({ to, content, type }) => bus.send("lead", to, content, type),
      plan_approval_request: ({ teammate, plan }) => request(teammate, "plan_approval_request", plan),
      shutdown_request: ({ teammate, reason }) => request(teammate, "shutdown_request", reason ?? "shutdown requested"),
      read_inbox: () => JSON.stringify(bus.readInbox("lead"), null, 2)
    },
    messages: history,
    messageBus: bus
  });
}

if (isMainModule(import.meta.url)) {
  await startRepl({ sessionId: "s10", runTurn: runS10 });
}
