/**
 * `npm run dev:live` — everything required for real backend data to reach the
 * frontend, in one command.
 *
 *   1. one-shot upcoming-odds sync, so the Odds tab has real prices on first
 *      paint instead of waiting for the next scheduled run
 *   2. the collector, which serves /api/upcoming-odds and the live SSE stream
 *   3. vite, whose /api proxy points at the collector
 *
 * The sync runs to completion first and is allowed to fail: a provider outage
 * or an exhausted quota should not stop the dashboard from starting against
 * whatever the last successful sync persisted.
 */

import { spawn } from "node:child_process";
import process from "node:process";

const children = new Set();
let shuttingDown = false;

function run(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
  children.add(child);

  const prefix = (line) => `[${name}] ${line}`;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.length > 0) console.log(prefix(line));
    });
  }

  child.on("exit", (code, signal) => {
    children.delete(child);
    if (shuttingDown) return;
    console.log(prefix(`exited (${signal ?? code})`));
    shutdown(code ?? 1);
  });

  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

const liveEnv = { DATA_MODE: "live" };

await new Promise((resolve) => {
  console.log("[sync] priming upcoming odds…");
  const sync = spawn(
    process.execPath,
    ["--env-file-if-exists=.env", "server/syncUpcoming.ts"],
    { stdio: "inherit", env: { ...process.env, ...liveEnv } },
  );
  sync.on("exit", (code) => {
    if (code !== 0) {
      console.log(
        "[sync] priming failed; starting anyway against the last persisted document",
      );
    }
    resolve();
  });
});

run(
  "collector",
  process.execPath,
  ["--env-file-if-exists=.env", "server/collector.ts"],
  liveEnv,
);
run("vite", process.execPath, ["node_modules/vite/bin/vite.js"]);
