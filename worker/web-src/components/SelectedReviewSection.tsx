import { useAppStore } from "../app/store";
import { SectionHeading } from "./SectionHeading";

export function SelectedReviewSection() {
  const { historyItems, currentReviewId } = useAppStore();
  const selectedItem = historyItems.find((item) => item.id === currentReviewId) ?? null;

  return (
    <section className="section-block">
      <SectionHeading eyebrow="Selected Review" title="Summary" />
      <section className="panel">
        <div className="selected-review-meta">
          <span className="pill mono">
            {selectedItem ? `review ${selectedItem.id}` : "review pending"}
          </span>
          <span className="pill">{selectedItem?.status ?? "loading"}</span>
          <span className="pill">{selectedItem?.uploadedAtText ?? "awaiting upload"}</span>
          <span className="pill">critical {selectedItem?.criticalText ?? "n/a"}</span>
          <span className="pill">wall {selectedItem?.wallText ?? "n/a"}</span>
        </div>
        <div className="kpi-grid" id="summary-grid"></div>
        <div className="tag-block">
          <h3>Notification Keywords</h3>
          <ul id="keyword-list" className="tag-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </div>
      </section>
    </section>
  );
}
