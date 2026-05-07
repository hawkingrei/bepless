import { SectionHeading } from "./SectionHeading";
import { useAppStore } from "../app/store";

export function RuntimeTab() {
  const { activeTab } = useAppStore();

  return (
    <section
      className={`section-block tab-panel${activeTab === "runtime" ? "" : " hidden"}`}
      data-tab-panel="runtime"
    >
      <SectionHeading eyebrow="Invocation Runtime" title="JVM And Timing" />
      <div className="grid-2">
        <section className="panel grid-span-2">
          <h3>Build Metadata</h3>
          <p className="muted section-copy">
            Metadata reported by <code>--build_metadata</code>, including CI, git, and PR fields.
          </p>
          <ul id="build-metadata-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel grid-span-2">
          <h3>Command Line</h3>
          <p className="muted section-copy">
            Raw invocation arguments from <code>unstructuredCommandLine</code>, with{" "}
            <code>optionsParsed</code> as a fallback.
          </p>
          <ul id="command-line-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel">
          <h3>Workspace Status</h3>
          <ul id="workspace-status-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel">
          <h3>Workspace Info</h3>
          <ul id="workspace-info-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel grid-span-2">
          <h3>Configurations</h3>
          <ul id="configurations-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel">
          <h3>Host JVM Args</h3>
          <ul id="host-jvm-args-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel">
          <h3>Bazel JVM Heap Metrics</h3>
          <ul id="jvm-metrics-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel grid-span-2">
          <h3>Bazel Timing Metrics</h3>
          <ul id="timing-metrics-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel">
          <h3>Network Metrics</h3>
          <ul id="network-metrics-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
        <section className="panel">
          <h3>Worker Stats</h3>
          <ul id="worker-stats-list">
            <li className="muted">No uploaded reviews yet.</li>
          </ul>
        </section>
      </div>
    </section>
  );
}
