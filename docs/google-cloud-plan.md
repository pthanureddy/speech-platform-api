# Google Cloud deployment plan (not executed)

No Google Cloud project, bucket, database, queue, secret, service account, or deployment was created while building this repository. This document is a design mapping, not a claim of operational GCP experience.

## Reference API deployment

`deploy/cloud-run-service.yaml` shows a Cloud Run service using Secret Manager references, a dedicated service account, probes, private/load-balancer ingress, and a secret PostgreSQL URL. Production startup requires that URL, so the service uses shared durable state and can coordinate multiple API instances. The manifest is still only a reference: no database, networking, IAM, secrets, or service was provisioned or validated.

## Production-oriented mapping

| Boundary | Possible Google Cloud service | Design concern |
|---|---|---|
| Fastify container | Cloud Run or GKE | Cloud Run minimizes operations; GKE offers more workload/network control |
| Relational repository | Cloud SQL for PostgreSQL | Transactions and unique constraints match quota/idempotency invariants |
| Work dispatch | Pub/Sub or Cloud Tasks | At-least-once delivery requires worker idempotency, leases, retries, and dead letters |
| Audio objects | Cloud Storage | Regional placement, CMEK, retention, signed delivery URLs, lifecycle rules |
| Secrets | Secret Manager | Versioned rotation and least-privilege access |
| Images | Artifact Registry | Immutable digests and vulnerability scanning |
| Telemetry | Cloud Logging/Monitoring/Trace | Log-based metrics, latency/error SLOs, quota and queue dashboards |

The implemented repository makes API horizontal scaling correct for jobs, quota, idempotency, and webhooks. API and future worker services can scale independently after database connection budgets and load behavior are validated. A queue message should contain job and tenant identifiers, never raw credentials. A worker claims a job transactionally, calls the synthesis provider with an idempotent provider key, stores audio, then consumes the reservation. An outbox or task-creation reconciliation loop closes the database/queue dual-write gap.

## Optional GCS adapter

`GcsAudioStore` is an implemented, unit-tested adapter behind `AudioStore`. It:

- creates tenant-prefixed object names;
- derives content type from the requested audio format;
- supplies private/no-store cache metadata;
- applies `ifGenerationMatch: 0` so a retry cannot overwrite an existing object;
- returns a `gs://` URI rather than making an object public.

The default fake synthesizer emits only deterministic metadata and therefore does not call the adapter. A real provider worker would supply audio bytes and inject the adapter. Unit tests use a narrow mock client; they do not prove Google credentials, IAM, bucket policy, upload latency, or a successful cloud request.

## Work required before deployment

1. Provision PostgreSQL with private networking, backups, restore drills, connection limits, and load/failure testing for the implemented adapter.
2. Replace environment tenant seeds with an identity/API-key service.
3. Implement a queue consumer, outbox, retries, timeouts, dead-letter flow, and reconciliation.
4. Add real synthesis provider integration, encrypted text handling, and retention/deletion controls.
5. Provision resources with reviewed infrastructure as code and least-privilege IAM.
6. Add metrics, traces, SLOs, alerts, runbooks, backups, restore tests, and cost controls.
7. Run integration, failure-injection, load, security, and regional recovery tests.

The reference manifests show multi-instance targets because `DATABASE_URL` selects PostgreSQL. They remain intentionally undeployed; capacity, SLO, queue, privacy, and recovery work above must be completed before real horizontal scaling.
