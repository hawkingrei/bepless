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

This is a safe skeleton so the repository can be initialized without leaking infrastructure details.
