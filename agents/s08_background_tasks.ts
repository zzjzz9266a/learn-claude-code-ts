import { BackgroundManager, createSystemPrompt, editWorkspaceFile, isMainModule, readWorkspaceFile, runAgentLoop, runCommand, startRepl, type Message, writeWorkspaceFile } from "../src/core";

const bg = new BackgroundManager();
const system = createSystemPrompt("Use background_run for long-running commands.");
const tools = [
  { name: "bash", description: "Run a shell command (blocking).", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  ...[
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } }
].slice(1),
  { name: "background_run", description: "Run command in background thread. Returns task_id immediately.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "check_background", description: "Check background task status. Omit task_id to list all.", input_schema: { type: "object", properties: { task_id: { type: "string" } } } }
];

export async function runS08(history: Message[]) {
  await runAgentLoop({
    system,
    tools,
    handlers: {
      bash: ({ command }) => runCommand(command),
      read_file: ({ path, limit }) => readWorkspaceFile(path, limit),
      write_file: ({ path, content }) => writeWorkspaceFile(path, content),
      edit_file: ({ path, old_text, new_text }) => editWorkspaceFile(path, old_text, new_text),
      background_run: ({ command }) => bg.run(command),
      check_background: ({ task_id }) => bg.check(task_id)
    },
    messages: history,
    backgroundManager: bg
  });
}

if (isMainModule(import.meta.url)) {
  await startRepl({ sessionId: "s08", runTurn: runS08 });
}
