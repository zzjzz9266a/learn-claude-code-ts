import {
  TaskManager,
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

const tasks = new TaskManager();
const system = createSystemPrompt("Use task tools to plan and track work.");
const tools = [
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "task_create", description: "Create a new task.", input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] } },
  { name: "task_update", description: "Update a task's status or dependencies.", input_schema: { type: "object", properties: { task_id: { type: "integer" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, addBlockedBy: { type: "array", items: { type: "integer" } }, removeBlockedBy: { type: "array", items: { type: "integer" } } }, required: ["task_id"] } },
  { name: "task_list", description: "List all tasks with status summary.", input_schema: { type: "object", properties: {} } },
  { name: "task_get", description: "Get full details of a task by ID.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } }
];

export async function runS07(history: Message[]) {
  await runAgentLoop({
    system,
    tools,
    handlers: {
      bash: ({ command }) => runCommand(command),
      read_file: ({ path, limit }) => readWorkspaceFile(path, limit),
      write_file: ({ path, content }) => writeWorkspaceFile(path, content),
      edit_file: ({ path, old_text, new_text }) => editWorkspaceFile(path, old_text, new_text),
      task_create: ({ subject, description }) => tasks.create(subject, description),
      task_update: ({ task_id, status, addBlockedBy, removeBlockedBy }) => tasks.update(task_id, status, addBlockedBy, removeBlockedBy),
      task_list: () => tasks.listAll(),
      task_get: ({ task_id }) => tasks.get(task_id)
    },
    messages: history
  });
}

if (isMainModule(import.meta.url)) {
  await startRepl({ sessionId: "s07", runTurn: runS07 });
}
