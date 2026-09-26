# Device Sync local edits after background suspension

The parent WebSocket surviving suspension does not preserve the background storage-change listener. Register `setupStorageListener()` synchronously during background evaluation; late initialization remains an idempotent retry. A first local template edit can otherwise wake the background through another listener without receiving a sync timestamp or broadcast. Reconnecting to an already-open parent socket does not reconstruct that missed timestamp.

The listener checks remote-echo suppression before awaiting the auto-sync preference. Disabled sync, a retired listener, and an overlapping explicit disconnect must not create a local timestamp or broadcast. If late startup has not yet attached module state to the existing parent transport, the debounce connects before broadcasting. Registration ownership is assigned only after successful addListener so a failed registration can retry.

`deviceSyncLocalWake.test.js` covers the real startup/consumer path with synthetic storage and transport. Live suspend/wake validation can namespace the test keys and capture outbound sends; that validates local delivery and timestamp/broadcast effects, but does not prove remote peer convergence.
