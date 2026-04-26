import {
  MessageBus,
  TEAM_DIR,
  TodoManager,
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

type Teammate = { name: string; role: string; status: string };

class TeammateManager {
  teammates = new Map<string, Teammate>();

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const teammate = JSON.parse(readFileSync(join(dir, file), "utf8")) as Teammate;
      this.teammates.set(teammate.name, teammate);
    }
  }

  spawn(name: string, role: string) {
    const teammate = { name, role, status: "idle" };
    this.teammates.set(name, teammate);
    writeFileSync(join(this.dir, `${name}.json`), `${JSON.stringify(teammate, null, 2)}\n`, "utf8");
    return JSON.stringify(teammate, null, 2);
  }

  listAll() {
    if (this.teammates.size === 0) return "No teammates.";
    return [...this.teammates.values()].map((t) => `[${t.status}] ${t.name}: ${t.role}`).join("\n");
  }

  remove(name: string) {
    if (!this.teammates.has(name)) return `Unknown teammate: ${name}`;
    this.teammates.delete(name);
    const file = join(this.dir, `${name}.json`);
    if (existsSync(file)) writeFileSync(file, "", "utf8");
    return `Removed teammate ${name}`;
  }
}

const todo = new TodoManager();
const team = new TeammateManager(join(TEAM_DIR, "roster"));
const bus = new MessageBus();
const system = createSystemPrompt("Coordinate with persistent teammates through async mailboxes.");
const tools = [
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "TodoWrite", description: "Update task tracking list.", input_schema: { type: "object", properties: { items: { type: "array" } }, required: ["items"] } },
  { name: "spawn_teammate", description: "Create a persistent teammate.", input_schema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" } }, required: ["name", "role"] } },
  { name: "team_list", description: "List teammates.", input_schema: { type: "object", properties: {} } },
  { name: "send_message", description: "Send a message to a teammate.", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" } }, required: ["to", "content"] } },
  { name: "read_inbox", description: "Read the lead inbox.", input_schema: { type: "object", properties: {} } }
];

export async function runS09(history: Message[]) {
  await runAgentLoop({
    system,
    tools,
    handlers: {
      bash: ({ command }) => runCommand(command),
      read_file: ({ path, limit }) => readWorkspaceFile(path, limit),
      write_file: ({ path, content }) => writeWorkspaceFile(path, content),
      edit_file: ({ path, old_text, new_text }) => editWorkspaceFile(path, old_text, new_text),
      TodoWrite: ({ items }) => todo.update(items),
      spawn_teammate: ({ name, role }) => team.spawn(name, role),
      team_list: () => team.listAll(),
      send_message: ({ to, content }) => bus.send("lead", to, content),
      read_inbox: () => JSON.stringify(bus.readInbox("lead"), null, 2)
    },
    messages: history,
    todoManager: todo,
    messageBus: bus
  });
}

if (isMainModule(import.meta.url)) {
  await startRepl({ sessionId: "s09", runTurn: runS09 });
}
