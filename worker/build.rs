fn main() -> Result<(), Box<dyn std::error::Error>> {
    tonic_build::configure()
        .build_client(false)
        .build_server(false)
        .protoc_arg("--experimental_allow_proto3_optional")
        .compile_protos(
            &[
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
