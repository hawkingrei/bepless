use std::{collections::BTreeMap, env, net::SocketAddr, sync::Arc, time::Duration};

use aws_config::BehaviorVersion;
use aws_sdk_s3::{primitives::ByteStream, Client as S3Client};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use flate2::{write::GzEncoder, Compression};
use prost::Message;
use prost_types::Any;
use prost_types::{Duration as ProtoDuration, Timestamp as ProtoTimestamp};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::io::Write;
use tokio::{signal, sync::mpsc, time::sleep};
use tokio_stream::wrappers::ReceiverStream;
use tonic::{async_trait, transport::Server, Request, Response, Status, Streaming};
use tracing::{error, info};

pub mod google {
    pub mod devtools {
        pub mod build {
            pub mod v1 {
                tonic::include_proto!("google.devtools.build.v1");
            }
        }
    }
}

pub mod blaze {
    include!(concat!(env!("OUT_DIR"), "/blaze.rs"));

    pub mod invocation_policy {
        include!(concat!(env!("OUT_DIR"), "/blaze.invocation_policy.rs"));
    }

    pub mod strategy_policy {
        include!(concat!(env!("OUT_DIR"), "/blaze.strategy_policy.rs"));
    }
}

pub mod command_line {
    include!(concat!(env!("OUT_DIR"), "/command_line.rs"));
}

pub mod failure_details {
    include!(concat!(env!("OUT_DIR"), "/failure_details.rs"));
}

pub mod options {
    include!(concat!(env!("OUT_DIR"), "/options.rs"));
}

pub mod devtools {
    pub mod build {
        pub mod lib {
            pub mod packages {
                pub mod metrics {
                    include!(concat!(
                        env!("OUT_DIR"),
                        "/devtools.build.lib.packages.metrics.rs"
                    ));
                }
            }
        }
    }
}

pub mod build_event_stream {
    include!(concat!(env!("OUT_DIR"), "/build_event_stream.rs"));
}

use google::devtools::build::v1::{
    publish_build_event_server::{PublishBuildEvent, PublishBuildEventServer},
    BuildEvent as BesEnvelope, PublishBuildToolEventStreamRequest,
    PublishBuildToolEventStreamResponse, PublishLifecycleEventRequest, StreamId,
};

#[derive(Debug, Clone, Serialize)]
struct NormalizedBuildEvent<'a> {
    project_id: &'a str,
    build_id: &'a str,
    invocation_id: &'a str,
    sequence_number: i64,
    notification_keywords: &'a [String],
    bazel_event_proto_base64: String,
}

#[derive(Debug, serde::Deserialize)]
struct BufferedBuildEvent {
    #[allow(dead_code)]
    project_id: String,
    #[allow(dead_code)]
    build_id: String,
    #[allow(dead_code)]
    invocation_id: String,
    #[allow(dead_code)]
    sequence_number: i64,
    #[allow(dead_code)]
    #[serde(default)]
    notification_keywords: Vec<String>,
    bazel_event_proto_base64: String,
}

#[derive(Debug, Clone, Serialize)]
struct ChunkUploadRequest<'a> {
    project_id: &'a str,
    build_id: &'a str,
    invocation_id: &'a str,
    chunk_index: u32,
    chunk_count: u32,
    notification_keywords: &'a [String],
    compression: &'a str,
    chunk_body_base64: String,
}

#[derive(Debug, Clone, Serialize)]
struct FinalizeUploadRequest<'a> {
    project_id: &'a str,
    build_id: &'a str,
    invocation_id: &'a str,
    chunk_count: u32,
    notification_keywords: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    normalized_object_key: Option<&'a str>,
}

#[derive(Debug, Clone)]
struct R2UploadConfig {
    bucket_name: String,
    client: S3Client,
}

#[derive(Debug, Clone)]
struct HttpSinkConfig {
    endpoint_url: Option<String>,
    timeout: Duration,
    max_retries: usize,
    retry_backoff: Duration,
    chunk_bytes: usize,
    r2_upload: Option<R2UploadConfig>,
}

impl R2UploadConfig {
    async fn from_env() -> Result<Option<Self>, String> {
        let bucket_name = env::var("BEPLESS_R2_BUCKET")
            .ok()
            .filter(|value| !value.is_empty());
        let endpoint_url = env::var("BEPLESS_R2_ENDPOINT")
            .ok()
            .filter(|value| !value.is_empty());
        let access_key_id = env::var("BEPLESS_R2_ACCESS_KEY_ID")
            .ok()
            .filter(|value| !value.is_empty());
        let secret_access_key = env::var("BEPLESS_R2_SECRET_ACCESS_KEY")
            .ok()
            .filter(|value| !value.is_empty());

        match (bucket_name, endpoint_url, access_key_id, secret_access_key) {
            (Some(bucket_name), Some(endpoint_url), Some(access_key_id), Some(secret_access_key)) => {
                let config = aws_config::defaults(BehaviorVersion::latest())
                    .endpoint_url(endpoint_url)
                    .credentials_provider(aws_sdk_s3::config::Credentials::new(
                        access_key_id,
                        secret_access_key,
                        None,
                        None,
                        "R2",
                    ))
                    .region("auto")
                    .load()
                    .await;

                Ok(Some(Self {
                    bucket_name,
                    client: S3Client::new(&config),
                }))
            }
            (None, None, None, None) => Ok(None),
            _ => Err(
                "incomplete R2 upload configuration; set BEPLESS_R2_BUCKET, BEPLESS_R2_ENDPOINT, BEPLESS_R2_ACCESS_KEY_ID, and BEPLESS_R2_SECRET_ACCESS_KEY"
                    .to_string(),
            ),
        }
    }
}

impl HttpSinkConfig {
    async fn load() -> Result<Self, String> {
        Ok(Self {
            endpoint_url: env::var("BEPLESS_HTTP_SINK_URL")
                .ok()
                .filter(|value| !value.is_empty()),
            timeout: Duration::from_secs(
                env::var("BEPLESS_HTTP_SINK_TIMEOUT_SECONDS")
                    .ok()
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(15),
            ),
            max_retries: env::var("BEPLESS_HTTP_SINK_MAX_RETRIES")
                .ok()
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(5),
            retry_backoff: Duration::from_secs(
                env::var("BEPLESS_HTTP_SINK_RETRY_BACKOFF_SECONDS")
                    .ok()
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(2),
            ),
            chunk_bytes: env::var("BEPLESS_HTTP_SINK_CHUNK_BYTES")
                .ok()
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(512 * 1024),
            r2_upload: R2UploadConfig::from_env().await?,
        })
    }

    fn chunk_endpoint_url(&self) -> Option<String> {
        self.endpoint_url
            .as_ref()
            .map(|value| derive_sink_url(value, "/ingest", "/ingest-chunks"))
    }

    fn finalize_endpoint_url(&self) -> Option<String> {
        self.endpoint_url
            .as_ref()
            .map(|value| derive_sink_url(value, "/ingest", "/ingest-finalize"))
    }

    async fn flush(
        &self,
        project_id: &str,
        stream_id: &StreamId,
        notification_keywords: &[String],
        lines: &[String],
    ) -> Result<(), String> {
        if lines.is_empty() {
            return Ok(());
        }

        if let Some(endpoint_url) = &self.endpoint_url {
            let client = reqwest::Client::builder()
                .timeout(self.timeout)
                .build()
                .map_err(|err| format!("failed to build http sink client: {err}"))?;

            if let Some(r2_upload) = &self.r2_upload {
                let body = normalize_ingest_lines(lines).map_err(|err| {
                    format!("failed to normalize invocation before R2 upload: {err}")
                })?;
                log_normalized_event_counts(project_id, stream_id, &body);
                let normalized_object_key = normalized_object_key(stream_id.invocation_id.as_str());
                r2_upload
                    .client
                    .put_object()
                    .bucket(&r2_upload.bucket_name)
                    .key(&normalized_object_key)
                    .content_type("application/x-ndjson")
                    .body(ByteStream::from(body.into_bytes()))
                    .send()
                    .await
                    .map_err(|err| {
                        format!("failed to upload normalized invocation to R2: {err}")
                    })?;

                let finalize_endpoint = self
                    .finalize_endpoint_url()
                    .ok_or_else(|| "failed to derive finalize endpoint url".to_string())?;
                let finalize = FinalizeUploadRequest {
                    project_id,
                    build_id: stream_id.build_id.as_str(),
                    invocation_id: stream_id.invocation_id.as_str(),
                    chunk_count: 0,
                    notification_keywords,
                    normalized_object_key: Some(&normalized_object_key),
                };
                let response = client
                    .post(&finalize_endpoint)
                    .json(&finalize)
                    .send()
                    .await
                    .map_err(|err| {
                        format!("failed to finalize normalized upload to http sink: {err}")
                    })?;

                if !response.status().is_success() {
                    return Err(format!(
                        "http sink finalize returned non-success status: {}",
                        response.status()
                    ));
                }

                info!(
                    endpoint_url,
                    invocation_id = stream_id.invocation_id,
                    build_id = stream_id.build_id,
                    object_key = normalized_object_key,
                    line_count = lines.len(),
                    "uploaded invocation to R2 and finalized via http sink"
                );
                return Ok(());
            }

            let chunks = chunk_lines(lines, self.chunk_bytes);
            let chunk_count = u32::try_from(chunks.len())
                .map_err(|_| "chunk count exceeds u32 range".to_string())?;
            let chunk_endpoint = self
                .chunk_endpoint_url()
                .ok_or_else(|| "failed to derive chunk endpoint url".to_string())?;
            let finalize_endpoint = self
                .finalize_endpoint_url()
                .ok_or_else(|| "failed to derive finalize endpoint url".to_string())?;

            for (chunk_index, chunk_body) in chunks.iter().enumerate() {
                let request = ChunkUploadRequest {
                    project_id,
                    build_id: stream_id.build_id.as_str(),
                    invocation_id: stream_id.invocation_id.as_str(),
                    chunk_index: chunk_index as u32,
                    chunk_count,
                    notification_keywords,
                    compression: "gzip",
                    chunk_body_base64: gzip_base64(chunk_body)
                        .map_err(|err| format!("failed to gzip chunk body: {err}"))?,
                };
                let response = client
                    .post(&chunk_endpoint)
                    .json(&request)
                    .send()
                    .await
                    .map_err(|err| format!("failed to upload chunk to http sink: {err}"))?;

                if !response.status().is_success() {
                    return Err(format!(
                        "http sink chunk upload returned non-success status: {}",
                        response.status()
                    ));
                }
            }

            let finalize = FinalizeUploadRequest {
                project_id,
                build_id: stream_id.build_id.as_str(),
                invocation_id: stream_id.invocation_id.as_str(),
                chunk_count,
                notification_keywords,
                normalized_object_key: None,
            };
            let response = client
                .post(&finalize_endpoint)
                .json(&finalize)
                .send()
                .await
                .map_err(|err| format!("failed to finalize chunk upload to http sink: {err}"))?;

            if !response.status().is_success() {
                return Err(format!(
                    "http sink finalize returned non-success status: {}",
                    response.status()
                ));
            }

            info!(
                endpoint_url,
                chunk_count,
                line_count = lines.len(),
                invocation_id = stream_id.invocation_id,
                "flushed invocation to http sink"
            );
            return Ok(());
        }

        let body = lines.join("\n");
        info!(
            target: "bepless.grpc_ingest.ndjson",
            project_id,
            build_id = stream_id.build_id,
            invocation_id = stream_id.invocation_id,
            line_count = lines.len(),
            body = body,
            "http sink url not configured; emitted ndjson body to logs"
        );
        Ok(())
    }
}

#[derive(Debug)]
struct PendingInvocation {
    project_id: String,
    stream_id: StreamId,
    notification_keywords: Vec<String>,
    lines: Vec<String>,
}

#[derive(Debug, Clone)]
struct BesIngestService {
    sink: Arc<HttpSinkConfig>,
    flush_tx: mpsc::Sender<PendingInvocation>,
}

impl BesIngestService {
    async fn new() -> Result<Self, String> {
        let sink = Arc::new(HttpSinkConfig::load().await?);
        let queue_capacity = env::var("BEPLESS_HTTP_SINK_QUEUE_CAPACITY")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(128);
        let (flush_tx, flush_rx) = mpsc::channel(queue_capacity);
        tokio::spawn(run_sink_worker(Arc::clone(&sink), flush_rx));

        Ok(Self { sink, flush_tx })
    }
}

#[async_trait]
impl PublishBuildEvent for BesIngestService {
    async fn publish_lifecycle_event(
        &self,
        request: Request<PublishLifecycleEventRequest>,
    ) -> Result<Response<()>, Status> {
        let payload = request.into_inner();
        let build_event = payload
            .build_event
            .ok_or_else(|| Status::invalid_argument("missing build_event"))?;

        info!(
            project_id = payload.project_id,
            sequence_number = build_event.sequence_number,
            "received lifecycle event"
        );

        Ok(Response::new(()))
    }

    type PublishBuildToolEventStreamStream =
        ReceiverStream<Result<PublishBuildToolEventStreamResponse, Status>>;

    async fn publish_build_tool_event_stream(
        &self,
        request: Request<Streaming<PublishBuildToolEventStreamRequest>>,
    ) -> Result<Response<Self::PublishBuildToolEventStreamStream>, Status> {
        let mut inbound = request.into_inner();
        let (tx, rx) = tokio::sync::mpsc::channel(64);
        let sink = Arc::clone(&self.sink);
        let flush_tx = self.flush_tx.clone();

        tokio::spawn(async move {
            let mut buffered_lines = Vec::new();
            let mut stream_context: Option<(String, StreamId, Vec<String>)> = None;
            loop {
                match inbound.message().await {
                    Ok(Some(message)) => match handle_stream_message(&sink, message).await {
                        Ok((
                            response,
                            maybe_line,
                            project_id,
                            stream_id,
                            notification_keywords,
                        )) => {
                            stream_context =
                                Some((project_id, stream_id.clone(), notification_keywords));
                            if let Some(line) = maybe_line {
                                buffered_lines.push(line);
                            }
                            if tx.send(Ok(response)).await.is_err() {
                                return;
                            }
                        }
                        Err(status) => {
                            let _ = tx.send(Err(status)).await;
                            return;
                        }
                    },
                    Ok(None) => {
                        if let Some((project_id, stream_id, notification_keywords)) = stream_context
                        {
                            enqueue_invocation(
                                flush_tx.clone(),
                                PendingInvocation {
                                    project_id,
                                    stream_id,
                                    notification_keywords,
                                    lines: buffered_lines,
                                },
                            );
                        }
                        return;
                    }
                    Err(err) => {
                        let _ = tx
                            .send(Err(Status::internal(format!(
                                "failed to receive BES message: {err}"
                            ))))
                            .await;
                        return;
                    }
                }
            }
        });

        Ok(Response::new(ReceiverStream::new(rx)))
    }
}

async fn handle_stream_message(
    sink: &Arc<HttpSinkConfig>,
    message: PublishBuildToolEventStreamRequest,
) -> Result<
    (
        PublishBuildToolEventStreamResponse,
        Option<String>,
        String,
        StreamId,
        Vec<String>,
    ),
    Status,
> {
    let project_id = message.project_id.clone();
    let notification_keywords = message.notification_keywords.clone();
    let ordered = message
        .ordered_build_event
        .ok_or_else(|| Status::invalid_argument("missing ordered_build_event"))?;
    let stream_id = ordered
        .stream_id
        .clone()
        .ok_or_else(|| Status::invalid_argument("missing ordered_build_event.stream_id"))?;

    if ordered.sequence_number <= 0 {
        return Err(Status::invalid_argument("sequence_number must be positive"));
    }

    let encoded_line = maybe_render_ndjson_line(
        sink.as_ref(),
        project_id.as_str(),
        &stream_id,
        ordered.sequence_number,
        notification_keywords.as_slice(),
        ordered.event.as_ref(),
    )?;

    Ok((
        PublishBuildToolEventStreamResponse {
            stream_id: Some(stream_id.clone()),
            sequence_number: ordered.sequence_number,
        },
        encoded_line,
        project_id,
        stream_id,
        notification_keywords,
    ))
}

fn maybe_render_ndjson_line(
    _sink: &HttpSinkConfig,
    project_id: &str,
    stream_id: &StreamId,
    sequence_number: i64,
    notification_keywords: &[String],
    envelope: Option<&BesEnvelope>,
) -> Result<Option<String>, Status> {
    let Some(envelope) = envelope else {
        return Ok(None);
    };
    let Some(any) = extract_bazel_any(envelope) else {
        return Ok(None);
    };
    decode_bazel_event(Some(envelope))?;
    let line = NormalizedBuildEvent {
        project_id,
        build_id: stream_id.build_id.as_str(),
        invocation_id: stream_id.invocation_id.as_str(),
        sequence_number,
        notification_keywords,
        bazel_event_proto_base64: BASE64_STANDARD.encode(any.value.as_slice()),
    };
    serde_json::to_string(&line)
        .map(Some)
        .map_err(|err| Status::internal(format!("failed to encode ndjson line: {err}")))
}

fn enqueue_invocation(flush_tx: mpsc::Sender<PendingInvocation>, pending: PendingInvocation) {
    match flush_tx.try_send(pending) {
        Ok(_) => {}
        Err(mpsc::error::TrySendError::Full(pending)) => {
            tokio::spawn(async move {
                if let Err(err) = flush_tx.send(pending).await {
                    error!(
                        "failed to enqueue invocation for asynchronous sink flush: {}",
                        err
                    );
                }
            });
        }
        Err(mpsc::error::TrySendError::Closed(_)) => {
            error!("sink flush queue is closed; dropping invocation");
        }
    }
}

async fn run_sink_worker(
    sink: Arc<HttpSinkConfig>,
    mut flush_rx: mpsc::Receiver<PendingInvocation>,
) {
    while let Some(pending) = flush_rx.recv().await {
        if let Err(err) = flush_with_retry(sink.as_ref(), &pending).await {
            error!(
                invocation_id = pending.stream_id.invocation_id,
                build_id = pending.stream_id.build_id,
                "failed to flush invocation to http sink after retries: {err}"
            );
        }
    }
}

async fn flush_with_retry(
    sink: &HttpSinkConfig,
    pending: &PendingInvocation,
) -> Result<(), String> {
    let attempts = sink.max_retries.max(1);

    for attempt in 1..=attempts {
        match sink
            .flush(
                &pending.project_id,
                &pending.stream_id,
                pending.notification_keywords.as_slice(),
                &pending.lines,
            )
            .await
        {
            Ok(_) => {
                info!(
                    invocation_id = pending.stream_id.invocation_id,
                    build_id = pending.stream_id.build_id,
                    line_count = pending.lines.len(),
                    attempt,
                    "queued invocation flushed to http sink"
                );
                return Ok(());
            }
            Err(err) if attempt < attempts => {
                error!(
                    invocation_id = pending.stream_id.invocation_id,
                    build_id = pending.stream_id.build_id,
                    attempt,
                    max_attempts = attempts,
                    "failed to flush invocation to http sink, retrying: {err}"
                );
                sleep(sink.retry_backoff).await;
            }
            Err(err) => return Err(err),
        }
    }

    Err("unreachable retry state".to_string())
}

fn derive_sink_url(endpoint_url: &str, from_suffix: &str, to_suffix: &str) -> String {
    if endpoint_url.ends_with(from_suffix) {
        let prefix = endpoint_url.trim_end_matches(from_suffix);
        return format!("{prefix}{to_suffix}");
    }

    format!(
        "{}/{}",
        endpoint_url.trim_end_matches('/'),
        to_suffix.trim_start_matches('/')
    )
}

fn normalized_object_key(invocation_id: &str) -> String {
    format!("reviews/{invocation_id}/normalized.ndjson")
}

fn normalize_ingest_lines(lines: &[String]) -> Result<String, String> {
    let mut normalized = Vec::new();

    for (index, line) in lines.iter().enumerate() {
        let envelope: BufferedBuildEvent = serde_json::from_str(line)
            .map_err(|err| format!("invalid buffered ingest line {}: {err}", index + 1))?;
        let payload = BASE64_STANDARD
            .decode(envelope.bazel_event_proto_base64)
            .map_err(|err| format!("invalid base64 payload at line {}: {err}", index + 1))?;
        let event = build_event_stream::BuildEvent::decode(payload.as_slice())
            .map_err(|err| format!("invalid BuildEvent protobuf at line {}: {err}", index + 1))?;
        let Some(json_event) = convert_proto_event_to_json(&event) else {
            continue;
        };
        normalized.push(json_event.to_string());
    }

    if normalized.is_empty() {
        return Err("no analyzable BEP events found while preparing R2 upload".to_string());
    }

    Ok(normalized.join("\n"))
}

fn log_normalized_event_counts(project_id: &str, stream_id: &StreamId, normalized_body: &str) {
    let counts = summarize_normalized_event_counts(normalized_body);
    let count_started = counts.get("started").copied().unwrap_or(0);
    let count_finished = counts.get("finished").copied().unwrap_or(0);
    let count_build_metrics = counts.get("buildMetrics").copied().unwrap_or(0);
    let count_action = counts.get("action").copied().unwrap_or(0);
    let count_test_result = counts.get("testResult").copied().unwrap_or(0);
    let count_test_summary = counts.get("testSummary").copied().unwrap_or(0);
    let count_target_configured = counts.get("targetConfigured").copied().unwrap_or(0);
    let count_target_completed = counts.get("targetCompleted").copied().unwrap_or(0);
    let missing_core_events = [
        ("started", count_started),
        ("finished", count_finished),
        ("buildMetrics", count_build_metrics),
        ("action", count_action),
    ]
    .into_iter()
    .filter_map(|(name, count)| (count == 0).then_some(name))
    .collect::<Vec<_>>()
    .join(",");
    let health = classify_normalized_event_health(
        count_started,
        count_finished,
        count_build_metrics,
        count_action,
        count_test_result,
        count_test_summary,
    );
    let counts_json = serde_json::to_string(&counts).unwrap_or_else(|_| "{}".to_string());

    info!(
        invocation_id = stream_id.invocation_id,
        build_id = stream_id.build_id,
        project_id,
        normalized_bytes = normalized_body.len(),
        count_started,
        count_finished,
        count_build_metrics,
        count_action,
        count_test_result,
        count_test_summary,
        count_target_configured,
        count_target_completed,
        has_started = count_started > 0,
        has_finished = count_finished > 0,
        has_build_metrics = count_build_metrics > 0,
        has_action = count_action > 0,
        health,
        missing_core_events,
        counts = counts_json,
        "normalized invocation event counts before R2 upload"
    );
}

fn classify_normalized_event_health(
    count_started: usize,
    count_finished: usize,
    count_build_metrics: usize,
    count_action: usize,
    count_test_result: usize,
    count_test_summary: usize,
) -> &'static str {
    if count_started > 0 && count_finished > 0 && count_build_metrics > 0 && count_action > 0 {
        return "complete";
    }
    if count_started == 0 && count_finished == 0 && count_build_metrics == 0 && count_action == 0 {
        return "missing_core";
    }
    if count_finished == 0
        && count_build_metrics == 0
        && count_action == 0
        && (count_test_result > 0 || count_test_summary > 0)
    {
        return "test_only";
    }
    if count_finished == 0 || count_build_metrics == 0 {
        return "missing_tail";
    }
    "partial"
}

fn summarize_normalized_event_counts(normalized_body: &str) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();

    for line in normalized_body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            *counts.entry("invalidJson".to_string()).or_default() += 1;
            continue;
        };

        let Some(object) = value.as_object() else {
            *counts.entry("nonObject".to_string()).or_default() += 1;
            continue;
        };

        let Some(id_object) = object.get("id").and_then(Value::as_object) else {
            *counts.entry("missingId".to_string()).or_default() += 1;
            continue;
        };

        if let Some(event_type) = id_object.keys().next() {
            *counts.entry(event_type.clone()).or_default() += 1;
        } else {
            *counts.entry("emptyId".to_string()).or_default() += 1;
        }
    }

    counts
}

fn chunk_lines(lines: &[String], max_chunk_bytes: usize) -> Vec<String> {
    let safe_limit = max_chunk_bytes.max(1);
    let mut chunks = Vec::new();
    let mut current = String::new();

    for line in lines {
        let line_len = line.len();
        if current.is_empty() {
            current.push_str(line);
            continue;
        }

        if current.len() + 1 + line_len > safe_limit {
            chunks.push(current);
            current = String::new();
            current.push_str(line);
        } else {
            current.push('\n');
            current.push_str(line);
        }
    }

    if !current.is_empty() {
        chunks.push(current);
    }

    chunks
}

fn gzip_base64(input: &str) -> Result<String, std::io::Error> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(input.as_bytes())?;
    let compressed = encoder.finish()?;
    Ok(BASE64_STANDARD.encode(compressed))
}

fn decode_bazel_event(
    envelope: Option<&BesEnvelope>,
) -> Result<Option<build_event_stream::BuildEvent>, Status> {
    let Some(envelope) = envelope else {
        return Ok(None);
    };

    let Some(any) = extract_bazel_any(envelope) else {
        return Ok(None);
    };

    build_event_stream::BuildEvent::decode(any.value.as_slice())
        .map(Some)
        .map_err(|err| Status::invalid_argument(format!("failed to decode bazel event: {err}")))
}

fn extract_bazel_any(envelope: &BesEnvelope) -> Option<&Any> {
    match envelope.event.as_ref()? {
        google::devtools::build::v1::build_event::Event::BazelEvent(event) => Some(event),
    }
}

#[allow(deprecated)]
fn convert_proto_event_to_json(event: &build_event_stream::BuildEvent) -> Option<Value> {
    let mut object = Map::new();
    object.insert("id".to_string(), convert_event_id(event.id.as_ref())?);

    match event.payload.as_ref()? {
        build_event_stream::build_event::Payload::Progress(progress) => {
            object.insert(
                "progress".to_string(),
                json!({
                    "stdout": progress.stdout,
                    "stderr": progress.stderr,
                }),
            );
        }
        build_event_stream::build_event::Payload::OptionsParsed(options) => {
            object.insert("optionsParsed".to_string(), convert_options_parsed(options));
        }
        build_event_stream::build_event::Payload::UnstructuredCommandLine(command_line) => {
            object.insert(
                "unstructuredCommandLine".to_string(),
                json!({
                    "args": command_line.args,
                }),
            );
        }
        build_event_stream::build_event::Payload::StructuredCommandLine(command_line) => {
            object.insert(
                "structuredCommandLine".to_string(),
                convert_structured_command_line(command_line),
            );
        }
        build_event_stream::build_event::Payload::WorkspaceStatus(workspace_status) => {
            object.insert(
                "workspaceStatus".to_string(),
                convert_workspace_status(workspace_status),
            );
        }
        build_event_stream::build_event::Payload::Fetch(fetch) => {
            object.insert(
                "fetch".to_string(),
                json!({
                    "success": fetch.success,
                }),
            );
        }
        build_event_stream::build_event::Payload::Configuration(configuration) => {
            object.insert(
                "configuration".to_string(),
                convert_configuration(configuration),
            );
        }
        build_event_stream::build_event::Payload::WorkspaceInfo(workspace_info) => {
            object.insert(
                "workspaceInfo".to_string(),
                json!({
                    "localExecRoot": workspace_info.local_exec_root,
                }),
            );
        }
        build_event_stream::build_event::Payload::Aborted(aborted) => {
            object.insert(
                "aborted".to_string(),
                json!({
                    "reason": build_event_stream::aborted::AbortReason::try_from(aborted.reason)
                        .ok()
                        .map(|reason| reason.as_str_name())
                        .unwrap_or("UNKNOWN"),
                    "description": aborted.description,
                }),
            );
        }
        build_event_stream::build_event::Payload::Started(started) => {
            object.insert(
                "started".to_string(),
                json!({
                    "uuid": started.uuid,
                    "startTimeMillis": proto_timestamp_to_millis(started.start_time.as_ref())
                        .unwrap_or(started.start_time_millis)
                        .to_string(),
                    "buildToolVersion": started.build_tool_version,
                    "command": started.command,
                }),
            );
        }
        build_event_stream::build_event::Payload::Configured(configured) => {
            let mut configured_object = Map::new();
            configured_object.insert("targetKind".to_string(), json!(configured.target_kind));
            if configured.test_size != build_event_stream::TestSize::Unknown as i32 {
                configured_object.insert(
                    "testSize".to_string(),
                    json!(build_event_stream::TestSize::try_from(configured.test_size)
                        .ok()
                        .map(|size| size.as_str_name())
                        .unwrap_or("UNKNOWN")),
                );
            }
            object.insert("configured".to_string(), Value::Object(configured_object));
        }
        build_event_stream::build_event::Payload::Completed(completed) => {
            object.insert(
                "completed".to_string(),
                json!({
                    "success": completed.success,
                }),
            );
        }
        build_event_stream::build_event::Payload::TestResult(test_result) => {
            object.insert("testResult".to_string(), convert_test_result(test_result));
        }
        build_event_stream::build_event::Payload::TestProgress(test_progress) => {
            object.insert(
                "testProgress".to_string(),
                json!({
                    "uri": test_progress.uri,
                }),
            );
        }
        build_event_stream::build_event::Payload::Action(action) => {
            object.insert("action".to_string(), convert_action_executed(action));
        }
        build_event_stream::build_event::Payload::TestSummary(test_summary) => {
            object.insert(
                "testSummary".to_string(),
                convert_test_summary(test_summary),
            );
        }
        build_event_stream::build_event::Payload::TargetSummary(target_summary) => {
            object.insert(
                "targetSummary".to_string(),
                convert_target_summary(target_summary),
            );
        }
        build_event_stream::build_event::Payload::Finished(finished) => {
            let overall_success = finished
                .exit_code
                .as_ref()
                .map(|exit_code| exit_code.code == 0)
                .unwrap_or(finished.overall_success);
            object.insert(
                "finished".to_string(),
                json!({
                    "overallSuccess": overall_success,
                    "finishTimeMillis": proto_timestamp_to_millis(finished.finish_time.as_ref())
                        .unwrap_or(finished.finish_time_millis)
                        .to_string(),
                    "exitCode": {
                        "name": finished.exit_code.as_ref().map(|exit_code| exit_code.name.clone()).unwrap_or_default()
                    }
                }),
            );
        }
        build_event_stream::build_event::Payload::BuildMetrics(metrics) => {
            object.insert("buildMetrics".to_string(), convert_build_metrics(metrics));
        }
        build_event_stream::build_event::Payload::BuildMetadata(build_metadata) => {
            object.insert(
                "buildMetadata".to_string(),
                json!({
                    "metadata": build_metadata.metadata,
                }),
            );
        }
        build_event_stream::build_event::Payload::ConvenienceSymlinksIdentified(symlinks) => {
            object.insert(
                "convenienceSymlinksIdentified".to_string(),
                convert_convenience_symlinks(symlinks),
            );
        }
        build_event_stream::build_event::Payload::ExecRequest(exec_request) => {
            object.insert(
                "execRequest".to_string(),
                convert_exec_request(exec_request),
            );
        }
        _ => return None,
    }

    Some(Value::Object(object))
}

fn convert_event_id(id: Option<&build_event_stream::BuildEventId>) -> Option<Value> {
    let id = id?.id.as_ref()?;
    Some(match id {
        build_event_stream::build_event_id::Id::Progress(_) => json!({ "progress": {} }),
        build_event_stream::build_event_id::Id::Started(_) => json!({ "started": {} }),
        build_event_stream::build_event_id::Id::UnstructuredCommandLine(_) => {
            json!({ "unstructuredCommandLine": {} })
        }
        build_event_stream::build_event_id::Id::StructuredCommandLine(command_line) => json!({
            "structuredCommandLine": {
                "commandLineLabel": command_line.command_line_label,
            }
        }),
        build_event_stream::build_event_id::Id::WorkspaceStatus(_) => {
            json!({ "workspaceStatus": {} })
        }
        build_event_stream::build_event_id::Id::Fetch(fetch) => json!({
            "fetch": {
                "url": fetch.url,
            }
        }),
        build_event_stream::build_event_id::Id::Configuration(configuration) => json!({
            "configuration": {
                "id": configuration.id,
            }
        }),
        build_event_stream::build_event_id::Id::Workspace(_) => json!({ "workspace": {} }),
        build_event_stream::build_event_id::Id::BuildFinished(_) => {
            json!({ "buildFinished": {} })
        }
        build_event_stream::build_event_id::Id::BuildMetrics(_) => json!({ "buildMetrics": {} }),
        build_event_stream::build_event_id::Id::BuildMetadata(_) => {
            json!({ "buildMetadata": {} })
        }
        build_event_stream::build_event_id::Id::TargetConfigured(target) => json!({
            "targetConfigured": {
                "label": target.label,
            }
        }),
        build_event_stream::build_event_id::Id::TargetCompleted(target) => json!({
            "targetCompleted": {
                "label": target.label,
                "configuration": {
                    "id": target.configuration.as_ref().map(|cfg| cfg.id.clone()).unwrap_or_default()
                }
            }
        }),
        build_event_stream::build_event_id::Id::ActionCompleted(action) => json!({
            "actionCompleted": {
                "label": action.label,
                "primaryOutput": action.primary_output,
                "configuration": {
                    "id": action.configuration.as_ref().map(|cfg| cfg.id.clone()).unwrap_or_default()
                }
            }
        }),
        build_event_stream::build_event_id::Id::TestSummary(test) => json!({
            "testSummary": {
                "label": test.label,
                "configuration": {
                    "id": test.configuration.as_ref().map(|cfg| cfg.id.clone()).unwrap_or_default()
                }
            }
        }),
        build_event_stream::build_event_id::Id::TestResult(test) => json!({
            "testResult": {
                "label": test.label,
                "configuration": {
                    "id": test.configuration.as_ref().map(|cfg| cfg.id.clone()).unwrap_or_default()
                },
                "run": test.run,
                "shard": test.shard,
                "attempt": test.attempt,
            }
        }),
        build_event_stream::build_event_id::Id::TestProgress(test) => json!({
            "testProgress": {
                "label": test.label,
                "configuration": {
                    "id": test.configuration.as_ref().map(|cfg| cfg.id.clone()).unwrap_or_default()
                },
                "run": test.run,
                "shard": test.shard,
                "attempt": test.attempt,
            }
        }),
        build_event_stream::build_event_id::Id::TargetSummary(target) => json!({
            "targetSummary": {
                "label": target.label,
                "configuration": {
                    "id": target.configuration.as_ref().map(|cfg| cfg.id.clone()).unwrap_or_default()
                }
            }
        }),
        build_event_stream::build_event_id::Id::ConvenienceSymlinksIdentified(_) => {
            json!({ "convenienceSymlinksIdentified": {} })
        }
        build_event_stream::build_event_id::Id::ExecRequest(_) => json!({ "execRequest": {} }),
        _ => return None,
    })
}

fn convert_test_result(test_result: &build_event_stream::TestResult) -> Value {
    let mut object = Map::new();
    object.insert(
        "status".to_string(),
        json!(build_event_stream::TestStatus::try_from(test_result.status)
            .ok()
            .map(|status| status.as_str_name())
            .unwrap_or("NO_STATUS")),
    );

    if let Some(execution_info) = test_result.execution_info.as_ref() {
        object.insert(
            "executionInfo".to_string(),
            convert_execution_info(execution_info),
        );
    }

    Value::Object(object)
}

fn convert_options_parsed(options: &build_event_stream::OptionsParsed) -> Value {
    json!({
        "startupOptions": options.startup_options,
        "explicitStartupOptions": options.explicit_startup_options,
        "cmdLine": options.cmd_line,
        "explicitCmdLine": options.explicit_cmd_line,
        "toolTag": options.tool_tag,
    })
}

fn convert_structured_command_line(command_line: &command_line::CommandLine) -> Value {
    json!({
        "commandLineLabel": command_line.command_line_label,
        "sections": command_line.sections.iter().map(|section| {
            let mut section_object = Map::new();
            section_object.insert("sectionLabel".to_string(), json!(section.section_label));
            match section.section_type.as_ref() {
                Some(command_line::command_line_section::SectionType::ChunkList(chunks)) => {
                    section_object.insert("chunkList".to_string(), json!({
                        "chunk": chunks.chunk,
                    }));
                }
                Some(command_line::command_line_section::SectionType::OptionList(options)) => {
                    section_object.insert("optionList".to_string(), json!({
                        "option": options.option.iter().map(|option| json!({
                            "combinedForm": option.combined_form,
                            "optionName": option.option_name,
                            "optionValue": option.option_value,
                            "source": option.source,
                        })).collect::<Vec<_>>(),
                    }));
                }
                None => {}
            }
            Value::Object(section_object)
        }).collect::<Vec<_>>(),
    })
}

fn convert_workspace_status(workspace_status: &build_event_stream::WorkspaceStatus) -> Value {
    json!({
        "item": workspace_status.item.iter().map(|item| json!({
            "key": item.key,
            "value": item.value,
        })).collect::<Vec<_>>(),
    })
}

fn convert_configuration(configuration: &build_event_stream::Configuration) -> Value {
    json!({
        "mnemonic": configuration.mnemonic,
        "platformName": configuration.platform_name,
        "cpu": configuration.cpu,
        "makeVariable": configuration.make_variable,
        "isTool": configuration.is_tool,
    })
}

fn convert_action_executed(action: &build_event_stream::ActionExecuted) -> Value {
    json!({
        "success": action.success,
        "type": action.r#type,
        "exitCode": action.exit_code,
        "primaryOutput": action.primary_output.as_ref().map(|file| file.name.clone()).unwrap_or_default(),
        "stdout": action.stdout.as_ref().map(|file| file.name.clone()).unwrap_or_default(),
        "stderr": action.stderr.as_ref().map(|file| file.name.clone()).unwrap_or_default(),
        "commandLine": action.command_line,
        "startTimeMillis": proto_timestamp_to_millis(action.start_time.as_ref()).map(|value| value.to_string()),
        "endTimeMillis": proto_timestamp_to_millis(action.end_time.as_ref()).map(|value| value.to_string()),
        "failureDetail": action.failure_detail.as_ref().map(|detail| detail.message.clone()),
    })
}

fn convert_target_summary(target_summary: &build_event_stream::TargetSummary) -> Value {
    json!({
        "overallBuildSuccess": target_summary.overall_build_success,
        "overallTestStatus": build_event_stream::TestStatus::try_from(target_summary.overall_test_status)
            .ok()
            .map(|status| status.as_str_name())
            .unwrap_or("NO_STATUS"),
    })
}

fn convert_convenience_symlinks(
    symlinks: &build_event_stream::ConvenienceSymlinksIdentified,
) -> Value {
    json!({
        "convenienceSymlinks": symlinks.convenience_symlinks.iter().map(|symlink| json!({
            "path": symlink.path,
            "action": build_event_stream::convenience_symlink::Action::try_from(symlink.action)
                .ok()
                .map(|action| action.as_str_name())
                .unwrap_or("UNKNOWN"),
            "target": symlink.target,
        })).collect::<Vec<_>>(),
    })
}

fn convert_exec_request(exec_request: &build_event_stream::ExecRequestConstructed) -> Value {
    json!({
        "workingDirectory": String::from_utf8_lossy(&exec_request.working_directory).to_string(),
        "argv": exec_request.argv.iter().map(|arg| String::from_utf8_lossy(arg).to_string()).collect::<Vec<_>>(),
        "environmentVariable": exec_request.environment_variable.iter().map(|variable| json!({
            "name": String::from_utf8_lossy(&variable.name).to_string(),
            "value": String::from_utf8_lossy(&variable.value).to_string(),
        })).collect::<Vec<_>>(),
        "environmentVariableToClear": exec_request
            .environment_variable_to_clear
            .iter()
            .map(|name| String::from_utf8_lossy(name).to_string())
            .collect::<Vec<_>>(),
        "shouldExec": exec_request.should_exec,
    })
}

fn convert_execution_info(
    execution_info: &build_event_stream::test_result::ExecutionInfo,
) -> Value {
    let mut object = Map::new();
    object.insert("strategy".to_string(), json!(execution_info.strategy));
    if let Some(timing_breakdown) = execution_info.timing_breakdown.as_ref() {
        object.insert(
            "timingBreakdown".to_string(),
            convert_timing_breakdown(timing_breakdown),
        );
    }
    Value::Object(object)
}

fn convert_timing_breakdown(
    timing_breakdown: &build_event_stream::test_result::execution_info::TimingBreakdown,
) -> Value {
    json!({
        "name": timing_breakdown.name,
        "time": proto_duration_to_seconds_text(timing_breakdown.time.as_ref()).unwrap_or_else(|| "0s".to_string()),
        "child": timing_breakdown
            .child
            .iter()
            .map(convert_timing_breakdown)
            .collect::<Vec<_>>(),
    })
}

#[allow(deprecated)]
fn convert_test_summary(test_summary: &build_event_stream::TestSummary) -> Value {
    json!({
        "overallStatus": build_event_stream::TestStatus::try_from(test_summary.overall_status)
            .ok()
            .map(|status| status.as_str_name())
            .unwrap_or("NO_STATUS"),
        "totalRunDurationMillis": proto_duration_to_millis(test_summary.total_run_duration.as_ref())
            .unwrap_or(test_summary.total_run_duration_millis)
            .to_string(),
        "totalRunDuration": proto_duration_to_seconds_text(test_summary.total_run_duration.as_ref())
            .unwrap_or_else(|| "0s".to_string()),
        "totalNumCached": test_summary.total_num_cached,
    })
}

fn convert_build_metrics(metrics: &build_event_stream::BuildMetrics) -> Value {
    let mut object = Map::new();

    if let Some(action_summary) = metrics.action_summary.as_ref() {
        object.insert(
            "actionSummary".to_string(),
            convert_action_summary(action_summary),
        );
    }
    if let Some(timing_metrics) = metrics.timing_metrics.as_ref() {
        object.insert(
            "timingMetrics".to_string(),
            json!({
                "wallTimeInMs": timing_metrics.wall_time_in_ms.to_string(),
                "cpuTimeInMs": timing_metrics.cpu_time_in_ms.to_string(),
                "analysisPhaseTimeInMs": timing_metrics.analysis_phase_time_in_ms.to_string(),
                "executionPhaseTimeInMs": timing_metrics.execution_phase_time_in_ms.to_string(),
            }),
        );
    }
    if let Some(memory_metrics) = metrics.memory_metrics.as_ref() {
        object.insert(
            "memoryMetrics".to_string(),
            json!({
                "usedHeapSizePostBuild": memory_metrics.used_heap_size_post_build.to_string(),
                "peakPostGcHeapSize": memory_metrics.peak_post_gc_heap_size.to_string(),
                "peakPostGcTenuredSpaceHeapSize": memory_metrics.peak_post_gc_tenured_space_heap_size.to_string(),
                "garbageMetrics": memory_metrics.garbage_metrics.iter().map(|metric| json!({
                    "type": metric.r#type,
                    "garbageCollected": metric.garbage_collected.to_string(),
                })).collect::<Vec<_>>(),
            }),
        );
    }
    if let Some(network_metrics) = metrics.network_metrics.as_ref() {
        object.insert(
            "networkMetrics".to_string(),
            json!({
                "systemNetworkStats": network_metrics.system_network_stats.as_ref().map(|stats| json!({
                    "bytesSent": stats.bytes_sent.to_string(),
                    "bytesRecv": stats.bytes_recv.to_string(),
                    "packetsSent": stats.packets_sent.to_string(),
                    "packetsRecv": stats.packets_recv.to_string(),
                    "peakBytesSentPerSec": stats.peak_bytes_sent_per_sec.to_string(),
                    "peakBytesRecvPerSec": stats.peak_bytes_recv_per_sec.to_string(),
                    "peakPacketsSentPerSec": stats.peak_packets_sent_per_sec.to_string(),
                    "peakPacketsRecvPerSec": stats.peak_packets_recv_per_sec.to_string(),
                })).unwrap_or_else(|| json!({})),
            }),
        );
    }
    object.insert(
        "workerMetrics".to_string(),
        Value::Array(metrics.worker_metrics.iter().map(|metric| json!({
            "mnemonic": metric.mnemonic,
            "isMultiplex": metric.is_multiplex,
            "isSandbox": metric.is_sandbox,
            "actionsExecuted": metric.actions_executed.to_string(),
            "priorActionsExecuted": metric.prior_actions_executed.to_string(),
            "workerStatus": build_event_stream::build_metrics::worker_metrics::WorkerStatus::try_from(metric.worker_status)
                .ok()
                .map(|status| status.as_str_name())
                .unwrap_or("UNKNOWN"),
            "workerStats": metric.worker_stats.iter().map(|stats| json!({
                "collectTimeInMs": stats.collect_time_in_ms.to_string(),
                "workerMemoryInKb": stats.worker_memory_in_kb,
                "priorWorkerMemoryInKb": stats.prior_worker_memory_in_kb,
                "lastActionStartTimeInMs": stats.last_action_start_time_in_ms.to_string(),
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>()),
    );

    Value::Object(object)
}

#[allow(deprecated)]
fn convert_action_summary(
    action_summary: &build_event_stream::build_metrics::ActionSummary,
) -> Value {
    json!({
        "actionsExecuted": action_summary.actions_executed.to_string(),
        "remoteCacheHits": action_summary.remote_cache_hits.to_string(),
        "actionCacheStatistics": action_summary.action_cache_statistics.as_ref().map(|stats| json!({
            "hits": stats.hits,
            "misses": stats.misses,
        })).unwrap_or_else(|| json!({})),
        "runnerCount": action_summary.runner_count.iter().map(|runner| json!({
            "name": runner.name,
            "count": runner.count,
        })).collect::<Vec<_>>(),
        "actionData": action_summary.action_data.iter().map(|data| json!({
            "mnemonic": data.mnemonic,
            "actionsExecuted": data.actions_executed.to_string(),
            "firstStartedMs": data.first_started_ms.to_string(),
            "lastEndedMs": data.last_ended_ms.to_string(),
            "systemTime": proto_duration_to_seconds_text(data.system_time.as_ref()),
            "userTime": proto_duration_to_seconds_text(data.user_time.as_ref()),
        })).collect::<Vec<_>>(),
    })
}

fn proto_duration_to_millis(duration: Option<&ProtoDuration>) -> Option<i64> {
    let duration = duration?;
    Some(duration.seconds.saturating_mul(1000) + i64::from(duration.nanos) / 1_000_000)
}

fn proto_duration_to_seconds_text(duration: Option<&ProtoDuration>) -> Option<String> {
    let duration = duration?;
    let millis = proto_duration_to_millis(Some(duration))?;
    Some(format!("{:.3}s", millis as f64 / 1000.0))
}

fn proto_timestamp_to_millis(timestamp: Option<&ProtoTimestamp>) -> Option<i64> {
    let timestamp = timestamp?;
    Some(timestamp.seconds.saturating_mul(1000) + i64::from(timestamp.nanos) / 1_000_000)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let listen_addr: SocketAddr = env::var("BEPLESS_GRPC_LISTEN_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:50051".to_string())
        .parse()?;
    let (mut health_reporter, health_service) = tonic_health::server::health_reporter();
    health_reporter
        .set_service_status(
            "google.devtools.build.v1.PublishBuildEvent",
            tonic_health::ServingStatus::Serving,
        )
        .await;

    let service = BesIngestService::new()
        .await
        .map_err(|err| format!("failed to initialize BES ingest service: {err}"))?;
    let sink_config = service.sink.as_ref().clone();

    info!(
        http_sink_configured = sink_config.endpoint_url.is_some(),
        http_sink_retry_attempts = sink_config.max_retries,
        "bepless grpc-ingest listening on {listen_addr}; configured as a thin BES ingress without embedded secrets"
    );

    Server::builder()
        .add_service(health_service)
        .add_service(PublishBuildEventServer::new(service))
        .serve_with_shutdown(listen_addr, async {
            if let Err(err) = signal::ctrl_c().await {
                error!("failed to wait for shutdown signal: {err}");
            }
        })
        .await?;

    Ok(())
}
