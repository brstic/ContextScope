# Privacy

ContextScope runs on your machine and sends nothing anywhere except your own requests to the provider you
addressed. There is no telemetry.

## What is stored

| Capture mode | Stored |
|---|---|
| `metadata` (default) | provider, endpoint, model, timings, status, usage, costs, segment kinds and sizes, keyed HMAC-SHA256 fingerprints. **No prompt or response text.** |
| `deep_memory` | as above, plus content in a bounded in-process ring buffer (`capture.memoryBufferEntries`); lost on restart, never written to disk. |
| `deep_persistent` | as above, plus content in SQLite encrypted with AES-256-GCM (`content.key`), deleted after `capture.contentRetentionHours`. |

Fingerprints use a per-install secret key (`<dataDir>/fingerprint.key`, mode 0600), so they cannot be compared
across installations or reversed with a dictionary of common prompts without that key.

## What is never stored

API keys and credentials (`authorization`, `x-api-key`, `x-goog-api-key`, `?key=`, …) are forwarded to the
provider but removed before logs, the database, exports and error messages. Secret headers are not stored at all.

## Deleting data

- **Crypto-shredding:** delete `<dataDir>/content.key` to make all deep-persisted content unreadable at once.
- Metadata older than `capture.metadataRetentionDays` (default 90) is deleted automatically.
- Delete the data dir to remove everything.

## Exports

`contextscope export` and `GET /api/export` contain metadata only (no secrets, no deep content).
Demo data lives in its own data dir and is labelled as demo.
