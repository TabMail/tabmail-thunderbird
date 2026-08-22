# Native FTS optimize is one full, parameterless call

The native helper's `optimize` writer RPC accepts no meaningful parameters. It runs SQLite FTS5's
full `optimize` command across every known year shard and currently returns exactly `{ok:true}`. The
consumer accepts future response fields only when `ok === true`. The helper does not expose steps,
changed-page counts, database size, convergence, resumable cursors, or time budgets.

Thunderbird therefore calls it exactly once after a successful daily, weekly, or monthly manual
maintenance scan; hourly maintenance does not optimize. The maintenance operation's existing
exclusive coordinator lease remains held until the native call resolves or rejects. Only
`result?.ok === true` is accepted. A missing/false acknowledgment or native rejection is logged as
an optimize failure without fabricating telemetry, but remains non-critical to repair work that has
already completed. The runtime optimize command uses the same zero-parameter wrapper and an owned
exclusive scan lifetime.

The helper call remains subject to the existing native-RPC timeout. Do not recreate client-side
chunking, budgets, convergence inference, or a longer timeout without a real native protocol change.
Regression coverage lives in `test/nativeOptimizeContract.test.js`.
