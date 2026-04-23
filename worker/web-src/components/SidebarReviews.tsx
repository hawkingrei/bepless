import { useAppStore } from "../app/store";
import { openReviewById } from "../controller";

export function SidebarReviews() {
  const { historyItems } = useAppStore();
  const hydratedCount = historyItems.filter((item) => item.status !== "n/a").length;

  return (
    <aside className="panel sidebar">
      <div className="sidebar-header">
        <div className="split-line">
          <h2>Uploaded Reviews</h2>
          <span className="badge">{historyItems.length} shown</span>
        </div>
        <p className="section-copy">
          Recent invocations persisted in D1. Select one review to hydrate the detailed dashboard.
        </p>
        <div className="sidebar-stats">
          <span className="pill">{hydratedCount} details loaded</span>
          <span className="pill">{Math.max(historyItems.length - hydratedCount, 0)} pending</span>
          <span className="pill">latest 50</span>
        </div>
      </div>
      <div className="history-list-shell">
        <ul id="history-list">
          {historyItems.length === 0 ? (
            <li className="muted">Loading uploaded reviews...</li>
          ) : (
            historyItems.map((item) => (
              <li
                key={item.id}
                className={`history-item${item.active ? " history-item-active" : ""}`}
                data-review-id={item.id}
                onClick={() => {
                  void openReviewById(item.id);
                }}
              >
                <div className="history-item-top">
                  <strong className="mono history-item-label">{item.label}</strong>
                  <span className={`badge history-status-badge history-status-${sanitizeStatus(item.status)}`}>
                    {item.status}
                  </span>
                </div>
                <div className="history-item-time">{item.uploadedAtText}</div>
                <div className="history-meta">
                  <span className="history-meta-chip">critical {item.criticalText}</span>
                  <span className="history-meta-chip">wall {item.wallText}</span>
                </div>
              </li>
            ))
          )}
        </ul>
      </div>
    </aside>
  );
}

function sanitizeStatus(status: string) {
  return status.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}
