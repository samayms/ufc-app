/**
 * Reconstructs the Kalshi RSA private key file on disk from an encrypted
 * Fly secret at process startup.
 *
 * `KALSHI_PRIVATE_KEY_PATH` (see server/config.ts, server/kalshiTransport.ts)
 * is a filesystem path the Kalshi live transport reads a PEM key from. In
 * local dev that path points at a file already on disk. On Fly there is no
 * such file baked into the image or volume, so instead of uploading a
 * local-only path as a secret, the PEM contents themselves are stored as
 * the `KALSHI_PRIVATE_KEY` secret and written to `KALSHI_PRIVATE_KEY_PATH`
 * here, once, before anything else reads it. The key is never logged.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function materializeKalshiPrivateKey(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const pem = env.KALSHI_PRIVATE_KEY;
  const path = env.KALSHI_PRIVATE_KEY_PATH;

  if (!pem || !path) return;
  if (existsSync(path)) return; // Volume already has it from a prior boot.

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, pem, { mode: 0o600 });
}
