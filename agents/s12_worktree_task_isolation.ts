import {
  EventBus,
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
const system = createSystemPrompt(
  "Use task + worktree tools for multi-task work. For parallel or risky changes: create tasks, allocate worktree lanes, run commands in those lanes, then choose keep/remove for closeout. Use worktree_events when you need lifecycle visibility."
);
const tools = [
  { name: "bash", description: "Run a shell command in the current workspace (blocking).", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  ...[
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } }
].slice(1),
  { name: "task_create", description: "Create a new task on the shared task board.", input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] } },
  { name: "task_list", description: "List all tasks with status, owner, and worktree binding.", input_schema: { type: "object", properties: {} } },
  { name: "task_get", description: "Get task details by ID.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
  { name: "task_update", description: "Update task status or owner.", input_schema: { type: "object", properties: { task_id: { type: "integer" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, owner: { type: "string" } }, required: ["task_id"] } },
  { name: "task_bind_worktree", description: "Bind a task to a worktree name.", input_schema: { type: "object", properties: { task_id: { type: "integer" }, worktree: { type: "string" }, owner: { type: "string" } }, required: ["task_id", "worktree"] } },
  { name: "worktree_create", description: "Create a git worktree and optionally bind it to a task.", input_schema: { type: "object", properties: { name: { type: "string" }, task_id: { type: "integer" }, base_ref: { type: "string" } }, required: ["name"] } },
  { name: "worktree_list", description: "List worktrees tracked in .worktrees/index.json.", input_schema: { type: "object", properties: {} } },
  { name: "worktree_status", description: "Show git status for one worktree.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "worktree_run", description: "Run a shell command in a named worktree directory.", input_schema: { type: "object", properties: { name: { type: "string" }, command: { type: "string" } }, required: ["name", "command"] } },
  { name: "worktree_remove", description: "Remove a worktree and optionally mark its bound task completed.", input_schema: { type: "object", properties: { name: { type: "string" }, force: { type: "boolean" }, complete_task: { type: "boolean" } }, required: ["name"] } },
  { name: "worktree_keep", description: "Mark a worktree as kept in lifecycle state without removing it.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "worktree_events", description: "List recent worktree/task lifecycle events from .worktrees/events.jsonl.", input_schema: { type: "object", properties: { limit: { type: "integer" } } } }
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
      task_list: () => tasks.listAll(),
      task_get: ({ task_id }) => tasks.get(task_id),
      task_update: ({ task_id, status, owner }) => tasks.update(task_id, status, undefined, undefined, owner),
      task_bind_worktree: ({ task_id, worktree, owner }) => tasks.bindWorktree(task_id, worktree, owner ?? ""),
      worktree_create: ({ name, task_id, base_ref }) => worktrees.create(name, task_id, base_ref),
      worktree_list: () => worktrees.listAll(),
      worktree_status: ({ name }) => worktrees.status(name),
      worktree_run: ({ name, command }) => worktrees.run(name, command),
      worktree_remove: ({ name, force, complete_task }) => worktrees.remove(name, force, complete_task),
      worktree_keep: ({ name }) => worktrees.keep(name),
      worktree_events: ({ limit }) => events.listRecent(limit)
    },
    messages: history
  });
}

if (isMainModule(import.meta.url)) {
  console.log("Repo root for s12: " + repoRoot);
  if (!worktrees.gitAvailable) console.log("Note: Not in a git repo. worktree_* tools will return errors.");
  await startRepl({ sessionId: "s12", runTurn: runS12 });
}
