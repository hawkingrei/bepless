use std::{env, net::SocketAddr, sync::Arc, time::Duration};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use prost::Message;
use prost_types::Any;
use serde::Serialize;
use tokio::{signal, sync::Mutex};
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

#[derive(Debug, Clone)]
struct HttpSinkConfig {
    endpoint_url: Option<String>,
    timeout: Duration,
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
        }
    }
}

impl HttpSinkConfig {
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
        lines: &[String],
    ) -> Result<(), String> {
        if lines.is_empty() {
            return Ok(());
        }

        let body = lines.join("\n");
        if let Some(endpoint_url) = &self.endpoint_url {
            let client = reqwest::Client::builder()
                .timeout(self.timeout)
                .build()
                .map_err(|err| format!("failed to build http sink client: {err}"))?;

            let response = client
                .post(endpoint_url)
                .header("content-type", "application/x-ndjson")
                .header("x-bepless-project-id", project_id)
                .header("x-bepless-build-id", stream_id.build_id.as_str())
                .header("x-bepless-invocation-id", stream_id.invocation_id.as_str())
                .body(body)
                .send()
                .await
                .map_err(|err| format!("failed to deliver ndjson to http sink: {err}"))?;

            if !response.status().is_success() {
                return Err(format!(
                    "http sink returned non-success status: {}",
                    response.status()
                ));
            }

            info!(
                endpoint_url,
                line_count = lines.len(),
                invocation_id = stream_id.invocation_id,
                "flushed invocation to http sink"
            );
            return Ok(());
        }

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

#[derive(Debug, Clone, Default)]
struct BesIngestService {
    sink: Arc<Mutex<HttpSinkConfig>>,
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

        tokio::spawn(async move {
            let mut buffered_lines = Vec::new();
            let mut stream_context: Option<(String, StreamId)> = None;
            loop {
                match inbound.message().await {
                    Ok(Some(message)) => match handle_stream_message(&sink, message).await {
                        Ok((response, maybe_line, project_id, stream_id)) => {
                            stream_context = Some((project_id, stream_id.clone()));
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
                        if let Some((project_id, stream_id)) = stream_context {
                            let sink_config = sink.lock().await.clone();
                            if let Err(err) = sink_config
                                .flush(&project_id, &stream_id, &buffered_lines)
                                .await
                            {
                                error!(
                                    invocation_id = stream_id.invocation_id,
                                    build_id = stream_id.build_id,
                                    "failed to flush invocation to http sink: {err}"
                                );
                            }
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
    sink: &Arc<Mutex<HttpSinkConfig>>,
    message: PublishBuildToolEventStreamRequest,
) -> Result<
    (
        PublishBuildToolEventStreamResponse,
        Option<String>,
        String,
        StreamId,
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

    let sink_config = sink.lock().await.clone();
    let encoded_line = maybe_render_ndjson_line(
        &sink_config,
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

    let service = BesIngestService::default();
    let sink_config = service.sink.lock().await.clone();

    info!(
        http_sink_configured = sink_config.endpoint_url.is_some(),
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
