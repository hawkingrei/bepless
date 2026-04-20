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
- `BEPLESS_HTTP_SINK_TIMEOUT_SECONDS`
  - Optional.
  - Defaults to `15`.
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

## Current State

The service now exposes a minimal BES-compatible gRPC surface:

- `PublishLifecycleEvent`
- `PublishBuildToolEventStream`

For build tool streams it:

- accepts ordered BES events
- decodes Bazel BEP payloads from the `bazel_event` `Any`
- buffers normalized NDJSON lines for the invocation
- flushes the invocation to a configurable HTTP endpoint when the stream ends
- sends ACKs using the incoming stream ID and sequence number

## HTTP Sink

The service can hand off one completed invocation to an HTTP endpoint.

Request shape:

- Method: `POST`
- Content-Type: `application/x-ndjson`
- Headers:
  - `x-bepless-project-id`
  - `x-bepless-build-id`
  - `x-bepless-invocation-id`

Each NDJSON line is a normalized wrapper that contains:

- `project_id`
- `build_id`
- `invocation_id`
- `sequence_number`
- `bazel_event_proto_base64`

The payload is base64-encoded Bazel `build_event_stream.BuildEvent` protobuf bytes.

It still intentionally does not include:

- tunnel configuration
- object storage credentials
- private hostnames
- production routing details
