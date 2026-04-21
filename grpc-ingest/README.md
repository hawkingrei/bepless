# bepless grpc-ingest

Thin Rust gRPC ingress service for Bazel BES traffic.

## Intended Role

- accept BES `PublishBuildToolEventStream`
- authenticate at the network edge or service layer
- normalize the incoming event stream
- hand off raw or normalized BEP to downstream storage or analysis systems

## Non-goals

- no review UI
- no public deployment metadata
- no checked-in tunnel configuration
- no production credentials

## Deployment

This service is intended to run behind a private Cloudflare Tunnel-connected environment.
Keep all hostnames, tunnel routes, and secrets outside the repository.

## Local Run

```bash
cd grpc-ingest
cargo run --release
```

Useful environment variables:

- `BEPLESS_GRPC_LISTEN_ADDR`
  - Optional.
  - Defaults to `127.0.0.1:50051`.
- `BEPLESS_HTTP_SINK_URL`
  - Optional.
  - If unset, the NDJSON body is emitted to logs instead of being posted.
  - Current deployment target: `https://bepless.hawkingrei.com/ingest`.
- `BEPLESS_HTTP_SINK_TIMEOUT_SECONDS`
  - Optional.
  - Defaults to `15`.
- `BEPLESS_HTTP_SINK_CHUNK_BYTES`
  - Optional.
  - Maximum NDJSON bytes per chunk sent to the worker chunk ingress fallback path.
  - Defaults to `524288` (512 KiB).
- `BEPLESS_R2_BUCKET`
  - Optional.
  - When set together with the R2 endpoint and credentials below, `grpc-ingest` uploads one normalized NDJSON object directly to R2 and only sends a lightweight finalize request to the worker.
- `BEPLESS_R2_ENDPOINT`
  - Optional.
  - Example: `https://<account_id>.r2.cloudflarestorage.com`
- `BEPLESS_R2_ACCESS_KEY_ID`
  - Optional.
  - R2 S3-compatible access key ID.
- `BEPLESS_R2_SECRET_ACCESS_KEY`
  - Optional.
  - R2 S3-compatible secret access key.
- `BEPLESS_HTTP_SINK_MAX_RETRIES`
  - Optional.
  - Defaults to `5`.
- `BEPLESS_HTTP_SINK_RETRY_BACKOFF_SECONDS`
  - Optional.
  - Defaults to `2`.
- `BEPLESS_HTTP_SINK_QUEUE_CAPACITY`
  - Optional.
  - Defaults to `128`.
- `RUST_LOG`
  - Optional.
  - Example: `info`, `debug`.

## systemd Template

For private Linux hosts, a ready-to-copy `systemd` template is included:

- `deploy/systemd/bepless-grpc-ingest.service`
- `deploy/systemd/grpc-ingest.env.example`

Suggested install flow:

1. Build the binary:

```bash
cd grpc-ingest
cargo build --release
```

2. Install the binary and config:

```bash
sudo install -d /opt/bepless/bin /opt/bepless/grpc-ingest /etc/bepless /var/lib/bepless
sudo install -m 0755 target/release/bepless-grpc-ingest /opt/bepless/bin/bepless-grpc-ingest
sudo install -m 0644 deploy/systemd/bepless-grpc-ingest.service /etc/systemd/system/bepless-grpc-ingest.service
sudo install -m 0644 deploy/systemd/grpc-ingest.env.example /etc/bepless/grpc-ingest.env
```

3. Edit `/etc/bepless/grpc-ingest.env` with your private values.

4. Create the service user if needed:

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin bepless
```

5. Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bepless-grpc-ingest
```

6. Check logs:

```bash
sudo systemctl status bepless-grpc-ingest
journalctl -u bepless-grpc-ingest -f
```

## cloudflared Template

If this service sits behind Cloudflare Tunnel on the same private host, a minimal tunnel config
template is included:

- `deploy/cloudflared/config.yml.example`
- `deploy/cloudflared/cloudflared.env.example`

The intended routing is:

1. `cloudflared` accepts the public gRPC hostname.
2. It forwards HTTP/2 traffic to `https://127.0.0.1:50051`.
3. `bepless-grpc-ingest` handles the BES stream locally.

Current hostnames:

- BES gRPC hostname: `beplessproxy.hawkingrei.com`
- Worker hostname: `bepless.hawkingrei.com`

Suggested install flow:

1. Copy the template:

```bash
sudo install -d /etc/cloudflared
sudo install -m 0644 deploy/cloudflared/config.yml.example /etc/cloudflared/config.yml
```

2. Fill in your private values:

- `tunnel`
- `credentials-file`
- `hostname`

3. Keep the local gRPC listener aligned with `BEPLESS_GRPC_LISTEN_ADDR`.

If you run `cloudflared` through a token-based service manager, keep the token in a separate local
env file and do not reuse the `grpc-ingest` env file for it.

## Current State

The service now exposes a minimal BES-compatible gRPC surface:

- `PublishLifecycleEvent`
- `PublishBuildToolEventStream`

For build tool streams it:

- accepts ordered BES events
- decodes Bazel BEP payloads from the `bazel_event` `Any`
- buffers normalized NDJSON lines for the invocation
- enqueues the completed invocation into an in-memory async sink queue when the stream ends
- flushes queued invocations to a configurable HTTP endpoint in the background
- sends ACKs using the incoming stream ID and sequence number

## HTTP Sink

The service can hand off one completed invocation to an HTTP endpoint.

Request shape:

When `BEPLESS_HTTP_SINK_URL` is set to the worker ingest URL, for example
`https://bepless.hawkingrei.com/ingest`, `grpc-ingest` now derives:

- chunk upload URL: `https://bepless.hawkingrei.com/ingest-chunks`
- finalize URL: `https://bepless.hawkingrei.com/ingest-finalize`

Without direct R2 upload configured, it:

1. renders one normalized NDJSON line per BES event
2. groups those lines into request chunks capped by `BEPLESS_HTTP_SINK_CHUNK_BYTES`
3. uploads each chunk to the worker chunk ingress
4. calls the finalize endpoint once all chunks are stored

With direct R2 upload configured, it:

1. renders one normalized NDJSON line per BES event
2. uploads the full normalized invocation as one R2 object
3. calls the finalize endpoint with the normalized R2 object key

Each NDJSON line inside the chunk bodies still contains:

- `project_id`
- `build_id`
- `invocation_id`
- `sequence_number`
- `notification_keywords`
- `bazel_event_proto_base64`

Each uploaded chunk request now carries:

- `compression = "gzip"`
- `chunk_body_base64`

where `chunk_body_base64` is the base64-encoded gzip payload for one chunk of NDJSON lines.

Direct R2 finalize request:

```json
{
  "project_id": "example-project",
  "build_id": "example-build",
  "invocation_id": "example-invocation",
  "chunk_count": 0,
  "notification_keywords": ["source:ci"],
  "normalized_object_key": "reviews/example-invocation/normalized.ndjson"
}
```

It still intentionally does not include:

- tunnel configuration
- object storage credentials
- private hostnames
- production routing details
