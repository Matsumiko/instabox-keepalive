// Tests run against a stubbed instabox API: no key, no network, no machine.
//   node --test test/
import assert from "node:assert/strict";
import test from "node:test";
import { config, inspect, listMachines, release, tick } from "../src/core.js";

// A tiny fake of the endpoints core.js uses. `machines` is mutated by resume/start
// so the wake polling can observe a state change.
function fakeApi({ machines = [], leaseStatus = 200, pages } = {}) {
  const calls = [];
  const state = new Map(machines.map((m) => [m.id, { ...m }]));
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method || "GET";
    const path = u.pathname;
    calls.push(`${method} ${path}`);
    const reply = (status, body) =>
      new Response(body === undefined ? "" : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (path === "/v1/machines" && method === "GET") {
      if (pages) {
        const page = Number(u.searchParams.get("cursor") || 1);
        const slice = pages[page - 1] || [];
        const next = pages[page] ? String(page + 1) : null;
        return reply(200, { machines: slice, nextCursor: next });
      }
      return reply(200, { machines: [...state.values()], nextCursor: null });
    }

    const one = /^\/v1\/machines\/([^/]+)$/.exec(path);
    if (one && method === "GET") {
      const ref = decodeURIComponent(one[1]);
      const found = [...state.values()].find((m) => m.id === ref || m.name === ref);
      if (!found) return reply(404, { error: { code: "not_found", message: "no such machine" } });
      return reply(200, found);
    }

    const life = /^\/v1\/machines\/([^/]+)\/(resume|start)$/.exec(path);
    if (life && method === "POST") {
      const m = state.get(life[1]);
      if (!m) return reply(404, { error: { code: "not_found" } });
      if (m.state === "running") return reply(409, { error: { code: "already_running" } });
      m.state = "running";
      return reply(202, { type: life[2], state: "succeeded" });
    }

    const lease = /^\/v1\/machines\/([^/]+)\/activity-leases\/[^/]+$/.exec(path);
    if (lease && (method === "PUT" || method === "DELETE")) {
      if (leaseStatus !== 200) {
        return reply(leaseStatus, { error: { code: "denied", message: "lease refused" } });
      }
      if (method === "DELETE") return reply(200, { ok: true });
      return reply(200, {
        id: "keepalive",
        machineId: lease[1],
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      });
    }

    return reply(404, { error: { code: "not_found", message: `route not found: ${path}` } });
  };
  return { fetchImpl, calls, state };
}

const baseEnv = { INSTABOX_API_KEY: "ibk_test", MACHINES: "fadz-1", TTL: "900" };
const fast = { wakeDelayMs: 0, wakePolls: 2 };

test("config clamps the TTL and splits machine references", () => {
  const cfg = config({ INSTABOX_API_KEY: "ibk_x", MACHINES: " a , m_b ,, ", TTL: "10" });
  assert.deepEqual(cfg.refs, ["a", "m_b"]);
  assert.equal(cfg.ttl, 30, "below the API minimum is raised to 30");
  assert.equal(config({ INSTABOX_API_KEY: "ibk_x", TTL: "99999" }).ttl, 3600);
  assert.equal(config({ INSTABOX_API_KEY: "ibk_x", TTL: "nonsense" }).ttl, 900);
  assert.deepEqual(config({ INSTABOX_API_KEY: "ibk_x" }).refs, [], "empty target list means all machines");
  assert.throws(() => config({}), /INSTABOX_API_KEY/);
});

test("a running machine gets one lease call and no wake", async () => {
  const api = fakeApi({ machines: [{ id: "m_1", name: "fadz-1", state: "running" }] });
  const report = await tick({ ...config(baseEnv), ...fast }, { fetchImpl: api.fetchImpl });

  assert.equal(report.ok, true);
  assert.equal(report.results[0].expiresAt !== undefined, true);
  assert.ok(!api.calls.some((c) => /resume|start/.test(c)), "must not wake a running machine");
  assert.equal(api.calls.filter((c) => c.startsWith("PUT")).length, 1);
});

test("a suspended machine is resumed, then leased", async () => {
  const api = fakeApi({ machines: [{ id: "m_1", name: "fadz-1", state: "suspended" }] });
  const report = await tick({ ...config(baseEnv), ...fast }, { fetchImpl: api.fetchImpl });

  assert.equal(report.ok, true);
  const first = report.results[0];
  assert.equal(first.state, "running");
  assert.deepEqual(first.wake, ["resume:202"]);
  assert.equal(api.calls.at(-1).startsWith("PUT"), true, "the lease is renewed after the wake");
});

test("a stopped machine falls back to start when resume is refused", async () => {
  const machines = [{ id: "m_1", name: "fadz-1", state: "stopped" }];
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${init.method || "GET"} ${path}`);
    const reply = (status, body) =>
      new Response(body === undefined ? "" : JSON.stringify(body), { status });
    if (path.endsWith("/resume")) return reply(409, { error: { code: "not_paused" } });
    if (path.endsWith("/start")) {
      machines[0].state = "running";
      return reply(202, { type: "start", state: "queued" });
    }
    if (path.endsWith("/activity-leases/keepalive")) {
      return reply(200, { expiresAt: "2026-01-01T00:00:00Z" });
    }
    return reply(200, machines[0]);
  };

  const report = await tick({ ...config(baseEnv), ...fast }, { fetchImpl });
  assert.equal(report.ok, true);
  assert.deepEqual(report.results[0].wake, ["resume:409", "start:202"]);
});

test("a machine that never reaches running is reported, not retried forever", async () => {
  const api = fakeApi({ machines: [{ id: "m_1", name: "fadz-1", state: "stopped" }] });
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/resume") || path.endsWith("/start")) {
      return new Response("{}", { status: 202 });
    }
    return api.fetchImpl(url, init); // GET keeps returning "stopped"
  };

  const report = await tick({ ...config(baseEnv), ...fast }, { fetchImpl });
  assert.equal(report.ok, false);
  assert.match(report.results[0].error, /still stopped/);
});

test("a refused lease surfaces the API error message", async () => {
  const api = fakeApi({ machines: [{ id: "m_1", name: "fadz-1", state: "running" }], leaseStatus: 403 });
  const report = await tick({ ...config(baseEnv), ...fast }, { fetchImpl: api.fetchImpl });
  assert.equal(report.ok, false);
  assert.match(report.results[0].error, /lease refused/);
});

test("dry run touches nothing", async () => {
  const api = fakeApi({ machines: [{ id: "m_1", name: "fadz-1", state: "suspended" }] });
  const report = await tick({ ...config({ ...baseEnv, DRY_RUN: "1" }), ...fast }, { fetchImpl: api.fetchImpl });

  assert.equal(report.ok, true);
  assert.equal(report.results[0].dryRun, true);
  assert.deepEqual(api.calls, ["GET /v1/machines/fadz-1"]);
});

test("no MACHINES means every machine the key can see", async () => {
  const api = fakeApi({
    machines: [
      { id: "m_1", name: "a", state: "running" },
      { id: "m_2", name: "b", state: "suspended" },
    ],
  });
  const report = await tick({ ...config({ INSTABOX_API_KEY: "ibk_x" }), ...fast }, { fetchImpl: api.fetchImpl });

  assert.equal(report.ok, true);
  assert.deepEqual(report.results.map((r) => r.name), ["a", "b"]);
  assert.equal(report.results[1].state, "running");
});

test("the machine list is followed across pages", async () => {
  const api = fakeApi({
    pages: [
      [{ id: "m_1", name: "a", state: "running" }],
      [{ id: "m_2", name: "b", state: "running" }],
    ],
  });
  const cfg = config({ INSTABOX_API_KEY: "ibk_x" });
  const all = await listMachines(cfg, api.fetchImpl);
  assert.deepEqual(all.map((m) => m.id), ["m_1", "m_2"]);
});

test("a name resolves to its ID", async () => {
  const api = fakeApi({ machines: [{ id: "m_1", name: "fadz-1", state: "running" }] });
  const info = await inspect(config(baseEnv), "fadz-1", api.fetchImpl);
  assert.equal(info.id, "m_1");
  await assert.rejects(() => inspect(config(baseEnv), "nope", api.fetchImpl), /no such machine/);
});

test("release is idempotent: an absent lease counts as success", async () => {
  const api = fakeApi({ machines: [{ id: "m_1", name: "fadz-1", state: "running" }] });
  const ok = await release(config(baseEnv), { fetchImpl: api.fetchImpl });
  assert.equal(ok.ok, true);

  const missing = async (url, init = {}) =>
    new URL(String(url)).pathname.endsWith("/activity-leases/keepalive")
      ? new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 })
      : api.fetchImpl(url, init);
  const again = await release(config(baseEnv), { fetchImpl: missing });
  assert.equal(again.ok, true);
  assert.equal(again.released[0].status, 404);
});

test("a 500 is retried, then reported if it keeps failing", async () => {
  const machines = [{ id: "m_1", name: "fadz-1", state: "running" }];
  let puts = 0;
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if ((init.method || "GET") === "PUT") {
      puts++;
      return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
    }
    return new Response(JSON.stringify(machines[0]), { status: 200 });
  };

  const report = await tick({ ...config({ ...baseEnv, RETRIES: "2" }), ...fast }, { fetchImpl });
  assert.equal(report.ok, false);
  assert.equal(puts, 2, "two attempts for RETRIES=2");
  assert.match(report.results[0].error, /boom/);
});

test("a dropped connection is retried and can still succeed", async () => {
  const machines = [{ id: "m_1", name: "fadz-1", state: "running" }];
  let puts = 0;
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if ((init.method || "GET") === "PUT") {
      puts++;
      if (puts === 1) throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } });
      return new Response(JSON.stringify({ expiresAt: "2026-01-01T00:00:00Z" }), { status: 200 });
    }
    return new Response(JSON.stringify(machines[0]), { status: 200 });
  };

  const report = await tick({ ...config({ ...baseEnv, RETRIES: "3" }), ...fast }, { fetchImpl });
  assert.equal(report.ok, true);
  assert.equal(puts, 2);
  assert.equal(report.results[0].expiresAt, "2026-01-01T00:00:00Z");
});
