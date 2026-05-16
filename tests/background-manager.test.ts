import { describe, expect, test } from "vitest";
import { BackgroundManager } from "../src/core/reference-agent";

describe("BackgroundManager", () => {
  test("blocks dangerous background commands before spawning a task", () => {
    const manager = new BackgroundManager();

    expect(manager.run("sudo reboot")).toBe("Error: Dangerous command blocked");
    expect(manager.tasks.size).toBe(0);
  });

  test("check returns command and running placeholder when result is null", () => {
    const manager = new BackgroundManager();
    manager.tasks.set("abc123", {
      status: "running",
      command: "sleep 1",
      result: null
    });

    expect(manager.check("abc123")).toBe("[running] sleep 1\n(running)");
  });
});
