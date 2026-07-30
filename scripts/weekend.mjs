/**
 * One-command fight-day launcher.
 *
 * `npm run weekend` owns the complete local production stack:
 *   - independent latency lab on 5055
 *   - best-effort live upcoming-odds prime
 *   - compiled dashboard build
 *   - live collector on 8600
 *   - compiled dashboard server on 4173
 *   - readiness checks and browser opening
 *
 * It intentionally never starts Vite's development server on 5173.
 */

import { spawn } from "node:child_process";
import process from "node:process";

export const WEEKEND_DASHBOARD_URL = "http://127.0.0.1:4173";
export const WEEKEND_LAB_URL = "http://127.0.0.1:5055";
export const WEEKEND_COLLECTOR_URL = "http://127.0.0.1:8600";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const shouldOpenBrowser = !args.has("--no-open");
const liveEnv = { DATA_MODE: "live" };
const residents = new Map();
let shuttingDown = false;

function usage() {
  console.log(`Usage: npm run weekend -- [--no-open | --dry-run]

Starts the compiled weekend dashboard and every service it needs.

  Dashboard  ${WEEKEND_DASHBOARD_URL}
  Lab        ${WEEKEND_LAB_URL}
  Collector  ${WEEKEND_COLLECTOR_URL}

Options:
  --no-open  Start everything without opening browser tabs
  --dry-run  Print the launch sequence without running anything`);
}

function printPlan() {
  console.log(`Weekend launch sequence:
  1. Start independent latency lab on 5055
  2. Prime live upcoming odds (best effort)
  3. Build the compiled dashboard
  4. Start live collector on 8600
  5. Serve compiled dashboard on 4173
  6. Health-check all three services
  7. Open ${WEEKEND_DASHBOARD_URL} and ${WEEKEND_LAB_URL}

Port 5173 is not used.`);
}

function pipeWithPrefix(name, stream) {
  stream.setEncoding("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length > 0) console.log(`[${name}] ${line}`);
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) console.log(`[${name}] ${buffer}`);
  });
}

function startResident(name, command, commandArgs, extraEnv = {}) {
  const child = spawn(command, commandArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
  residents.set(name, child);
  pipeWithPrefix(name, child.stdout);
  pipeWithPrefix(name, child.stderr);

  child.on("exit", (code, signal) => {
    residents.delete(name);
    if (shuttingDown) return;
    console.error(`[${name}] stopped unexpectedly (${signal ?? code})`);
    shutdown(code === null || code === 0 ? 1 : code);
  });
  child.on("error", (error) => {
    residents.delete(name);
    if (shuttingDown) return;
    console.error(`[${name}] could not start: ${error.message}`);
    shutdown(1);
  });
  return child;
}

function runStep(name, command, commandArgs, extraEnv = {}) {
  console.log(`[weekend] ${name}…`);
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, commandArgs, {
      stdio: "inherit",
      env: { ...process.env, ...extraEnv },
    });
    residents.set(`step:${name}`, child);
    const finish = (code) => {
      if (settled) return;
      settled = true;
      residents.delete(`step:${name}`);
      resolve(code);
    };
    child.on("exit", (code) => {
      finish(code ?? 1);
    });
    child.on("error", (error) => {
      console.error(`[weekend] ${name} could not start: ${error.message}`);
      finish(1);
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForUrl(name, url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!shuttingDown && Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        console.log(`[weekend] ${name} ready`);
        return;
      }
    } catch {
      // The service is still starting.
    }
    await delay(250);
  }
  throw new Error(`${name} did not become ready at ${url}`);
}

function openBrowserTabs() {
  if (!shouldOpenBrowser) return;
  if (process.platform !== "darwin") {
    console.log("[weekend] Open the dashboard and lab URLs shown below.");
    return;
  }
  const opener = spawn(
    "open",
    [WEEKEND_DASHBOARD_URL, WEEKEND_LAB_URL],
    { stdio: "ignore", detached: true },
  );
  opener.on("error", () => {
    console.log("[weekend] Browser could not be opened automatically.");
  });
  opener.unref();
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of residents.values()) {
    child.kill("SIGTERM");
  }
  process.exitCode = code;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log("\n[weekend] Stopping dashboard, collector, and lab…");
    shutdown(0);
  });
}

async function main() {
  if (args.has("--help") || args.has("-h")) {
    usage();
    return;
  }
  if (dryRun) {
    printPlan();
    return;
  }

  console.log("[weekend] Starting UFC weekend mode");
  startResident(
    "lab",
    process.execPath,
    ["--env-file-if-exists=.env", "server/lab/server.ts"],
  );

  const syncCode = await runStep(
    "Priming live upcoming odds",
    process.execPath,
    ["--env-file-if-exists=.env", "server/syncUpcoming.ts"],
    liveEnv,
  );
  if (shuttingDown) return;
  if (syncCode !== 0) {
    console.warn(
      "[weekend] Odds prime failed; continuing with the last saved prices.",
    );
  }

  const buildCode = await runStep(
    "Building compiled dashboard",
    "npm",
    ["run", "build"],
  );
  if (shuttingDown) return;
  if (buildCode !== 0) {
    throw new Error("Compiled dashboard build failed");
  }

  startResident(
    "collector",
    process.execPath,
    ["--env-file-if-exists=.env", "server/collector.ts"],
    liveEnv,
  );
  startResident(
    "dashboard",
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      "4173",
      "--strictPort",
    ],
  );

  await Promise.all([
    waitForUrl("lab", `${WEEKEND_LAB_URL}/lab/health`),
    waitForUrl("collector", `${WEEKEND_COLLECTOR_URL}/api/health`, 60_000),
    waitForUrl("compiled dashboard", WEEKEND_DASHBOARD_URL),
  ]);
  if (shuttingDown) return;

  console.log(`
[weekend] Ready for fight day
  Dashboard  ${WEEKEND_DASHBOARD_URL}
  Lab        ${WEEKEND_LAB_URL}

Keep this terminal open. Press Ctrl-C once to stop everything.`);
  openBrowserTabs();
}

main().catch((error) => {
  console.error(
    `[weekend] ${error instanceof Error ? error.message : "Launch failed"}`,
  );
  shutdown(1);
});
