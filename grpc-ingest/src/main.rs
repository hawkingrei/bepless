use std::net::SocketAddr;

use tokio::signal;
use tonic::transport::Server;
use tracing::info;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let listen_addr: SocketAddr = "127.0.0.1:50051".parse()?;
    let (mut health_reporter, health_service) = tonic_health::server::health_reporter();
    health_reporter
        .set_service_status("", tonic_health::ServingStatus::Serving)
        .await;

    info!(
        "bepless grpc-ingest skeleton starting on {listen_addr}; no private deployment metadata is checked in"
    );

    Server::builder()
        .add_service(health_service)
        .serve_with_shutdown(listen_addr, async {
            let _ = signal::ctrl_c().await;
        })
        .await?;

    Ok(())
}
