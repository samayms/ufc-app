import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("weekend launcher", () => {
  it("documents the complete production launch without using port 5173", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/weekend.mjs", "--dry-run"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("compiled dashboard on 4173");
    expect(result.stdout).toContain("live collector on 8600");
    expect(result.stdout).toContain("latency lab on 5055");
    expect(result.stdout).toContain("Port 5173 is not used.");
  });
});
