import { SectionHeading } from "./SectionHeading";
import { useAppStore } from "../app/store";

export function SummaryTab() {
  const { activeTab } = useAppStore();

  return (
    <section
      className={`section-block tab-panel${activeTab === "summary" ? "" : " hidden"}`}
      data-tab-panel="summary"
    >
      <SectionHeading eyebrow="Build Health" title="Findings And Failures" />
      <div className="grid-2">
        <section className="panel">
          <h3>Findings</h3>
          <ul id="findings-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel">
          <h3>Failed Targets</h3>
          <ul id="failed-targets-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel grid-span-2">
          <h3>Target Summaries</h3>
          <p className="muted section-copy">
            Target-level aggregate result from <code>targetSummary</code> events.
          </p>
          <ul id="target-summaries-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
      </div>
    </section>
  );
}
