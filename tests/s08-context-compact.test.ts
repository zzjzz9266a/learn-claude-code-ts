import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

process.env.MODEL_ID ??= "test-model";

const { ContextCompactor } = await import("../s08_context_compact/code.ts");

const tempDirs: string[] = [];

function createCompactor(): InstanceType<typeof ContextCompactor> {
  const root = mkdtempSync(join(tmpdir(), "s08-compact-"));
  tempDirs.push(root);
  return new ContextCompactor(
    {
      messages: {
        create: async () => {
          throw new Error("summarize_history should not run");
        },
      },
    },
    "test-model",
    join(root, "transcripts"),
    join(root, "tool-results"),
  );
}

function toolPair(tool_id: string, output: string): any[] {
  return [
    {"role": "assistant", "content": [
      {"type": "tool_use", "id": tool_id, "name": "read_file", "input": {}},
    ]},
    {"role": "user", "content": [
      {"type": "tool_result", "tool_use_id": tool_id, "content": output},
    ]},
  ];
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("s08 prepare restores the active request after snip", () => {
  test("leaves a short task unchanged", async () => {
    const compactor = createCompactor();
    const active_request = "inspect the repository";
    const messages = [
      {"role": "user", "content": active_request},
      {"role": "assistant", "content": [
        {"type": "text", "text": "done"},
      ]},
    ];

    const prepared = await compactor.prepare(messages, active_request);

    expect(prepared).toBe(messages);
  });

  test("keeps the active request after repeated snip compact", async () => {
    const compactor = createCompactor();
    const active_request = "compare s08_context_compact/code.ts and s09_memory/code.ts";
    const messages = [
      {"role": "user", "content": "read the first five lesson READMEs"},
      {"role": "assistant", "content": [
        {"type": "text", "text": "first answer"},
      ]},
      {"role": "user", "content": "analyze docs.json"},
      {"role": "assistant", "content": [
        {"type": "text", "text": "second answer"},
      ]},
      {"role": "user", "content": active_request},
    ];
    for (let index = 0; index < 23; index += 1) {
      messages.push(...toolPair(`current-tool-${index}`, `result-${index}`));
    }
    compactor.summarize_history = async () => {
      throw new Error("snip compact should be enough");
    };

    let prepared = await compactor.prepare(messages, active_request);
    prepared.push(...toolPair("current-tool-after-first-snip", "more-current-work"));
    prepared = await compactor.prepare(prepared, active_request);

    const request_marker = `Current user request:\n${active_request}`;
    const visible_requests = prepared
      .filter((message) => (
        message.role === "user"
        && typeof message.content === "string"
        && (message.content === active_request || message.content.includes(request_marker))
      ))
      .map((message) => message.content);
    expect(visible_requests).toHaveLength(1);
    expect(prepared.some((message) => compactor.is_archive_marker(message))).toBe(true);
    prepared.forEach((message, index) => {
      if (!compactor.is_tool_result(message)) return;
      expect(index).toBeGreaterThan(0);
      expect(compactor.has_tool_use(prepared[index - 1])).toBe(true);
    });
  });

  test.each([
    ["review code and rewrite it", true],
    ["review code", false],
  ] as const)(
    "matches the complete request in a retained summary (%j)",
    async (previous_request, expected_restored) => {
      const compactor = createCompactor();
      const request = "review code";
      const summary = compactor.summary_message(
        "Compacted",
        previous_request,
        "previous work",
        join(tempDirs[tempDirs.length - 1], "old.jsonl"),
      );
      const messages = [
        summary,
        {"role": "assistant", "content": [{"type": "text", "text": "done"}]},
        {"role": "user", "content": "earlier question"},
        {"role": "assistant", "content": [{"type": "text", "text": "done"}]},
        {"role": "user", "content": request},
      ];
      for (let index = 0; index < 30; index += 1) {
        messages.push(...toolPair(`summary-tool-${index}`, "ok"));
      }

      const prepared = await compactor.prepare(messages, request);

      expect(prepared).toContain(summary);
      expect(prepared.some((message) => message.content === request)).toBe(expected_restored);
    },
  );
});
