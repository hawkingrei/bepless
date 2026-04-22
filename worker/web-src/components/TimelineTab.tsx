import { SectionHeading } from "./SectionHeading";
import { useAppStore } from "../app/store";

export function TimelineTab() {
  const { activeTab } = useAppStore();

  return (
    <section
      className={`section-block tab-panel${activeTab === "timeline" ? "" : " hidden"}`}
      data-tab-panel="timeline"
    >
      <SectionHeading eyebrow="Chronology" title="Wall-Time Timeline" />
      <section className="panel">
        <p className="section-copy">
          Real wall-clock ordering of build span, action ranges, and test attempts.
        </p>
        <div className="timeline-toolbar">
          <div className="timeline-filters" id="timeline-filters">
            <button
              className="secondary compact timeline-filter-button timeline-filter-button-active"
              data-timeline-filter="all"
              type="button"
            >
              All
            </button>
            <button
              className="secondary compact timeline-filter-button"
              data-timeline-filter="action"
              type="button"
            >
              Actions
            </button>
            <button
              className="secondary compact timeline-filter-button"
              data-timeline-filter="test"
              type="button"
            >
              Tests
            </button>
            <button
              className="secondary compact timeline-filter-button"
              data-timeline-filter="failed"
              type="button"
            >
              Failed
            </button>
          </div>
          <label className="timeline-limit-label" htmlFor="timeline-limit">
            <span>Items</span>
            <select id="timeline-limit" defaultValue="48">
              <option value="24">24</option>
              <option value="48">48</option>
              <option value="96">96</option>
            </select>
          </label>
        </div>
        <div id="timeline-summary" className="timeline-summary muted">
          No uploaded reviews yet.
        </div>
        <div id="timeline-chart" className="timeline-chart">
          <div className="muted">No uploaded reviews yet.</div>
        </div>
        <div id="timeline-detail" className="timeline-detail muted">
          Select a timeline item to inspect its details.
        </div>
      </section>
    </section>
  );
}
