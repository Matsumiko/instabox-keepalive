#!/usr/bin/env node
// Command line runner: the same keepalive round as the Worker, on any host with
// Node 18+ (VPS, NAS, Raspberry Pi, a systemd timer, cron).
//
//   instabox-keepalive tick        one round (default)
//   instabox-keepalive status      states only, no wake, no lease
//   instabox-keepalive release     drop the lease, back to normal idle pause
//   instabox-keepalive watch       tick every INTERVAL seconds until Ctrl-C
//
// Configuration comes from the environment, optionally seeded by a .env file
// next to the working directory (see .env.example).

import { existsSync, readFileSync } from "node:fs";
import { config, inspect, listMachines, release, tick } from "./core.js";

function loadDotEnv(file = process.env.ENV_FILE || ".env") {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, name, raw] = match;
    if (process.env[name] !== undefined) continue;
    process.env[name] = raw.trim().replace(/^["'](.*)["']$/, "$1");
  }
}

const redact = (r) => {
  const out = { ...r };
  if (out.error) out.error = String(out.error).replace(/ibk_[a-z0-9]{52}/gi, "ibk_***");
  return out;
};

async function main(argv) {
  loadDotEnv();
  const command = (argv[0] || "tick").toLowerCase();
  const cfg = config(process.env);

  if (command === "status") {
    const targets = cfg.refs.length ? cfg.refs : (await listMachines(cfg)).map((m) => m.id);
    const rows = [];
    for (const ref of targets) {
      try {
        const info = await inspect(cfg, ref);
        rows.push({ id: info.id, name: info.name, state: info.state });
      } catch (e) {
        rows.push({ machine: ref, ok: false, error: String(e?.message || e) });
      }
    }
    console.log(JSON.stringify({ at: new Date().toISOString(), lease: cfg.lease, machines: rows }, null, 2));
    return 0;
  }

  if (command === "release") {
    const report = await release(cfg);
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  if (command === "watch") {
    const interval = Math.max(60, Number(process.env.INTERVAL ?? 300)) * 1000;
    let stopping = false;
    const stop = () => {
      stopping = true;
      console.error("stopping after this round");
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    while (!stopping) {
      const report = await tick(cfg);
      console.log(JSON.stringify({ ...report, results: report.results.map(redact) }));
      if (stopping) break;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    return 0;
  }

  if (command !== "tick") {
    console.error(`unknown command: ${command}`);
    console.error("usage: instabox-keepalive [tick|status|release|watch]");
    return 2;
  }

  const report = await tick(cfg);
  console.log(JSON.stringify({ ...report, results: report.results.map(redact) }, null, 2));
  return report.ok ? 0 : 1;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(JSON.stringify({ ok: false, error: String(e?.message || e) }));
    process.exit(1);
  });
