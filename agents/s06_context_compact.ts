import {
  createClient,
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

const client = createClient();
const system = createSystemPrompt("Use tools to solve tasks.");
const tools = [
  ...[
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } }
],
  {
    name: "compact",
    description: "Trigger manual conversation compression.",
    input_schema: { type: "object", properties: { focus: { type: "string", description: "What to preserve in the summary" } } }
  }
];

export async function runS06(history: Message[]) {
  await runAgentLoop({
    system,
    tools,
    handlers: {
      bash: ({ command }) => runCommand(command),
      read_file: ({ path, limit }) => readWorkspaceFile(path, limit),
      write_file: ({ path, content }) => writeWorkspaceFile(path, content),
      edit_file: ({ path, old_text, new_text }) => editWorkspaceFile(path, old_text, new_text),
      compact: () => "Manual compression requested."
    },
    messages: history,
    compressClient: client,
    compact: true,
    compactPrefix: "Conversation compressed",
    tokenThreshold: 50_000
  });
}

if (isMainModule(import.meta.url)) {
  await startRepl({ sessionId: "s06", runTurn: runS06 });
}
