# Pull requests are welcome. For a bug, include the failing output of

node src/cli.js status
node src/cli.js tick

# with the API key and machine names masked.

- `src/core.js` holds every API call and the round logic. Keep it dependency-free:
  it runs in Workers, so no node: builtins, and only `fetch`, `crypto.randomUUID`,
  `JSON`, timers.
- `src/worker.js` and `src/cli.js` are thin entry points over `core.js`.
- Any behaviour change needs a test in `test/`, against the stubbed API. Run it
  with `node --test test/*.test.js`.
- Never log the API key. `ibk_...` values are masked in CLI output; keep it that
  way if you add logs.
