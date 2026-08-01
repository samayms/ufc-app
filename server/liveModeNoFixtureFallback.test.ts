import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runUpcomingSync } from "./syncUpcoming.ts";

let scratchDir: string | undefined;

afterEach(() => {
  if (scratchDir) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = undefined;
  }
});

/**
 * `DATA_MODE=live` must hydrate from real provider state and must never
 * silently substitute fixture odds when credentials or providers are
 * unavailable — it should fail loudly instead. `loadConfig` enforces this
 * before any card/provider is ever loaded (see `assertLiveCredentials` in
 * server/config.ts), which is what this test pins down at the
 * `runUpcomingSync` entry point actually used by the scheduler and by
 * `npm run sync:upcoming:live`.
 */
describe("live mode never falls back to fixture odds", () => {
  it("rejects instead of running the fixture path when live credentials are missing", async () => {
    scratchDir = mkdtempSync(join(tmpdir(), "ufc-live-no-fallback-"));
    const env: NodeJS.ProcessEnv = {
      DATA_MODE: "live",
      PERSISTENCE_PATH: scratchDir,
      // Deliberately omit every live credential.
    };

    await expect(runUpcomingSync(env)).rejects.toThrow(
      /Live mode requires server credentials/,
    );
  });

  it("fixture mode (no DATA_MODE set) succeeds without any credentials", async () => {
    scratchDir = mkdtempSync(join(tmpdir(), "ufc-fixture-mode-"));
    const result = await runUpcomingSync({ PERSISTENCE_PATH: scratchDir });
    expect(result.cards).toBeGreaterThan(0);
  });
});
