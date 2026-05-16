import {
  BackgroundManager,
  FULL_TOKEN_THRESHOLD,
  MessageBus,
  ProtocolState,
  SKILLS_DIR,
  SkillLoader,
  TaskManager,
  TeammateManager,
  TodoManager,
  VALID_MSG_TYPES,
  createClient,
  createSystemPrompt,
  editWorkspaceFile,
  isMainModule,
  readWorkspaceFile,
  runAgentLoop,
  runCommand,
  runSubagent,
  startRepl,
  type Message,
  writeWorkspaceFile
} from "../src/core";

const todo = new TodoManager();
const skills = new SkillLoader(SKILLS_DIR);
const tasks = new TaskManager();
const background = new BackgroundManager();
const bus = new MessageBus();
const protocols = new ProtocolState();
const team = new TeammateManager(undefined, bus, "autonomous", protocols, tasks);
const client = createClient();
const system = createSystemPrompt(
  "Use tools to solve tasks.\n" +
  "Prefer task_create/task_update/task_list for multi-step work. Use TodoWrite for short checklists.\n" +
  "Use task for subagent delegation. Use load_skill for specialized knowledge.\n" +
  "Skills: " + skills.descriptions()
);
const tools = [
  ...[
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } }
],
  { name: "TodoWrite", description: "Update task tracking list.", input_schema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, activeForm: { type: "string" } }, required: ["content", "status", "activeForm"] } } }, required: ["items"] } },
  { name: "task", description: "Spawn a subagent for isolated exploration or work.", input_schema: { type: "object", properties: { prompt: { type: "string" }, agent_type: { type: "string", enum: ["Explore", "general-purpose"] } }, required: ["prompt"] } },
  { name: "load_skill", description: "Load specialized knowledge by name.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "compress", description: "Manually compress conversation context.", input_schema: { type: "object", properties: {} } },
  { name: "background_run", description: "Run command in background thread.", input_schema: { type: "object", properties: { command: { type: "string" }, timeout: { type: "integer" } }, required: ["command"] } },
  { name: "check_background", description: "Check background task status.", input_schema: { type: "object", properties: { task_id: { type: "string" } } } },
  { name: "task_create", description: "Create a persistent file task.", input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] } },
  { name: "task_get", description: "Get task details by ID.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
  { name: "task_update", description: "Update task status or dependencies.", input_schema: { type: "object", properties: { task_id: { type: "integer" }, status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] }, add_blocked_by: { type: "array", items: { type: "integer" } }, remove_blocked_by: { type: "array", items: { type: "integer" } } }, required: ["task_id"] } },
  { name: "task_list", description: "List all tasks.", input_schema: { type: "object", properties: {} } },
  { name: "spawn_teammate", description: "Spawn a persistent autonomous teammate.", input_schema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] } },
  { name: "list_teammates", description: "List all teammates.", input_schema: { type: "object", properties: {} } },
  { name: "send_message", description: "Send a message to a teammate.", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: [...VALID_MSG_TYPES] } }, required: ["to", "content"] } },
  { name: "read_inbox", description: "Read and drain the lead's inbox.", input_schema: { type: "object", properties: {} } },
  { name: "broadcast", description: "Send message to all teammates.", input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } },
  { name: "shutdown_request", description: "Request a teammate to shut down.", input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] } },
  { name: "plan_approval", description: "Approve or reject a teammate's plan.", input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] } },
  { name: "idle", description: "Enter idle state.", input_schema: { type: "object", properties: {} } },
  { name: "claim_task", description: "Claim a task from the board.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } }
];

export async function runFull(history: Message[]) {
  await runAgentLoop({
    system,
    tools,
    handlers: {
      bash: ({ command }) => runCommand(command),
      read_file: ({ path, limit }) => readWorkspaceFile(path, limit),
      write_file: ({ path, content }) => writeWorkspaceFile(path, content),
      edit_file: ({ path, old_text, new_text }) => editWorkspaceFile(path, old_text, new_text),
      TodoWrite: ({ items }) => todo.update(items),
      task: ({ prompt, agent_type }) => runSubagent(prompt, agent_type),
      load_skill: ({ name }) => skills.load(name),
      compress: () => "Compressing...",
      background_run: ({ command, timeout }) => background.run(command, timeout ?? 120),
      check_background: ({ task_id }) => background.check(task_id),
      task_create: ({ subject, description }) => tasks.create(subject, description),
      task_get: ({ task_id }) => tasks.get(task_id),
      task_update: ({ task_id, status, add_blocked_by, remove_blocked_by }) => tasks.update(task_id, status, add_blocked_by, remove_blocked_by),
      task_list: () => tasks.listAll(),
      spawn_teammate: ({ name, role, prompt }) => team.spawn(name, role, prompt),
      list_teammates: () => team.listAll(),
      send_message: ({ to, content, msg_type }) => bus.send("lead", to, content, msg_type ?? "message"),
      read_inbox: () => JSON.stringify(bus.readInbox("lead"), null, 2),
      broadcast: ({ content }) => bus.broadcast("lead", content, team.memberNames()),
      shutdown_request: ({ teammate }) => protocols.requestShutdown(bus, teammate),
      plan_approval: ({ request_id, approve, feedback }) => protocols.reviewPlan(bus, request_id, approve, feedback ?? ""),
      idle: () => "Lead does not idle.",
      claim_task: ({ task_id }) => tasks.claim(task_id, "lead")
    },
    messages: history,
    todoManager: todo,
    backgroundManager: background,
    messageBus: bus,
    compressClient: client,
    compact: true,
    compactPrefix: "Compressed",
    tokenThreshold: FULL_TOKEN_THRESHOLD,
    nagTodo: "open"
  });
}

if (isMainModule(import.meta.url)) {
  await startRepl({ sessionId: "s_full", runTurn: runFull });
}
