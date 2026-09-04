# Multi-Tenant Speech Job API

A TypeScript/Node.js control-plane API for asynchronous speech jobs. It focuses on the backend concerns around synthesis—tenant authentication, plan policy, quota accounting, idempotency, job state, provider callbacks, and operational contracts—rather than claiming to implement a real text-to-speech model.

This is an independent portfolio project. It is not a Speechify product, is not affiliated with Speechify, and has not been deployed to production or Google Cloud. The synthesizer is deterministic. Development can use the in-memory repository, while production requires the implemented PostgreSQL adapter.

## What is implemented

- Fastify 5 API written in strict TypeScript
- API-key authentication with keys held as SHA-256 digests in the repository
- Tenant-scoped job access with non-enumerating `404` responses
- `free`, `starter`, and `business` subscription policies
- Atomic quota reservation and idempotent job creation
- PostgreSQL migrations plus a transaction-safe repository for multi-replica state
- Row-locked quota settlement and job transitions, with cross-replica deduplication locks
- Separate reserved and consumed character counters
- Explicit `queued -> processing -> completed|failed` lifecycle plus queued cancellation
- Deterministic local synthesis behind a `Synthesizer` interface
- HMAC-SHA256 webhook verification over exact request bytes, timestamp tolerance, and event deduplication
- RFC 7807-style `application/problem+json` errors with stable machine codes
- OpenAPI JSON and Swagger UI
- Structured Fastify/Pino logs with credential-header redaction
- Separate liveness and readiness probes
- Optional Google Cloud Storage audio adapter, tested through an injected client
- Docker, Kubernetes reference manifests, a Cloud Run reference manifest, and a GitHub Actions workflow

## Quick start

Prerequisites: Node.js 22 or newer and npm.

```bash
npm ci
copy .env.example .env
npm run dev
```

PowerShell can load the example values directly, or the application will use the same non-production defaults when `NODE_ENV` is not `production`. Never use those defaults outside local development.

Create and process one job:

```bash
curl -i -X POST http://localhost:3000/v1/speech/jobs \
  -H "content-type: application/json" \
  -H "x-api-key: dev_demo_key_change_me" \
  -H "idempotency-key: example-001" \
  -d '{"text":"Reading should not be a barrier.","voice":"narrator-en","format":"mp3"}'

curl -X POST http://localhost:3000/internal/v1/speech/jobs/JOB_ID/process \
  -H "x-internal-token: dev_internal_token_change_me"

curl http://localhost:3000/v1/usage \
  -H "x-api-key: dev_demo_key_change_me"
```

The processing response contains a `memory://` artifact URI and deterministic digest. It does not contain playable audio.

## API surface

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health/live` | none | Process liveness |
| `GET` | `/health/ready` | none | Repository readiness |
| `GET` | `/openapi.json` | none | OpenAPI document |
| `GET` | `/docs/` | none | Swagger UI |
| `POST` | `/v1/speech/jobs` | API key | Atomically reserve quota and create a job |
| `GET` | `/v1/speech/jobs/:jobId` | API key | Read a tenant-owned job |
| `POST` | `/v1/speech/jobs/:jobId/cancel` | API key | Cancel a queued job and release quota |
| `GET` | `/v1/usage` | API key | Current UTC-month ledger |
| `GET` | `/v1/subscription` | API key | Effective plan policy; this is not a billing integration |
| `POST` | `/internal/v1/speech/jobs/:jobId/process` | internal token | Exercise the local worker boundary |
| `POST` | `/v1/webhooks/synthesis` | signed body | Apply a provider completion/failure event |

`POST /v1/speech/jobs` requires an `Idempotency-Key` containing 1–128 letters, digits, dots, colons, underscores, or hyphens. An identical tenant/key/body retry returns the original job with `idempotency-replayed: true`. Reusing the key for a different canonical request returns `409 IDEMPOTENCY_KEY_REUSED`.

## Quota invariant

For each tenant and UTC month:

```text
reservedCharacters >= 0
consumedCharacters >= 0
reservedCharacters + consumedCharacters <= characterLimit
```

Submission reserves Unicode code points. Completion moves the same amount from reserved to consumed. Cancellation or failure releases it. The in-memory adapter serializes every read-modify-write transaction with an async mutex. The PostgreSQL adapter locks the current tenant plan and usage row, uses the lower of current/request-snapshotted limits, performs guarded ledger updates, and uses transaction-scoped advisory locks for idempotency and webhook keys whose rows may not exist yet. Concurrent live-database tests exercise these invariants across independent pools.

## Configuration

| Variable | Default in development | Notes |
|---|---|---|
| `NODE_ENV` | `development` | Must be `development`, `test`, or `production` |
| `HOST` | `0.0.0.0` | Listen address |
| `PORT` | `3000` | Listen port; integer from 1 through 65535 |
| `LOG_LEVEL` | `info` | Pino level |
| `DATABASE_URL` | unset | PostgreSQL URL; selects the durable adapter and is required in production |
| `DEMO_TENANT_ID` | `tenant_demo` | Single local seed tenant |
| `DEMO_TENANT_NAME` | `Demo tenant` | Local display name |
| `DEMO_PLAN` | `starter` | `free`, `starter`, or `business` |
| `DEMO_API_KEY` | development value | 12-256 visible ASCII characters; development value rejected in production |
| `TENANTS_JSON` | unset | Non-empty tenant seed array; supersedes demo variables |
| `INTERNAL_TOKEN` | development value | Production requires 32-512 non-whitespace characters |
| `WEBHOOK_SECRET` | development value | Production requires 32-512 non-whitespace characters |
| `WEBHOOK_TOLERANCE_SECONDS` | `300` | Maximum past/future clock skew |

Example `TENANTS_JSON`:

```json
[
  {
    "id": "tenant_acme",
    "name": "Acme",
    "planId": "starter",
    "apiKey": "replace-with-a-random-secret"
  }
]
```

Seeds are validated at startup. API keys are SHA-256 hashed before repository calls, only the digest is written to PostgreSQL, and raw keys are never deliberately logged. Seed upserts and schema migrations are serialized so concurrent replica starts are safe. A mature system should replace environment seeds with an API-key lifecycle service supporting scoped keys, rotation, revocation, and audit.

## Quality checks

```bash
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run check
```

PostgreSQL integration tests are opt-in locally and require all three guard variables:

```bash
RUN_INFRA_TESTS=1 CONFIRM_DATABASE_RESET=speech-platform-integration-tests DATABASE_URL=postgresql://postgres:password@127.0.0.1:5432/speech_platform_test npm run test:integration
```

The database name must end in `_test`; the confirmation value is an additional guard against targeting durable data accidentally. GitHub Actions is configured to start PostgreSQL 17, run the dedicated integration suite, then include it in the coverage run. Coverage gates remain 80% lines/functions/statements and 75% branches.

Tests cover concurrent quota reservations, concurrent identical submissions, changed-payload idempotency conflicts, tenant isolation, cancellation/processing races, success/failure accounting, raw-body signature verification, stale/tampered callbacks, webhook replay, OpenAPI, probes, and the GCS adapter mapping.

## Containers and deployment references

```bash
docker compose up --build
```

The multi-stage `Dockerfile` runs as the unprivileged `node` user. Compose is configured to start PostgreSQL 17, wait for readiness, then boot the read-only API container with `NODE_ENV=production` and `DATABASE_URL`. Startup applies checksummed SQL migrations and digest-only tenant seeds. Compose credentials are local examples and must be replaced.

The files under `k8s/` and `deploy/cloud-run-service.yaml` are reference configuration examples, not evidence of a deployment. Their production-mode API uses the durable adapter through a secret `DATABASE_URL`. The HPA and PDB target that Deployment but intentionally remain excluded from `k8s/kustomization.yaml`; they have not been applied. The Cloud Run reference permits multiple instances but likewise remains undeployed and requires real database networking, IAM, capacity, and secret configuration.

The optional `GcsAudioStore` maps immutable, tenant-prefixed audio objects to Google Cloud Storage using generation-match preconditions and private cache metadata. Its mapping is unit-tested with an injected client; no bucket was created and no Google credentials were used.

## Design documents

- [Architecture and request flows](docs/architecture.md)
- [Durable persistence boundary](docs/persistence.md)
- [Security model](docs/security.md)
- [Google Cloud deployment plan](docs/google-cloud-plan.md)
- [Limitations and production work](docs/limitations.md)

## Repository layout

```text
src/
  domain/                 policies, types, and domain errors
  http/                   auth, schemas, routes, and error mapping
  infrastructure/         memory/PostgreSQL repositories, fake synthesis, GCS adapter
  services/               use-case orchestration
migrations/               checksummed PostgreSQL schema migrations
test/                     integration and adapter tests
k8s/                      Kubernetes reference manifests
deploy/                   Cloud Run reference manifest
docs/                     architecture, persistence, security, limitations
```

## License

MIT; see [LICENSE](LICENSE).
