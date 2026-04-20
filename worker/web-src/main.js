const status = document.getElementById("status");
const refreshBtn = document.getElementById("refresh-btn");
const historyList = document.getElementById("history-list");
const bazelConfig = document.getElementById("bazel-config");
const copyBazelConfigBtn = document.getElementById("copy-bazel-config-btn");
const copyBazelConfigStatus = document.getElementById("copy-bazel-config-status");
const sinkConfig = document.getElementById("sink-config");

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

let currentReviewId = null;

function currentInvocationPath() {
  const trimmed = window.location.pathname.replace(/^\/+|\/+$/g, "");
  return trimmed || null;
}

function syncInvocationPath(invocationId) {
  const nextPath = invocationId ? `/${encodeURIComponent(invocationId)}` : "/";
  if (window.location.pathname !== nextPath) {
    window.history.replaceState(null, "", nextPath);
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
  findingsList.innerHTML = `<li class="muted">${message}</li>`;
  failedTargetsList.innerHTML = `<li class="muted">${message}</li>`;
  cacheOverviewList.innerHTML = `<li class="muted">${message}</li>`;
  cacheMissReasonsList.innerHTML = `<li class="muted">${message}</li>`;
  flakyTestsList.innerHTML = `<li class="muted">${message}</li>`;
  compileTopList.innerHTML = `<li class="muted">${message}</li>`;
  ioTopList.innerHTML = `<li class="muted">${message}</li>`;
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

async function loadReviewByInvocation(invocationId) {
  status.textContent = `Loading invocation ${invocationId}...`;

  const response = await fetch(`/api/reviews/by-invocation/${encodeURIComponent(invocationId)}`);
  if (!response.ok) {
    const message = `Failed to find invocation ${invocationId}.`;
    status.textContent = message;
    throw new Error(message);
  }

  const payload = await response.json();
  await loadReview(payload.review_id);
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
  resetReviewPanels();

  try {
    const reviews = await fetchReviews();
    if (reviews.length === 0) {
      status.textContent = "Waiting for BES uploads.";
      return;
    }

    const invocationId = currentInvocationPath();
    if (invocationId) {
      await loadReviewByInvocation(decodeURIComponent(invocationId));
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
