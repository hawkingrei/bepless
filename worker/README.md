# bepless worker

Cloudflare Worker for:

- review page rendering
- HTTP-based BEP ingestion
- gRPC handoff ingestion via `/ingest`
- stateless analysis of pasted BEP NDJSON
- browser-local review history retention

This directory intentionally contains no deployment secrets.

## Endpoints

- `GET /`: review page, rendering stays in the browser
- `POST /analyze`: accepts pasted Bazel BEP NDJSON and returns an analysis summary
- `POST /ingest`: accepts NDJSON envelopes emitted by `grpc-ingest`

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
shape, and returns the same summary/findings response schema as `/analyze`.

## Run

```bash
cd worker
npm install
cargo check
npm run dev
```

This directory is pinned to the stable Rust toolchain through `rust-toolchain.toml`.

## Deploy

```bash
cd worker
npm install
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
