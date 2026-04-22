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
  setupGrid,
  sinkConfig,
  timelineFilterButtons,
  timelineLimit,
  initDom,
} from "./app/dom";
import { formatMs, sleep } from "./app/utils";
import { setAppStoreState } from "./app/store";
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
const HISTORY_HYDRATION_LIMIT = 6;

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
  const hasInvocationPath = Boolean(currentInvocationPath());
  setupGrid?.classList.toggle("hidden", hasInvocationPath);
  document.body.classList.toggle("review-entry", hasInvocationPath);
}

function setActiveTab(tab) {
  activeTab = tab;
  setAppStoreState({ activeTab: tab });
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

async function fetchReviewMetadata(reviewId) {
  const response = await fetch(`/api/reviews/${reviewId}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load review #${reviewId}.`);
  }

  return response.json();
}

async function fetchReviewBody(reviewId) {
  const response = await fetch(`/api/reviews/${reviewId}/body`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load review body for #${reviewId}.`);
  }

  return response.text();
}

function queueHistoryHydration(reviews) {
  const prioritized = [];
  const seen = new Set();

  if (currentReviewId !== null) {
    const activeReview = reviews.find((review) => review.id === currentReviewId);
    if (activeReview) {
      prioritized.push(activeReview);
      seen.add(activeReview.id);
    }
  }

  for (const review of reviews) {
    if (prioritized.length >= HISTORY_HYDRATION_LIMIT) break;
    if (seen.has(review.id)) continue;
    prioritized.push(review);
    seen.add(review.id);
  }

  for (const review of prioritized) {
    if (!reviewNeedsHydration(review)) continue;
    if (historySummaryCache.has(review.id) || historySummaryInflight.has(review.id)) continue;

    historySummaryInflight.add(review.id);
    fetchReviewMetadata(review.id)
      .then((detail) => {
        historySummaryCache.set(review.id, { analysis: detail.analysis });
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

function renderHistory(reviews, options = {}) {
  const { hydrate = true } = options;
  if (!reviews || reviews.length === 0) {
    currentHistoryReviews = [];
    setAppStoreState({ historyItems: [] });
    return;
  }

  currentHistoryReviews = reviews;
  setAppStoreState({
    historyItems: reviews.map((review) => {
      const summary = reviewSummary(review);
      return {
        id: review.id,
        label: reviewLabel(review),
        status: reviewStatus(review),
        uploadedAtText: new Date(review.uploaded_at_ms).toLocaleString(),
        criticalText: formatMs(summary.critical_path_ms),
        wallText: formatMs(summary.wall_time_ms ?? summary.elapsed_ms),
        active: review.id === currentReviewId,
      };
    }),
  });

  if (hydrate) {
    queueHistoryHydration(reviews);
  }
}

function renderSetupSnippets() {
  const grpcHost = "beplessproxy.hawkingrei.com";
  const workerOrigin = "https://bepless.hawkingrei.com";
  if (bazelConfig) {
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
  }
  if (sinkConfig) {
    sinkConfig.textContent = [
    `BEPLESS_HTTP_SINK_URL=${workerOrigin}/ingest`,
    "BEPLESS_HTTP_SINK_TIMEOUT_SECONDS=30",
    ].join("\n");
  }
}

async function copyBazelConfig() {
  try {
    await navigator.clipboard.writeText(bazelConfig?.textContent || "");
    if (copyBazelConfigStatus) {
      copyBazelConfigStatus.textContent = "Copied Bazel config.";
    }
  } catch (error) {
    console.error(error);
    if (copyBazelConfigStatus) {
      copyBazelConfigStatus.textContent = "Copy failed. Select the snippet manually.";
    }
  }
}

async function loadReview(reviewId) {
  setAppStoreState({ statusText: `Loading review #${reviewId}...` });

  const [review, ingestBody] = await Promise.all([
    fetchReviewMetadata(reviewId),
    fetchReviewBody(reviewId),
  ]);
  const browserInsights = summarizeBrowserInsights(ingestBody, review.analysis);
  historySummaryCache.set(review.id, browserInsights);
  currentReviewId = review.id;
  setAppStoreState({ currentReviewId: review.id });
  renderHistory(currentHistoryReviews);
  activeFlakyLabel = resolveActiveFlakyLabel(browserInsights, activeFlakyLabel);
  window.__lastBrowserInsights = browserInsights;
  renderAnalysis(browserInsights.analysis, browserInsights, {
    activeFlakyLabel,
    activeTimelineFilter,
    rowLimit: currentTimelineRowLimit(),
  });
  syncInvocationPath(review.invocation_id || browserInsights.analysis.summary.invocation_id || null);
  setAppStoreState({
    statusText: `Showing review #${review.id} from ${new Date(review.uploaded_at_ms).toLocaleString()}.`,
  });
}

async function fetchReviews(updateStatus = true, options = {}) {
  const { hydrateHistory = true } = options;
  if (updateStatus) {
    setAppStoreState({ statusText: "Loading uploaded reviews..." });
  }

  const response = await fetch("/api/reviews", { cache: "no-store" });
  if (!response.ok) {
    const message = "Failed to load uploaded reviews.";
    setAppStoreState({ statusText: message });
    throw new Error(message);
  }

  const reviews = await response.json();
  renderHistory(reviews, { hydrate: hydrateHistory });
  return reviews;
}

async function findInvocationReviewWithRetry(invocationId, updateStatus = true) {
  const decodedInvocationId = decodeURIComponent(invocationId);

  for (let attempt = 1; attempt <= INVOCATION_LOOKUP_MAX_ATTEMPTS; attempt += 1) {
    if (updateStatus) {
      setAppStoreState({
        statusText:
          attempt === 1
            ? `Loading invocation ${decodedInvocationId}...`
            : `Invocation ${decodedInvocationId} not visible yet. Retrying ${attempt}/${INVOCATION_LOOKUP_MAX_ATTEMPTS}...`,
      });
    }

    const reviews = await fetchReviews(false, { hydrateHistory: false });
    const matchedReview = reviews.find((review) => review.invocation_id === decodedInvocationId);
    if (matchedReview) {
      return { reviews, matchedReview };
    }

    if (attempt < INVOCATION_LOOKUP_MAX_ATTEMPTS) {
      const backoffMs = INVOCATION_LOOKUP_BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(backoffMs);
    }
  }

  return { reviews: await fetchReviews(false, { hydrateHistory: false }), matchedReview: null };
}

async function boot() {
  renderSetupSnippets();
  syncSetupVisibility();
  activeFlakyLabel = null;
  resetReviewPanels();

  try {
    const reviews = await fetchReviews();
    if (reviews.length === 0) {
      setAppStoreState({ statusText: "Waiting for BES uploads." });
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
      setAppStoreState({ currentReviewId: null });
      renderHistory(retriedReviews);
      activeFlakyLabel = null;
      resetReviewPanels(`Invocation ${decodeURIComponent(invocationId)} was not found in the latest 50 reviews.`);
      setAppStoreState({
        statusText: `Invocation ${decodeURIComponent(invocationId)} was not found after ${INVOCATION_LOOKUP_MAX_ATTEMPTS} attempts.`,
      });
      return;
    }

    currentReviewId = reviews[0].id;
    setAppStoreState({ currentReviewId: reviews[0].id });
    renderHistory(reviews);
    await loadReview(reviews[0].id);
  } catch (error) {
    console.error(error);
    activeFlakyLabel = null;
    resetReviewPanels("Failed to load reviews.");
  }
}

export async function refreshReviews() {
  try {
    const invocationId = currentInvocationPath();
    if (invocationId) {
      const { reviews, matchedReview } = await findInvocationReviewWithRetry(invocationId);
      if (matchedReview) {
        currentReviewId = matchedReview.id;
        setAppStoreState({ currentReviewId: matchedReview.id });
        renderHistory(reviews);
        await loadReview(matchedReview.id);
      } else {
        currentReviewId = null;
        setAppStoreState({ currentReviewId: null });
        renderHistory(reviews);
        activeFlakyLabel = null;
        resetReviewPanels(`Invocation ${decodeURIComponent(invocationId)} was not found in the latest 50 reviews.`);
        setAppStoreState({
          statusText: `Invocation ${decodeURIComponent(invocationId)} was not found after ${INVOCATION_LOOKUP_MAX_ATTEMPTS} attempts.`,
        });
      }
      return;
    }

    const reviews = await fetchReviews();
    if (reviews.length === 0) {
      currentReviewId = null;
      setAppStoreState({ currentReviewId: null });
      activeFlakyLabel = null;
      resetReviewPanels();
      setAppStoreState({ statusText: "Waiting for BES uploads." });
      return;
    }

    const target = reviews.some((review) => review.id === currentReviewId) ? currentReviewId : reviews[0].id;
    currentReviewId = target;
    setAppStoreState({ currentReviewId: target });
    renderHistory(reviews);
    await loadReview(target);
  } catch (error) {
    console.error(error);
  }
}

export async function openReviewById(reviewId: number) {
  if (!Number.isFinite(reviewId)) return;
  try {
    await loadReview(reviewId);
  } catch (error) {
    console.error(error);
  }
}

export function activateTab(tab: string) {
  setActiveTab(tab || "summary");
}

function bindEvents() {

  copyBazelConfigBtn?.addEventListener("click", async () => {
    await copyBazelConfig();
  });

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

  flakyTestsList?.addEventListener("click", (event) => {
    const item = (event.target as HTMLElement | null)?.closest("[data-flaky-label]");
    if (!item) return;
    activeFlakyLabel = (item as HTMLElement).dataset.flakyLabel || null;
    const reviewPanel = document.querySelector('[data-tab-panel="hotspots"]');
    if (!reviewPanel || reviewPanel.classList.contains("hidden")) {
      setActiveTab("hotspots");
    }
    if (window.__lastBrowserInsights) {
      renderFlakyAttempts(window.__lastBrowserInsights, activeFlakyLabel);
    }
  });
}

export async function bootstrapApp() {
  initDom();
  bindEvents();
  await boot();
  setActiveTab(activeTab);
  setActiveTimelineFilter(activeTimelineFilter);
}
