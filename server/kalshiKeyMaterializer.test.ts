import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { materializeKalshiPrivateKey } from "./kalshiKeyMaterializer.ts";

let scratchDir: string | undefined;

afterEach(() => {
  if (scratchDir) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = undefined;
  }
});

describe("materializeKalshiPrivateKey", () => {
  it("writes KALSHI_PRIVATE_KEY to KALSHI_PRIVATE_KEY_PATH, creating parent dirs, with 0600 perms", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "kalshi-key-"));
    const path = join(scratchDir, "nested", "kalshi_private_key.pem");
    const pem = "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n";

    materializeKalshiPrivateKey({ KALSHI_PRIVATE_KEY: pem, KALSHI_PRIVATE_KEY_PATH: path });

    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(pem);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("does nothing when KALSHI_PRIVATE_KEY is absent", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "kalshi-key-"));
    const path = join(scratchDir, "kalshi_private_key.pem");

    materializeKalshiPrivateKey({ KALSHI_PRIVATE_KEY_PATH: path });

    expect(existsSync(path)).toBe(false);
  });

  it("does not overwrite an existing key file (e.g. already restored on the volume)", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "kalshi-key-"));
    const path = join(scratchDir, "kalshi_private_key.pem");

    materializeKalshiPrivateKey({ KALSHI_PRIVATE_KEY: "first", KALSHI_PRIVATE_KEY_PATH: path });
    materializeKalshiPrivateKey({ KALSHI_PRIVATE_KEY: "second", KALSHI_PRIVATE_KEY_PATH: path });

    expect(readFileSync(path, "utf8")).toBe("first");
  });
});
