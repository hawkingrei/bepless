# bepless worker

Cloudflare Worker for:

- review page rendering
- HTTP-based BEP ingestion
- gRPC handoff ingestion via `/ingest`
- D1-backed retention for the latest 50 uploaded reviews
- browser-side rendering of uploaded review details

This directory intentionally contains no deployment secrets.

## Endpoints

- `GET /`: review page with Bazel/BES setup guidance and uploaded review browsing
- `GET /api/reviews`: lists the latest 50 uploaded reviews from D1
- `GET /api/reviews/:id`: returns one stored review, including the normalized NDJSON used for browser-side rendering
- `POST /analyze`: accepts Bazel BEP NDJSON and returns an analysis summary
- `POST /ingest`: accepts NDJSON envelopes emitted by `grpc-ingest`, normalizes them, stores the latest 50 reviews in D1, and returns the analysis payload
- `POST /ingest-chunks`: accepts one chunk of NDJSON envelopes and stores it in R2
- `POST /ingest-finalize`: reassembles stored chunks from R2, analyzes the invocation, stores the final review in D1, and deletes the temporary chunk objects

## `/ingest` format

Each request body is newline-delimited JSON. Every line contains one wrapped Bazel `BuildEvent`
protobuf payload:

```json
{
  "project_id": "example-project",
  "build_id": "example-build",
  "invocation_id": "example-invocation",
  "sequence_number": 42,
  "bazel_event_proto_base64": "BASE64_ENCODED_BUILD_EVENT_PROTO"
}
```

The worker decodes the protobuf payload, maps the supported BEP subset into the local analyzer
shape, persists a normalized NDJSON copy in D1, and returns the same summary/findings response
schema as `/analyze`.

## Chunked `/ingest` format

Large invocations can exceed the single-request body size accepted by Workers. The chunked path
keeps the worker as an R2-backed ingest coordinator:

1. `grpc-ingest` uploads multiple smaller chunks to `POST /ingest-chunks`
2. each chunk is stored in R2 under the invocation ID
3. `POST /ingest-finalize` fetches all chunks, reassembles the original NDJSON body, runs the
   analyzer, stores one final review row in D1, and removes the temporary R2 objects

Chunk upload request:

```json
{
  "project_id": "example-project",
  "build_id": "example-build",
  "invocation_id": "example-invocation",
  "chunk_index": 0,
  "chunk_count": 4,
  "notification_keywords": ["source:ci"],
  "compression": "gzip",
  "chunk_body_base64": "<base64-gzipped-ndjson-lines>"
}
```

Finalize request:

```json
{
  "project_id": "example-project",
  "build_id": "example-build",
  "invocation_id": "example-invocation",
  "chunk_count": 4,
  "notification_keywords": ["source:ci"]
}
```

## D1 Binding

The worker expects a D1 binding named `BEPLESS_DB`.

Add the binding in your Wrangler configuration or local environment before using `/ingest` or the
review list UI. Keep the actual database IDs out of the repository.

Recommended Wrangler shape:

```toml
[[d1_databases]]
binding = "BEPLESS_DB"
database_name = "bepless"
database_id = "<your-d1-database-id>"
```

## R2 Binding

The chunked ingestion path expects an R2 bucket binding named `BEPLESS_CHUNKS`.

Recommended Wrangler shape:

```toml
[[r2_buckets]]
binding = "BEPLESS_CHUNKS"
bucket_name = "<your-r2-bucket-name>"
```

## D1 Migration

The canonical schema now lives in:

- `migrations/0001_reviews.sql`
- `migrations/0002_notification_keywords.sql`

Initialize the remote database explicitly instead of relying on first-request table creation:

```bash
cd worker
npx wrangler d1 execute bepless --remote --file migrations/0001_reviews.sql
npx wrangler d1 execute bepless --remote --file migrations/0002_notification_keywords.sql
```

Quick verification:

```bash
cd worker
npx wrangler d1 execute bepless --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='reviews';"
```

`grpc-ingest` now forwards BES `notification_keywords` from `--bes_keywords`, and the worker stores
them in D1 so the review page can display them per invocation.

## Run

```bash
cd worker
npm install
npm run build:web
cargo check
npm run dev
```

This directory is pinned to the stable Rust toolchain through `rust-toolchain.toml`.

## Deploy

```bash
cd worker
npm install
npm run build:web
npm run deploy
```

`wrangler.toml` bootstraps `worker-build` with Cargo during deployment, so a clean environment does
not need a preinstalled `worker-build` binary. The deployment environment still needs a working Rust
toolchain because `worker-build` compiles the Rust worker to WebAssembly.

If you want to deploy to a specific Wrangler environment locally:

```bash
cd worker
npm install
npx wrangler deploy --env dev
```

`wrangler.toml` defines these local deployment targets:

- `dev` -> `bep-analyzer-worker-dev`
- `production` -> `bep-analyzer-worker`

## Frontend Build

Frontend source lives in `web-src/`.

- `web-src/index.html`
- `web-src/styles.css`
- `web-src/main.js`

`npm run build:web` bundles the frontend and writes a single embedded page to `web-dist/index.html`.
The Rust worker includes that generated file at compile time.
