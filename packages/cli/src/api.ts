import { gzipSync } from "node:zlib";
import type { SignedEnvelope } from "@builder/types";
import { solveChallenge } from "@builder/upload";

/**
 * The ONLY module in the collector that performs network I/O.
 *
 * The README argues the CLI structurally cannot reach a cloud provider, and
 * that argument used to rest on a missing dependency edge — there was no
 * `fetch` anywhere in `packages/cli`. Publishing requires one, so the guarantee
 * is restated rather than quietly abandoned: the collector reaches exactly one
 * host, taken from `config.api_base_url`, from exactly one file. A test walks
 * `packages/cli/src` and fails the build if `fetch(` appears anywhere else.
 *
 * A token is never placed in a URL. It travels in an Authorization header, so
 * it cannot reach an access log, a CDN, or a Referer.
 */

export class ApiRequestError extends Error {
  override readonly name = "ApiRequestError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface DeviceCredentials {
  device_id: string;
  device_token: string;
  key_id: string;
  key_secret: string;
}

export interface UploadResponse {
  status: "published" | "duplicate";
  proof_score: number;
  provisional_rank: number;
  ranked_population: number;
  claimed: boolean;
  handle: string | null;
  claim?: { code: string; expires_at: number };
}

export interface ClaimResponse {
  code?: string;
  expires_at?: number;
  already_claimed?: boolean;
}

/**
 * Timeouts, per request rather than one number for everything.
 *
 * The small endpoints answer in milliseconds and a short deadline is what
 * makes a wrong base URL fail fast instead of hanging. The upload does not
 * belong in that category: it carries nine megabytes of evidence and the
 * server rebuilds episodes and rescores 109,000 events before it answers.
 *
 * A flat 20s got this exactly wrong once. The server logged
 * "POST /api/v1/uploads 200 in 20006ms" while the client reported the host
 * unreachable, so a publish that had fully succeeded was announced as a
 * failure. Aborting a write the server is still committing is the worst
 * shape of timeout available, because the retry is the only thing standing
 * between that and a duplicate.
 */
const TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 180_000;

export class ApiClient {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(
    path: string,
    init: RequestInit & { token?: string; timeoutMs?: number },
  ): Promise<T> {
    const { token, timeoutMs: _t, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("content-type", "application/json");
    if (token !== undefined) headers.set("authorization", `Bearer ${token}`);

    let res: Response;
    try {
      res = await fetch(new URL(path, this.baseUrl), {
        ...rest,
        headers,
        signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (err) {
      // A refused connection is by far the most likely failure in development,
      // and "fetch failed" tells nobody anything.
      throw new ApiRequestError(
        0,
        "unreachable",
        `Could not reach ${this.baseUrl}. Is the server running? (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
    }

    const text = await res.text();
    const body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      throw new ApiRequestError(
        res.status,
        typeof body.error === "string" ? body.error : "http_error",
        typeof body.message === "string" ? body.message : `Request failed with ${res.status}.`,
      );
    }
    return body as T;
  }

  /**
   * Register, solving a proof of work only if this server asks for one.
   *
   * The challenge is fetched first because it is free and stateless, and its
   * `bits` is how the server says whether it wants work at all. At zero, which
   * is the default, `solveChallenge` returns on its first attempt and this
   * costs one extra request. A server that has not deployed the endpoint at
   * all still works: the failure is caught and registration proceeds exactly
   * as it did before, so a new client never breaks against an old deployment.
   */
  async registerDevice(clientVersion: string): Promise<DeviceCredentials> {
    let proof: { challenge: string; solution: string } | undefined;
    try {
      const c = await this.request<{ challenge?: string; bits?: number }>(
        "/api/v1/devices/challenge",
        { method: "GET" },
      );
      if (typeof c.challenge === "string") {
        proof = { challenge: c.challenge, solution: solveChallenge(c.challenge, c.bits ?? 0) };
      }
    } catch {
      // An older server has no such endpoint. Nothing to prove.
    }

    return this.request<DeviceCredentials>("/api/v1/devices", {
      method: "POST",
      body: JSON.stringify({ client_version: clientVersion, ...proof }),
    });
  }

  async nonce(token: string): Promise<{ nonce: string; expires_at: number }> {
    return this.request("/api/v1/uploads/nonce", { method: "POST", token, body: "{}" });
  }

  /** Sessions the server already has, so a later publish sends only what is new. */
  async knownSessions(token: string): Promise<string[]> {
    const r = await this.request<{ session_ids?: string[] }>("/api/v1/uploads/known", {
      method: "POST",
      token,
      body: "{}",
    });
    return r.session_ids ?? [];
  }

  async startClaim(token: string): Promise<ClaimResponse> {
    return this.request<ClaimResponse>("/api/v1/claims", { method: "POST", token, body: "{}" });
  }

  /** Ask the server to forget this machine. Used when a publish is declined. */
  async unlinkDevice(token: string): Promise<{ unlinked: boolean }> {
    return this.request("/api/v1/devices/unlink", { method: "POST", token, body: "{}" });
  }

  async forgetDevice(token: string): Promise<{ forgotten: boolean }> {
    return this.request("/api/v1/devices/forget", { method: "POST", token, body: "{}" });
  }

  /**
   * The evidence upload, compressed.
   *
   * A year of heavy use is ~56 MB of JSON and ~8 MB gzipped. Sending it raw
   * would be rude on a hotel connection and would hit the body cap; the
   * structure is highly repetitive, so it compresses about seven to one.
   */
  async upload(token: string, envelope: SignedEnvelope): Promise<UploadResponse> {
    const body = gzipSync(new TextEncoder().encode(JSON.stringify(envelope)));
    return this.request<UploadResponse>("/api/v1/uploads", {
      method: "POST",
      token,
      body,
      headers: { "content-encoding": "gzip" },
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
  }
}
