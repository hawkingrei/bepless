import { useAppStore } from "../app/store";
import { refreshReviews } from "../controller";

export function HeroSection() {
  const { statusText, historyItems, currentReviewId } = useAppStore();
  const selectedLabel =
    historyItems.find((item) => item.id === currentReviewId)?.label ?? null;

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
