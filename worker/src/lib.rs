use std::collections::BTreeMap;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use prost::Message;
use prost_types::{Duration as ProtoDuration, Timestamp as ProtoTimestamp};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use worker::{event, Context, FormEntry, Method, Request, Response, Result};

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

#[derive(Debug, Deserialize)]
struct IngestEnvelope {
    #[allow(dead_code)]
    project_id: String,
    #[allow(dead_code)]
    build_id: String,
    #[allow(dead_code)]
    invocation_id: String,
    #[allow(dead_code)]
    sequence_number: i64,
    bazel_event_proto_base64: String,
}

#[derive(Debug, Clone, Serialize)]
struct Summary {
    invocation_id: Option<String>,
    command: Option<String>,
    bazel_version: Option<String>,
    success: Option<bool>,
    exit_code: Option<String>,
    started_at_ms: Option<u64>,
    finished_at_ms: Option<u64>,
    elapsed_ms: Option<u64>,
    critical_path_ms: Option<u64>,
    wall_time_ms: Option<u64>,
    cpu_time_ms: Option<u64>,
    analysis_phase_ms: Option<u64>,
    execution_phase_ms: Option<u64>,
    configured_targets: usize,
    configured_test_targets: usize,
    completed_targets: usize,
    failed_targets: usize,
    test_summaries: usize,
    failed_tests: usize,
    total_actions: Option<u64>,
    remote_cache_hits: Option<u64>,
    action_cache_hits: Option<u64>,
    action_cache_misses: Option<u64>,
    cache_hit_ratio: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
struct SlowTarget {
    label: String,
    duration_ms: u64,
    status: String,
    cached: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
struct ActionMnemonic {
    mnemonic: String,
    actions_executed: u64,
    span_ms: u64,
    system_time_ms: Option<u64>,
    user_time_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
struct Finding {
    severity: &'static str,
    category: &'static str,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
struct AnalysisResponse {
    summary: Summary,
    slowest_tests: Vec<SlowTarget>,
    failed_targets: Vec<String>,
    top_action_mnemonics: Vec<ActionMnemonic>,
    runner_counts: BTreeMap<String, u64>,
    test_strategy_counts: BTreeMap<String, u64>,
    timing_breakdown_ms: BTreeMap<String, u64>,
    findings: Vec<Finding>,
}

#[derive(Debug, Default)]
struct AnalyzerState {
    invocation_id: Option<String>,
    command: Option<String>,
    bazel_version: Option<String>,
    success: Option<bool>,
    exit_code: Option<String>,
    started_at_ms: Option<u64>,
    finished_at_ms: Option<u64>,
    critical_path_ms: Option<u64>,
    wall_time_ms: Option<u64>,
    cpu_time_ms: Option<u64>,
    analysis_phase_ms: Option<u64>,
    execution_phase_ms: Option<u64>,
    configured_targets: usize,
    configured_test_targets: usize,
    completed_targets: usize,
    failed_targets: Vec<String>,
    test_summaries: usize,
    failed_tests: usize,
    total_actions: Option<u64>,
    remote_cache_hits: Option<u64>,
    action_cache_hits: Option<u64>,
    action_cache_misses: Option<u64>,
    slowest_tests: Vec<SlowTarget>,
    top_action_mnemonics: Vec<ActionMnemonic>,
    runner_counts: BTreeMap<String, u64>,
    test_strategy_counts: BTreeMap<String, u64>,
    timing_breakdown_ms: BTreeMap<String, u64>,
}

impl AnalyzerState {
    fn ingest(&mut self, event: &Value) {
        self.ingest_started(event);
        self.ingest_finished(event);
        self.ingest_progress(event);
        self.ingest_target_configured(event);
        self.ingest_target_completed(event);
        self.ingest_test_summary(event);
        self.ingest_test_result(event);
        self.ingest_build_metrics(event);
    }

    fn ingest_started(&mut self, event: &Value) {
        let started = match pointer(event, &["started"]) {
            Some(value) => value,
            None => return,
        };

        self.invocation_id
            .get_or_insert_with(|| string_at(started, &["uuid"]).unwrap_or_default());
        self.command
            .get_or_insert_with(|| string_at(started, &["command"]).unwrap_or_default());
        self.bazel_version
            .get_or_insert_with(|| string_at(started, &["buildToolVersion"]).unwrap_or_default());
        self.started_at_ms = self
            .started_at_ms
            .or_else(|| u64_at(started, &["startTimeMillis"]));
    }

    fn ingest_finished(&mut self, event: &Value) {
        let finished = match pointer(event, &["finished"]) {
            Some(value) => value,
            None => return,
        };

        self.success = self
            .success
            .or_else(|| bool_at(finished, &["overallSuccess"]));
        self.finished_at_ms = self
            .finished_at_ms
            .or_else(|| u64_at(finished, &["finishTimeMillis"]));
        if self.exit_code.is_none() {
            self.exit_code = string_at(finished, &["exitCode", "name"]);
        }
    }

    fn ingest_progress(&mut self, event: &Value) {
        let Some(stderr) = string_at(event, &["progress", "stderr"]) else {
            return;
        };
        if self.critical_path_ms.is_none() {
            self.critical_path_ms = extract_critical_path_ms(&stderr);
        }
    }

    fn ingest_target_configured(&mut self, event: &Value) {
        if pointer(event, &["id", "targetConfigured"]).is_none()
            || pointer(event, &["configured"]).is_none()
        {
            return;
        }
        self.configured_targets += 1;
        if pointer(event, &["configured", "testSize"]).is_some() {
            self.configured_test_targets += 1;
        }
    }

    fn ingest_target_completed(&mut self, event: &Value) {
        let Some(target_id) = pointer(event, &["id", "targetCompleted"]) else {
            return;
        };
        self.completed_targets += 1;

        let label = string_at(target_id, &["label"]).unwrap_or_else(|| "<unknown>".to_string());
        let completed_success = bool_at(event, &["completed", "success"]);
        let aborted_reason = string_at(event, &["aborted", "reason"]);

        if completed_success == Some(false) || aborted_reason.is_some() {
            if self.failed_targets.len() < 20 {
                self.failed_targets.push(label);
            }
        }
    }

    fn ingest_test_summary(&mut self, event: &Value) {
        let Some(test_id) = pointer(event, &["id", "testSummary"]) else {
            return;
        };
        let Some(test_summary) = pointer(event, &["testSummary"]) else {
            return;
        };

        self.test_summaries += 1;
        let status =
            string_at(test_summary, &["overallStatus"]).unwrap_or_else(|| "UNKNOWN".to_string());
        if status != "PASSED" && status != "FLAKY" {
            self.failed_tests += 1;
        }

        let label = string_at(test_id, &["label"]).unwrap_or_else(|| "<unknown>".to_string());
        let duration_ms = u64_at(test_summary, &["totalRunDurationMillis"])
            .or_else(|| u64_at(test_summary, &["totalRunDurationInMs"]))
            .or_else(|| duration_text_at(test_summary, &["totalRunDuration"]))
            .unwrap_or(0);

        let cached_runs = u64_at(test_summary, &["totalNumCached"]);
        self.slowest_tests.push(SlowTarget {
            label,
            duration_ms,
            status,
            cached: cached_runs.map(|value| value > 0),
        });
    }

    fn ingest_test_result(&mut self, event: &Value) {
        let Some(test_result) = pointer(event, &["testResult"]) else {
            return;
        };
        let Some(execution_info) = pointer(test_result, &["executionInfo"]) else {
            return;
        };

        if let Some(strategy) = string_at(execution_info, &["strategy"]) {
            *self.test_strategy_counts.entry(strategy).or_default() += 1;
        }

        if let Some(timing_breakdown) = pointer(execution_info, &["timingBreakdown"]) {
            fold_timing_breakdown(timing_breakdown, &mut self.timing_breakdown_ms);
        }
    }

    fn ingest_build_metrics(&mut self, event: &Value) {
        let Some(metrics) = pointer(event, &["buildMetrics"]) else {
            return;
        };

        self.wall_time_ms = self
            .wall_time_ms
            .or_else(|| u64_at(metrics, &["timingMetrics", "wallTimeInMs"]));
        self.cpu_time_ms = self
            .cpu_time_ms
            .or_else(|| u64_at(metrics, &["timingMetrics", "cpuTimeInMs"]));
        self.analysis_phase_ms = self
            .analysis_phase_ms
            .or_else(|| u64_at(metrics, &["timingMetrics", "analysisPhaseTimeInMs"]));
        self.execution_phase_ms = self
            .execution_phase_ms
            .or_else(|| u64_at(metrics, &["timingMetrics", "executionPhaseTimeInMs"]));

        self.total_actions = self
            .total_actions
            .or_else(|| u64_at(metrics, &["actionSummary", "actionsExecuted"]));
        self.remote_cache_hits = self
            .remote_cache_hits
            .or_else(|| u64_at(metrics, &["actionSummary", "remoteCacheHits"]));
        self.action_cache_hits = self
            .action_cache_hits
            .or_else(|| u64_at(metrics, &["actionSummary", "actionCacheStatistics", "hits"]));
        self.action_cache_misses = self.action_cache_misses.or_else(|| {
            u64_at(
                metrics,
                &["actionSummary", "actionCacheStatistics", "misses"],
            )
        });

        if let Some(runner_count) = array_at(metrics, &["actionSummary", "runnerCount"]) {
            for entry in runner_count {
                let name = string_at(entry, &["name"]).unwrap_or_else(|| "unknown".to_string());
                let count = u64_at(entry, &["count"]).unwrap_or(0);
                self.runner_counts.insert(name, count);
            }
        }

        if let Some(action_data) = array_at(metrics, &["actionSummary", "actionData"]) {
            let mut top = Vec::with_capacity(action_data.len());
            for entry in action_data {
                let mnemonic =
                    string_at(entry, &["mnemonic"]).unwrap_or_else(|| "unknown".to_string());
                let actions_executed = u64_at(entry, &["actionsExecuted"]).unwrap_or(0);
                let first_started_ms = u64_at(entry, &["firstStartedMs"]).unwrap_or(0);
                let last_ended_ms = u64_at(entry, &["lastEndedMs"]).unwrap_or(0);
                let span_ms = last_ended_ms.saturating_sub(first_started_ms);
                top.push(ActionMnemonic {
                    mnemonic,
                    actions_executed,
                    span_ms,
                    system_time_ms: duration_text_at(entry, &["systemTime"]),
                    user_time_ms: duration_text_at(entry, &["userTime"]),
                });
            }
            top.sort_by(|left, right| right.span_ms.cmp(&left.span_ms));
            self.top_action_mnemonics = top.into_iter().take(8).collect();
        }
    }

    fn finish(mut self) -> AnalysisResponse {
        self.slowest_tests
            .sort_by(|left, right| right.duration_ms.cmp(&left.duration_ms));

        let elapsed_ms = match (self.started_at_ms, self.finished_at_ms) {
            (Some(started), Some(finished)) if finished >= started => Some(finished - started),
            _ => None,
        };

        let cache_hit_ratio = match (self.action_cache_hits, self.action_cache_misses) {
            (Some(hits), Some(misses)) if hits + misses > 0 => {
                Some(hits as f64 / (hits + misses) as f64)
            }
            _ => None,
        };

        let summary = Summary {
            invocation_id: take_non_empty(self.invocation_id),
            command: take_non_empty(self.command),
            bazel_version: take_non_empty(self.bazel_version),
            success: self.success,
            exit_code: take_non_empty(self.exit_code),
            started_at_ms: self.started_at_ms,
            finished_at_ms: self.finished_at_ms,
            elapsed_ms,
            critical_path_ms: self.critical_path_ms,
            wall_time_ms: self.wall_time_ms,
            cpu_time_ms: self.cpu_time_ms,
            analysis_phase_ms: self.analysis_phase_ms,
            execution_phase_ms: self.execution_phase_ms,
            configured_targets: self.configured_targets,
            configured_test_targets: self.configured_test_targets,
            completed_targets: self.completed_targets,
            failed_targets: self.failed_targets.len(),
            test_summaries: self.test_summaries,
            failed_tests: self.failed_tests,
            total_actions: self.total_actions,
            remote_cache_hits: self.remote_cache_hits,
            action_cache_hits: self.action_cache_hits,
            action_cache_misses: self.action_cache_misses,
            cache_hit_ratio,
        };

        let findings = build_findings(
            &summary,
            &self.slowest_tests,
            &self.top_action_mnemonics,
            &self.timing_breakdown_ms,
        );

        AnalysisResponse {
            summary,
            slowest_tests: self.slowest_tests.into_iter().take(10).collect(),
            failed_targets: self.failed_targets,
            top_action_mnemonics: self.top_action_mnemonics,
            runner_counts: self.runner_counts,
            test_strategy_counts: self.test_strategy_counts,
            timing_breakdown_ms: self.timing_breakdown_ms,
            findings,
        }
    }
}

#[event(fetch)]
async fn fetch(mut req: Request, _env: worker::Env, _ctx: Context) -> Result<Response> {
    console_error_panic_hook::set_once();

    match (req.method(), req.path().as_str()) {
        (Method::Options, _) => cors_response(),
        (Method::Get, "/") => html_response(),
        (Method::Post, "/analyze") => analyze_request(&mut req).await,
        (Method::Post, "/ingest") => ingest_request(&mut req).await,
        _ => json_error(404, "not_found", "Route not found"),
    }
}

async fn analyze_request(req: &mut Request) -> Result<Response> {
    let payload = extract_payload(req).await?;
    let content = String::from_utf8(payload)
        .map_err(|_| worker::Error::RustError("Request body is not valid UTF-8".into()))?;
    let result = analyze_ndjson(&content).map_err(|message| worker::Error::RustError(message))?;

    let mut response = Response::from_json(&result)?;
    response
        .headers_mut()
        .set("content-type", "application/json; charset=utf-8")?;
    apply_cors(response)
}

async fn ingest_request(req: &mut Request) -> Result<Response> {
    let payload = extract_payload(req).await?;
    let content = String::from_utf8(payload)
        .map_err(|_| worker::Error::RustError("Request body is not valid UTF-8".into()))?;
    let result =
        analyze_ingest_ndjson(&content).map_err(|message| worker::Error::RustError(message))?;

    let mut response = Response::from_json(&result)?;
    response
        .headers_mut()
        .set("content-type", "application/json; charset=utf-8")?;
    apply_cors(response)
}

async fn extract_payload(req: &mut Request) -> Result<Vec<u8>> {
    let content_type = req
        .headers()
        .get("content-type")?
        .unwrap_or_default()
        .to_ascii_lowercase();

    if content_type.contains("multipart/form-data") {
        let form = req.form_data().await?;
        return match form.get("file") {
            Some(FormEntry::File(file)) => file.bytes().await,
            Some(FormEntry::Field(body)) => Ok(body.into_bytes()),
            None => Err(worker::Error::RustError(
                "Multipart upload must contain a file field named `file`".into(),
            )),
        };
    }

    req.bytes().await
}

fn analyze_ndjson(input: &str) -> std::result::Result<AnalysisResponse, String> {
    let mut analyzer = AnalyzerState::default();
    let mut parsed_lines = 0usize;

    for (line_index, raw_line) in input.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        let event: Value = serde_json::from_str(line)
            .map_err(|err| format!("Invalid BEP JSON at line {}: {}", line_index + 1, err))?;
        analyzer.ingest(&event);
        parsed_lines += 1;
    }

    if parsed_lines == 0 {
        return Err("No BEP events were found in the request body".to_string());
    }

    Ok(analyzer.finish())
}

fn analyze_ingest_ndjson(input: &str) -> std::result::Result<AnalysisResponse, String> {
    let mut analyzer = AnalyzerState::default();
    let mut parsed_lines = 0usize;

    for (line_index, raw_line) in input.lines().enumerate() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        let envelope: IngestEnvelope = serde_json::from_str(line)
            .map_err(|err| format!("Invalid ingest NDJSON at line {}: {}", line_index + 1, err))?;
        let payload = BASE64_STANDARD
            .decode(envelope.bazel_event_proto_base64)
            .map_err(|err| {
                format!(
                    "Invalid base64 BEP payload at line {}: {}",
                    line_index + 1,
                    err
                )
            })?;
        let event = build_event_stream::BuildEvent::decode(payload.as_slice()).map_err(|err| {
            format!(
                "Invalid Bazel BuildEvent protobuf at line {}: {}",
                line_index + 1,
                err
            )
        })?;

        if let Some(json_event) = convert_proto_event_to_json(&event) {
            analyzer.ingest(&json_event);
            parsed_lines += 1;
        }
    }

    if parsed_lines == 0 {
        return Err("No analyzable BEP events were found in the ingest body".to_string());
    }

    Ok(analyzer.finish())
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
        build_event_stream::build_event::Payload::TestSummary(test_summary) => {
            object.insert(
                "testSummary".to_string(),
                convert_test_summary(test_summary),
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
        _ => return None,
    }

    Some(Value::Object(object))
}

fn convert_event_id(id: Option<&build_event_stream::BuildEventId>) -> Option<Value> {
    let id = id?.id.as_ref()?;
    Some(match id {
        build_event_stream::build_event_id::Id::Progress(_) => json!({ "progress": {} }),
        build_event_stream::build_event_id::Id::Started(_) => json!({ "started": {} }),
        build_event_stream::build_event_id::Id::BuildFinished(_) => {
            json!({ "buildFinished": {} })
        }
        build_event_stream::build_event_id::Id::BuildMetrics(_) => json!({ "buildMetrics": {} }),
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
            "systemTime": proto_duration_to_seconds_text(data.system_time.as_ref()).unwrap_or_else(|| "0s".to_string()),
            "userTime": proto_duration_to_seconds_text(data.user_time.as_ref()).unwrap_or_else(|| "0s".to_string()),
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

fn build_findings(
    summary: &Summary,
    slowest_tests: &[SlowTarget],
    top_actions: &[ActionMnemonic],
    timing_breakdown_ms: &BTreeMap<String, u64>,
) -> Vec<Finding> {
    let mut findings = Vec::new();

    if let (Some(execution_ms), Some(wall_ms)) = (summary.execution_phase_ms, summary.wall_time_ms)
    {
        if wall_ms > 0 && execution_ms * 100 / wall_ms >= 70 {
            findings.push(Finding {
                severity: "high",
                category: "execution",
                message: format!(
                    "Execution dominates wall time: execution phase is {} ms out of {} ms wall time.",
                    execution_ms, wall_ms
                ),
            });
        }
    }

    if let (Some(analysis_ms), Some(wall_ms)) = (summary.analysis_phase_ms, summary.wall_time_ms) {
        if wall_ms > 0 && analysis_ms * 100 / wall_ms >= 30 {
            findings.push(Finding {
                severity: "medium",
                category: "analysis",
                message: format!(
                    "Analysis is a visible cost center: analysis phase is {} ms out of {} ms wall time.",
                    analysis_ms, wall_ms
                ),
            });
        }
    }

    if let Some(ratio) = summary.cache_hit_ratio {
        if ratio < 0.60 {
            findings.push(Finding {
                severity: "high",
                category: "cache",
                message: format!(
                    "Action cache hit ratio is low at {:.1}%. Expect unnecessary rebuild work.",
                    ratio * 100.0
                ),
            });
        } else if ratio < 0.85 {
            findings.push(Finding {
                severity: "medium",
                category: "cache",
                message: format!(
                    "Action cache hit ratio is only {:.1}%. There is room to reduce repeated execution.",
                    ratio * 100.0
                ),
            });
        }
    }

    if let (Some(critical_path_ms), Some(slowest_test)) =
        (summary.critical_path_ms, slowest_tests.first())
    {
        if critical_path_ms > 0 && slowest_test.duration_ms * 100 / critical_path_ms >= 50 {
            findings.push(Finding {
                severity: "medium",
                category: "tests",
                message: format!(
                    "A single test is consuming a large portion of the critical path: {} took {} ms, critical path is {} ms.",
                    slowest_test.label, slowest_test.duration_ms, critical_path_ms
                ),
            });
        }
    }

    if let Some(queue_ms) = timing_breakdown_ms.get("queueTime") {
        if *queue_ms > 0 {
            findings.push(Finding {
                severity: "medium",
                category: "remote-execution",
                message: format!(
                    "Observed queueTime in test execution breakdowns: {} ms aggregated. Scheduler pressure may be visible.",
                    queue_ms
                ),
            });
        }
    }

    if let Some(network_ms) = timing_breakdown_ms.get("networkTime") {
        if *network_ms > 0 {
            findings.push(Finding {
                severity: "low",
                category: "remote-execution",
                message: format!(
                    "Observed networkTime in execution breakdowns: {} ms aggregated.",
                    network_ms
                ),
            });
        }
    }

    if let Some(action) = top_actions.first() {
        if action.span_ms > 0 {
            findings.push(Finding {
                severity: "low",
                category: "actions",
                message: format!(
                    "Longest action mnemonic span is {} at {} ms across {} executed actions.",
                    action.mnemonic, action.span_ms, action.actions_executed
                ),
            });
        }
    }

    findings
}

fn fold_timing_breakdown(node: &Value, totals: &mut BTreeMap<String, u64>) {
    if let Some(name) = string_at(node, &["name"]) {
        if let Some(duration_ms) = duration_text_at(node, &["time"]) {
            *totals.entry(name).or_default() += duration_ms;
        }
    }

    if let Some(children) = array_at(node, &["child"]) {
        for child in children {
            fold_timing_breakdown(child, totals);
        }
    }
}

fn extract_critical_path_ms(stderr: &str) -> Option<u64> {
    let needle = "Critical Path:";
    let index = stderr.find(needle)?;
    let tail = stderr[index + needle.len()..].trim_start();
    let token = tail.split_whitespace().next()?;
    parse_duration_to_ms(token)
}

fn pointer<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for segment in path {
        current = current.get(*segment)?;
    }
    Some(current)
}

fn array_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a [Value]> {
    pointer(value, path)?.as_array().map(Vec::as_slice)
}

fn string_at(value: &Value, path: &[&str]) -> Option<String> {
    let candidate = pointer(value, path)?;
    match candidate {
        Value::String(inner) => Some(inner.clone()),
        Value::Number(inner) => Some(inner.to_string()),
        _ => None,
    }
}

fn bool_at(value: &Value, path: &[&str]) -> Option<bool> {
    pointer(value, path)?.as_bool()
}

fn u64_at(value: &Value, path: &[&str]) -> Option<u64> {
    let candidate = pointer(value, path)?;
    match candidate {
        Value::Number(inner) => inner.as_u64(),
        Value::String(inner) => inner.parse::<u64>().ok(),
        _ => None,
    }
}

fn duration_text_at(value: &Value, path: &[&str]) -> Option<u64> {
    let candidate = string_at(value, path)?;
    parse_duration_to_ms(&candidate)
}

fn parse_duration_to_ms(text: &str) -> Option<u64> {
    let trimmed = text.trim();
    if let Some(value) = trimmed.strip_suffix("ms") {
        return value
            .trim()
            .parse::<f64>()
            .ok()
            .map(|value| value.round() as u64);
    }
    if let Some(value) = trimmed.strip_suffix('s') {
        return value
            .trim()
            .parse::<f64>()
            .ok()
            .map(|value| (value * 1000.0).round() as u64);
    }
    trimmed.parse::<u64>().ok()
}

fn apply_cors(mut response: Response) -> Result<Response> {
    let headers = response.headers_mut();
    headers.set("access-control-allow-origin", "*")?;
    headers.set("access-control-allow-methods", "GET,POST,OPTIONS")?;
    headers.set("access-control-allow-headers", "content-type")?;
    Ok(response)
}

fn take_non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|inner| if inner.is_empty() { None } else { Some(inner) })
}

fn cors_response() -> Result<Response> {
    apply_cors(Response::empty()?)
}

fn json_error(status: u16, code: &str, message: &str) -> Result<Response> {
    let body = serde_json::json!({
        "error": code,
        "message": message,
    });
    let response = Response::from_json(&body)?.with_status(status);
    apply_cors(response)
}

fn html_response() -> Result<Response> {
    let html = r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Bazel BEP Review</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f3efe6;
        --panel: rgba(255, 252, 245, 0.88);
        --ink: #1b1c1d;
        --muted: #5e625d;
        --accent: #0b6e4f;
        --accent-strong: #084c39;
        --accent-soft: rgba(11, 110, 79, 0.1);
        --warn: #92400e;
        --warn-soft: rgba(146, 64, 14, 0.12);
        --danger: #991b1b;
        --danger-soft: rgba(153, 27, 27, 0.1);
        --border: rgba(105, 95, 78, 0.22);
        --shadow: 0 20px 60px rgba(57, 49, 35, 0.12);
      }
      body {
        margin: 0;
        font-family: "Iosevka Aile", "IBM Plex Sans", sans-serif;
        background:
          radial-gradient(circle at top right, rgba(11, 110, 79, 0.15), transparent 24%),
          radial-gradient(circle at left 20%, rgba(217, 119, 6, 0.08), transparent 22%),
          linear-gradient(180deg, #f8f4eb 0%, #ece3d2 100%);
        color: var(--ink);
      }
      main {
        max-width: 1320px;
        margin: 0 auto;
        padding: 28px 20px 72px;
      }
      .shell {
        display: grid;
        gap: 18px;
      }
      .hero {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 28px;
        padding: 28px 30px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(12px);
      }
      h1 {
        font-family: "IBM Plex Mono", monospace;
        font-size: clamp(32px, 5vw, 54px);
        line-height: 1.05;
        margin: 0 0 12px;
      }
      p {
        color: var(--muted);
        font-size: 16px;
        line-height: 1.6;
        margin: 0;
      }
      .hero-grid {
        display: grid;
        grid-template-columns: minmax(0, 1.05fr) minmax(320px, 0.95fr);
        gap: 18px;
        align-items: start;
        margin-top: 24px;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 18px;
        padding: 18px;
      }
      .input-panel {
        display: grid;
        gap: 14px;
      }
      .label {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: baseline;
        font-family: "IBM Plex Mono", monospace;
        font-size: 13px;
        color: var(--muted);
      }
      textarea {
        width: 100%;
        min-height: 420px;
        resize: vertical;
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 16px;
        font: 13px/1.55 "IBM Plex Mono", monospace;
        color: var(--ink);
        background: rgba(255, 255, 255, 0.72);
        box-sizing: border-box;
      }
      textarea:focus {
        outline: 2px solid rgba(11, 110, 79, 0.16);
        border-color: rgba(11, 110, 79, 0.4);
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }
      button {
        appearance: none;
        border: 0;
        border-radius: 999px;
        background: var(--accent);
        color: white;
        padding: 12px 18px;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
        transition: transform 120ms ease, background 120ms ease;
      }
      button:hover {
        background: var(--accent-strong);
        transform: translateY(-1px);
      }
      button.secondary {
        background: rgba(27, 28, 29, 0.08);
        color: var(--ink);
      }
      button.secondary:hover {
        background: rgba(27, 28, 29, 0.14);
      }
      .status {
        min-height: 20px;
        font-size: 13px;
        color: var(--muted);
      }
      .dashboard {
        display: grid;
        gap: 18px;
      }
      .kpi-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
      }
      .kpi {
        background: rgba(255, 255, 255, 0.7);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 14px;
      }
      .kpi-label {
        font-family: "IBM Plex Mono", monospace;
        color: var(--muted);
        font-size: 12px;
      }
      .kpi-value {
        font-size: 28px;
        font-weight: 700;
        margin-top: 8px;
      }
      .grid-2 {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 320px;
        gap: 18px;
      }
      h2 {
        margin: 0 0 14px;
        font-size: 18px;
      }
      ul {
        margin: 0;
        padding: 0;
        list-style: none;
        display: grid;
        gap: 10px;
      }
      li {
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 12px 14px;
        background: rgba(255, 255, 255, 0.64);
      }
      .finding-high {
        background: var(--danger-soft);
        border-color: rgba(153, 27, 27, 0.22);
      }
      .finding-medium {
        background: var(--warn-soft);
        border-color: rgba(146, 64, 14, 0.22);
      }
      .finding-low {
        background: var(--accent-soft);
      }
      .mono {
        font-family: "IBM Plex Mono", monospace;
      }
      .muted {
        color: var(--muted);
      }
      .split-line {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: baseline;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 4px 10px;
        font-size: 12px;
        font-family: "IBM Plex Mono", monospace;
        background: rgba(27, 28, 29, 0.08);
      }
      pre {
        overflow: auto;
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: "IBM Plex Mono", monospace;
        font-size: 13px;
        line-height: 1.55;
      }
      .hint {
        font-family: "IBM Plex Mono", monospace;
        font-size: 13px;
      }
      .history-item {
        cursor: pointer;
        transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
      }
      .history-item:hover {
        transform: translateY(-1px);
        border-color: rgba(11, 110, 79, 0.28);
        background: rgba(255, 255, 255, 0.82);
      }
      .history-meta {
        margin-top: 8px;
        font-size: 12px;
        color: var(--muted);
        display: grid;
        gap: 4px;
      }
      @media (max-width: 1100px) {
        .layout {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="shell">
        <div class="layout">
          <div class="shell">
            <section class="hero">
              <h1>Bazel BEP Review</h1>
              <p>
                Paste BEP NDJSON and review the bottlenecks directly: critical path, action cache efficiency,
                slow tests, action spans, timing breakdowns, and a small set of performance findings.
              </p>
              <div class="hero-grid">
                <section class="panel input-panel">
                  <div class="label">
                    <span>Input</span>
                    <span>Paste `--build_event_json_file` output</span>
                  </div>
                  <textarea id="source" spellcheck="false" placeholder="Paste BEP NDJSON here"></textarea>
                  <div class="toolbar">
                    <button id="analyze-btn" type="button">Run Review</button>
                    <button id="clear-btn" class="secondary" type="button">Clear</button>
                    <button id="sample-btn" class="secondary" type="button">Insert Sample</button>
                  </div>
                  <div class="status" id="status">Waiting for input.</div>
                </section>

                <section class="dashboard">
                  <section class="panel">
                    <h2>Summary</h2>
                    <div class="kpi-grid" id="summary-grid"></div>
                  </section>

                  <section class="grid-2">
                    <section class="panel">
                      <h2>Findings</h2>
                      <ul id="findings-list">
                        <li class="muted">No analysis yet.</li>
                      </ul>
                    </section>
                    <section class="panel">
                      <h2>Failed Targets</h2>
                      <ul id="failed-targets-list">
                        <li class="muted">No analysis yet.</li>
                      </ul>
                    </section>
                  </section>
                </section>
              </div>
            </section>

            <section class="grid-2">
              <section class="panel">
                <h2>Slowest Tests</h2>
                <ul id="slow-tests-list">
                  <li class="muted">No analysis yet.</li>
                </ul>
              </section>
              <section class="panel">
                <h2>Top Action Mnemonics</h2>
                <ul id="actions-list">
                  <li class="muted">No analysis yet.</li>
                </ul>
              </section>
            </section>

            <section class="grid-2">
              <section class="panel">
                <h2>Runner Counts</h2>
                <ul id="runner-counts-list">
                  <li class="muted">No analysis yet.</li>
                </ul>
              </section>
              <section class="panel">
                <h2>Timing Breakdown</h2>
                <ul id="timing-breakdown-list">
                  <li class="muted">No analysis yet.</li>
                </ul>
              </section>
            </section>
          </div>

          <aside class="panel">
            <h2>Recent Reviews</h2>
            <p class="hint">Only the latest 50 reviews are retained locally in this browser.</p>
            <ul id="history-list">
              <li class="muted">No review history yet.</li>
            </ul>
          </aside>
        </div>
      </div>
    </main>
    <script>
      const source = document.getElementById("source");
      const status = document.getElementById("status");
      const analyzeBtn = document.getElementById("analyze-btn");
      const clearBtn = document.getElementById("clear-btn");
      const sampleBtn = document.getElementById("sample-btn");

      const summaryGrid = document.getElementById("summary-grid");
      const findingsList = document.getElementById("findings-list");
      const failedTargetsList = document.getElementById("failed-targets-list");
      const slowTestsList = document.getElementById("slow-tests-list");
      const actionsList = document.getElementById("actions-list");
      const runnerCountsList = document.getElementById("runner-counts-list");
      const timingBreakdownList = document.getElementById("timing-breakdown-list");
      const historyList = document.getElementById("history-list");

      const HISTORY_KEY = "bep-review-history-v1";
      const HISTORY_LIMIT = 50;

      const sampleText = [
        '{"id":{"started":{}},"started":{"uuid":"demo-invocation","startTimeMillis":"1714695817843","buildToolVersion":"7.1.0","command":"test"}}',
        '{"id":{"testSummary":{"label":"//demo:test","configuration":{"id":"fastbuild"}}},"testSummary":{"overallStatus":"PASSED","totalRunDurationMillis":"1134","totalNumCached":0}}',
        '{"id":{"progress":{"opaqueCount":1}},"progress":{"stderr":"INFO: Elapsed time: 2.598s, Critical Path: 2.22s\\n"}}',
        '{"id":{"buildMetrics":{}},"buildMetrics":{"actionSummary":{"actionsExecuted":"4","remoteCacheHits":"10","actionCacheStatistics":{"hits":10,"misses":5},"runnerCount":[{"name":"total","count":4},{"name":"darwin-sandbox","count":2}],"actionData":[{"mnemonic":"TestRunner","actionsExecuted":"1","firstStartedMs":"1714695819112","lastEndedMs":"1714695820440","systemTime":"0.356s","userTime":"0.830s"}]},"timingMetrics":{"cpuTimeInMs":"3495","wallTimeInMs":"2565","analysisPhaseTimeInMs":"56","executionPhaseTimeInMs":"2268"}}',
        '{"id":{"buildFinished":{}},"finished":{"overallSuccess":true,"finishTimeMillis":"1714695820441","exitCode":{"name":"SUCCESS"}}}'
      ].join("\\n");

      function formatMs(value) {
        if (value === null || value === undefined) return "n/a";
        if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
        return `${value}ms`;
      }

      function formatPercent(value) {
        if (value === null || value === undefined) return "n/a";
        return `${(value * 100).toFixed(1)}%`;
      }

      function createListItems(container, items, render, emptyText) {
        if (!items || items.length === 0) {
          container.innerHTML = `<li class="muted">${emptyText}</li>`;
          return;
        }
        container.innerHTML = items.map(render).join("");
      }

      function readHistory() {
        try {
          const raw = localStorage.getItem(HISTORY_KEY);
          if (!raw) return [];
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
          return [];
        }
      }

      function writeHistory(history) {
        const next = history.slice(0, HISTORY_LIMIT);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
        return next;
      }

      function saveHistoryEntry(input, payload) {
        const history = readHistory().filter((entry) => entry.input !== input);
        history.unshift({
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          created_at: new Date().toISOString(),
          input,
          summary: payload.summary,
        });
        return writeHistory(history);
      }

      function renderHistory() {
        const history = writeHistory(readHistory());
        if (history.length === 0) {
          historyList.innerHTML = '<li class="muted">No review history yet.</li>';
          return;
        }

        historyList.innerHTML = history.map((entry) => `
          <li class="history-item" data-history-id="${entry.id}">
            <div class="split-line">
              <strong class="mono">${entry.summary.invocation_id || entry.summary.command || "unknown"}</strong>
              <span class="badge">${entry.summary.success === true ? "success" : entry.summary.success === false ? "failed" : "n/a"}</span>
            </div>
            <div class="history-meta">
              <span>${new Date(entry.created_at).toLocaleString()}</span>
              <span>critical=${formatMs(entry.summary.critical_path_ms)}</span>
              <span>wall=${formatMs(entry.summary.wall_time_ms ?? entry.summary.elapsed_ms)}</span>
            </div>
          </li>
        `).join("");
      }

      function renderSummary(summary) {
        const cards = [
          ["Invocation", summary.invocation_id || "n/a"],
          ["Command", summary.command || "n/a"],
          ["Wall Time", formatMs(summary.wall_time_ms ?? summary.elapsed_ms)],
          ["Critical Path", formatMs(summary.critical_path_ms)],
          ["Cache Hit Ratio", formatPercent(summary.cache_hit_ratio)],
          ["Actions", summary.total_actions ?? "n/a"],
          ["Failed Tests", summary.failed_tests],
          ["Exit Code", summary.exit_code || "n/a"]
        ];
        summaryGrid.innerHTML = cards.map(([label, value]) => `
          <article class="kpi">
            <div class="kpi-label">${label}</div>
            <div class="kpi-value">${value}</div>
          </article>
        `).join("");
      }

      function renderAnalysis(payload) {
        renderSummary(payload.summary);

        createListItems(findingsList, payload.findings, (item) => `
          <li class="finding-${item.severity}">
            <div class="split-line">
              <strong>${item.category}</strong>
              <span class="badge">${item.severity}</span>
            </div>
            <div class="muted" style="margin-top: 8px;">${item.message}</div>
          </li>
        `, "No findings.");

        createListItems(failedTargetsList, payload.failed_targets, (item) => `
          <li><span class="mono">${item}</span></li>
        `, "No failed targets.");

        createListItems(slowTestsList, payload.slowest_tests, (item) => `
          <li>
            <div class="split-line">
              <strong class="mono">${item.label}</strong>
              <span class="badge">${formatMs(item.duration_ms)}</span>
            </div>
            <div class="muted" style="margin-top: 8px;">
              status=${item.status} cached=${item.cached === null || item.cached === undefined ? "n/a" : String(item.cached)}
            </div>
          </li>
        `, "No test summaries.");

        createListItems(actionsList, payload.top_action_mnemonics, (item) => `
          <li>
            <div class="split-line">
              <strong>${item.mnemonic}</strong>
              <span class="badge">${formatMs(item.span_ms)}</span>
            </div>
            <div class="muted" style="margin-top: 8px;">
              actions=${item.actions_executed} user=${formatMs(item.user_time_ms)} system=${formatMs(item.system_time_ms)}
            </div>
          </li>
        `, "No action metrics.");

        createListItems(
          runnerCountsList,
          Object.entries(payload.runner_counts || {}).sort((a, b) => b[1] - a[1]),
          ([name, count]) => `
            <li class="split-line">
              <span>${name}</span>
              <span class="badge">${count}</span>
            </li>
          `,
          "No runner counts."
        );

        createListItems(
          timingBreakdownList,
          Object.entries(payload.timing_breakdown_ms || {}).sort((a, b) => b[1] - a[1]),
          ([name, value]) => `
            <li class="split-line">
              <span>${name}</span>
              <span class="badge">${formatMs(value)}</span>
            </li>
          `,
          "No timing breakdown."
        );
      }

      function resetReviewPanels() {
        summaryGrid.innerHTML = "";
        findingsList.innerHTML = '<li class="muted">No analysis yet.</li>';
        failedTargetsList.innerHTML = '<li class="muted">No analysis yet.</li>';
        slowTestsList.innerHTML = '<li class="muted">No analysis yet.</li>';
        actionsList.innerHTML = '<li class="muted">No analysis yet.</li>';
        runnerCountsList.innerHTML = '<li class="muted">No analysis yet.</li>';
        timingBreakdownList.innerHTML = '<li class="muted">No analysis yet.</li>';
      }

      async function runAnalysis() {
        const body = source.value.trim();
        if (!body) {
          status.textContent = "Paste BEP NDJSON first.";
          source.focus();
          return;
        }

        status.textContent = "Analyzing...";
        analyzeBtn.disabled = true;

        try {
          const response = await fetch("/analyze", {
            method: "POST",
            headers: { "content-type": "text/plain; charset=utf-8" },
            body
          });

          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.message || "Request failed");
          }

          renderAnalysis(payload);
          renderHistory(saveHistoryEntry(body, payload));
          status.textContent = `Review complete. Parsed invocation ${payload.summary.invocation_id || "n/a"}.`;
        } catch (error) {
          status.textContent = `Review failed: ${error.message}`;
        } finally {
          analyzeBtn.disabled = false;
        }
      }

      analyzeBtn.addEventListener("click", runAnalysis);
      clearBtn.addEventListener("click", () => {
        source.value = "";
        status.textContent = "Waiting for input.";
        resetReviewPanels();
      });
      sampleBtn.addEventListener("click", () => {
        source.value = sampleText;
        status.textContent = "Sample BEP inserted.";
      });
      historyList.addEventListener("click", (event) => {
        const item = event.target.closest("[data-history-id]");
        if (!item) return;
        const history = readHistory();
        const selected = history.find((entry) => entry.id === item.dataset.historyId);
        if (!selected) return;
        source.value = selected.input;
        status.textContent = `Loaded review from ${new Date(selected.created_at).toLocaleString()}.`;
      });

      resetReviewPanels();
      renderHistory();
    </script>
  </body>
</html>
"#;

    let response = Response::from_html(html)?;
    apply_cors(response)
}
