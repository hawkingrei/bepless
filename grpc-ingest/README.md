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

## Current State

The service now exposes a minimal BES-compatible gRPC surface:

- `PublishLifecycleEvent`
- `PublishBuildToolEventStream`

For build tool streams it:

- accepts ordered BES events
- decodes Bazel BEP payloads from the `bazel_event` `Any`
- emits normalized NDJSON lines to logs as a safe local sink
- sends ACKs using the incoming stream ID and sequence number

It still intentionally does not include:

- tunnel configuration
- object storage credentials
- private hostnames
- production routing details
