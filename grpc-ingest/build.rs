fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_build::configure()
        .build_client(true)
        .build_server(true)
        .compile_protos(
            &[
                "proto/google/protobuf/empty.proto",
                "proto/google/devtools/build/v1/build_events.proto",
                "proto/google/devtools/build/v1/publish_build_event.proto",
                "proto/src/main/java/com/google/devtools/build/lib/buildeventstream/proto/build_event_stream.proto",
                "proto/src/main/java/com/google/devtools/build/lib/packages/metrics/package_load_metrics.proto",
                "proto/src/main/protobuf/action_cache.proto",
                "proto/src/main/protobuf/command_line.proto",
                "proto/src/main/protobuf/failure_details.proto",
                "proto/src/main/protobuf/invocation_policy.proto",
                "proto/src/main/protobuf/option_filters.proto",
                "proto/src/main/protobuf/strategy_policy.proto",
            ],
            &["proto"],
        )?;

    println!("cargo:rerun-if-changed=proto");
    Ok(())
}
