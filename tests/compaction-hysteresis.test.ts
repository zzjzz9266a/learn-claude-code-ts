import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";

process.env.MODEL_ID ??= "test-model";
process.env.ANTHROPIC_API_KEY ??= "test-key";

const { ContextCompactor } = await import("../s08_context_compact/code.ts");

const s15Root = mkdtempSync(join(tmpdir(), "s15-hysteresis-"));
const previousCwd = process.cwd();
process.chdir(s15Root);
const s15 = await import("../s15_integrated_harness/code.ts");
process.chdir(previousCwd);
const s15TranscriptDir = join(realpathSync(s15Root), ".transcripts");

const tempDirs: string[] = [];

type Chapter = {
  name: string;
  transcriptDir: string;
  prepare: (messages: any[], activeRequest?: string) => Promise<any[]>;
  snip: (messages: any[], trigger_messages: number, target_messages: number) => any[];
};

function createS08(): Chapter {
  const root = mkdtempSync(join(tmpdir(), "s08-hysteresis-"));
  tempDirs.push(root);
  const compactor = new ContextCompactor(
    {messages: {create: async () => { throw new Error("summarize_history should not run"); }}},
    "test-model",
    join(root, "transcripts"),
    join(root, "tool-results"),
  );
  return {
    name: "s08",
    transcriptDir: compactor.transcript_dir,
    prepare: (messages, activeRequest = "continue") => compactor.prepare(messages, activeRequest),
    snip: (messages, trigger_messages, target_messages) => compactor.snip_compact(messages, trigger_messages, target_messages),
  };
}

function createS15(): Chapter {
  rmSync(s15TranscriptDir, { recursive: true, force: true });
  return {
    name: "s15",
    transcriptDir: s15TranscriptDir,
    prepare: (messages, activeRequest = "continue") => s15.prepare_context(messages, activeRequest),
    snip: (messages, trigger_messages, target_messages) => s15.snip_compact(messages, trigger_messages, target_messages),
  };
}

function chapters(): Chapter[] {
  return [createS08(), createS15()];
}

function userText(): any {
  return {"role": "user", "content": "continue"};
}

function assistantText(): any {
  return {"role": "assistant", "content": [{"type": "text", "text": "ok"}]};
}

function toolUseMessage(tool_id = "tool-1"): any {
  return {
    "role": "assistant",
    "content": [{"type": "tool_use", "id": tool_id, "name": "bash"}],
  };
}

function toolResultMessage(tool_id = "tool-1"): any {
  return {
    "role": "user",
    "content": [{"type": "tool_result", "tool_use_id": tool_id, "content": "ok"}],
  };
}

function archives(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();
}

function jsonlCount(file: string): number {
  return readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0).length;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(s15TranscriptDir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(s15Root, { recursive: true, force: true });
});

describe("snip compact hysteresis", () => {
  test("leaves room before archiving again", async () => {
    for (const chapter of chapters()) {
      let messages = Array.from({length: 49}, (_, index) => index % 2 === 0 ? userText() : assistantText());
      expect(await chapter.prepare(messages), chapter.name).toBe(messages);
      expect(existsSync(chapter.transcriptDir), chapter.name).toBe(false);

      messages.push(assistantText());
      const original = messages.slice();
      messages = await chapter.prepare(messages);
      expect(messages, chapter.name).toHaveLength(30);
      expect(messages.slice(0, 3), chapter.name).toEqual(original.slice(0, 3));
      expect(messages.slice(-26), chapter.name).toEqual(original.slice(-26));
      const firstArchives = archives(chapter.transcriptDir);
      expect(firstArchives, chapter.name).toHaveLength(1);
      expect(jsonlCount(join(chapter.transcriptDir, firstArchives[0])), chapter.name).toBe(50);

      for (let index = 0; index < 9; index += 1) {
        messages.push(userText(), assistantText());
        messages = await chapter.prepare(messages);
        expect(archives(chapter.transcriptDir), chapter.name).toEqual(firstArchives);
      }

      messages.push(userText(), assistantText());
      messages = await chapter.prepare(messages);
      expect(messages, chapter.name).toHaveLength(30);
      expect(archives(chapter.transcriptDir), chapter.name).toHaveLength(2);
    }
  });

  test("handles a threshold overshoot", () => {
    for (const chapter of chapters()) {
      const messages = Array.from({length: 55}, () => userText());
      const compacted = chapter.snip(messages, 50, 30);
      expect(compacted, chapter.name).toHaveLength(30);
      expect(compacted.at(-1), chapter.name).toEqual(messages.at(-1));
      const saved = archives(chapter.transcriptDir);
      expect(saved, chapter.name).toHaveLength(1);
      expect(jsonlCount(join(chapter.transcriptDir, saved[0])), chapter.name).toBe(55);
    }
  });

  test("rejects invalid thresholds", () => {
    for (const chapter of chapters()) {
      for (const [trigger, target] of [[50, 4], [30, 30], [20, 30]] as const) {
        expect(
          () => chapter.snip([], trigger, target),
          `${chapter.name} ${trigger}/${target}`,
        ).toThrow(/Require 5 <= target_messages < trigger_messages/);
      }
      expect(existsSync(chapter.transcriptDir), chapter.name).toBe(false);
    }
  });

  test("keeps the head tool pair", () => {
    const messages = [
      userText(),
      assistantText(),
      toolUseMessage("head-tool"),
      toolResultMessage("head-tool"),
      assistantText(),
      userText(),
      assistantText(),
      userText(),
      assistantText(),
      userText(),
    ];
    for (const chapter of chapters()) {
      const compacted = chapter.snip(messages.slice(), 7, 6);
      expect(compacted[2], chapter.name).toEqual(messages[2]);
      expect(compacted[3], chapter.name).toEqual(messages[3]);
      expect(compacted, chapter.name).toHaveLength(7);
      expect(chapter.snip(compacted.slice(), 7, 6), chapter.name).toEqual(compacted);
      expect(archives(chapter.transcriptDir), chapter.name).toHaveLength(1);
    }
  });

  test("keeps the tail tool pair", () => {
    const messages = [
      userText(),
      assistantText(),
      userText(),
      assistantText(),
      userText(),
      assistantText(),
      toolUseMessage("tail-tool"),
      toolResultMessage("tail-tool"),
      assistantText(),
      userText(),
    ];
    for (const chapter of chapters()) {
      const compacted = chapter.snip(messages.slice(), 9, 7);
      expect(compacted, chapter.name).toHaveLength(8);
      expect(compacted.slice(-4), chapter.name).toEqual(messages.slice(-4));
    }
  });
});
