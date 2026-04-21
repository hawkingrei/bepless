use std::collections::BTreeMap;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use prost::Message;
use prost_types::{Duration as ProtoDuration, Timestamp as ProtoTimestamp};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use worker::wasm_bindgen::JsValue;
use worker::{
    console_error, console_log, event, Bucket, Context, D1Database, FormEntry, Method, Request,
    Response, Result,
};

const CHUNK_BUCKET_BINDING: &str = "BEPLESS_CHUNKS";

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
    #[serde(default)]
    notification_keywords: Vec<String>,
    bazel_event_proto_base64: String,
}

#[derive(Debug, Deserialize)]
struct IngestChunkRequest {
    project_id: String,
    build_id: String,
    invocation_id: String,
    chunk_index: u32,
    chunk_count: u32,
    #[serde(default)]
    notification_keywords: Vec<String>,
    chunk_body: String,
}

#[derive(Debug, Deserialize)]
struct IngestFinalizeRequest {
    project_id: String,
    build_id: String,
    invocation_id: String,
    chunk_count: u32,
    #[serde(default)]
    notification_keywords: Vec<String>,
}

#[derive(Debug, Serialize)]
struct IngestChunkAck {
    invocation_id: String,
    chunk_index: u32,
    chunk_count: u32,
    stored: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SlowTarget {
    label: String,
    duration_ms: u64,
    status: String,
    cached: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ActionMnemonic {
    mnemonic: String,
    actions_executed: u64,
    span_ms: u64,
    system_time_ms: Option<u64>,
    user_time_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Finding {
    severity: String,
    category: String,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredReviewListItem {
    id: i64,
    source_type: String,
    project_id: Option<String>,
    build_id: Option<String>,
    invocation_id: Option<String>,
    notification_keywords: Vec<String>,
    uploaded_at_ms: i64,
    summary: Summary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredReviewDetail {
    id: i64,
    source_type: String,
    project_id: Option<String>,
    build_id: Option<String>,
    invocation_id: Option<String>,
    notification_keywords: Vec<String>,
    uploaded_at_ms: i64,
    analysis: AnalysisResponse,
    ingest_body: String,
}

#[derive(Debug, Deserialize)]
struct StoredReviewRow {
    id: i64,
    source_type: String,
    project_id: Option<String>,
    build_id: Option<String>,
    invocation_id: Option<String>,
    notification_keywords_json: String,
    uploaded_at_ms: i64,
    analysis_json: String,
    ingest_body: String,
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
async fn fetch(mut req: Request, env: worker::Env, _ctx: Context) -> Result<Response> {
    console_error_panic_hook::set_once();

    let method = req.method().to_string();
    let path = req.path();
    let route_result = match (req.method(), path.as_str()) {
        (Method::Options, _) => cors_response(),
        (Method::Get, "/") => html_response(),
        (Method::Get, "/api/reviews") => list_reviews(&env).await,
        (Method::Get, path) if path.starts_with("/api/reviews/") => get_review(&env, path).await,
        (Method::Get, path) if is_review_entry_path(path) => html_response(),
        (Method::Post, "/analyze") => analyze_request(&mut req).await,
        (Method::Post, "/ingest") => ingest_request(&mut req, &env).await,
        (Method::Post, "/ingest-chunks") => ingest_chunk_request(&mut req, &env).await,
        (Method::Post, "/ingest-finalize") => ingest_finalize_request(&mut req, &env).await,
        _ => json_error(404, "not_found", "Route not found"),
    };

    match route_result {
        Ok(response) => Ok(response),
        Err(err) => {
            let error = err.to_string();
            log_error(
                "request_failed",
                vec![("method", method), ("path", path), ("error", error)],
            );
            json_error(500, "internal_error", "Internal server error")
        }
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

async fn ingest_request(req: &mut Request, env: &worker::Env) -> Result<Response> {
    let payload = extract_payload(req).await?;
    log_info(
        "ingest_request_received",
        vec![("payload_bytes", payload.len().to_string())],
    );
    let content = String::from_utf8(payload)
        .map_err(|_| worker::Error::RustError("Request body is not valid UTF-8".into()))?;
    let normalized =
        normalize_ingest_ndjson(&content).map_err(|message| worker::Error::RustError(message))?;
    let result =
        analyze_ndjson(&normalized).map_err(|message| worker::Error::RustError(message))?;
    store_ingest_review(env, &content, &normalized, &result).await?;
    log_info(
        "ingest_request_stored",
        vec![
            (
                "invocation_id",
                result.summary.invocation_id.clone().unwrap_or_default(),
            ),
            ("failed_targets", result.failed_targets.len().to_string()),
            ("failed_tests", result.summary.failed_tests.to_string()),
        ],
    );

    let mut response = Response::from_json(&result)?;
    response
        .headers_mut()
        .set("content-type", "application/json; charset=utf-8")?;
    apply_cors(response)
}

async fn ingest_chunk_request(req: &mut Request, env: &worker::Env) -> Result<Response> {
    let body = req.bytes().await?;
    log_info(
        "ingest_chunk_request_received",
        vec![("payload_bytes", body.len().to_string())],
    );
    let payload: IngestChunkRequest = serde_json::from_slice(&body).map_err(|err| {
        worker::Error::RustError(format!("Invalid ingest chunk JSON payload: {}", err))
    })?;
    validate_chunk_request(&payload)?;

    let bucket = open_chunk_bucket(env)?;
    let object_key = chunk_object_key(&payload.invocation_id, payload.chunk_index);
    bucket
        .put(object_key.clone(), payload.chunk_body.as_bytes().to_vec())
        .execute()
        .await?;

    log_info(
        "ingest_chunk_stored",
        vec![
            ("invocation_id", payload.invocation_id.clone()),
            ("build_id", payload.build_id.clone()),
            ("project_id", payload.project_id.clone()),
            ("chunk_index", payload.chunk_index.to_string()),
            ("chunk_count", payload.chunk_count.to_string()),
            (
                "notification_keywords",
                payload.notification_keywords.len().to_string(),
            ),
            ("chunk_bytes", payload.chunk_body.len().to_string()),
        ],
    );

    let mut response = Response::from_json(&IngestChunkAck {
        invocation_id: payload.invocation_id,
        chunk_index: payload.chunk_index,
        chunk_count: payload.chunk_count,
        stored: true,
    })?;
    response
        .headers_mut()
        .set("content-type", "application/json; charset=utf-8")?;
    apply_cors(response)
}

async fn ingest_finalize_request(req: &mut Request, env: &worker::Env) -> Result<Response> {
    let body = req.bytes().await?;
    let payload: IngestFinalizeRequest = serde_json::from_slice(&body).map_err(|err| {
        worker::Error::RustError(format!("Invalid ingest finalize JSON payload: {}", err))
    })?;
    validate_finalize_request(&payload)?;

    if let Some(existing_review) =
        find_review_by_invocation_id(env, payload.invocation_id.as_str()).await?
    {
        log_info(
            "ingest_finalize_reused_existing_review",
            vec![
                ("invocation_id", payload.invocation_id.clone()),
                ("review_id", existing_review.id.to_string()),
            ],
        );
        let mut response = Response::from_json(&existing_review.analysis)?;
        response
            .headers_mut()
            .set("content-type", "application/json; charset=utf-8")?;
        return apply_cors(response);
    }

    let bucket = open_chunk_bucket(env)?;
    let mut chunk_bodies = Vec::with_capacity(payload.chunk_count as usize);
    for chunk_index in 0..payload.chunk_count {
        let object = bucket
            .get(chunk_object_key(&payload.invocation_id, chunk_index))
            .execute()
            .await?;
        let Some(object) = object else {
            return Err(worker::Error::RustError(format!(
                "Missing ingest chunk {} for invocation {}",
                chunk_index, payload.invocation_id
            )));
        };
        let chunk_body = object
            .body()
            .ok_or_else(|| {
                worker::Error::RustError(format!(
                    "Ingest chunk {} for invocation {} has no body",
                    chunk_index, payload.invocation_id
                ))
            })?
            .text()
            .await?;
        chunk_bodies.push(chunk_body);
    }

    let raw_ingest_body = chunk_bodies.join("\n");
    let normalized = normalize_ingest_ndjson(&raw_ingest_body)
        .map_err(|message| worker::Error::RustError(message))?;
    let result =
        analyze_ndjson(&normalized).map_err(|message| worker::Error::RustError(message))?;
    store_ingest_review(env, &raw_ingest_body, &normalized, &result).await?;

    let delete_keys = (0..payload.chunk_count)
        .map(|chunk_index| chunk_object_key(&payload.invocation_id, chunk_index))
        .collect::<Vec<_>>();
    bucket.delete_multiple(delete_keys).await?;

    log_info(
        "ingest_finalize_completed",
        vec![
            ("invocation_id", payload.invocation_id.clone()),
            ("build_id", payload.build_id.clone()),
            ("project_id", payload.project_id.clone()),
            ("chunk_count", payload.chunk_count.to_string()),
            (
                "notification_keywords",
                payload.notification_keywords.len().to_string(),
            ),
            ("normalized_bytes", normalized.len().to_string()),
        ],
    );

    let mut response = Response::from_json(&result)?;
    response
        .headers_mut()
        .set("content-type", "application/json; charset=utf-8")?;
    apply_cors(response)
}

async fn list_reviews(env: &worker::Env) -> Result<Response> {
    let db = open_database(env)?;

    let result = db
        .prepare(
            "SELECT id, source_type, project_id, build_id, invocation_id, notification_keywords_json, uploaded_at_ms, analysis_json, ingest_body
             FROM reviews
             ORDER BY uploaded_at_ms DESC, id DESC
             LIMIT 50",
        )
        .all()
        .await?;
    let rows = result.results::<StoredReviewRow>()?;
    log_info(
        "reviews_loaded",
        vec![("row_count", rows.len().to_string())],
    );
    let mut reviews = Vec::with_capacity(rows.len());

    for row in rows {
        let analysis: AnalysisResponse =
            serde_json::from_str(&row.analysis_json).map_err(|err| {
                worker::Error::RustError(format!(
                    "Stored review {} has invalid analysis JSON: {}",
                    row.id, err
                ))
            })?;
        reviews.push(StoredReviewListItem {
            id: row.id,
            source_type: row.source_type,
            project_id: row.project_id,
            build_id: row.build_id,
            invocation_id: row.invocation_id,
            notification_keywords: parse_keywords_json(&row.notification_keywords_json)?,
            uploaded_at_ms: row.uploaded_at_ms,
            summary: analysis.summary,
        });
    }

    let mut response = Response::from_json(&reviews)?;
    response
        .headers_mut()
        .set("content-type", "application/json; charset=utf-8")?;
    apply_cors(response)
}

async fn get_review(env: &worker::Env, path: &str) -> Result<Response> {
    let review_id = path
        .trim_start_matches("/api/reviews/")
        .parse::<i64>()
        .map_err(|_| worker::Error::RustError("Review id must be an integer".into()))?;

    let db = open_database(env)?;

    let statement = db
        .prepare(
            "SELECT id, source_type, project_id, build_id, invocation_id, notification_keywords_json, uploaded_at_ms, analysis_json, ingest_body
             FROM reviews
             WHERE id = ?1
             LIMIT 1",
        )
        .bind(&[JsValue::from_f64(review_id as f64)])?;
    let row = statement.first::<StoredReviewRow>(None).await?;
    let Some(row) = row else {
        log_info(
            "review_not_found",
            vec![("review_id", review_id.to_string())],
        );
        return json_error(404, "review_not_found", "Review not found");
    };

    let analysis: AnalysisResponse = serde_json::from_str(&row.analysis_json).map_err(|err| {
        worker::Error::RustError(format!(
            "Stored review {} has invalid analysis JSON: {}",
            row.id, err
        ))
    })?;
    let payload = StoredReviewDetail {
        id: row.id,
        source_type: row.source_type,
        project_id: row.project_id,
        build_id: row.build_id,
        invocation_id: row.invocation_id,
        notification_keywords: parse_keywords_json(&row.notification_keywords_json)?,
        uploaded_at_ms: row.uploaded_at_ms,
        analysis,
        ingest_body: row.ingest_body,
    };

    let mut response = Response::from_json(&payload)?;
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

fn normalize_ingest_ndjson(input: &str) -> std::result::Result<String, String> {
    let mut normalized = Vec::new();
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
            normalized.push(json_event.to_string());
            parsed_lines += 1;
        }
    }

    if parsed_lines == 0 {
        return Err("No analyzable BEP events were found in the ingest body".to_string());
    }

    Ok(normalized.join("\n"))
}

fn open_database(env: &worker::Env) -> Result<D1Database> {
    match env.d1("BEPLESS_DB") {
        Ok(db) => Ok(db),
        Err(err) => {
            let error = err.to_string();
            log_error(
                "open_database_failed",
                vec![("binding", "BEPLESS_DB".to_string()), ("error", error)],
            );
            Err(err)
        }
    }
}

fn open_chunk_bucket(env: &worker::Env) -> Result<Bucket> {
    match env.bucket(CHUNK_BUCKET_BINDING) {
        Ok(bucket) => Ok(bucket),
        Err(err) => {
            let error = err.to_string();
            log_error(
                "open_chunk_bucket_failed",
                vec![
                    ("binding", CHUNK_BUCKET_BINDING.to_string()),
                    ("error", error),
                ],
            );
            Err(err)
        }
    }
}

fn is_review_entry_path(path: &str) -> bool {
    if path == "/" || path.starts_with("/api/") {
        return false;
    }

    let trimmed = path.trim_matches('/');
    !trimmed.is_empty() && !trimmed.contains('/')
}

async fn store_ingest_review(
    env: &worker::Env,
    raw_ingest_body: &str,
    normalized_ingest_body: &str,
    analysis: &AnalysisResponse,
) -> Result<()> {
    let db = open_database(env)?;

    let metadata = extract_ingest_metadata(raw_ingest_body);
    let uploaded_at_ms = analysis
        .summary
        .finished_at_ms
        .or(analysis.summary.started_at_ms)
        .map(|value| value as i64)
        .unwrap_or(0);
    let analysis_json = serde_json::to_string(analysis).map_err(|err| {
        worker::Error::RustError(format!("Failed to serialize analysis payload: {}", err))
    })?;
    let notification_keywords_json = serde_json::to_string(&metadata.notification_keywords)
        .map_err(|err| {
            worker::Error::RustError(format!(
                "Failed to serialize notification keywords: {}",
                err
            ))
        })?;

    log_info(
        "store_ingest_review_begin",
        vec![
            (
                "invocation_id",
                metadata.invocation_id.clone().unwrap_or_default(),
            ),
            (
                "project_id",
                metadata.project_id.clone().unwrap_or_default(),
            ),
            ("build_id", metadata.build_id.clone().unwrap_or_default()),
            ("notification_keywords", notification_keywords_json.clone()),
            ("normalized_bytes", normalized_ingest_body.len().to_string()),
        ],
    );

    db.prepare(
        "INSERT INTO reviews (
            source_type,
            project_id,
            build_id,
            invocation_id,
            notification_keywords_json,
            uploaded_at_ms,
            ingest_body,
            analysis_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(&[
        JsValue::from_str("ingest"),
        metadata
            .project_id
            .as_deref()
            .map(JsValue::from_str)
            .unwrap_or_else(JsValue::null),
        metadata
            .build_id
            .as_deref()
            .map(JsValue::from_str)
            .unwrap_or_else(JsValue::null),
        metadata
            .invocation_id
            .as_deref()
            .map(JsValue::from_str)
            .unwrap_or_else(JsValue::null),
        JsValue::from_str(&notification_keywords_json),
        JsValue::from_f64(uploaded_at_ms as f64),
        JsValue::from_str(normalized_ingest_body),
        JsValue::from_str(&analysis_json),
    ])?
    .run()
    .await?;
    log_info(
        "store_ingest_review_inserted",
        vec![(
            "invocation_id",
            metadata.invocation_id.clone().unwrap_or_default(),
        )],
    );

    db.prepare(
        "DELETE FROM reviews
         WHERE id NOT IN (
             SELECT id
             FROM reviews
             ORDER BY uploaded_at_ms DESC, id DESC
             LIMIT 50
         )",
    )
    .run()
    .await?;
    log_info(
        "store_ingest_review_trimmed",
        vec![(
            "invocation_id",
            metadata.invocation_id.clone().unwrap_or_default(),
        )],
    );

    Ok(())
}

async fn find_review_by_invocation_id(
    env: &worker::Env,
    invocation_id: &str,
) -> Result<Option<StoredReviewDetail>> {
    let db = open_database(env)?;
    let statement = db
        .prepare(
            "SELECT id, source_type, project_id, build_id, invocation_id, notification_keywords_json, uploaded_at_ms, analysis_json, ingest_body
             FROM reviews
             WHERE invocation_id = ?1
             ORDER BY uploaded_at_ms DESC, id DESC
             LIMIT 1",
        )
        .bind(&[JsValue::from_str(invocation_id)])?;
    let row = statement.first::<StoredReviewRow>(None).await?;
    let Some(row) = row else {
        return Ok(None);
    };

    let analysis: AnalysisResponse = serde_json::from_str(&row.analysis_json).map_err(|err| {
        worker::Error::RustError(format!(
            "Stored review {} has invalid analysis JSON: {}",
            row.id, err
        ))
    })?;

    Ok(Some(StoredReviewDetail {
        id: row.id,
        source_type: row.source_type,
        project_id: row.project_id,
        build_id: row.build_id,
        invocation_id: row.invocation_id,
        notification_keywords: parse_keywords_json(&row.notification_keywords_json)?,
        uploaded_at_ms: row.uploaded_at_ms,
        analysis,
        ingest_body: row.ingest_body,
    }))
}

fn validate_chunk_request(payload: &IngestChunkRequest) -> Result<()> {
    if payload.invocation_id.trim().is_empty() {
        return Err(worker::Error::RustError(
            "ingest chunk invocation_id must not be empty".into(),
        ));
    }
    if payload.chunk_count == 0 {
        return Err(worker::Error::RustError(
            "ingest chunk chunk_count must be positive".into(),
        ));
    }
    if payload.chunk_index >= payload.chunk_count {
        return Err(worker::Error::RustError(format!(
            "ingest chunk index {} is out of range for {} chunks",
            payload.chunk_index, payload.chunk_count
        )));
    }
    if payload.chunk_body.trim().is_empty() {
        return Err(worker::Error::RustError(
            "ingest chunk body must not be empty".into(),
        ));
    }
    Ok(())
}

fn validate_finalize_request(payload: &IngestFinalizeRequest) -> Result<()> {
    if payload.invocation_id.trim().is_empty() {
        return Err(worker::Error::RustError(
            "ingest finalize invocation_id must not be empty".into(),
        ));
    }
    if payload.chunk_count == 0 {
        return Err(worker::Error::RustError(
            "ingest finalize chunk_count must be positive".into(),
        ));
    }
    Ok(())
}

fn chunk_object_key(invocation_id: &str, chunk_index: u32) -> String {
    format!(
        "invocations/{}/chunks/{:08}.ndjson",
        invocation_id, chunk_index
    )
}

fn extract_ingest_metadata(input: &str) -> IngestMetadata {
    for raw_line in input.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        if let Ok(envelope) = serde_json::from_str::<IngestEnvelope>(line) {
            return IngestMetadata {
                project_id: non_empty_string(envelope.project_id),
                build_id: non_empty_string(envelope.build_id),
                invocation_id: non_empty_string(envelope.invocation_id),
                notification_keywords: envelope.notification_keywords,
            };
        }
    }

    IngestMetadata::default()
}

#[derive(Debug, Default)]
struct IngestMetadata {
    project_id: Option<String>,
    build_id: Option<String>,
    invocation_id: Option<String>,
    notification_keywords: Vec<String>,
}

fn parse_keywords_json(input: &str) -> Result<Vec<String>> {
    serde_json::from_str(input).map_err(|err| {
        worker::Error::RustError(format!(
            "Stored review has invalid notification keywords JSON: {}",
            err
        ))
    })
}

fn log_info(event_name: &str, fields: Vec<(&str, String)>) {
    console_log!("{}", format_log_line(event_name, &fields));
}

fn log_error(event_name: &str, fields: Vec<(&str, String)>) {
    console_error!("{}", format_log_line(event_name, &fields));
}

fn format_log_line(event_name: &str, fields: &[(&str, String)]) -> String {
    let mut line = format!("event={}", event_name);
    for (key, value) in fields {
        line.push(' ');
        line.push_str(key);
        line.push('=');
        line.push_str(&escape_log_value(value));
    }
    line
}

fn escape_log_value(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
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
        build_event_stream::build_event::Payload::Action(action) => {
            object.insert("action".to_string(), convert_action_executed(action));
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
                severity: "high".to_string(),
                category: "execution".to_string(),
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
                severity: "medium".to_string(),
                category: "analysis".to_string(),
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
                severity: "high".to_string(),
                category: "cache".to_string(),
                message: format!(
                    "Action cache hit ratio is low at {:.1}%. Expect unnecessary rebuild work.",
                    ratio * 100.0
                ),
            });
        } else if ratio < 0.85 {
            findings.push(Finding {
                severity: "medium".to_string(),
                category: "cache".to_string(),
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
                severity: "medium".to_string(),
                category: "tests".to_string(),
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
                severity: "medium".to_string(),
                category: "remote-execution".to_string(),
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
                severity: "low".to_string(),
                category: "remote-execution".to_string(),
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
                severity: "low".to_string(),
                category: "actions".to_string(),
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

fn non_empty_string(value: String) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
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
    let response = Response::from_html(include_str!("../web-dist/index.html"))?;
    apply_cors(response)
}
