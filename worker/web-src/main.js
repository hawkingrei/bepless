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
const compileTopList = document.getElementById("compile-top-list");
const ioTopList = document.getElementById("io-top-list");
const slowActionsList = document.getElementById("slow-actions-list");
const slowTestsList = document.getElementById("slow-tests-list");
const actionsList = document.getElementById("actions-list");
const runnerCountsList = document.getElementById("runner-counts-list");
const timingBreakdownList = document.getElementById("timing-breakdown-list");

let currentReviewId = null;
let activeTab = "summary";

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

function isFlakyTest(test) {
  if (!test) return false;
  if (test.status === "FLAKY") return true;
  const attemptCount = toNumber(test.attempt_count);
  const totalRunCount = toNumber(test.total_run_count);
  return (attemptCount !== null && attemptCount > 1) || (totalRunCount !== null && totalRunCount > 1);
}

function summarizeBrowserInsights(input) {
  const compileItems = [];
  const ioItems = [];
  const slowActions = [];
  const tests = [];
  const flakyTests = [];
  const cacheMissReasons = new Map();
  const hostJvmArgs = new Set();
  let cacheOverview = null;
  let jvmMetrics = null;
  let timingMetrics = null;
  let networkMetrics = null;
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

      for (const detail of actionCacheStatistics.missDetails || []) {
        const reason = detail.reason || "UNKNOWN";
        const count = toNumber(detail.count) || 0;
        cacheMissReasons.set(reason, (cacheMissReasons.get(reason) || 0) + count);
      }

      for (const entry of actionSummary.actionData || []) {
        const mnemonic = entry.mnemonic || "unknown";
        if (!isCompileMnemonic(mnemonic)) continue;

        const firstStartedMs = toNumber(entry.firstStartedMs) || 0;
        const lastEndedMs = toNumber(entry.lastEndedMs) || 0;
        compileItems.push({
          name: mnemonic,
          actions_executed: toNumber(entry.actionsExecuted) || 0,
          duration_ms: Math.max(0, lastEndedMs - firstStartedMs),
          user_time_ms: parseDurationMs(entry.userTime),
          system_time_ms: parseDurationMs(entry.systemTime),
        });
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
    }

    if (event.id && event.id.testSummary && event.testSummary) {
      const summary = event.testSummary;
      const test = {
        label: event.id.testSummary.label || "<unknown>",
        status: summary.overallStatus || "UNKNOWN",
        duration_ms:
          toNumber(summary.totalRunDurationMillis) ??
          toNumber(summary.totalRunDurationInMs) ??
          parseDurationMs(summary.totalRunDuration) ??
          0,
        cached:
          summary.totalNumCached === null || summary.totalNumCached === undefined
            ? null
            : Number(summary.totalNumCached) > 0,
        attempt_count: toNumber(summary.attemptCount),
        run_count: toNumber(summary.runCount),
        total_run_count: toNumber(summary.totalRunCount),
      };

      tests.push(test);
      if (isFlakyTest(test)) {
        flakyTests.push(test);
      }
    }

    if (event.id && event.id.testResult && event.testResult && event.testResult.executionInfo) {
      const testResult = event.testResult;
      const ioMs = sumIOTimingMs(testResult.executionInfo.timingBreakdown);
      ioItems.push({
        name: event.id.testResult.label || "<unknown>",
        duration_ms: ioMs,
        strategy: testResult.executionInfo.strategy || "n/a",
        status: testResult.status || "UNKNOWN",
      });
    }
  }

  compileItems.sort((left, right) => right.duration_ms - left.duration_ms);
  ioItems.sort((left, right) => right.duration_ms - left.duration_ms);
  slowActions.sort((left, right) => (right.duration_ms ?? -1) - (left.duration_ms ?? -1));
  tests.sort((left, right) => right.duration_ms - left.duration_ms);
  flakyTests.sort((left, right) => right.duration_ms - left.duration_ms);

  return {
    cacheOverview,
    hostJvmArgs: Array.from(hostJvmArgs),
    jvmMetrics,
    timingMetrics,
    networkMetrics,
    workerMetrics: workerMetrics
      .sort((left, right) => (right.worker_memory_kb ?? -1) - (left.worker_memory_kb ?? -1))
      .slice(0, 10),
    cacheMissReasons: Array.from(cacheMissReasons.entries()).sort((left, right) => right[1] - left[1]),
    topCompileItems: compileItems.slice(0, 10),
    topIoItems: ioItems.filter((item) => item.duration_ms > 0).slice(0, 10),
    slowActions: slowActions.filter((item) => item.duration_ms !== null).slice(0, 10),
    topTests: tests.slice(0, 10),
    flakyTests: flakyTests.slice(0, 10),
  };
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
    ["Invocation", summary.invocation_id || "n/a"],
    ["Command", summary.command || "n/a"],
    ["Wall Time", formatMs(summary.wall_time_ms ?? summary.elapsed_ms)],
    ["Critical Path", formatMs(summary.critical_path_ms)],
    ["Cache Hit Ratio", formatPercent(summary.cache_hit_ratio)],
    ["Actions", summary.total_actions ?? "n/a"],
    ["Failed Tests", summary.failed_tests],
    ["Exit Code", summary.exit_code || "n/a"],
  ];
  summaryGrid.innerHTML = cards
    .map(
      ([label, value]) => `
        <article class="kpi">
          <div class="kpi-label">${label}</div>
          <div class="kpi-value">${value}</div>
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
      <li>
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
  summaryGrid.innerHTML = "";
  keywordList.innerHTML = `<li class="muted">${message}</li>`;
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
  compileTopList.innerHTML = `<li class="muted">${message}</li>`;
  ioTopList.innerHTML = `<li class="muted">${message}</li>`;
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

function reviewStatus(review) {
  return review.summary.success === true ? "success" : review.summary.success === false ? "failed" : "n/a";
}

function renderHistory(reviews) {
  if (!reviews || reviews.length === 0) {
    historyList.innerHTML = '<li class="muted">No uploaded reviews yet.</li>';
    return;
  }

  historyList.innerHTML = reviews
    .map(
      (review) => `
        <li class="history-item ${review.id === currentReviewId ? "history-item-active" : ""}" data-review-id="${review.id}">
          <div class="split-line">
            <strong class="mono">${reviewLabel(review)}</strong>
            <span class="badge">${reviewStatus(review)}</span>
          </div>
          <div class="history-meta">
            <span>${new Date(review.uploaded_at_ms).toLocaleString()}</span>
            <span>critical=${formatMs(review.summary.critical_path_ms)}</span>
            <span>wall=${formatMs(review.summary.wall_time_ms ?? review.summary.elapsed_ms)}</span>
          </div>
        </li>
      `,
    )
    .join("");
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

  const response = await fetch(`/api/reviews/${reviewId}`);
  if (!response.ok) {
    const message = `Failed to load review #${reviewId}.`;
    status.textContent = message;
    throw new Error(message);
  }

  const review = await response.json();
  currentReviewId = review.id;
  renderHistory(await fetchReviews(false));
  renderAnalysis(review.analysis, summarizeBrowserInsights(review.ingest_body));
  syncInvocationPath(review.invocation_id || review.analysis.summary.invocation_id || null);
  status.textContent = `Showing review #${review.id} from ${new Date(review.uploaded_at_ms).toLocaleString()}.`;
}

async function fetchReviews(updateStatus = true) {
  if (updateStatus) {
    status.textContent = "Loading uploaded reviews...";
  }

  const response = await fetch("/api/reviews");
  if (!response.ok) {
    const message = "Failed to load uploaded reviews.";
    status.textContent = message;
    throw new Error(message);
  }

  const reviews = await response.json();
  renderHistory(reviews);
  return reviews;
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
      const matchedReview = reviews.find(
        (review) => review.invocation_id === decodeURIComponent(invocationId),
      );
      if (matchedReview) {
        currentReviewId = matchedReview.id;
        renderHistory(reviews);
        await loadReview(matchedReview.id);
        return;
      }

      status.textContent = `Invocation ${decodeURIComponent(invocationId)} is not in the latest 50 reviews.`;
      currentReviewId = reviews[0].id;
      renderHistory(reviews);
      await loadReview(reviews[0].id);
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

boot();
setActiveTab(activeTab);
