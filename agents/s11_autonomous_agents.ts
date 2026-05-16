import {
  MessageBus,
  ProtocolState,
  TaskManager,
  TeammateManager,
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

const bus = new MessageBus();
const protocols = new ProtocolState();
const tasks = new TaskManager();
const team = new TeammateManager(undefined, bus, "autonomous", protocols, tasks);
const system = createSystemPrompt("Teammates are autonomous -- they find work themselves.");
const tools = [
  ...[
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } }
],
  { name: "spawn_teammate", description: "Spawn an autonomous teammate.", input_schema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] } },
  { name: "list_teammates", description: "List all teammates.", input_schema: { type: "object", properties: {} } },
  { name: "send_message", description: "Send a message to a teammate.", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } }, required: ["to", "content"] } },
  { name: "read_inbox", description: "Read and drain the lead's inbox.", input_schema: { type: "object", properties: {} } },
  { name: "broadcast", description: "Send a message to all teammates.", input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } },
  { name: "shutdown_request", description: "Request a teammate to shut down.", input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] } },
  { name: "shutdown_response", description: "Check shutdown request status.", input_schema: { type: "object", properties: { request_id: { type: "string" } }, required: ["request_id"] } },
  { name: "plan_approval", description: "Approve or reject a teammate's plan.", input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] } },
  { name: "idle", description: "Enter idle state (for lead -- rarely used).", input_schema: { type: "object", properties: {} } },
  { name: "claim_task", description: "Claim a task from the board by ID.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } }
];

export async function runS11(history: Message[]) {
  await runAgentLoop({
    system,
    tools,
    handlers: {
      bash: ({ command }) => runCommand(command),
      read_file: ({ path, limit }) => readWorkspaceFile(path, limit),
      write_file: ({ path, content }) => writeWorkspaceFile(path, content),
      edit_file: ({ path, old_text, new_text }) => editWorkspaceFile(path, old_text, new_text),
      spawn_teammate: ({ name, role, prompt }) => team.spawn(name, role, prompt),
      list_teammates: () => team.listAll(),
      send_message: ({ to, content, msg_type }) => bus.send("lead", to, content, msg_type ?? "message"),
      read_inbox: () => JSON.stringify(bus.readInbox("lead"), null, 2),
      broadcast: ({ content }) => bus.broadcast("lead", content, team.memberNames()),
      shutdown_request: ({ teammate }) => protocols.requestShutdown(bus, teammate),
      shutdown_response: ({ request_id }) => protocols.checkShutdown(request_id ?? ""),
      plan_approval: ({ request_id, approve, feedback }) => protocols.reviewPlan(bus, request_id, approve, feedback ?? ""),
      idle: () => "Lead does not idle.",
      claim_task: ({ task_id }) => tasks.claim(task_id, "lead")
    },
    messages: history,
    messageBus: bus
  });
}

if (isMainModule(import.meta.url)) {
  await startRepl({ sessionId: "s11", runTurn: runS11 });
}
