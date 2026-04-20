const source = document.getElementById("source");
const status = document.getElementById("status");
const analyzeBtn = document.getElementById("analyze-btn");
const clearBtn = document.getElementById("clear-btn");
const sampleBtn = document.getElementById("sample-btn");

const summaryGrid = document.getElementById("summary-grid");
const findingsList = document.getElementById("findings-list");
const failedTargetsList = document.getElementById("failed-targets-list");
const cacheOverviewList = document.getElementById("cache-overview-list");
const cacheMissReasonsList = document.getElementById("cache-miss-reasons-list");
const flakyTestsList = document.getElementById("flaky-tests-list");
const compileTopList = document.getElementById("compile-top-list");
const ioTopList = document.getElementById("io-top-list");
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
  '{"id":{"buildFinished":{}},"finished":{"overallSuccess":true,"finishTimeMillis":"1714695820441","exitCode":{"name":"SUCCESS"}}}',
].join("\n");

function formatMs(value) {
  if (value === null || value === undefined) return "n/a";
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  return `${value}ms`;
}

function formatPercent(value) {
  if (value === null || value === undefined) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
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
  const tests = [];
  const flakyTests = [];
  const cacheMissReasons = new Map();
  let cacheOverview = null;

  for (const rawLine of input.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = JSON.parse(line);
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
  tests.sort((left, right) => right.duration_ms - left.duration_ms);
  flakyTests.sort((left, right) => right.duration_ms - left.duration_ms);

  return {
    cacheOverview,
    cacheMissReasons: Array.from(cacheMissReasons.entries()).sort((left, right) => right[1] - left[1]),
    topCompileItems: compileItems.slice(0, 10),
    topIoItems: ioItems.filter((item) => item.duration_ms > 0).slice(0, 10),
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

function readHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
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

  historyList.innerHTML = history
    .map(
      (entry) => `
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
      `,
    )
    .join("");
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

function renderBrowserInsights(insights) {
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
          <div class="muted" style="margin-top: 8px;">
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
        <div class="muted" style="margin-top: 8px;">
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
        <div class="muted" style="margin-top: 8px;">
          strategy=${item.strategy} status=${item.status}
        </div>
      </li>
    `,
    "No IO timing breakdown found.",
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
        <div class="muted" style="margin-top: 8px;">
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
        <div class="muted" style="margin-top: 8px;">
          status=${item.status} cached=${item.cached === null ? "n/a" : String(item.cached)} attempts=${item.attempt_count ?? "n/a"}
        </div>
      </li>
    `,
    "No test summaries.",
  );
}

function renderAnalysis(payload, browserInsights) {
  renderSummary(payload.summary);
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
        <div class="muted" style="margin-top: 8px;">${item.message}</div>
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
        <div class="muted" style="margin-top: 8px;">
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

function resetReviewPanels() {
  summaryGrid.innerHTML = "";
  findingsList.innerHTML = '<li class="muted">No analysis yet.</li>';
  failedTargetsList.innerHTML = '<li class="muted">No analysis yet.</li>';
  cacheOverviewList.innerHTML = '<li class="muted">No analysis yet.</li>';
  cacheMissReasonsList.innerHTML = '<li class="muted">No analysis yet.</li>';
  flakyTestsList.innerHTML = '<li class="muted">No analysis yet.</li>';
  compileTopList.innerHTML = '<li class="muted">No analysis yet.</li>';
  ioTopList.innerHTML = '<li class="muted">No analysis yet.</li>';
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
    const browserInsights = summarizeBrowserInsights(body);
    const response = await fetch("/analyze", {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body,
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message || "Request failed");
    }

    renderAnalysis(payload, browserInsights);
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
