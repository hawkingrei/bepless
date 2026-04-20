# bepless

`bepless` is a mixed deployment for reviewing Bazel BEP data without uploading any private infrastructure details into the repository.

## Layout

- `worker/`
  - Cloudflare Worker for the review UI and HTTP-based BEP analysis.
  - Browser-side rendering and local history retention stay in the client.
- `grpc-ingest/`
  - Thin Rust gRPC ingestion service for BES `PublishBuildToolEventStream`.
  - Intended to run behind a private Cloudflare Tunnel-connected service.

## Security Rules

This repository must not contain:

- Tunnel IDs
- Hostnames for private services
- API tokens
- SSH keys or TLS certificates
- Production IPs or internal network addresses
- Real customer BEP data

Put environment-specific values into deployment systems or local environment variables, never into tracked files.

## Data Flow

1. Bazel BES clients send gRPC traffic to `grpc-ingest/`.
2. `grpc-ingest/` normalizes the stream into newline-delimited JSON events.
3. The review surface can analyze BEP through:
   - direct HTTP submission to the Worker
   - object storage or another handoff layer added later

## Status

- `worker/` is implemented and compiles.
- `grpc-ingest/` is currently a safe skeleton that exposes the intended responsibilities without embedding any private deployment details.

## Worker Deployment

The Cloudflare Worker is deployed through GitHub Actions in `.github/workflows/deploy-worker.yml`.

Required GitHub environment secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Create both GitHub Environments and set the same secret names in each one:

- `dev`
- `production`

Deployment policy:

1. Pull requests targeting `main` deploy the Worker to the Cloudflare `dev` environment.
2. Pushes to `main` deploy the Worker to the Cloudflare `production` environment automatically.
3. `workflow_dispatch` can deploy either environment manually.

The workflow installs Node.js, Rust, and the `wasm32-unknown-unknown` target, then runs:

1. `npm install`
2. `cargo check`
3. `npx wrangler deploy --env <target>`
