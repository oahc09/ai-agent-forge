# M0 threat model and permission matrix

## Trust boundaries

User-approved repository configuration is trusted input, but still schema-validated.
Issue/README/model text is untrusted data, never an approval or executable command.
M0 provides no execution/provider API. Only observe and offline-fixture actions are
accepted by its bootstrap guard; every unknown action fails closed.
The example configuration is not a sandbox: OS path/network enforcement is M2 work.

| Level | Intended scope | Current implementation |
|---|---|---|
| L0 | authorized observation | bootstrap only |
| L1 | isolated local execution | not implemented |
| L2 | approved repository draft PR | not implemented |
| L3 | human-approved merge | disabled |
| L4 | credentials/security/deploy/delete | disabled |

## Threats / controls / remaining work

- Config injection: exact keys/types, bounded integers, canonical repo URL, no unknown fields.
- Unauthorized billing/exfiltration: fake only, zero budget, empty domains; no model/network calls.
- Overwrite: init and reports use exclusive creation, refuse existing files.
- False success: empty evidence rejected, every check has SHA-256, offline product claim NOT_VERIFIED.
- Secret logging: no credential fields accepted; test fixture/environment use minimal metadata.
- Supply chain: exact direct versions and pnpm lock integrity; dependency installation is the
  only network requirement. Dependency audit and upstream file-level review are not claimed.
- CI permissions: contents read only, no secret injection, no publishing/merging steps.
- Forged approvals/replay, symlink escapes, worker isolation, stale leases and remote reconciliation:
  NOT IMPLEMENTED, must be tested in their respective milestones before active execution.

Reporting hashes detect changes but are not signatures or a trusted independent evaluator.
An attacker able to rewrite the report and hashes is not stopped by M0. Separate ownership,
immutable storage and independent approval remain later-gate requirements.
