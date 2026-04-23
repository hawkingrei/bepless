import { useAppStore } from "../app/store";
import { refreshReviews } from "../controller";

export function HeroSection() {
  const { statusText, loading, historyItems, currentReviewId } = useAppStore();
  const selectedLabel =
    historyItems.find((item) => item.id === currentReviewId)?.label ?? null;
  const progressText =
    loading.progress !== null ? `${Math.max(0, Math.min(100, Math.round(loading.progress)))}%` : "syncing";
  const stepText =
    loading.step !== null && loading.totalSteps !== null
      ? `step ${Math.max(1, loading.step)}/${loading.totalSteps}`
      : null;
  const loadingSteps =
    loading.totalSteps !== null ? Array.from({ length: loading.totalSteps }, (_, index) => index + 1) : [];

  return (
    <section className="hero">
      <div className="hero-top">
        <div className="hero-main">
          <p className="eyebrow">Bazel Review Surface</p>
          <h1>BEP Performance Review</h1>
          <p className="hero-copy">
            Review uploaded BES invocations without re-parsing them on the server. The worker keeps
            the latest 50 normalized uploads, and the browser renders cache, compile, IO,
            flaky-test, and timing signals locally.
          </p>
          <div className="hero-facts">
            <span className="pill">{historyItems.length} cached reviews</span>
            <span className="pill">browser-side analysis</span>
            {selectedLabel ? <span className="pill mono">selected {selectedLabel}</span> : null}
          </div>
        </div>
        <div className="hero-actions">
          <button
            id="refresh-btn"
            className="secondary"
            type="button"
            onClick={() => {
              void refreshReviews();
            }}
          >
            Refresh Reviews
          </button>
          <div className="status" id="status">{statusText}</div>
        </div>
      </div>

      {loading.active ? (
        <div className={`loading-strip${loading.indeterminate ? " loading-strip-indeterminate" : ""}`}>
          <div className="loading-strip-head">
            <div className="loading-strip-title">
              <span className="loading-spinner" aria-hidden="true"></span>
              <strong>{loading.phase || statusText}</strong>
            </div>
            <div className="loading-strip-meta">
              {stepText ? <span>{stepText}</span> : null}
              <span>{progressText}</span>
            </div>
          </div>
          {loadingSteps.length > 0 ? (
            <div
              className="loading-steps"
              aria-hidden="true"
              style={{ gridTemplateColumns: `repeat(${loadingSteps.length}, minmax(0, 1fr))` }}
            >
              {loadingSteps.map((step) => (
                <span
                  key={step}
                  className={`loading-step${loading.step !== null && step <= loading.step ? " loading-step-complete" : ""}`}
                ></span>
              ))}
            </div>
          ) : null}
          <div className="loading-bar">
            <div
              className="loading-bar-fill"
              style={{
                width: loading.progress !== null ? `${Math.max(6, Math.min(100, loading.progress))}%` : "38%",
              }}
            ></div>
          </div>
        </div>
      ) : null}

      <div className="setup-grid" id="setup-grid">
        <section className="panel setup-card">
          <div className="split-line">
            <h2>Bazel Setup</h2>
            <button id="copy-bazel-config-btn" className="secondary compact" type="button">
              Copy
            </button>
          </div>
          <p className="section-copy">
            Put this block into your <code>.bazelrc</code>. It includes the BES endpoint, result
            URL, and the recommended metrics flags for this review surface.
          </p>
          <pre id="bazel-config"></pre>
          <p className="hint setup-feedback" id="copy-bazel-config-status">
            Ready to copy.
          </p>
        </section>

        <section className="panel setup-card">
          <div className="split-line">
            <h2>HTTP Sink</h2>
            <span className="badge">worker</span>
          </div>
          <p className="section-copy">
            <code>grpc-ingest</code> flushes one completed invocation at a time to the worker
            ingress.
          </p>
          <pre id="sink-config"></pre>
        </section>
      </div>
    </section>
  );
}
