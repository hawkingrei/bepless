import { SectionHeading } from "./SectionHeading";
import { useAppStore } from "../app/store";

export function ExecutionTab() {
  const { activeTab } = useAppStore();

  return (
    <section
      className={`section-block tab-panel${activeTab === "execution" ? "" : " hidden"}`}
      data-tab-panel="execution"
    >
      <SectionHeading eyebrow="Execution Signals" title="Actions, Runners, And Timing" />
      <div className="grid-2">
        <section className="panel">
          <h3>Top Action Mnemonics</h3>
          <ul id="actions-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel">
          <h3>Runner Counts</h3>
          <ul id="runner-counts-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel grid-span-2">
          <h3>Timing Breakdown</h3>
          <ul id="timing-breakdown-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel">
          <h3>Test Progress URIs</h3>
          <ul id="test-progress-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel">
          <h3>Convenience Symlinks</h3>
          <ul id="convenience-symlinks-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel grid-span-2">
          <h3>Exec Request</h3>
          <ul id="exec-request-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
      </div>
    </section>
  );
}
