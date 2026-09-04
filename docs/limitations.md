# Limitations and production work

This repository demonstrates API and domain design. It is not a production TTS service.

## Deliberate limitations

- Development without `DATABASE_URL` uses volatile process memory. Production fails closed unless PostgreSQL is configured.
- The PostgreSQL adapter is integration-tested locally, and CI is configured to repeat those tests; no remote Actions run is claimed. It has not been operated, load-tested, backed up, or restored in a real environment.
- The synthesizer produces deterministic metadata and a `memory://` URI, not audio.
- The GCS adapter is unit-tested with a mock and is not wired to the fake synthesizer.
- No GCP deployment or live cloud integration was executed.
- Tenant keys are startup seeds; there is no rotation, revocation, API-key management API, or OAuth.
- Plan policy is static; there are no payments, invoices, refunds, trials, proration, entitlement history, or billing-provider reconciliation.
- There is no rate limiter independent of the monthly character quota.
- The internal processing endpoint substitutes for a queue/worker system.
- No worker lease, retry schedule, timeout, backpressure, dead-letter queue, or reconciler exists.
- Webhook/idempotency retention is unbounded in both adapters.
- Input text is stored in the selected repository, including PostgreSQL; there is no encryption, retention, or deletion workflow.
- No playable audio endpoint, signed download URL, streaming response, or content delivery layer exists.
- The API exposes one version and has no compatibility/deprecation policy.
- Kubernetes and Cloud Run files are unexecuted reference manifests with placeholder images and secrets.

## Before horizontal scaling

The transaction contract is implemented and concurrent tests run against PostgreSQL 17. Production mode also requires `DATABASE_URL`, so the reference Deployment targeted by the HPA/PDB cannot silently use memory. The two resources nevertheless remain deliberately excluded from the Kustomize base and undeployed. Before adding them, provision and load-test the database, set per-replica connection budgets, add the outbox-backed worker flow, define SLO/capacity assumptions, and test backup/restore and failure behavior.

## Additional production controls

- Per-key/IP rate limiting and abuse detection
- API-key lifecycle and audit trail
- Schema/version compatibility tests and client SDK policy
- Encrypted content, regional residency, retention, deletion, and data-subject workflows
- Provider circuit breakers, concurrency limits, fallback policy, and cost budgets
- Metrics for request latency, error codes, quota denials, jobs by state/age, provider latency, callback lag, and reconciliation drift
- Distributed traces linking API request, outbox event, worker attempt, provider request, object, and callback
- SLOs, paging thresholds, runbooks, backups, restore drills, and capacity/load tests
- Dependency/image scanning, SBOM/signing, admission policy, and regular threat-model review
