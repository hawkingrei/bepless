use std::{env, net::SocketAddr, sync::Arc};

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
    invocation_id: &'a str,
    sequence_number: i64,
    event_debug: String,
}

#[derive(Debug, Default)]
struct NdjsonEventSink {
    lines_emitted: usize,
}

impl NdjsonEventSink {
    fn emit(
        &mut self,
        project_id: &str,
        stream_id: &StreamId,
        sequence_number: i64,
        event: &build_event_stream::BuildEvent,
    ) -> Result<(), Status> {
        let line = NormalizedBuildEvent {
            project_id,
            invocation_id: stream_id.invocation_id.as_str(),
            sequence_number,
            event_debug: format!("{event:?}"),
        };
        let encoded = serde_json::to_string(&line)
            .map_err(|err| Status::internal(format!("failed to encode ndjson line: {err}")))?;
        info!(target: "bepless.grpc_ingest.ndjson", "{encoded}");
        self.lines_emitted += 1;
        Ok(())
    }
}

#[derive(Debug, Clone, Default)]
struct BesIngestService {
    sink: Arc<Mutex<NdjsonEventSink>>,
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
            loop {
                match inbound.message().await {
                    Ok(Some(message)) => match handle_stream_message(&sink, message).await {
                        Ok(response) => {
                            if tx.send(Ok(response)).await.is_err() {
                                return;
                            }
                        }
                        Err(status) => {
                            let _ = tx.send(Err(status)).await;
                            return;
                        }
                    },
                    Ok(None) => return,
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
    sink: &Arc<Mutex<NdjsonEventSink>>,
    message: PublishBuildToolEventStreamRequest,
) -> Result<PublishBuildToolEventStreamResponse, Status> {
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

    if let Some(bazel_event) = decode_bazel_event(ordered.event.as_ref())? {
        sink.lock().await.emit(
            message.project_id.as_str(),
            &stream_id,
            ordered.sequence_number,
            &bazel_event,
        )?;
    }

    Ok(PublishBuildToolEventStreamResponse {
        stream_id: Some(stream_id),
        sequence_number: ordered.sequence_number,
    })
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

    info!(
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
