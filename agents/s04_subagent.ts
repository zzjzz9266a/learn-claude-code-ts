import { runSubagent, createSystemPrompt, editWorkspaceFile, isMainModule, readWorkspaceFile, runAgentLoop, runCommand, startRepl, type Message, writeWorkspaceFile } from "../src/core";

const system = createSystemPrompt("Use the task tool to delegate exploration or subtasks.");
const tools = [
  ...[
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } }
],
  {
    name: "task",
    description: "Spawn a subagent with fresh context. It shares the filesystem but not conversation history.",
    input_schema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        description: { type: "string", description: "Short description of the task" }
      },
      required: ["prompt"]
    }
  }
];

export async function runS04(history: Message[]) {
  await runAgentLoop({
    system,
    tools,
    handlers: {
      bash: ({ command }) => runCommand(command),
      read_file: ({ path, limit }) => readWorkspaceFile(path, limit),
      write_file: ({ path, content }) => writeWorkspaceFile(path, content),
      edit_file: ({ path, old_text, new_text }) => editWorkspaceFile(path, old_text, new_text),
      task: ({ prompt }) => runSubagent(prompt, "general-purpose")
    },
    messages: history
  });
}

if (isMainModule(import.meta.url)) {
  await startRepl({ sessionId: "s04", runTurn: runS04 });
}
