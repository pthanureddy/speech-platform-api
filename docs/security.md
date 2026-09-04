# Security model

## Trust boundaries

- Public tenant routes authenticate `x-api-key` and derive the tenant server-side.
- The local worker route uses a separate internal token and should be network-restricted or replaced by queue identity in production.
- Provider callbacks carry a timestamp and `v1=` HMAC-SHA256 signature.
- Liveness, readiness, OpenAPI, and docs are public in the reference app.

API keys are SHA-256 digested before repository lookup and PostgreSQL seed upsert, so repositories do not retain plaintext seed keys. Production configuration rejects development defaults, short/whitespace internal or webhook secrets, malformed tenant seeds, and a missing/invalid PostgreSQL URL. A production identity service should still add a keyed hash or high-entropy key identifier, rotation, overlapping validity, revocation, audit records, rate limits, and anomaly detection. Environment-based tenant seeding is bootstrap configuration, not a complete identity design.

## Webhook verification

The signed message is:

```text
<unix timestamp>.<exact HTTP request body bytes>
```

The handler rejects malformed headers through JSON Schema, rejects timestamps outside the configured past/future window, and compares a fixed-length hash of expected and supplied signatures with `timingSafeEqual`. The event id is the durable replay nonce. Repository-level event fingerprints prevent the same id from being reused with altered fields.

The timestamp check depends on synchronized clocks. A production service also needs provider secret rotation, multiple active signature versions, request-size/rate limits at the edge, source monitoring, and durable event retention.

## Tenant isolation

All public job reads and cancellations use `(authenticated tenant id, job id)`. A job that exists for another tenant returns the same `404 JOB_NOT_FOUND` as an unknown id. This avoids confirming that another tenant's identifier exists.

## Logging

Fastify/Pino supplies JSON request logs. API keys, internal tokens, signatures, and idempotency keys are redacted by path. Request bodies are not deliberately logged. Production logging would also need tested sink-side filters, access controls, retention limits, and security/audit event separation.

## Transport and secrets

TLS termination, a web application firewall, secret-manager integration, IAM, workload identity, and network policy are deployment responsibilities and are not implemented by this process. Example manifests contain placeholders only.
