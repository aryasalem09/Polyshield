// HTTP client for the Polyshield control plane. Every call is an outbound
// POST to /api/runner with the pairing token as a bearer — the runner never
// listens on anything.
import { hostname } from "node:os";

export class ControlPlaneError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class ControlPlane {
  constructor(baseUrl, token, version) {
    const url = new URL("/api/runner", baseUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new ControlPlaneError(`Refusing to send pairing token over unencrypted connection to ${url.origin}`);
    }
    this.endpoint = url.toString();
    this.token = token;
    this.version = version;
  }

  async #post(body) {
    let res;
    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
        redirect: "error", // Prevent token leakage via redirects
      });
    } catch (err) {
      throw new ControlPlaneError(
        `Could not reach the Polyshield control plane at ${new URL(this.endpoint).host}: ${err?.message ?? err}`,
      );
    }
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new ControlPlaneError(`Control plane returned non-JSON (HTTP ${res.status}).`, res.status);
    }
    if (!res.ok) {
      throw new ControlPlaneError(json.error ?? `Control plane error (HTTP ${res.status}).`, res.status);
    }
    return json;
  }

  /**
   * Heartbeat + report per-server state, receive the stdio server configs
   * (env secrets are released by the control plane only to a paired runner).
   * reports: [{serverId, status?, error?, tools?}]
   */
  async sync(reports = []) {
    return this.#post({
      op: "sync",
      hostname: hostname(),
      version: this.version,
      servers: reports,
    });
  }

  /** Claim up to `max` pending tool-call jobs. */
  async claim(max = 5) {
    return this.#post({ op: "claim", max });
  }

  /** Deliver a job result (or error). */
  async complete(jobId, result, error) {
    return this.#post({ op: "complete", jobId, result, error });
  }
}
