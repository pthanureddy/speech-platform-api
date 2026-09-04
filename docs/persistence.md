# Durable persistence boundary

`PlatformRepository` is the persistence port. The in-memory implementation remains fast and deterministic for unit tests. `PostgresPlatformRepository` is the durable adapter selected by `DATABASE_URL`; production configuration refuses to start without it.

## Required durable data

Migration `migrations/001_platform_store.sql` creates these records:

| Record | Important fields/constraints |
|---|---|
| `tenants` | tenant id primary key, name, plan id, unique SHA-256 API-key digest |
| `speech_jobs` | job id, tenant id, state, input text, quota period, character count, timestamps, JSON output/failure |
| `usage_buckets` | `(tenant_id, period)` primary key, reserved, consumed, snapshotted limit, non-negative/within-limit checks |
| `idempotency_keys` | `(tenant_id, key)` primary key, fingerprint, job id |
| `webhook_events` | event id unique, fingerprint, job id, accepted timestamp |

The migration runner orders numeric file versions, rejects duplicates, checks file SHA-256 values in `platform_schema_migrations`, and takes a database advisory lock so only one replica applies pending migrations. Startup tenant seed upserts run under a separate advisory lock. Raw configured keys are hashed in process before the repository sees them. The project deliberately has no payment-provider tables or flows; `GET /v1/subscription` exposes effective policy only.

## Transaction requirements

`createJobWithReservation` is one database transaction. It first takes a transaction-scoped advisory lock derived from the tenant and idempotency key. This closes PostgreSQL's absent-row locking gap: a concurrent retry waits, then observes the committed key before touching quota. The transaction reads the tenant with `FOR SHARE`, resolves its current plan policy, and uses the lower of that locked policy and the request's policy snapshot. It then creates and locks the monthly usage row with `SELECT ... FOR UPDATE`, checks the effective limit, and inserts the idempotency record, job, and reservation atomically. Primary/unique constraints remain the final integrity authority.

Completion, failure, and cancellation lock the job row, validate its state, perform a guarded usage update, and update job state in the same transaction. The lock order is always job then usage. Settlement uses the job's stored quota period, so a January reservation completed in February still settles January.

Webhook processing takes an event-id advisory lock before replay/state checks, then locks job and usage rows. Event insertion, settlement, and the terminal transition commit together. An identical redelivery reads the recorded outcome before validating the now-terminal job; a conflicting payload under the same event id returns `409`.

Recommended database constraints include:

```sql
CHECK (reserved_characters >= 0),
CHECK (consumed_characters >= 0),
CHECK (reserved_characters + consumed_characters <= character_limit),
PRIMARY KEY (tenant_id, idempotency_key),
PRIMARY KEY (event_id)
```

On an accepted reservation, the usage bucket stores the effective limit used by that transaction. The tenant `FOR SHARE` lock serializes seed-driven plan changes, while the usage-row lock serializes concurrent reservations. A stale higher request snapshot therefore cannot bypass a downgrade; a stale lower snapshot remains conservatively limiting.

## Queue/outbox boundary

A production submit transaction should write an outbox event beside the job and reservation. A publisher can deliver that event to a queue at least once. Workers claim with a lease, make provider calls with their own idempotency key, and settle through the repository. Retries, exponential backoff, lease expiry, dead-letter handling, and reconciliation are intentionally absent here.

## Privacy and retention

The PostgreSQL job currently contains input text because the fake synthesizer needs it. A real deployment must add application-layer encryption or a content-reference design, minimize log exposure, define regional residency and retention, and delete both text and audio on policy-driven schedules. Those privacy controls are not implemented here.
