# Offline Radar preview

`OfflineRadar` accepts fixed, host-selected GitHub source metadata. A trusted host
calls `begin`, supplies a page to `complete`, or reports `fail`. It does not fetch
URLs. Each opaque request handle is single-use; a cloned or stale handle fails.
Sources, requests and retained records are copied/frozen at boundaries. Failed
pages do not partially store candidates or advance the cursor. Retries use a
bounded exponential delay and stop after the configured attempt limit.

Candidates deduplicate by canonical repository, exact commit and mechanism digest.
Pinned references cannot be silently overwritten. A rejection survives later
observations. Source text stays behind an untrusted body reference; no command,
permission, credential, or executable artifact field is accepted.

These are in-memory host APIs, not process isolation, persistent scheduling or an
HTTP implementation. The ten fixed sources in the tests are synthetic fixtures,
not ten audited/live upstreams. The host must independently verify source bytes,
commit authenticity and reference metadata. G5's live fetching, isolated research,
real source review and transfer acceptance remain unverified.
