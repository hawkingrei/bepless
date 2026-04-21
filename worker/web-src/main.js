const status = document.getElementById("status");
const refreshBtn = document.getElementById("refresh-btn");
const historyList = document.getElementById("history-list");
const setupGrid = document.getElementById("setup-grid");
const tabButtons = Array.from(document.querySelectorAll("[data-tab]"));
const tabPanels = Array.from(document.querySelectorAll("[data-tab-panel]"));
const bazelConfig = document.getElementById("bazel-config");
const copyBazelConfigBtn = document.getElementById("copy-bazel-config-btn");
const copyBazelConfigStatus = document.getElementById("copy-bazel-config-status");
const sinkConfig = document.getElementById("sink-config");

const summaryGrid = document.getElementById("summary-grid");
const keywordList = document.getElementById("keyword-list");
const timelineSummary = document.getElementById("timeline-summary");
const timelineChart = document.getElementById("timeline-chart");
const timelineFilterButtons = Array.from(document.querySelectorAll("[data-timeline-filter]"));
const timelineLimit = document.getElementById("timeline-limit");
const hostJvmArgsList = document.getElementById("host-jvm-args-list");
const jvmMetricsList = document.getElementById("jvm-metrics-list");
const timingMetricsList = document.getElementById("timing-metrics-list");
const networkMetricsList = document.getElementById("network-metrics-list");
const workerStatsList = document.getElementById("worker-stats-list");
const findingsList = document.getElementById("findings-list");
const failedTargetsList = document.getElementById("failed-targets-list");
const cacheOverviewList = document.getElementById("cache-overview-list");
const cacheMissReasonsList = document.getElementById("cache-miss-reasons-list");
const flakyTestsList = document.getElementById("flaky-tests-list");
const flakyAttemptsList = document.getElementById("flaky-attempts-list");
const compileTopList = document.getElementById("compile-top-list");
const ioTopList = document.getElementById("io-top-list");
const testExecWallTopList = document.getElementById("test-exec-wall-top-list");
const slowActionsList = document.getElementById("slow-actions-list");
const slowTestsList = document.getElementById("slow-tests-list");
const actionsList = document.getElementById("actions-list");
const runnerCountsList = document.getElementById("runner-counts-list");
const timingBreakdownList = document.getElementById("timing-breakdown-list");

let currentReviewId = null;
let activeTab = "summary";
let activeFlakyLabel = null;
let activeTimelineFilter = "longest";
let currentHistoryReviews = [];
const historySummaryCache = new Map();
const historySummaryInflight = new Set();
window.__lastBrowserInsights = null;

const INVOCATION_LOOKUP_MAX_ATTEMPTS = 5;
const INVOCATION_LOOKUP_BASE_BACKOFF_MS = 800;

function currentInvocationPath() {
  const trimmed = window.location.pathname.replace(/^\/+|\/+$/g, "");
  return trimmed || null;
}

function syncInvocationPath(invocationId) {
  const nextPath = invocationId ? `/${encodeURIComponent(invocationId)}` : "/";
  if (window.location.pathname !== nextPath) {
    window.history.replaceState(null, "", nextPath);
  }
  syncSetupVisibility();
}

function syncSetupVisibility() {
  setupGrid.classList.toggle("hidden", Boolean(currentInvocationPath()));
}

function setActiveTab(tab) {
  activeTab = tab;
  for (const button of tabButtons) {
    button.classList.toggle("tab-button-active", button.dataset.tab === tab);
  }
  for (const panel of tabPanels) {
    panel.classList.toggle("hidden", panel.dataset.tabPanel !== tab);
  }
}

function setActiveTimelineFilter(filter) {
  activeTimelineFilter = filter;
  for (const button of timelineFilterButtons) {
    button.classList.toggle("timeline-filter-button-active", button.dataset.timelineFilter === filter);
  }
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatMs(value) {
  if (value === null || value === undefined) return "n/a";
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  return `${value}ms`;
}

function formatPercent(value) {
  if (value === null || value === undefined) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function formatBytes(value) {
  if (value === null || value === undefined) return "n/a";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Number(value);
  if (!Number.isFinite(size)) return "n/a";
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)}${units[unitIndex]}`;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDurationMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

  const match = trimmed.match(/^(-?\d+(?:\.\d+)?)(ms|s|m)$/);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "ms") return amount;
  if (unit === "s") return amount * 1000;
  if (unit === "m") return amount * 60_000;
  return null;
}

function isCompileMnemonic(name) {
  const lower = String(name || "").toLowerCase();
  return (
    [
      "compile",
      "link",
      "javac",
      "kotlinc",
      "scalac",
      "swift",
      "rustc",
      "tsproject",
      "tsc",
      "protoc",
      "modulemap",
    ].some((keyword) => lower.includes(keyword)) || /^(go|cc|cpp|objc)/.test(lower)
  );
}

function isIOTimingName(name) {
  return [
    "parsetime",
    "fetchtime",
    "queuetime",
    "uploadtime",
    "setuptime",
    "processoutputstime",
    "networktime",
    "downloadtime",
    "cachechecktime",
    "filesystemtime",
    "iotime",
  ].includes(String(name || "").toLowerCase());
}

function sumIOTimingMs(node) {
  if (!node || typeof node !== "object") return 0;
  let total = 0;

  if (isIOTimingName(node.name)) {
    total += parseDurationMs(node.time) || 0;
  }

  if (Array.isArray(node.child)) {
    for (const child of node.child) {
      total += sumIOTimingMs(child);
    }
  }

  return total;
}

function timingBreakdownTotalMs(node) {
  if (!node || typeof node !== "object") return null;
  const explicit = parseDurationMs(node.time);
  if (explicit !== null) return explicit;

  if (Array.isArray(node.child) && node.child.length > 0) {
    let total = 0;
    let hasChild = false;
    for (const child of node.child) {
      const childMs = timingBreakdownTotalMs(child);
      if (childMs !== null) {
        total += childMs;
        hasChild = true;
      }
    }
    return hasChild ? total : null;
  }

  return null;
}

function parseCriticalPathMs(stderr) {
  const text = String(stderr || "");
  const index = text.indexOf("Critical Path:");
  if (index < 0) return null;
  const token = text
    .slice(index + "Critical Path:".length)
    .trim()
    .split(/\s+/)[0];
  return parseDurationMs(token);
}

function stripAnsi(value) {
  return String(value || "").replaceAll(
    // eslint-disable-next-line no-control-regex
    /\u001b\[[0-9;]*m/g,
    "",
  );
}

function inferCommandFromOptionsParsed(optionsParsed) {
  for (const key of ["cmdLine", "explicitCmdLine"]) {
    for (const entry of optionsParsed?.[key] || []) {
      const token = String(entry || "").trim();
      if (["build", "test", "run", "query", "cquery", "aquery", "coverage", "fetch", "info", "clean"].includes(token)) {
        return token;
      }
    }
  }
  return null;
}

function foldTimingBreakdownTotals(node, totals) {
  if (!node || typeof node !== "object") return;
  const name = node.name ? String(node.name) : null;
  const durationMs = parseDurationMs(node.time);
  if (name && durationMs !== null) {
    totals[name] = (totals[name] || 0) + durationMs;
  }
  for (const child of node.child || []) {
    foldTimingBreakdownTotals(child, totals);
  }
}

function buildFindings(summary, slowestTests, topActionMnemonics, timingBreakdownMs) {
  const findings = [];

  if (summary.execution_phase_ms !== null && summary.wall_time_ms !== null && summary.wall_time_ms > 0) {
    if ((summary.execution_phase_ms * 100) / summary.wall_time_ms >= 70) {
      findings.push({
        severity: "high",
        category: "execution",
        message: `Execution dominates wall time: execution phase is ${summary.execution_phase_ms} ms out of ${summary.wall_time_ms} ms wall time.`,
      });
    }
  }

  if (summary.analysis_phase_ms !== null && summary.wall_time_ms !== null && summary.wall_time_ms > 0) {
    if ((summary.analysis_phase_ms * 100) / summary.wall_time_ms >= 30) {
      findings.push({
        severity: "medium",
        category: "analysis",
        message: `Analysis is a visible cost center: analysis phase is ${summary.analysis_phase_ms} ms out of ${summary.wall_time_ms} ms wall time.`,
      });
    }
  }

  if (summary.cache_hit_ratio !== null && summary.cache_hit_ratio !== undefined) {
    if (summary.cache_hit_ratio < 0.6) {
      findings.push({
        severity: "high",
        category: "cache",
        message: `Action cache hit ratio is low at ${(summary.cache_hit_ratio * 100).toFixed(1)}%. Expect unnecessary rebuild work.`,
      });
    } else if (summary.cache_hit_ratio < 0.85) {
      findings.push({
        severity: "medium",
        category: "cache",
        message: `Action cache hit ratio is only ${(summary.cache_hit_ratio * 100).toFixed(1)}%. There is room to reduce repeated execution.`,
      });
    }
  }

  if (summary.critical_path_ms !== null && slowestTests.length > 0 && summary.critical_path_ms > 0) {
    const slowestTest = slowestTests[0];
    if ((slowestTest.duration_ms * 100) / summary.critical_path_ms >= 50) {
      findings.push({
        severity: "medium",
        category: "tests",
        message: `A single test is consuming a large portion of the critical path: ${slowestTest.label} took ${slowestTest.duration_ms} ms, critical path is ${summary.critical_path_ms} ms.`,
      });
    }
  }

  if ((timingBreakdownMs.queueTime || 0) > 0) {
    findings.push({
      severity: "medium",
      category: "remote-execution",
      message: `Observed queueTime in test execution breakdowns: ${timingBreakdownMs.queueTime} ms aggregated. Scheduler pressure may be visible.`,
    });
  }

  if ((timingBreakdownMs.networkTime || 0) > 0) {
    findings.push({
      severity: "low",
      category: "remote-execution",
      message: `Observed networkTime in execution breakdowns: ${timingBreakdownMs.networkTime} ms aggregated.`,
    });
  }

  if (topActionMnemonics.length > 0 && topActionMnemonics[0].span_ms > 0) {
    const action = topActionMnemonics[0];
    findings.push({
      severity: "low",
      category: "actions",
      message: `Longest action mnemonic span is ${action.mnemonic} at ${action.span_ms} ms across ${action.actions_executed} executed actions.`,
    });
  }

  return findings;
}

function isFlakyTest(test) {
  if (!test) return false;
  if (test.status === "FLAKY") return true;
  const attemptCount = toNumber(test.attempt_count);
  const totalRunCount = toNumber(test.total_run_count);
  return (attemptCount !== null && attemptCount > 1) || (totalRunCount !== null && totalRunCount > 1);
}

function hashString(value) {
  let hash = 0;
  for (const char of String(value || "")) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }
  return hash;
}

function mnemonicColor(mnemonic, success) {
  const hue = hashString(mnemonic);
  const saturation = success ? 64 : 72;
  const lightness = success ? 42 : 38;
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

function summarizeBrowserInsights(input, storedAnalysis = null) {
  const compileItems = [];
  const ioItems = [];
  const testExecutionWallItems = [];
  const slowActions = [];
  const timelineActions = [];
  const tests = [];
  const flakyTests = [];
  const flakyAttemptsByLabel = new Map();
  const cacheMissReasons = new Map();
  const hostJvmArgs = new Set();
  const failedTargets = [];
  const runnerCounts = {};
  const testStrategyCounts = {};
  const timingBreakdownMs = {};
  const topActionEntries = [];
  let abortReason = null;
  let abortDescription = null;
  let firstErrorLine = null;
  const storedSummary = storedAnalysis?.summary || {};
  const summary = {
    invocation_id: storedSummary.invocation_id || null,
    invocation_source: storedSummary.invocation_source || null,
    command: storedSummary.command || null,
    command_source: storedSummary.command_source || null,
    bazel_version: storedSummary.bazel_version || null,
    success: storedSummary.success ?? null,
    exit_code: storedSummary.exit_code || null,
    started_at_ms: storedSummary.started_at_ms ?? null,
    finished_at_ms: storedSummary.finished_at_ms ?? null,
    elapsed_ms: storedSummary.elapsed_ms ?? null,
    critical_path_ms: storedSummary.critical_path_ms ?? null,
    wall_time_ms: storedSummary.wall_time_ms ?? null,
    cpu_time_ms: storedSummary.cpu_time_ms ?? null,
    analysis_phase_ms: storedSummary.analysis_phase_ms ?? null,
    execution_phase_ms: storedSummary.execution_phase_ms ?? null,
    configured_targets: 0,
    configured_test_targets: 0,
    completed_targets: 0,
    failed_targets: 0,
    test_summaries: 0,
    failed_tests: 0,
    total_actions: storedSummary.total_actions ?? null,
    remote_cache_hits: storedSummary.remote_cache_hits ?? null,
    action_cache_hits: storedSummary.action_cache_hits ?? null,
    action_cache_misses: storedSummary.action_cache_misses ?? null,
    cache_hit_ratio: storedSummary.cache_hit_ratio ?? null,
  };
  let cacheOverview = null;
  let jvmMetrics = null;
  let timingMetrics = null;
  let networkMetrics = null;
  let invocationWindow = null;
  const workerMetrics = [];

  for (const rawLine of input.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const envelope = JSON.parse(line);
    const payload = envelope.bazel_event_proto_base64 ? null : envelope;
    const event = payload;
    if (!event) continue;

    const buildMetrics = event.buildMetrics;
    if (buildMetrics && buildMetrics.actionSummary) {
      const actionSummary = buildMetrics.actionSummary;
      const actionCacheStatistics = actionSummary.actionCacheStatistics || {};
      cacheOverview = {
        remote_hits: toNumber(actionSummary.remoteCacheHits),
        action_hits: toNumber(actionCacheStatistics.hits),
        action_misses: toNumber(actionCacheStatistics.misses),
      };
      summary.total_actions = toNumber(actionSummary.actionsExecuted) ?? summary.total_actions;
      summary.remote_cache_hits = cacheOverview.remote_hits;
      summary.action_cache_hits = cacheOverview.action_hits;
      summary.action_cache_misses = cacheOverview.action_misses;

      for (const detail of actionCacheStatistics.missDetails || []) {
        const reason = detail.reason || "UNKNOWN";
        const count = toNumber(detail.count) || 0;
        cacheMissReasons.set(reason, (cacheMissReasons.get(reason) || 0) + count);
      }

      for (const entry of actionSummary.actionData || []) {
        const mnemonic = entry.mnemonic || "unknown";
        const actionsExecuted = toNumber(entry.actionsExecuted) || 0;
        const firstStartedMs = toNumber(entry.firstStartedMs) || 0;
        const lastEndedMs = toNumber(entry.lastEndedMs) || 0;
        const spanMs = Math.max(0, lastEndedMs - firstStartedMs);
        runnerCounts[mnemonic] = runnerCounts[mnemonic] || 0;
        const topActionEntry = {
          mnemonic,
          actions_executed: actionsExecuted,
          span_ms: spanMs,
          user_time_ms: parseDurationMs(entry.userTime),
          system_time_ms: parseDurationMs(entry.systemTime),
        };
        topActionEntries.push(topActionEntry);
        if (!isCompileMnemonic(mnemonic)) continue;
        compileItems.push({
          name: mnemonic,
          actions_executed: actionsExecuted,
          duration_ms: spanMs,
          user_time_ms: topActionEntry.user_time_ms,
          system_time_ms: topActionEntry.system_time_ms,
        });
      }

      for (const entry of actionSummary.runnerCount || []) {
        const name = entry.name || "unknown";
        runnerCounts[name] = toNumber(entry.count) || 0;
      }
    }

    if (buildMetrics && buildMetrics.memoryMetrics) {
      const memoryMetrics = buildMetrics.memoryMetrics;
      jvmMetrics = {
        used_heap_size_post_build: toNumber(memoryMetrics.usedHeapSizePostBuild),
        peak_post_gc_heap_size: toNumber(memoryMetrics.peakPostGcHeapSize),
        peak_post_gc_tenured_space_heap_size: toNumber(memoryMetrics.peakPostGcTenuredSpaceHeapSize),
        garbage_metrics: Array.isArray(memoryMetrics.garbageMetrics) ? memoryMetrics.garbageMetrics : [],
      };
    }

    if (buildMetrics && buildMetrics.timingMetrics) {
      const metrics = buildMetrics.timingMetrics;
      timingMetrics = {
        wall_time_ms: toNumber(metrics.wallTimeInMs),
        cpu_time_ms: toNumber(metrics.cpuTimeInMs),
        analysis_phase_time_ms: toNumber(metrics.analysisPhaseTimeInMs),
        execution_phase_time_ms: toNumber(metrics.executionPhaseTimeInMs),
      };
      summary.wall_time_ms = timingMetrics.wall_time_ms;
      summary.cpu_time_ms = timingMetrics.cpu_time_ms;
      summary.analysis_phase_ms = timingMetrics.analysis_phase_time_ms;
      summary.execution_phase_ms = timingMetrics.execution_phase_time_ms;
    }

    if (buildMetrics && buildMetrics.networkMetrics && buildMetrics.networkMetrics.systemNetworkStats) {
      const stats = buildMetrics.networkMetrics.systemNetworkStats;
      networkMetrics = {
        bytes_sent: toNumber(stats.bytesSent),
        bytes_recv: toNumber(stats.bytesRecv),
        packets_sent: toNumber(stats.packetsSent),
        packets_recv: toNumber(stats.packetsRecv),
        peak_bytes_sent_per_sec: toNumber(stats.peakBytesSentPerSec),
        peak_bytes_recv_per_sec: toNumber(stats.peakBytesRecvPerSec),
        peak_packets_sent_per_sec: toNumber(stats.peakPacketsSentPerSec),
        peak_packets_recv_per_sec: toNumber(stats.peakPacketsRecvPerSec),
      };
    }

    if (buildMetrics && Array.isArray(buildMetrics.workerMetrics)) {
      for (const metric of buildMetrics.workerMetrics) {
        const latestStats = Array.isArray(metric.workerStats) && metric.workerStats.length > 0
          ? metric.workerStats[metric.workerStats.length - 1]
          : null;
        workerMetrics.push({
          mnemonic: metric.mnemonic || "unknown",
          worker_status: metric.workerStatus || "UNKNOWN",
          actions_executed: toNumber(metric.actionsExecuted),
          prior_actions_executed: toNumber(metric.priorActionsExecuted),
          is_multiplex: Boolean(metric.isMultiplex),
          is_sandbox: Boolean(metric.isSandbox),
          worker_memory_kb: latestStats ? toNumber(latestStats.workerMemoryInKb) : null,
          prior_worker_memory_kb: latestStats ? toNumber(latestStats.priorWorkerMemoryInKb) : null,
        });
      }
    }

    if (event.optionsParsed) {
      if (!summary.command) {
        const inferredCommand = inferCommandFromOptionsParsed(event.optionsParsed);
        if (inferredCommand) {
          summary.command = inferredCommand;
          summary.command_source = "optionsParsed.cmdLine";
        }
      }
      for (const option of event.optionsParsed.startupOptions || []) {
        if (String(option).includes("jvm")) {
          hostJvmArgs.add(option);
        }
      }
      for (const option of event.optionsParsed.explicitStartupOptions || []) {
        if (String(option).includes("jvm")) {
          hostJvmArgs.add(option);
        }
      }
    }

    if (event.aborted) {
      if (!abortReason && event.aborted.reason) {
        abortReason = String(event.aborted.reason);
      }
      if (!abortDescription && event.aborted.description) {
        abortDescription = String(event.aborted.description);
      }
    }

    if (event.id && event.id.actionCompleted && event.action) {
      const actionId = event.id.actionCompleted;
      const action = event.action;
      const startTimeMs = toNumber(action.startTimeMillis);
      const endTimeMs = toNumber(action.endTimeMillis);
      const durationMs =
        startTimeMs !== null && endTimeMs !== null ? Math.max(0, endTimeMs - startTimeMs) : null;
      const commandLine = Array.isArray(action.commandLine) ? action.commandLine.filter(Boolean) : [];

      slowActions.push({
        label: actionId.label || "<unknown>",
        mnemonic: action.type || "unknown",
        primary_output: action.primaryOutput || actionId.primaryOutput || "n/a",
        duration_ms: durationMs,
        success: action.success,
        exit_code: toNumber(action.exitCode),
        command_line: commandLine,
        command_preview: commandLine.join(" "),
        failure_detail: action.failureDetail || "",
      });
      if (startTimeMs !== null && endTimeMs !== null) {
        timelineActions.push({
          label: actionId.label || "<unknown>",
          mnemonic: action.type || "unknown",
          start_ms: startTimeMs,
          end_ms: endTimeMs,
          duration_ms: Math.max(0, endTimeMs - startTimeMs),
          success: action.success,
        });
      }
    }

    if (event.started) {
      if (!summary.invocation_id && event.started.uuid) {
        summary.invocation_id = event.started.uuid;
        summary.invocation_source = "started.uuid";
      }
      if (!summary.command && event.started.command) {
        summary.command = event.started.command;
        summary.command_source = "started.command";
      }
      if (!summary.bazel_version && event.started.buildToolVersion) {
        summary.bazel_version = event.started.buildToolVersion;
      }
      const startMs = toNumber(event.started.startTimeMillis);
      if (startMs !== null) {
        invocationWindow = invocationWindow || {};
        invocationWindow.started_at_ms = startMs;
        summary.started_at_ms = startMs;
      }
    }

    if (event.finished) {
      const endMs = toNumber(event.finished.finishTimeMillis);
      if (endMs !== null) {
        invocationWindow = invocationWindow || {};
        invocationWindow.finished_at_ms = endMs;
        summary.finished_at_ms = endMs;
      }
      if (event.finished.overallSuccess !== undefined && event.finished.overallSuccess !== null) {
        summary.success = Boolean(event.finished.overallSuccess);
      }
      if (!summary.exit_code && event.finished.exitCode?.name) {
        summary.exit_code = event.finished.exitCode.name;
      }
    }

    if (event.progress?.stderr && summary.critical_path_ms === null) {
      const criticalPathMs = parseCriticalPathMs(event.progress.stderr);
      if (criticalPathMs !== null) {
        summary.critical_path_ms = criticalPathMs;
      }
    }

    if (event.progress?.stderr && !firstErrorLine) {
      const cleaned = stripAnsi(event.progress.stderr);
      const matchedLine = cleaned
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.includes("ERROR:") || line.includes("WARNING:"));
      if (matchedLine) {
        firstErrorLine = matchedLine;
      }
    }

    if (event.id?.targetConfigured && event.configured) {
      summary.configured_targets += 1;
      if (event.configured.testSize) {
        summary.configured_test_targets += 1;
      }
    }

    if (event.id?.targetCompleted) {
      summary.completed_targets += 1;
      const label = event.id.targetCompleted.label || "<unknown>";
      const completedSuccess = event.completed?.success;
      const abortedReason = event.aborted?.reason;
      if (completedSuccess === false || abortedReason) {
        if (failedTargets.length < 20) {
          failedTargets.push(label);
        }
      }
    }

    if (event.id && event.id.testSummary && event.testSummary) {
      const testSummary = event.testSummary;
      const test = {
        label: event.id.testSummary.label || "<unknown>",
        status: testSummary.overallStatus || "UNKNOWN",
        duration_ms:
          toNumber(testSummary.totalRunDurationMillis) ??
          toNumber(testSummary.totalRunDurationInMs) ??
          parseDurationMs(testSummary.totalRunDuration) ??
          0,
        cached:
          testSummary.totalNumCached === null || testSummary.totalNumCached === undefined
            ? null
            : Number(testSummary.totalNumCached) > 0,
        attempt_count: toNumber(testSummary.attemptCount),
        run_count: toNumber(testSummary.runCount),
        total_run_count: toNumber(testSummary.totalRunCount),
      };

      tests.push(test);
      summary.test_summaries += 1;
      if (test.status !== "PASSED" && test.status !== "FLAKY") {
        summary.failed_tests += 1;
      }
      if (isFlakyTest(test)) {
        flakyTests.push(test);
      }
    }

    if (event.id && event.id.testResult && event.testResult && event.testResult.executionInfo) {
      const testId = event.id.testResult;
      const testResult = event.testResult;
      const timingBreakdown = testResult.executionInfo.timingBreakdown;
      const ioMs = sumIOTimingMs(timingBreakdown);
      const executionWallMs = timingBreakdownTotalMs(timingBreakdown);
      const label = testId.label || "<unknown>";
      ioItems.push({
        name: label,
        duration_ms: ioMs,
        strategy: testResult.executionInfo.strategy || "n/a",
        status: testResult.status || "UNKNOWN",
      });
      testExecutionWallItems.push({
        name: label,
        duration_ms: executionWallMs,
        strategy: testResult.executionInfo.strategy || "n/a",
        status: testResult.status || "UNKNOWN",
      });
      if (testResult.executionInfo.strategy) {
        testStrategyCounts[testResult.executionInfo.strategy] =
          (testStrategyCounts[testResult.executionInfo.strategy] || 0) + 1;
      }
      foldTimingBreakdownTotals(timingBreakdown, timingBreakdownMs);
      const attempts = flakyAttemptsByLabel.get(label) || [];
      attempts.push({
        label,
        run: toNumber(testId.run),
        shard: toNumber(testId.shard),
        attempt: toNumber(testId.attempt),
        status: testResult.status || "UNKNOWN",
        strategy: testResult.executionInfo.strategy || "n/a",
        execution_wall_ms: executionWallMs,
        io_ms: ioMs,
      });
      flakyAttemptsByLabel.set(label, attempts);
    }
  }

  compileItems.sort((left, right) => right.duration_ms - left.duration_ms);
  ioItems.sort((left, right) => right.duration_ms - left.duration_ms);
  testExecutionWallItems.sort((left, right) => (right.duration_ms ?? -1) - (left.duration_ms ?? -1));
  slowActions.sort((left, right) => (right.duration_ms ?? -1) - (left.duration_ms ?? -1));
  tests.sort((left, right) => right.duration_ms - left.duration_ms);
  flakyTests.sort((left, right) => right.duration_ms - left.duration_ms);
  const topActionMnemonics = topActionEntries
    .sort((left, right) => right.span_ms - left.span_ms)
    .slice(0, 8);

  if (summary.started_at_ms !== null && summary.finished_at_ms !== null && summary.finished_at_ms >= summary.started_at_ms) {
    summary.elapsed_ms = summary.finished_at_ms - summary.started_at_ms;
  }
  if (summary.action_cache_hits !== null && summary.action_cache_misses !== null) {
    const totalCacheEvents = summary.action_cache_hits + summary.action_cache_misses;
    if (totalCacheEvents > 0) {
      summary.cache_hit_ratio = summary.action_cache_hits / totalCacheEvents;
    }
  }
  if (cacheOverview) {
    const totalCacheEvents = (cacheOverview.action_hits || 0) + (cacheOverview.action_misses || 0);
    if (totalCacheEvents > 0) {
      summary.cache_hit_ratio = (cacheOverview.action_hits || 0) / totalCacheEvents;
    }
  }
  summary.failed_targets = failedTargets.length;
  if (summary.success === null && abortReason) {
    summary.success = false;
  }

  const findings = buildFindings(summary, tests.slice(0, 10), topActionMnemonics, timingBreakdownMs);
  if (abortReason) {
    findings.unshift({
      severity: "high",
      category: "abort",
      message: abortDescription
        ? `Build aborted before completion: ${abortReason}. ${abortDescription}`
        : `Build aborted before completion: ${abortReason}.`,
    });
  }
  if (firstErrorLine) {
    findings.unshift({
      severity: "high",
      category: "startup",
      message: firstErrorLine,
    });
  }

  return {
    analysis: {
      summary,
      slowest_tests: tests.slice(0, 10),
      failed_targets: failedTargets,
      top_action_mnemonics: topActionMnemonics,
      runner_counts: runnerCounts,
      test_strategy_counts: testStrategyCounts,
      timing_breakdown_ms: timingBreakdownMs,
      findings,
    },
    cacheOverview,
    hostJvmArgs: Array.from(hostJvmArgs),
    jvmMetrics,
    timingMetrics,
    networkMetrics,
    invocationWindow,
    timelineActions: timelineActions
      .sort((left, right) => left.start_ms - right.start_ms || right.duration_ms - left.duration_ms),
    workerMetrics: workerMetrics
      .sort((left, right) => (right.worker_memory_kb ?? -1) - (left.worker_memory_kb ?? -1))
      .slice(0, 10),
    cacheMissReasons: Array.from(cacheMissReasons.entries()).sort((left, right) => right[1] - left[1]),
    topCompileItems: compileItems.slice(0, 10),
    topIoItems: ioItems.filter((item) => item.duration_ms > 0).slice(0, 10),
    topTestExecutionWallItems: testExecutionWallItems.filter((item) => item.duration_ms !== null).slice(0, 10),
    slowActions: slowActions.filter((item) => item.duration_ms !== null).slice(0, 10),
    topTests: tests.slice(0, 10),
    flakyTests: flakyTests.slice(0, 10),
    flakyAttemptsByLabel,
  };
}

function renderTimeline(insights) {
  const actions = insights.timelineActions || [];
  const startCandidates = [];
  const endCandidates = [];

  if (insights.invocationWindow?.started_at_ms !== null && insights.invocationWindow?.started_at_ms !== undefined) {
    startCandidates.push(insights.invocationWindow.started_at_ms);
  }
  if (insights.invocationWindow?.finished_at_ms !== null && insights.invocationWindow?.finished_at_ms !== undefined) {
    endCandidates.push(insights.invocationWindow.finished_at_ms);
  }
  for (const action of actions) {
    startCandidates.push(action.start_ms);
    endCandidates.push(action.end_ms);
  }

  if (startCandidates.length === 0 || endCandidates.length === 0) {
    timelineSummary.textContent = "No absolute wall-time markers in this BEP.";
    timelineChart.innerHTML = '<div class="muted">No action or invocation timestamps found.</div>';
    return;
  }

  const rangeStart = Math.min(...startCandidates);
  const rangeEnd = Math.max(...endCandidates);
  const totalMs = Math.max(1, rangeEnd - rangeStart);
  const rowLimit = Math.max(1, Number(timelineLimit?.value || 24));
  let filteredActions = actions.slice();
  if (activeTimelineFilter === "failed") {
    filteredActions = filteredActions.filter((item) => item.success === false);
  } else if (activeTimelineFilter === "compile") {
    filteredActions = filteredActions.filter((item) => isCompileMnemonic(item.mnemonic));
  }

  let visibleActions;
  if (activeTimelineFilter === "all") {
    visibleActions = filteredActions
      .slice()
      .sort((left, right) => left.start_ms - right.start_ms || right.duration_ms - left.duration_ms)
      .slice(0, rowLimit);
  } else {
    visibleActions = filteredActions
      .slice()
      .sort((left, right) => right.duration_ms - left.duration_ms || left.start_ms - right.start_ms)
      .slice(0, rowLimit)
      .sort((left, right) => left.start_ms - right.start_ms || right.duration_ms - left.duration_ms);
  }

  const filterLabel = {
    longest: "Longest",
    all: "Earliest",
    failed: "Failed",
    compile: "Compile",
  }[activeTimelineFilter] || "Longest";
  timelineSummary.textContent =
    `Start ${new Date(rangeStart).toLocaleString()} · End ${new Date(rangeEnd).toLocaleString()} · Span ${formatMs(totalMs)} · Showing ${visibleActions.length}/${actions.length} ${filterLabel.toLowerCase()} actions`;

  const bars = [];
  if (insights.invocationWindow?.started_at_ms !== null && insights.invocationWindow?.finished_at_ms !== null) {
    const left = ((insights.invocationWindow.started_at_ms - rangeStart) / totalMs) * 100;
    const width = ((insights.invocationWindow.finished_at_ms - insights.invocationWindow.started_at_ms) / totalMs) * 100;
    bars.push(`
      <div class="timeline-row timeline-row-build">
        <div class="timeline-label">build</div>
        <div class="timeline-track">
          <div class="timeline-bar timeline-bar-build" style="left:${left}%; width:${Math.max(width, 0.8)}%"></div>
        </div>
        <div class="timeline-meta">${formatMs(insights.invocationWindow.finished_at_ms - insights.invocationWindow.started_at_ms)}</div>
      </div>
    `);
  }

  for (const action of visibleActions) {
    const left = ((action.start_ms - rangeStart) / totalMs) * 100;
    const width = ((action.end_ms - action.start_ms) / totalMs) * 100;
    const mnemonic = escapeHtml(action.mnemonic);
    const label = escapeHtml(action.label);
    const color = mnemonicColor(action.mnemonic, action.success);
    bars.push(`
      <div class="timeline-row">
        <div class="timeline-label" title="${label}">${mnemonic}</div>
        <div class="timeline-track">
          <div class="timeline-bar ${action.success ? "timeline-bar-success" : "timeline-bar-failed"}" style="--timeline-bar-color:${color}; left:${left}%; width:${Math.max(width, 0.8)}%" title="${label} · ${mnemonic} · ${formatMs(action.duration_ms)}"></div>
        </div>
        <div class="timeline-meta">${formatMs(action.duration_ms)}</div>
      </div>
    `);
  }

  timelineChart.innerHTML = bars.join("");
}

function createListItems(container, items, render, emptyText) {
  if (!items || items.length === 0) {
    container.innerHTML = `<li class="muted">${emptyText}</li>`;
    return;
  }
  container.innerHTML = items.map(render).join("");
}

function renderSummary(summary) {
  const cards = [
    ["Invocation", summary.invocation_id || "n/a", summary.invocation_source || null],
    ["Command", summary.command || "n/a", summary.command_source || null],
    ["Wall Time", formatMs(summary.wall_time_ms ?? summary.elapsed_ms), null],
    ["Critical Path", formatMs(summary.critical_path_ms), null],
    ["Cache Hit Ratio", formatPercent(summary.cache_hit_ratio), null],
    ["Actions", summary.total_actions ?? "n/a", null],
    ["Failed Tests", summary.failed_tests, null],
    ["Exit Code", summary.exit_code || "n/a", null],
  ];
  summaryGrid.innerHTML = cards
    .map(
      ([label, value, source]) => `
        <article class="kpi">
          <div class="kpi-label">${label}</div>
          <div class="kpi-value">${value}</div>
          ${source ? `<div class="kpi-label">source=${source}</div>` : ""}
        </article>
      `,
    )
    .join("");
}

function renderKeywords(keywords) {
  if (!keywords || keywords.length === 0) {
    keywordList.innerHTML = '<li class="muted">No notification keywords.</li>';
    return;
  }

  keywordList.innerHTML = keywords
    .map(
      (keyword) => `
        <li class="tag-chip mono">${keyword}</li>
      `,
    )
    .join("");
}

function renderBrowserInsights(insights) {
  window.__lastBrowserInsights = insights;
  if (
    activeFlakyLabel &&
    (!insights.flakyAttemptsByLabel || !insights.flakyAttemptsByLabel.has(activeFlakyLabel))
  ) {
    activeFlakyLabel = null;
  }
  if (!activeFlakyLabel && insights.flakyTests.length > 0) {
    activeFlakyLabel = insights.flakyTests[0].label;
  }

  renderTimeline(insights);

  createListItems(
    hostJvmArgsList,
    insights.hostJvmArgs,
    (item) => `
      <li><span class="mono">${item}</span></li>
    `,
    "No JVM startup options reported.",
  );

  createListItems(
    jvmMetricsList,
    insights.jvmMetrics ? [
      ["Used Heap Post Build", formatBytes(insights.jvmMetrics.used_heap_size_post_build)],
      ["Peak Post-GC Heap", formatBytes(insights.jvmMetrics.peak_post_gc_heap_size)],
      [
        "Peak Tenured Post-GC Heap",
        formatBytes(insights.jvmMetrics.peak_post_gc_tenured_space_heap_size),
      ],
    ] : [],
    ([label, value]) => `
      <li class="split-line">
        <span>${label}</span>
        <span class="badge">${value}</span>
      </li>
    `,
    "No Bazel JVM heap metrics.",
  );

  createListItems(
    timingMetricsList,
    insights.timingMetrics ? [
      ["Wall Time", formatMs(insights.timingMetrics.wall_time_ms)],
      ["CPU Time", formatMs(insights.timingMetrics.cpu_time_ms)],
      ["Analysis Phase", formatMs(insights.timingMetrics.analysis_phase_time_ms)],
      ["Execution Phase", formatMs(insights.timingMetrics.execution_phase_time_ms)],
    ] : [],
    ([label, value]) => `
      <li class="split-line">
        <span>${label}</span>
        <span class="badge">${value}</span>
      </li>
    `,
    "No Bazel timing metrics.",
  );

  createListItems(
    networkMetricsList,
    insights.networkMetrics ? [
      ["Bytes Sent", formatBytes(insights.networkMetrics.bytes_sent)],
      ["Bytes Recv", formatBytes(insights.networkMetrics.bytes_recv)],
      ["Packets Sent", insights.networkMetrics.packets_sent ?? "n/a"],
      ["Packets Recv", insights.networkMetrics.packets_recv ?? "n/a"],
      ["Peak Send Throughput", `${formatBytes(insights.networkMetrics.peak_bytes_sent_per_sec)}/s`],
      ["Peak Recv Throughput", `${formatBytes(insights.networkMetrics.peak_bytes_recv_per_sec)}/s`],
    ] : [],
    ([label, value]) => `
      <li class="split-line">
        <span>${label}</span>
        <span class="badge">${value}</span>
      </li>
    `,
    "No network metrics.",
  );

  createListItems(
    workerStatsList,
    insights.workerMetrics,
    (item) => `
      <li>
        <div class="split-line">
          <strong>${item.mnemonic}</strong>
          <span class="badge">${item.worker_status}</span>
        </div>
        <div class="muted detail-line">
          actions=${item.actions_executed ?? "n/a"} prior_actions=${item.prior_actions_executed ?? "n/a"}
        </div>
        <div class="muted detail-line">
          memory=${item.worker_memory_kb === null ? "n/a" : formatBytes(item.worker_memory_kb * 1024)}
          prior_memory=${item.prior_worker_memory_kb === null ? "n/a" : formatBytes(item.prior_worker_memory_kb * 1024)}
        </div>
        <div class="muted detail-line">
          multiplex=${String(item.is_multiplex)} sandbox=${String(item.is_sandbox)}
        </div>
      </li>
    `,
    "No worker stats.",
  );

  createListItems(
    cacheOverviewList,
    insights.cacheOverview ? [insights.cacheOverview] : [],
    (item) => {
      const hits = item.action_hits;
      const misses = item.action_misses;
      const ratio = hits !== null && misses !== null && hits + misses > 0 ? hits / (hits + misses) : null;

      return `
        <li>
          <div class="split-line">
            <strong>Action Cache</strong>
            <span class="badge">${formatPercent(ratio)}</span>
          </div>
          <div class="muted detail-line">
            hits=${hits ?? "n/a"} misses=${misses ?? "n/a"} remote_hits=${item.remote_hits ?? "n/a"}
          </div>
        </li>
      `;
    },
    "No cache metrics in this BEP.",
  );

  createListItems(
    cacheMissReasonsList,
    insights.cacheMissReasons,
    ([reason, count]) => `
      <li class="split-line">
        <span>${reason}</span>
        <span class="badge">${count}</span>
      </li>
    `,
    "No cache miss reason breakdown.",
  );

  createListItems(
    compileTopList,
    insights.topCompileItems,
    (item) => `
      <li>
        <div class="split-line">
          <strong>${item.name}</strong>
          <span class="badge">${formatMs(item.duration_ms)}</span>
        </div>
        <div class="muted detail-line">
          actions=${item.actions_executed} user=${formatMs(item.user_time_ms)} system=${formatMs(item.system_time_ms)}
        </div>
      </li>
    `,
    "No compile-classified actions.",
  );

  createListItems(
    ioTopList,
    insights.topIoItems,
    (item) => `
      <li>
        <div class="split-line">
          <strong class="mono">${item.name}</strong>
          <span class="badge">${formatMs(item.duration_ms)}</span>
        </div>
        <div class="muted detail-line">
          strategy=${item.strategy} status=${item.status}
        </div>
      </li>
    `,
    "No IO timing breakdown found.",
  );

  createListItems(
    testExecWallTopList,
    insights.topTestExecutionWallItems,
    (item) => `
      <li>
        <div class="split-line">
          <strong class="mono">${item.name}</strong>
          <span class="badge">${formatMs(item.duration_ms)}</span>
        </div>
        <div class="muted detail-line">
          strategy=${item.strategy} status=${item.status}
        </div>
      </li>
    `,
    "No test execution wall-time data.",
  );

  createListItems(
    slowActionsList,
    insights.slowActions,
    (item) => `
      <li>
        <div class="split-line">
          <strong>${item.mnemonic}</strong>
          <span class="badge">${formatMs(item.duration_ms)}</span>
        </div>
        <div class="muted detail-line">
          label=${item.label} exit=${item.exit_code ?? "n/a"} success=${String(item.success)}
        </div>
        <div class="muted detail-line">
          output=${item.primary_output}
        </div>
        ${item.failure_detail ? `<div class="muted detail-line">failure=${item.failure_detail}</div>` : ""}
        <pre class="command-preview">${item.command_preview || "No command line reported."}</pre>
      </li>
    `,
    "No slow action execution records.",
  );

  createListItems(
    flakyTestsList,
    insights.flakyTests,
    (item) => `
      <li class="clickable-row ${activeFlakyLabel === item.label ? "clickable-row-active" : ""}" data-flaky-label="${escapeHtml(item.label)}">
        <div class="split-line">
          <strong class="mono">${item.label}</strong>
          <span class="badge">${formatMs(item.duration_ms)}</span>
        </div>
        <div class="muted detail-line">
          status=${item.status} attempts=${item.attempt_count ?? "n/a"} total_runs=${item.total_run_count ?? "n/a"}
        </div>
      </li>
    `,
    "No flaky test signal found.",
  );

  renderFlakyAttempts(insights, activeFlakyLabel);

  createListItems(
    slowTestsList,
    insights.topTests,
    (item) => `
      <li>
        <div class="split-line">
          <strong class="mono">${item.label}</strong>
          <span class="badge">${formatMs(item.duration_ms)}</span>
        </div>
        <div class="muted detail-line">
          status=${item.status} cached=${item.cached === null ? "n/a" : String(item.cached)} attempts=${item.attempt_count ?? "n/a"}
        </div>
      </li>
    `,
    "No test summaries.",
  );
}

function renderFlakyAttempts(insights, label) {
  const attempts = label ? insights.flakyAttemptsByLabel.get(label) || [] : [];
  createListItems(
    flakyAttemptsList,
    attempts
      .slice()
      .sort((left, right) => {
        if ((left.run ?? -1) !== (right.run ?? -1)) return (left.run ?? -1) - (right.run ?? -1);
        if ((left.shard ?? -1) !== (right.shard ?? -1)) return (left.shard ?? -1) - (right.shard ?? -1);
        return (left.attempt ?? -1) - (right.attempt ?? -1);
      }),
    (item) => `
      <li>
        <div class="split-line">
          <strong>run=${item.run ?? "n/a"} shard=${item.shard ?? "n/a"} attempt=${item.attempt ?? "n/a"}</strong>
          <span class="badge">${item.status}</span>
        </div>
        <div class="muted detail-line">
          strategy=${item.strategy} wall=${formatMs(item.execution_wall_ms)} io=${formatMs(item.io_ms)}
        </div>
      </li>
    `,
    label ? "No test attempts recorded." : "Select a flaky test.",
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderAnalysis(payload, browserInsights) {
  renderSummary(payload.summary);
  renderKeywords(payload.notification_keywords);
  renderBrowserInsights(browserInsights);

  createListItems(
    findingsList,
    payload.findings,
    (item) => `
      <li class="finding-${item.severity}">
        <div class="split-line">
          <strong>${item.category}</strong>
          <span class="badge">${item.severity}</span>
        </div>
        <div class="muted detail-line">${item.message}</div>
      </li>
    `,
    "No findings.",
  );

  createListItems(
    failedTargetsList,
    payload.failed_targets,
    (item) => `
      <li><span class="mono">${item}</span></li>
    `,
    "No failed targets.",
  );

  createListItems(
    actionsList,
    payload.top_action_mnemonics,
    (item) => `
      <li>
        <div class="split-line">
          <strong>${item.mnemonic}</strong>
          <span class="badge">${formatMs(item.span_ms)}</span>
        </div>
        <div class="muted detail-line">
          actions=${item.actions_executed} user=${formatMs(item.user_time_ms)} system=${formatMs(item.system_time_ms)}
        </div>
      </li>
    `,
    "No action metrics.",
  );

  createListItems(
    runnerCountsList,
    Object.entries(payload.runner_counts || {}).sort((a, b) => b[1] - a[1]),
    ([name, count]) => `
      <li class="split-line">
        <span>${name}</span>
        <span class="badge">${count}</span>
      </li>
    `,
    "No runner counts.",
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
    "No timing breakdown.",
  );
}

function resetReviewPanels(message = "No uploaded reviews yet.") {
  window.__lastBrowserInsights = null;
  activeFlakyLabel = null;
  summaryGrid.innerHTML = "";
  keywordList.innerHTML = `<li class="muted">${message}</li>`;
  timelineSummary.textContent = message;
  timelineChart.innerHTML = `<div class="muted">${message}</div>`;
  hostJvmArgsList.innerHTML = `<li class="muted">${message}</li>`;
  jvmMetricsList.innerHTML = `<li class="muted">${message}</li>`;
  timingMetricsList.innerHTML = `<li class="muted">${message}</li>`;
  networkMetricsList.innerHTML = `<li class="muted">${message}</li>`;
  workerStatsList.innerHTML = `<li class="muted">${message}</li>`;
  findingsList.innerHTML = `<li class="muted">${message}</li>`;
  failedTargetsList.innerHTML = `<li class="muted">${message}</li>`;
  cacheOverviewList.innerHTML = `<li class="muted">${message}</li>`;
  cacheMissReasonsList.innerHTML = `<li class="muted">${message}</li>`;
  flakyTestsList.innerHTML = `<li class="muted">${message}</li>`;
  flakyAttemptsList.innerHTML = `<li class="muted">${message}</li>`;
  compileTopList.innerHTML = `<li class="muted">${message}</li>`;
  ioTopList.innerHTML = `<li class="muted">${message}</li>`;
  testExecWallTopList.innerHTML = `<li class="muted">${message}</li>`;
  slowActionsList.innerHTML = `<li class="muted">${message}</li>`;
  slowTestsList.innerHTML = `<li class="muted">${message}</li>`;
  actionsList.innerHTML = `<li class="muted">${message}</li>`;
  runnerCountsList.innerHTML = `<li class="muted">${message}</li>`;
  timingBreakdownList.innerHTML = `<li class="muted">${message}</li>`;
}

function reviewLabel(review) {
  return (
    review.invocation_id ||
    review.summary.invocation_id ||
    review.build_id ||
    review.project_id ||
    review.summary.command ||
    "unknown"
  );
}

function reviewSummary(review) {
  return historySummaryCache.get(review.id)?.analysis.summary || review.summary;
}

function reviewNeedsHydration(review) {
  const summary = reviewSummary(review);
  return (
    summary.success === null ||
    summary.wall_time_ms === null ||
    summary.critical_path_ms === null ||
    summary.command === null
  );
}

function reviewStatus(review) {
  const summary = reviewSummary(review);
  return summary.success === true ? "success" : summary.success === false ? "failed" : "n/a";
}

async function fetchReviewDetail(reviewId) {
  const response = await fetch(`/api/reviews/${reviewId}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load review #${reviewId}.`);
  }

  return response.json();
}

function queueHistoryHydration(reviews) {
  for (const review of reviews) {
    if (!reviewNeedsHydration(review)) continue;
    if (historySummaryCache.has(review.id) || historySummaryInflight.has(review.id)) continue;

    historySummaryInflight.add(review.id);
    fetchReviewDetail(review.id)
      .then((detail) => {
        const browserInsights = summarizeBrowserInsights(detail.ingest_body, detail.analysis);
        historySummaryCache.set(review.id, browserInsights);
        if (currentReviewId === review.id) {
          renderAnalysis(browserInsights.analysis, browserInsights);
        }
      })
      .catch((error) => {
        console.error(error);
        historySummaryCache.delete(review.id);
      })
      .finally(() => {
        historySummaryInflight.delete(review.id);
        renderHistory(currentHistoryReviews);
      });
  }
}

function renderHistory(reviews) {
  if (!reviews || reviews.length === 0) {
    currentHistoryReviews = [];
    historyList.innerHTML = '<li class="muted">No uploaded reviews yet.</li>';
    return;
  }

  currentHistoryReviews = reviews;
  historyList.innerHTML = reviews
    .map((review) => {
      const summary = reviewSummary(review);
      return `
        <li class="history-item ${review.id === currentReviewId ? "history-item-active" : ""}" data-review-id="${review.id}">
          <div class="split-line">
            <strong class="mono">${reviewLabel(review)}</strong>
            <span class="badge">${reviewStatus(review)}</span>
          </div>
          <div class="history-meta">
            <span>${new Date(review.uploaded_at_ms).toLocaleString()}</span>
            <span>critical=${formatMs(summary.critical_path_ms)}</span>
            <span>wall=${formatMs(summary.wall_time_ms ?? summary.elapsed_ms)}</span>
          </div>
        </li>
      `;
    })
    .join("");

  queueHistoryHydration(reviews);
}

function renderSetupSnippets() {
  const grpcHost = "beplessproxy.hawkingrei.com";
  const workerOrigin = "https://bepless.hawkingrei.com";
  bazelConfig.textContent = [
    `build --bes_backend=grpcs://${grpcHost}`,
    `test --bes_backend=grpcs://${grpcHost}`,
    `build --bes_results_url=${workerOrigin}/`,
    `test --bes_results_url=${workerOrigin}/`,
    "build --build_event_publish_all_actions",
    "test --build_event_publish_all_actions",
    "build --experimental_build_event_upload_strategy=fully_async",
    "test --experimental_build_event_upload_strategy=fully_async",
  ].join("\n");
  sinkConfig.textContent = [
    `BEPLESS_HTTP_SINK_URL=${workerOrigin}/ingest`,
    "BEPLESS_HTTP_SINK_TIMEOUT_SECONDS=30",
  ].join("\n");
}

async function copyBazelConfig() {
  try {
    await navigator.clipboard.writeText(bazelConfig.textContent);
    copyBazelConfigStatus.textContent = "Copied Bazel config.";
  } catch (error) {
    console.error(error);
    copyBazelConfigStatus.textContent = "Copy failed. Select the snippet manually.";
  }
}

async function loadReview(reviewId) {
  status.textContent = `Loading review #${reviewId}...`;

  const review = await fetchReviewDetail(reviewId);
  const browserInsights = summarizeBrowserInsights(review.ingest_body, review.analysis);
  historySummaryCache.set(review.id, browserInsights);
  currentReviewId = review.id;
  renderHistory(await fetchReviews(false));
  renderAnalysis(browserInsights.analysis, browserInsights);
  syncInvocationPath(review.invocation_id || browserInsights.analysis.summary.invocation_id || null);
  status.textContent = `Showing review #${review.id} from ${new Date(review.uploaded_at_ms).toLocaleString()}.`;
}

async function fetchReviews(updateStatus = true) {
  if (updateStatus) {
    status.textContent = "Loading uploaded reviews...";
  }

  const response = await fetch("/api/reviews", { cache: "no-store" });
  if (!response.ok) {
    const message = "Failed to load uploaded reviews.";
    status.textContent = message;
    throw new Error(message);
  }

  const reviews = await response.json();
  renderHistory(reviews);
  return reviews;
}

async function findInvocationReviewWithRetry(invocationId, updateStatus = true) {
  const decodedInvocationId = decodeURIComponent(invocationId);

  for (let attempt = 1; attempt <= INVOCATION_LOOKUP_MAX_ATTEMPTS; attempt += 1) {
    if (updateStatus) {
      status.textContent =
        attempt === 1
          ? `Loading invocation ${decodedInvocationId}...`
          : `Invocation ${decodedInvocationId} not visible yet. Retrying ${attempt}/${INVOCATION_LOOKUP_MAX_ATTEMPTS}...`;
    }

    const reviews = await fetchReviews(false);
    const matchedReview = reviews.find((review) => review.invocation_id === decodedInvocationId);
    if (matchedReview) {
      return { reviews, matchedReview };
    }

    if (attempt < INVOCATION_LOOKUP_MAX_ATTEMPTS) {
      const backoffMs = INVOCATION_LOOKUP_BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(backoffMs);
    }
  }

  return { reviews: await fetchReviews(false), matchedReview: null };
}

async function boot() {
  renderSetupSnippets();
  syncSetupVisibility();
  resetReviewPanels();

  try {
    const reviews = await fetchReviews();
    if (reviews.length === 0) {
      status.textContent = "Waiting for BES uploads.";
      return;
    }

    const invocationId = currentInvocationPath();
    if (invocationId) {
      const { reviews: retriedReviews, matchedReview } = await findInvocationReviewWithRetry(
        invocationId,
      );
      if (matchedReview) {
        currentReviewId = matchedReview.id;
        renderHistory(retriedReviews);
        await loadReview(matchedReview.id);
        return;
      }

      currentReviewId = null;
      renderHistory(retriedReviews);
      resetReviewPanels(`Invocation ${decodeURIComponent(invocationId)} was not found in the latest 50 reviews.`);
      status.textContent = `Invocation ${decodeURIComponent(invocationId)} was not found after ${INVOCATION_LOOKUP_MAX_ATTEMPTS} attempts.`;
      return;
    }

    currentReviewId = reviews[0].id;
    renderHistory(reviews);
    await loadReview(reviews[0].id);
  } catch (error) {
    console.error(error);
    resetReviewPanels("Failed to load reviews.");
  }
}

refreshBtn.addEventListener("click", async () => {
  try {
    const invocationId = currentInvocationPath();
    if (invocationId) {
      const { reviews, matchedReview } = await findInvocationReviewWithRetry(invocationId);
      if (matchedReview) {
        currentReviewId = matchedReview.id;
        renderHistory(reviews);
        await loadReview(matchedReview.id);
      } else {
        currentReviewId = null;
        renderHistory(reviews);
        resetReviewPanels(`Invocation ${decodeURIComponent(invocationId)} was not found in the latest 50 reviews.`);
        status.textContent = `Invocation ${decodeURIComponent(invocationId)} was not found after ${INVOCATION_LOOKUP_MAX_ATTEMPTS} attempts.`;
      }
      return;
    }

    const reviews = await fetchReviews();
    if (reviews.length === 0) {
      currentReviewId = null;
      resetReviewPanels();
      status.textContent = "Waiting for BES uploads.";
      return;
    }

    const target = reviews.some((review) => review.id === currentReviewId) ? currentReviewId : reviews[0].id;
    currentReviewId = target;
    renderHistory(reviews);
    await loadReview(target);
  } catch (error) {
    console.error(error);
  }
});

copyBazelConfigBtn.addEventListener("click", async () => {
  await copyBazelConfig();
});

for (const button of tabButtons) {
  button.addEventListener("click", () => {
    setActiveTab(button.dataset.tab || "summary");
  });
}

for (const button of timelineFilterButtons) {
  button.addEventListener("click", () => {
    setActiveTimelineFilter(button.dataset.timelineFilter || "longest");
    if (window.__lastBrowserInsights) {
      renderTimeline(window.__lastBrowserInsights);
    }
  });
}

timelineLimit?.addEventListener("change", () => {
  if (window.__lastBrowserInsights) {
    renderTimeline(window.__lastBrowserInsights);
  }
});

historyList.addEventListener("click", async (event) => {
  const item = event.target.closest("[data-review-id]");
  if (!item) return;

  const reviewId = Number(item.dataset.reviewId);
  if (!Number.isFinite(reviewId)) return;

  try {
    await loadReview(reviewId);
  } catch (error) {
    console.error(error);
  }
});

flakyTestsList.addEventListener("click", (event) => {
  const item = event.target.closest("[data-flaky-label]");
  if (!item) return;
  activeFlakyLabel = item.dataset.flakyLabel || null;
  const reviewPanel = document.querySelector('[data-tab-panel="hotspots"]');
  if (!reviewPanel || reviewPanel.classList.contains("hidden")) {
    setActiveTab("hotspots");
  }
  if (window.__lastBrowserInsights) {
    renderFlakyAttempts(window.__lastBrowserInsights, activeFlakyLabel);
  }
});

boot();
setActiveTab(activeTab);
setActiveTimelineFilter(activeTimelineFilter);
