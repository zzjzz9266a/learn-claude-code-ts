import {
  MessageBus,
  TEAM_DIR,
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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tasks = new TaskManager();
const bus = new MessageBus();
const claimsDir = join(TEAM_DIR, "claims");
mkdirSync(claimsDir, { recursive: true });

class ClaimManager {
  identity = `agent_${process.pid}`;

  claimable() {
    if (!existsSync(".tasks")) return [];
    return readdirSync(".tasks")
      .filter((name) => /^task_\d+\.json$/.test(name))
      .map((name) => JSON.parse(readFileSync(join(".tasks", name), "utf8")))
      .filter((task) => task.status === "pending" && !task.owner && (!task.blockedBy || task.blockedBy.length === 0));
  }

  claim(taskId: number) {
    const taskPath = join(".tasks", `task_${taskId}.json`);
    if (!existsSync(taskPath)) return `Task ${taskId} not found`;
    const claimPath = join(claimsDir, `task_${taskId}.json`);
    if (existsSync(claimPath)) return `Task ${taskId} is already claimed`;
    const claim = { task_id: taskId, owner: this.identity, claimed_at: Date.now() / 1000 };
    writeFileSync(claimPath, `${JSON.stringify(claim, null, 2)}\n`, "utf8");
    tasks.claim(taskId, this.identity);
    return JSON.stringify(claim, null, 2);
  }
}

const claims = new ClaimManager();
const system = createSystemPrompt("Scan the task board, claim available work, and resume autonomously.");
const tools = [
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "task_list", description: "List tasks.", input_schema: { type: "object", properties: {} } },
  { name: "task_get", description: "Get task details.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
  { name: "claimable_tasks", description: "List unblocked unowned tasks.", input_schema: { type: "object", properties: {} } },
  { name: "claim_task", description: "Claim task by ID.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
  { name: "idle", description: "Enter idle state.", input_schema: { type: "object", properties: {} } },
  { name: "read_inbox", description: "Read inbox.", input_schema: { type: "object", properties: {} } }
];

export async function runS11(history: Message[]) {
  history.push({ role: "user", content: `<identity>${claims.identity}</identity>` });
  await runAgentLoop({
    system,
    tools,
    handlers: {
      bash: ({ command }) => runCommand(command),
      read_file: ({ path, limit }) => readWorkspaceFile(path, limit),
      write_file: ({ path, content }) => writeWorkspaceFile(path, content),
      edit_file: ({ path, old_text, new_text }) => editWorkspaceFile(path, old_text, new_text),
      task_list: () => tasks.listAll(),
      task_get: ({ task_id }) => tasks.get(task_id),
      claimable_tasks: () => JSON.stringify(claims.claimable(), null, 2),
      claim_task: ({ task_id }) => claims.claim(task_id),
      idle: () => "idle",
      read_inbox: () => JSON.stringify(bus.readInbox("lead"), null, 2)
    },
    messages: history,
    messageBus: bus
  });
}

if (isMainModule(import.meta.url)) {
  await startRepl({ sessionId: "s11", runTurn: runS11 });
}
