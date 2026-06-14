// Supervision of local stdio MCP servers. Each registered server gets one
// child process, spoken to over the official MCP SDK stdio client. Secrets
// (env values) arrive from the control plane over TLS and exist only in this
// process's memory and the child's environment — they are never written to
// disk and never travel back out.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  assertPathArgsInScope,
  buildEnv,
  resolveLaunch,
  scopeEnforced,
  scopeRootFor,
  wallLimitMs,
} from "./sandbox.js";

/** Stable fingerprint of a server config so we restart when it changes. */
export function configFingerprint(config) {
  return JSON.stringify([
    config.command,
    config.args,
    config.env,
    config.envPassthrough,
    config.cwd,
    config.sandbox,
  ]);
}

export class ServerProcess {
  constructor(config, log) {
    this.config = config;
    this.fingerprint = configFingerprint(config);
    this.log = log;
    this.client = null;
    this.startError = null;
    // The scope root is also the child's working directory, so a tool's
    // relative paths resolve inside the sandbox by construction.
    this.scopeRoot = scopeRootFor(config);
    this.enforceScope = scopeEnforced(config);
  }

  async start() {
    const env = buildEnv(this.config);
    const launch = resolveLaunch(this.config, this.scopeRoot);
    this.containerized = launch.containerized;
    if (launch.fellBack) {
      this.log("containerize requested but Docker is unavailable — running directly (declared, not enforced)");
    }

    const transport = new StdioClientTransport({
      command: launch.command,
      args: launch.args,
      env,
      // In a container the working dir is the in-container mount (-w /work);
      // direct launches pin cwd to the scope root.
      cwd: launch.containerized ? undefined : this.scopeRoot || undefined,
      stderr: "ignore",
    });
    const client = new Client(
      { name: "polyshield-runner", version: "0.1.0" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      this.client = client;
      this.startError = null;
      this.log(
        `started${this.containerized ? " (containerized)" : ""}: ${this.config.command} ${(this.config.args ?? []).join(" ")}`.trim(),
      );
    } catch (err) {
      this.client = null;
      this.startError = err?.message ?? String(err);
      this.log(`failed to start: ${this.startError}`);
      try {
        await transport.close();
      } catch {
        // already dead
      }
    }
  }

  async ensureStarted() {
    if (!this.client) await this.start();
    return this.client !== null;
  }

  async listTools() {
    if (!(await this.ensureStarted())) {
      throw new Error(this.startError ?? "server not running");
    }
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await this.client.listTools(cursor ? { cursor } : {});
      for (const t of result.tools ?? []) {
        tools.push({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        });
      }
      cursor = result.nextCursor;
      if (!cursor || tools.length >= 500) break;
    }
    return tools;
  }

  async callTool(name, args) {
    // Filesystem scope: refuse path args that escape the scope BEFORE the
    // child runs, so a scoped server can't be steered outside its root.
    if (this.enforceScope) assertPathArgsInScope(args, this.scopeRoot);

    if (!(await this.ensureStarted())) {
      throw new Error(this.startError ?? "server not running");
    }
    const timeout = wallLimitMs(this.config);
    let result;
    try {
      result = await this.client.callTool({ name, arguments: args ?? {} }, undefined, { timeout });
    } catch (err) {
      // One restart-and-retry: stdio children die (crash, idle exit) and the
      // next call should not require a human.
      this.log(`call failed (${err?.message ?? err}); restarting child`);
      await this.stop();
      if (!(await this.ensureStarted())) {
        throw new Error(this.startError ?? "server not running");
      }
      result = await this.client.callTool({ name, arguments: args ?? {} }, undefined, { timeout });
    }
    return {
      content: Array.isArray(result?.content) ? result.content : [],
      structuredContent: result?.structuredContent,
      isError: result?.isError === true,
    };
  }

  async stop() {
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // already closed
      }
      this.client = null;
    }
  }
}
