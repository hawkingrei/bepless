# bepless worker

Cloudflare Worker for:

- review page rendering
- HTTP-based BEP ingestion
- stateless analysis of pasted BEP NDJSON
- browser-local review history retention

This directory intentionally contains no deployment secrets.

## Run

```bash
cd worker
cargo check
wrangler dev
```
