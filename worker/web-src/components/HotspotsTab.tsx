import { SectionHeading } from "./SectionHeading";
import { useAppStore } from "../app/store";

export function HotspotsTab() {
  const { activeTab } = useAppStore();

  return (
    <section
      className={`section-block tab-panel${activeTab === "hotspots" ? "" : " hidden"}`}
      data-tab-panel="hotspots"
    >
      <SectionHeading eyebrow="Performance Hotspots" title="Cache, Tests, Compile, And IO" />
      <div className="grid-2">
        <section className="panel">
          <h3>Cache Overview</h3>
          <ul id="cache-overview-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel">
          <h3>Flaky Tests</h3>
          <ul id="flaky-tests-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel">
          <h3>Flaky Attempts</h3>
          <ul id="flaky-attempts-list">
            <li className="muted">Select a flaky test.</li>
          </ul>
        </section>
        <section className="panel">
          <h3>Top Compile Span</h3>
          <p className="muted section-copy">
            Wall-clock span across the first started and last finished action for each compile
            mnemonic.
          </p>
          <ul id="compile-top-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel">
          <h3>Top IO Time</h3>
          <ul id="io-top-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel">
          <h3>Top Test Execution Wall Time</h3>
          <ul id="test-exec-wall-top-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel grid-span-2">
          <h3>Artifact References</h3>
          <p className="muted section-copy">
            File references reported by BEP events such as <code>testActionOutput</code>,{" "}
            <code>namedSetOfFiles</code>, <code>outputGroup</code>, <code>buildToolLogs</code>,
            and action stdio.
          </p>
          <ul id="artifact-references-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel">
          <h3>Slow Actions</h3>
          <ul id="slow-actions-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel">
          <h3>Top Test Time</h3>
          <ul id="slow-tests-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel grid-span-2">
          <h3>Cache Miss Reasons</h3>
          <ul id="cache-miss-reasons-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
      </div>
    </section>
  );
}
