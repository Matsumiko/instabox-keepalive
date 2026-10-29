// Core keepalive logic, shared by the Cloudflare Worker and the local runner.
//
// One round per machine: read its state, wake it when it is not running, then
// renew an activity lease. The lease is what keeps instabox from pausing an idle
// machine, and the lease can only do its job while the machine runs.

export const DEFAULT_API = "https://api.instabox.sh";

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? "").trim());

export function config(env = {}) {
  const key = String(env.INSTABOX_API_KEY ?? "").trim();
  if (!key) throw new Error("INSTABOX_API_KEY is not set");
  const refs = String(env.MACHINES ?? env.MACHINE ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ttl = Number(env.TTL ?? 900);
  return {
    api: String(env.INSTABOX_API_URL || DEFAULT_API).replace(/\/+$/, ""),
    key,
    // Empty list means "every machine this key can see".
    refs,
    lease: String(env.LEASE ?? "keepalive").trim() || "keepalive",
    // The API takes 30..3600; anything else is refused with a 400.
    ttl: Number.isFinite(ttl) ? Math.min(3600, Math.max(30, Math.trunc(ttl))) : 900,
    dryRun: truthy(env.DRY_RUN),
    wakePolls: Number(env.WAKE_POLLS ?? 6),
    wakeDelayMs: Number(env.WAKE_DELAY_MS ?? 4000),
    retries: Number(env.RETRIES ?? 3),
  };
}

async function callOnce(cfg, method, path, body, fetchImpl) {
  const headers = { "X-API-Key": cfg.key };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // State-changing calls need an Idempotency-Key; the lease endpoints and
  // lifecycle endpoints are both state-changing.
  if (method === "POST" || method === "PUT" || method === "DELETE") {
    headers["Idempotency-Key"] = crypto.randomUUID();
  }
  const res = await fetchImpl(cfg.api + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json, text: text.slice(0, 300) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One request, retried on the failures that are worth retrying: a dropped
 * connection and 429/5xx. A keepalive round that fails on a single network blip
 * would leave the lease to expire, so it is worth three tries. The
 * Idempotency-Key is generated per attempt, which is safe here: renewing a lease
 * and starting a machine are both idempotent in effect.
 */
async function call(cfg, method, path, body, fetchImpl = fetch) {
  const attempts = Math.max(1, Number(cfg.retries ?? 3));
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(400 * 2 ** (attempt - 1));
    try {
      const r = await callOnce(cfg, method, path, body, fetchImpl);
      if (r.status === 429 || r.status >= 500) {
        lastError = r;
        continue;
      }
      return r;
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError instanceof Error) {
    const cause = lastError.cause?.code || lastError.cause?.message;
    throw new Error(`${method} ${path} failed: ${lastError.message}${cause ? ` (${cause})` : ""}`);
  }
  return lastError;
}

const errorText = (r) => r.json?.error?.message || r.text || `HTTP ${r.status}`;

/** GET /v1/machines, following nextCursor. Returns [{id, name, state}]. */
export async function listMachines(cfg, fetchImpl = fetch) {
  const out = [];
  let cursor = "";
  for (let page = 0; page < 20; page++) {
    const path = "/v1/machines" + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : "");
    const r = await call(cfg, "GET", path, undefined, fetchImpl);
    if (!r.ok) throw new Error(`listing machines failed: ${errorText(r)}`);
    for (const m of r.json?.machines || []) out.push({ id: m.id, name: m.name, state: m.state });
    cursor = r.json?.nextCursor || "";
    if (!cursor) break;
  }
  return out;
}

/** GET /v1/machines/{ref}; the API takes a machine ID or its name. */
export async function inspect(cfg, ref, fetchImpl = fetch) {
  const r = await call(cfg, "GET", `/v1/machines/${encodeURIComponent(ref)}`, undefined, fetchImpl);
  if (!r.ok) throw new Error(`machine ${ref}: ${errorText(r)}`);
  return { id: r.json.id, name: r.json.name, state: r.json.state };
}


/**
 * Bring a machine back to running. `resume` keeps memory and processes and is
 * what a paused machine needs; `start` is the fallback for a stopped one.
 */
export async function wake(cfg, id, fetchImpl = fetch) {
  const sent = [];
  let lastState = null;
  for (const action of ["resume", "start"]) {
    const r = await call(cfg, "POST", `/v1/machines/${id}/${action}`, undefined, fetchImpl);
    sent.push(`${action}:${r.status}`);
    // 202 queued the operation. Anything else (409 not_paused / already_running,
    // 5xx) means this action did nothing, so try the next one before polling.
    if (r.status === 202) break;
  }
  for (let attempt = 0; attempt < cfg.wakePolls; attempt++) {
    await sleep(cfg.wakeDelayMs);
    lastState = (await inspect(cfg, id, fetchImpl)).state;
    if (lastState === "running") return { ok: true, sent, state: lastState };
  }
  return { ok: false, sent, state: lastState };
}

/** PUT the lease. It is accepted even while the machine is suspended. */
export async function renew(cfg, id, fetchImpl = fetch) {
  return call(
    cfg,
    "PUT",
    `/v1/machines/${id}/activity-leases/${encodeURIComponent(cfg.lease)}`,
    { ttlSeconds: cfg.ttl },
    fetchImpl,
  );
}

export async function dropLease(cfg, id, fetchImpl = fetch) {
  return call(
    cfg,
    "DELETE",
    `/v1/machines/${id}/activity-leases/${encodeURIComponent(cfg.lease)}`,
    undefined,
    fetchImpl,
  );
}

async function keepOne(cfg, ref, fetchImpl) {
  const out = { machine: ref };
  try {
    const info = await inspect(cfg, ref, fetchImpl);
    out.id = info.id;
    out.name = info.name;
    out.state = info.state;

    if (cfg.dryRun) return { ...out, ok: true, dryRun: true };

    if (info.state !== "running") {
      const woken = await wake(cfg, info.id, fetchImpl);
      out.wake = woken.sent;
      out.state = woken.state;
      if (!woken.ok) {
        return { ...out, ok: false, error: `still ${woken.state ?? "unknown"} after wake` };
      }
    }

    const lease = await renew(cfg, info.id, fetchImpl);
    out.leaseStatus = lease.status;
    if (lease.ok) {
      out.expiresAt = lease.json?.expiresAt;
      return { ...out, ok: true };
    }
    return { ...out, ok: false, error: errorText(lease) };
  } catch (e) {
    return { ...out, ok: false, error: String(e?.message || e) };
  }
}

/** One keepalive round over every target machine. */
export async function tick(cfg, { fetchImpl = fetch } = {}) {
  const at = new Date().toISOString();
  let refs = cfg.refs;
  if (!refs.length) {
    const all = await listMachines(cfg, fetchImpl);
    refs = all.map((m) => m.id);
  }
  const results = [];
  for (const ref of refs) results.push(await keepOne(cfg, ref, fetchImpl));
  return { at, lease: cfg.lease, ttl: cfg.ttl, ok: results.every((r) => r.ok), results };
}

/** Drop the lease everywhere; machines go back to pausing when idle. */
export async function release(cfg, { fetchImpl = fetch } = {}) {
  const at = new Date().toISOString();
  let refs = cfg.refs;
  if (!refs.length) refs = (await listMachines(cfg, fetchImpl)).map((m) => m.id);
  const results = [];
  for (const ref of refs) {
    const out = { machine: ref };
    try {
      const info = await inspect(cfg, ref, fetchImpl);
      out.id = info.id;
      const r = await dropLease(cfg, info.id, fetchImpl);
      // 404: there was nothing to release, which is the state we want.
      out.ok = r.ok || r.status === 404;
      out.status = r.status;
      if (!out.ok) out.error = errorText(r);
    } catch (e) {
      out.ok = false;
      out.error = String(e?.message || e);
    }
    results.push(out);
  }
  return { at, lease: cfg.lease, ok: results.every((r) => r.ok), released: results };
}
