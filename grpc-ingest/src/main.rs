use std::{env, net::SocketAddr, sync::Arc, time::Duration};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use flate2::{write::GzEncoder, Compression};
use prost::Message;
use prost_types::Any;
use serde::Serialize;
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
}

#[derive(Debug, Clone)]
struct HttpSinkConfig {
    endpoint_url: Option<String>,
    timeout: Duration,
    max_retries: usize,
    retry_backoff: Duration,
    chunk_bytes: usize,
}

impl Default for HttpSinkConfig {
    fn default() -> Self {
        Self {
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
        }
    }
}

impl HttpSinkConfig {
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

    fn render_ndjson_line(
        &self,
        project_id: &str,
        stream_id: &StreamId,
        sequence_number: i64,
        notification_keywords: &[String],
        payload: &[u8],
    ) -> Result<String, Status> {
        let line = NormalizedBuildEvent {
            project_id,
            build_id: stream_id.build_id.as_str(),
            invocation_id: stream_id.invocation_id.as_str(),
            sequence_number,
            notification_keywords,
            bazel_event_proto_base64: BASE64_STANDARD.encode(payload),
        };
        serde_json::to_string(&line)
            .map_err(|err| Status::internal(format!("failed to encode ndjson line: {err}")))
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
    fn new() -> Self {
        let sink = Arc::new(HttpSinkConfig::default());
        let queue_capacity = env::var("BEPLESS_HTTP_SINK_QUEUE_CAPACITY")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(128);
        let (flush_tx, flush_rx) = mpsc::channel(queue_capacity);
        tokio::spawn(run_sink_worker(Arc::clone(&sink), flush_rx));

        Self { sink, flush_tx }
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
    sink: &HttpSinkConfig,
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
    sink.render_ndjson_line(
        project_id,
        stream_id,
        sequence_number,
        notification_keywords,
        any.value.as_slice(),
    )
    .map(Some)
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

    let service = BesIngestService::new();
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
