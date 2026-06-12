// The runner main loop: heartbeat-sync with the control plane, supervise the
// project's stdio MCP servers, discover and report their tools, and execute
// claimed jobs. Everything is outbound polling — kill the process and the
// cloud simply sees the runner go offline.
import { ControlPlane, ControlPlaneError } from "./api.js";
import { ServerProcess, configFingerprint } from "./servers.js";

export const VERSION = "0.1.0";
const SYNC_INTERVAL_MS = 15_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(message) {
  console.log(`[polyshield-runner] ${message}`);
}

export async function runLoop(config) {
  const cp = new ControlPlane(config.url, config.token, VERSION);
  const procs = new Map(); // serverId -> ServerProcess
  let pollIntervalMs = 1500;
  let stopping = false;

  async function reconcile() {
    const response = await cp.sync([]);
    if (typeof response.pollIntervalMs === "number") pollIntervalMs = response.pollIntervalMs;

    const reports = [];
    const seen = new Set();

    for (const cfg of response.servers ?? []) {
      seen.add(cfg.id);
      let proc = procs.get(cfg.id);
      if (proc && proc.fingerprint !== configFingerprint(cfg)) {
        log(`${cfg.prefix}: config changed, restarting`);
        await proc.stop();
        procs.delete(cfg.id);
        proc = null;
      }
      if (!proc) {
        proc = new ServerProcess(cfg, (m) => log(`${cfg.prefix}: ${m}`));
        procs.set(cfg.id, proc);
        try {
          const tools = await proc.listTools();
          log(`${cfg.prefix}: discovered ${tools.length} tool(s)`);
          reports.push({ serverId: cfg.id, status: "connected", tools });
        } catch (err) {
          reports.push({
            serverId: cfg.id,
            status: "error",
            error: String(err?.message ?? err),
          });
        }
      }
    }

    for (const [id, proc] of procs) {
      if (!seen.has(id)) {
        log(`${proc.config.prefix}: removed in dashboard, stopping`);
        await proc.stop();
        procs.delete(id);
      }
    }

    if (reports.length > 0) await cp.sync(reports);
  }

  async function pollJobs() {
    const { jobs } = await cp.claim(5);
    for (const job of jobs ?? []) {
      const proc = procs.get(job.serverId);
      if (!proc) {
        await cp.complete(job.id, null, "This server is not running on the connected runner.");
        continue;
      }
      log(`${proc.config.prefix}: executing ${job.rawName}`);
      try {
        const result = await proc.callTool(job.rawName, job.args ?? {});
        await cp.complete(job.id, result, null);
      } catch (err) {
        await cp.complete(job.id, null, String(err?.message ?? err));
      }
    }
  }

  async function shutdown() {
    if (stopping) return;
    stopping = true;
    log("shutting down…");
    try {
      await cp.sync(
        [...procs.keys()].map((serverId) => ({
          serverId,
          status: "pending",
          error: "runner went offline — restart polyshield-runner to reconnect",
        })),
      );
    } catch {
      // best effort
    }
    for (const proc of procs.values()) await proc.stop();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // First sync doubles as token validation.
  try {
    await reconcile();
  } catch (err) {
    if (err instanceof ControlPlaneError && err.status === 401) {
      log("pairing token rejected. Re-pair from the Polyshield dashboard (Servers → Pair runner).");
      process.exit(1);
    }
    throw err;
  }
  log(`connected to ${new URL(config.url).host} — supervising ${procs.size} stdio server(s)`);
  log("waiting for jobs (Ctrl-C to stop)");

  let lastSync = Date.now();
  while (!stopping) {
    await sleep(pollIntervalMs);
    try {
      await pollJobs();
      if (Date.now() - lastSync > SYNC_INTERVAL_MS) {
        await reconcile();
        lastSync = Date.now();
      }
    } catch (err) {
      log(`loop error: ${err?.message ?? err} (retrying)`);
      await sleep(3_000);
    }
  }
}

/** One-shot connectivity check used by `pair` and `status`. */
export async function checkOnce(config) {
  const cp = new ControlPlane(config.url, config.token, VERSION);
  const response = await cp.sync([]);
  return response.servers ?? [];
}
