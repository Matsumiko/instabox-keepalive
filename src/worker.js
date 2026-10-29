// Cloudflare Worker entry: one keepalive round per cron trigger, plus an HTTP
// endpoint so you can check (and renew) on demand:
//
//   GET /                 run one round, JSON report
//   GET /?dry=1           same, without wake or lease calls
//   GET /?token=...       required when the TOKEN secret/var is set
//
// Nothing else is exposed; there is no state to read or write beyond the lease.

import { config, tick } from "./core.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function readConfig(env, url) {
  const dryRun = url.searchParams.get("dry") === "1" ? true : undefined;
  return config({ ...env, DRY_RUN: dryRun ?? env.DRY_RUN });
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          const report = await tick(readConfig(env, new URL("https://worker.local/")));
          console.log(JSON.stringify(report));
        } catch (e) {
          console.error(JSON.stringify({ ok: false, error: String(e?.message || e) }));
        }
      })(),
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/") return json({ ok: false, error: "not found" }, 404);
    if (env.TOKEN && url.searchParams.get("token") !== env.TOKEN) {
      return json({ ok: false, error: "forbidden: ?token= is wrong or missing" }, 403);
    }
    try {
      const report = await tick(readConfig(env, url));
      return json(report, report.ok ? 200 : 502);
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  },
};
