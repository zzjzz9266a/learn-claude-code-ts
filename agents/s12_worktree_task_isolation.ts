import {
  EventBus,
  MessageBus,
  TaskManager,
  WorktreeManager,
  createSystemPrompt,
  detectRepoRoot,
  editWorkspaceFile,
  isMainModule,
  readWorkspaceFile,
  runAgentLoop,
  runCommand,
  startRepl,
  type Message,
  writeWorkspaceFile
} from "../src/core";
import { join } from "node:path";

const repoRoot = detectRepoRoot() ?? process.cwd();
const tasks = new TaskManager(join(repoRoot, ".tasks"));
const events = new EventBus(join(repoRoot, ".worktrees", "events.jsonl"));
const worktrees = new WorktreeManager(repoRoot, tasks, events);
const bus = new MessageBus();
const system = createSystemPrompt("Use tasks for goals and worktrees for isolated directories. Bind them by task ID.");
const tools = [
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "task_create", description: "Create a persistent task.", input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] } },
  { name: "task_get", description: "Get task details.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
  { name: "task_update", description: "Update task status.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
  { name: "task_list", description: "List tasks.", input_schema: { type: "object", properties: {} } },
  { name: "worktree_create", description: "Create a git worktree lane.", input_schema: { type: "object", properties: { name: { type: "string" }, task_id: { type: "integer" }, base_ref: { type: "string" } }, required: ["name"] } },
  { name: "worktree_list", description: "List tracked worktrees.", input_schema: { type: "object", properties: {} } },
  { name: "worktree_status", description: "Show git status for a worktree.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "worktree_run", description: "Run command inside a worktree.", input_schema: { type: "object", properties: { name: { type: "string" }, command: { type: "string" } }, required: ["name", "command"] } },
  { name: "worktree_remove", description: "Remove a worktree lane.", input_schema: { type: "object", properties: { name: { type: "string" }, force: { type: "boolean" }, complete_task: { type: "boolean" } }, required: ["name"] } },
  { name: "worktree_keep", description: "Mark a worktree as kept.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "worktree_events", description: "Read recent worktree events.", input_schema: { type: "object", properties: { limit: { type: "integer" } } } },
  { name: "read_inbox", description: "Read inbox.", input_schema: { type: "object", properties: {} } }
];

export async function runS12(history: Message[]) {
  await runAgentLoop({
    system,
    tools,
    handlers: {
      bash: ({ command }) => runCommand(command),
      read_file: ({ path, limit }) => readWorkspaceFile(path, limit),
      write_file: ({ path, content }) => writeWorkspaceFile(path, content),
      edit_file: ({ path, old_text, new_text }) => editWorkspaceFile(path, old_text, new_text),
      task_create: ({ subject, description }) => tasks.create(subject, description),
      task_get: ({ task_id }) => tasks.get(task_id),
      task_update: ({ task_id, status, addBlockedBy, removeBlockedBy }) => tasks.update(task_id, status, addBlockedBy, removeBlockedBy),
      task_list: () => tasks.listAll(),
      worktree_create: ({ name, task_id, base_ref }) => worktrees.create(name, task_id, base_ref),
      worktree_list: () => worktrees.listAll(),
      worktree_status: ({ name }) => worktrees.status(name),
      worktree_run: ({ name, command }) => worktrees.run(name, command),
      worktree_remove: ({ name, force, complete_task }) => worktrees.remove(name, force, complete_task),
      worktree_keep: ({ name }) => worktrees.keep(name),
      worktree_events: ({ limit }) => events.listRecent(limit),
      read_inbox: () => JSON.stringify(bus.readInbox("lead"), null, 2)
    },
    messages: history,
    messageBus: bus
  });
}

if (isMainModule(import.meta.url)) {
  await startRepl({ sessionId: "s12", runTurn: runS12 });
}
