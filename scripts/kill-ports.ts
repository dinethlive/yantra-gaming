#!/usr/bin/env bun
import { $ } from "bun";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const ports = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
if (ports.length === 0) {
  console.log("[kill-ports] No ports specified");
  process.exit(0);
}

const isWindows = process.platform === "win32";

// Returns only DYNAMIC Hyper-V/WSL exclusions (no trailing `*`).
// Administered exclusions (marked `*`) don't block listen() — they only exclude ports
// from auto-assignment when binding to port 0, so we ignore them.
async function getWindowsExcludedRanges(): Promise<Array<[number, number]>> {
  const ranges: Array<[number, number]> = [];
  const out = await $`netsh int ipv4 show excludedportrange protocol=tcp`.quiet().nothrow().text();
  for (const line of out.split(/\r?\n/)) {
    const trimmed = line.trim();
    const m = trimmed.match(/^(\d+)\s+(\d+)(\s*\*)?\s*$/);
    if (!m) continue;
    if (m[3]) continue; // administered (starred) — skip
    ranges.push([Number(m[1]), Number(m[2])]);
  }
  return ranges;
}

// Find PIDs whose LOCAL address matches :port, regardless of socket state
// (LISTENING, CLOSE_WAIT, FIN_WAIT, BOUND, etc). A previous dev process —
// or a browser's network-service subprocess that dialed localhost:PORT —
// may hold the socket in a state netstat doesn't surface.
async function findPidsOnPort(port: number): Promise<Set<string>> {
  const pids = new Set<string>();
  if (isWindows) {
    // Get-NetTCPConnection catches the BOUND state that `netstat -ano -p tcp`
    // silently omits. Chromium-based browsers (Brave/Chrome/Edge) are a
    // frequent source of lingering BOUND sockets on the local dev port.
    const psCmd =
      `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue ` +
      `| Select-Object -ExpandProperty OwningProcess`;
    const out = await $`powershell -NoProfile -Command ${psCmd}`
      .quiet()
      .nothrow()
      .text();
    for (const line of out.split(/\r?\n/)) {
      const pid = line.trim();
      if (/^\d+$/.test(pid) && pid !== "0") pids.add(pid);
    }
    // Fall back to netstat as well, in case PowerShell is unavailable on a
    // stripped-down Windows install.
    if (pids.size === 0) {
      const out2 = await $`netstat -ano -p tcp`.quiet().nothrow().text();
      for (const line of out2.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4 || parts[0] !== "TCP") continue;
        const local = parts[1];
        if (!local || !local.endsWith(`:${port}`)) continue;
        const pid = parts[parts.length - 1];
        if (pid && pid !== "0") pids.add(pid);
      }
    }
  } else {
    const out = await $`lsof -ti:${port}`.quiet().nothrow().text();
    for (const pid of out.trim().split(/\r?\n/).filter(Boolean)) pids.add(pid);
  }
  return pids;
}

async function processNameFor(pid: string): Promise<string | undefined> {
  if (isWindows) {
    const out = await $`tasklist /FI ${`PID eq ${pid}`} /FO CSV /NH`
      .quiet()
      .nothrow()
      .text();
    // CSV row: "name.exe","PID","Session","SessionNo","Memory"
    const m = out.match(/^"([^"]+)"/);
    return m?.[1];
  }
  const out = await $`ps -p ${pid} -o comm=`.quiet().nothrow().text();
  return out.trim() || undefined;
}

async function killPid(pid: string): Promise<void> {
  if (isWindows) await $`taskkill /F /PID ${pid}`.quiet().nothrow();
  else await $`kill -9 ${pid}`.quiet().nothrow();
}

// True iff we can actually bind a listening socket on this port right now.
// More reliable than parsing netstat — it's the same syscall concurrently's
// children will make, so agreement here means they'll succeed.
function isBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "0.0.0.0");
  });
}

let excludedRanges: Array<[number, number]> = [];
if (isWindows) excludedRanges = await getWindowsExcludedRanges();

const blocked: Array<{ port: number; range: [number, number] }> = [];
const stuck: number[] = [];

for (const port of ports) {
  if (isWindows) {
    const hit = excludedRanges.find(([s, e]) => port >= s && port <= e);
    if (hit) {
      blocked.push({ port, range: hit });
      console.log(`[kill-ports] port ${port}: BLOCKED by Windows excluded range ${hit[0]}-${hit[1]} (Hyper-V/WSL)`);
      continue;
    }
  }

  const pids = await findPidsOnPort(port);
  for (const pid of pids) {
    const name = await processNameFor(pid);
    await killPid(pid);
    console.log(`[kill-ports] port ${port}: killed PID ${pid}${name ? ` (${name})` : ""}`);
  }

  // Poll bind() until the OS actually releases the port (up to 3s). Handles
  // the case where the killed process hasn't fully torn down its socket yet.
  const deadline = Date.now() + 3000;
  let ready = await isBindable(port);
  while (!ready && Date.now() < deadline) {
    await sleep(100);
    ready = await isBindable(port);
  }

  if (!ready) {
    stuck.push(port);
    console.log(`[kill-ports] port ${port}: STILL IN USE after kill`);
  } else if (pids.size === 0) {
    console.log(`[kill-ports] port ${port}: free`);
  } else {
    console.log(`[kill-ports] port ${port}: released`);
  }
}

if (blocked.length > 0) {
  console.error("");
  console.error("[kill-ports] ERROR: one or more ports are reserved by Windows and CANNOT be bound.");
  console.error("[kill-ports] These ranges are allocated dynamically by Hyper-V/WSL/Docker and change on reboot.");
  console.error("[kill-ports] Fix options:");
  console.error("[kill-ports]   1. Pick a different port (edit .env PORT and vite.config.ts proxies)");
  console.error("[kill-ports]   2. Release all dynamic ranges (admin PowerShell):");
  console.error("[kill-ports]        net stop winnat && net start winnat");
  console.error("[kill-ports]      (temporary — ranges come back on next reboot)");
  console.error("[kill-ports]   3. Permanently reserve your port (admin PowerShell, one-time):");
  for (const { port } of blocked) {
    console.error(`[kill-ports]        netsh int ipv4 add excludedportrange protocol=tcp startport=${port} numberofports=1 mode=persistent`);
  }
  process.exit(1);
}

if (stuck.length > 0) {
  console.error(`[kill-ports] ERROR: ports still in use after kill: ${stuck.join(", ")}`);
  process.exit(1);
}
