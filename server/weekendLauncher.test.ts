import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("real-app launcher", () => {
  it("launches the production app without the lab or development server", () => {
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
    expect(result.stdout).not.toContain("latency lab");
    expect(result.stdout).toContain("Ports 5055 and 5173 are not used.");
  });
});
