// Supervision of local stdio MCP servers. Each registered server gets one
// child process, spoken to over the official MCP SDK stdio client. Secrets
// (env values) arrive from the control plane over TLS and exist only in this
// process's memory and the child's environment — they are never written to
// disk and never travel back out.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const CALL_TIMEOUT_MS = 50_000;

/** Stable fingerprint of a server config so we restart when it changes. */
export function configFingerprint(config) {
  return JSON.stringify([
    config.command,
    config.args,
    config.env,
    config.envPassthrough,
    config.cwd,
  ]);
}

export class ServerProcess {
  constructor(config, log) {
    this.config = config;
    this.fingerprint = configFingerprint(config);
    this.log = log;
    this.client = null;
    this.startError = null;
  }

  async start() {
    const env = { ...getDefaultEnvironment() };
    for (const key of this.config.envPassthrough ?? []) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    Object.assign(env, this.config.env ?? {});

    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args ?? [],
      env,
      cwd: this.config.cwd || undefined,
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
      this.log(`started: ${this.config.command} ${(this.config.args ?? []).join(" ")}`.trim());
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
    if (!(await this.ensureStarted())) {
      throw new Error(this.startError ?? "server not running");
    }
    let result;
    try {
      result = await this.client.callTool(
        { name, arguments: args ?? {} },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      );
    } catch (err) {
      // One restart-and-retry: stdio children die (crash, idle exit) and the
      // next call should not require a human.
      this.log(`call failed (${err?.message ?? err}); restarting child`);
      await this.stop();
      if (!(await this.ensureStarted())) {
        throw new Error(this.startError ?? "server not running");
      }
      result = await this.client.callTool(
        { name, arguments: args ?? {} },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      );
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
