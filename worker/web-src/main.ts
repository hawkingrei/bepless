declare global {
  interface Window {
    __lastBrowserInsights: any;
  }
}

import {
  bazelConfig,
  copyBazelConfigBtn,
  copyBazelConfigStatus,
  flakyTestsList,
  historyList,
  refreshBtn,
  setupGrid,
  sinkConfig,
  status,
  tabButtons,
  tabPanels,
  timelineFilterButtons,
  timelineLimit,
} from "./app/dom";
import { formatMs, sleep } from "./app/utils";
import { summarizeBrowserInsights } from "./app/analysis";
import {
  renderAnalysis,
  renderFlakyAttempts,
  resetReviewPanels,
  resolveActiveFlakyLabel,
  renderTimeline,
} from "./app/render";

let currentReviewId = null;
let activeTab = "summary";
let activeFlakyLabel = null;
let activeTimelineFilter = "all";
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

function currentTimelineRowLimit() {
  return Math.max(1, Number(timelineLimit?.value || 48));
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
          activeFlakyLabel = resolveActiveFlakyLabel(browserInsights, activeFlakyLabel);
          window.__lastBrowserInsights = browserInsights;
          renderAnalysis(browserInsights.analysis, browserInsights, {
            activeFlakyLabel,
            activeTimelineFilter,
            rowLimit: currentTimelineRowLimit(),
          });
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
  activeFlakyLabel = resolveActiveFlakyLabel(browserInsights, activeFlakyLabel);
  window.__lastBrowserInsights = browserInsights;
  renderAnalysis(browserInsights.analysis, browserInsights, {
    activeFlakyLabel,
    activeTimelineFilter,
    rowLimit: currentTimelineRowLimit(),
  });
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
  activeFlakyLabel = null;
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
      activeFlakyLabel = null;
      resetReviewPanels(`Invocation ${decodeURIComponent(invocationId)} was not found in the latest 50 reviews.`);
      status.textContent = `Invocation ${decodeURIComponent(invocationId)} was not found after ${INVOCATION_LOOKUP_MAX_ATTEMPTS} attempts.`;
      return;
    }

    currentReviewId = reviews[0].id;
    renderHistory(reviews);
    await loadReview(reviews[0].id);
  } catch (error) {
    console.error(error);
    activeFlakyLabel = null;
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
        activeFlakyLabel = null;
        resetReviewPanels(`Invocation ${decodeURIComponent(invocationId)} was not found in the latest 50 reviews.`);
        status.textContent = `Invocation ${decodeURIComponent(invocationId)} was not found after ${INVOCATION_LOOKUP_MAX_ATTEMPTS} attempts.`;
      }
      return;
    }

    const reviews = await fetchReviews();
    if (reviews.length === 0) {
      currentReviewId = null;
      activeFlakyLabel = null;
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
    setActiveTimelineFilter(button.dataset.timelineFilter || "all");
    if (window.__lastBrowserInsights) {
      renderTimeline(window.__lastBrowserInsights, {
        activeTimelineFilter,
        rowLimit: currentTimelineRowLimit(),
      });
    }
  });
}

timelineLimit?.addEventListener("change", () => {
  if (window.__lastBrowserInsights) {
    renderTimeline(window.__lastBrowserInsights, {
      activeTimelineFilter,
      rowLimit: currentTimelineRowLimit(),
    });
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
