import {
  actionsList,
  artifactReferencesList,
  cacheMissReasonsList,
  cacheOverviewList,
  compileTopList,
  failedTargetsList,
  findingsList,
  flakyAttemptsList,
  flakyTestsList,
  hostJvmArgsList,
  ioTopList,
  jvmMetricsList,
  keywordList,
  networkMetricsList,
  slowActionsList,
  slowTestsList,
  summaryGrid,
  testExecWallTopList,
  timelineChart,
  timelineDetail,
  timelineSummary,
  timingBreakdownList,
  timingMetricsList,
  workerStatsList,
  runnerCountsList,
} from "./dom";
import { escapeHtml, formatBytes, formatMs, formatPercent } from "./utils";
import { Timeline } from "vis-timeline";

type TimelineRenderOptions = {
  activeTimelineFilter: string;
  rowLimit: number;
};

type AnalysisRenderOptions = TimelineRenderOptions & {
  activeFlakyLabel: string | null;
};

function createListItems(
  container: HTMLElement | null,
  items: any[],
  render: (item: any) => string,
  emptyText: string,
) {
  if (!container) return;
  if (!items || items.length === 0) {
    container.innerHTML = `<li class="muted">${emptyText}</li>`;
    return;
  }
  container.innerHTML = items.map(render).join("");
}

function filterTimelineEvents(events: any[], filter: string) {
  if (filter === "action") {
    return events.filter((event) => event.category === "action");
  }
  if (filter === "test") {
    return events.filter((event) => event.category === "test");
  }
  if (filter === "failed") {
    return events.filter((event) => event.failed === true);
  }
  return events;
}

let timelineInstance: Timeline | null = null;

function timelineGroupLabel(group: string) {
  if (group === "build") return "Build";
  if (group === "action") return "Action";
  if (group === "test") return "Test";
  return group || "Unknown";
}

function renderTimelineDetail(item: any) {
  if (!timelineDetail) return;
  if (!item) {
    timelineDetail.classList.add("muted");
    timelineDetail.innerHTML = "Select a timeline item to inspect its details.";
    return;
  }

  const durationMs =
    item.end_ms !== null && item.end_ms !== undefined
      ? Math.max(0, item.end_ms - item.start_ms)
      : null;
  const rows = [
    ["Title", item.title || item.content || "n/a"],
    ["Category", item.category || "n/a"],
    ["Group", timelineGroupLabel(item.group)],
    ["Kind", item.item_type || (item.end_ms !== null && item.end_ms !== undefined ? "range" : "point")],
    ["Failed", item.failed ? "true" : "false"],
    ["Started", new Date(item.start_ms).toLocaleString()],
    ["Finished", item.end_ms !== null && item.end_ms !== undefined ? new Date(item.end_ms).toLocaleString() : "n/a"],
    ["Duration", durationMs !== null ? formatMs(durationMs) : "n/a"],
  ];

  const detailBlocks = [item.detail, item.content]
    .filter((value, index, source) => value && source.indexOf(value) === index)
    .map(
      (value) => `
        <div class="timeline-detail-row">
          <div class="timeline-detail-label">Detail</div>
          <pre class="timeline-detail-pre">${escapeHtml(String(value))}</pre>
        </div>
      `,
    )
    .join("");

  timelineDetail.classList.remove("muted");
  timelineDetail.innerHTML = `
    <div class="timeline-detail-grid">
      ${rows
        .map(
          ([label, value]) => `
            <div class="timeline-detail-row">
              <div class="timeline-detail-label">${escapeHtml(String(label))}</div>
              <div class="timeline-detail-value">${escapeHtml(String(value))}</div>
            </div>
          `,
        )
        .join("")}
    </div>
    ${detailBlocks}
  `;
}

function destroyTimeline() {
  if (timelineInstance) {
    timelineInstance.destroy();
    timelineInstance = null;
  }
}

export function renderTimeline(insights: any, options: TimelineRenderOptions) {
  // TODO:
  // - Add stronger failed-item emphasis in the timeline itself, not just via filter.
  // - Add click-to-inspect details for the selected timeline item.
  const items = Array.isArray(insights.timelineItems) ? insights.timelineItems : [];
  if (items.length === 0) {
    destroyTimeline();
    timelineSummary.textContent = "No absolute event timestamps in this BEP.";
    timelineChart.innerHTML = '<div class="muted">No build, action, or test events carried absolute wall-time markers.</div>';
    renderTimelineDetail(null);
    return;
  }

  const filteredItems = filterTimelineEvents(items, options.activeTimelineFilter);
  if (filteredItems.length === 0) {
    destroyTimeline();
    timelineSummary.textContent = "No timeline items matched the current filter.";
    timelineChart.innerHTML = '<div class="muted">No events matched the current timeline filter.</div>';
    renderTimelineDetail(null);
    return;
  }

  const visibleItems = filteredItems.slice(0, options.rowLimit);
  const timeCandidates = visibleItems.flatMap((item) => [item.start_ms, item.end_ms ?? item.start_ms]);
  const rangeStart = Math.min(...timeCandidates);
  const rangeEnd = Math.max(...timeCandidates);
  const groups = [
    { id: "build", content: "Build" },
    { id: "action", content: "Actions" },
    { id: "test", content: "Tests" },
  ].filter((group) => visibleItems.some((item) => item.group === group.id));

  const failedCount = visibleItems.filter((item) => item.failed).length;
  timelineSummary.textContent = `Showing ${visibleItems.length}/${filteredItems.length} items · Start ${new Date(rangeStart).toLocaleString()} · Span ${formatMs(Math.max(0, rangeEnd - rangeStart))} · Failed ${failedCount}`;

  destroyTimeline();
  timelineChart.innerHTML = "";
  const container = document.createElement("div");
  container.className = "timeline-vis";
  timelineChart.appendChild(container);

  const itemById = new Map(visibleItems.map((item) => [item.id, item]));

  const visItems = visibleItems.map((item) => {
    const classNames = ["timeline-vis-item", `timeline-vis-item-${item.category}`];
    if (item.failed) classNames.push("timeline-vis-item-failed");
    if (item.item_type === "background") classNames.push("timeline-vis-item-background");
    return {
      id: item.id,
      group: item.group,
      start: new Date(item.start_ms),
      end: item.end_ms !== null && item.end_ms !== undefined ? new Date(item.end_ms) : undefined,
      type: item.item_type || (item.end_ms !== null && item.end_ms !== undefined ? "range" : "point"),
      content: escapeHtml(item.content || item.title || item.group),
      title: escapeHtml([item.title, item.detail].filter(Boolean).join(" · ")),
      className: classNames.join(" "),
    };
  });

  timelineInstance = new Timeline(container, visItems as any, groups as any, {
    stack: true,
    groupOrder: "id",
    showCurrentTime: false,
    horizontalScroll: true,
    verticalScroll: true,
    zoomKey: "ctrlKey",
    orientation: { axis: "top", item: "top" },
    margin: { item: { horizontal: 8, vertical: 10 }, axis: 8 },
    tooltip: { followMouse: true },
    minHeight: "420px",
    maxHeight: "620px",
  });
  timelineInstance.setWindow(new Date(rangeStart), new Date(rangeEnd), { animation: false });

  const initialItem =
    visibleItems.find((item) => item.failed && item.item_type !== "background") ||
    visibleItems.find((item) => item.item_type !== "background") ||
    visibleItems[0] ||
    null;

  renderTimelineDetail(initialItem);
  if (initialItem) {
    timelineInstance.setSelection([initialItem.id], { focus: false });
  }

  timelineInstance.on("select", (properties: any) => {
    const [selectedId] = Array.isArray(properties?.items) ? properties.items : [];
    renderTimelineDetail(selectedId ? itemById.get(selectedId) || null : null);
  });
}

export function renderSummary(summary: any) {
  const cards = [
    ["Invocation", summary.invocation_id || "n/a", summary.invocation_source || null],
    ["Command", summary.command || "n/a", summary.command_source || null],
    ["Wall Time", formatMs(summary.wall_time_ms ?? summary.elapsed_ms), null],
    ["Critical Path", formatMs(summary.critical_path_ms), null],
    ["Cache Hit Ratio", formatPercent(summary.cache_hit_ratio), null],
    ["Actions", summary.total_actions ?? "n/a", null],
    ["Failed Tests", summary.failed_tests, null],
    ["Exit Code", summary.exit_code || "n/a", null],
  ];
  summaryGrid.innerHTML = cards
    .map(
      ([label, value, source]) => `
        <article class="kpi">
          <div class="kpi-label">${label}</div>
          <div class="kpi-value">${value}</div>
          ${source ? `<div class="kpi-label">source=${source}</div>` : ""}
        </article>
      `,
    )
    .join("");
}

export function renderKeywords(keywords: string[]) {
  if (!keywords || keywords.length === 0) {
    keywordList.innerHTML = '<li class="muted">No notification keywords.</li>';
    return;
  }

  keywordList.innerHTML = keywords
    .map(
      (keyword) => `
        <li class="tag-chip mono">${keyword}</li>
      `,
    )
    .join("");
}

export function resolveActiveFlakyLabel(insights: any, activeFlakyLabel: string | null) {
  if (
    activeFlakyLabel &&
    (!insights.flakyAttemptsByLabel || !insights.flakyAttemptsByLabel.has(activeFlakyLabel))
  ) {
    return insights.flakyTests.length > 0 ? insights.flakyTests[0].label : null;
  }
  if (!activeFlakyLabel && insights.flakyTests.length > 0) {
    return insights.flakyTests[0].label;
  }
  return activeFlakyLabel;
}

export function renderFlakyAttempts(insights: any, label: string | null) {
  const attempts = label ? insights.flakyAttemptsByLabel.get(label) || [] : [];
  createListItems(
    flakyAttemptsList,
    attempts
      .slice()
      .sort((left, right) => {
        if ((left.run ?? -1) !== (right.run ?? -1)) return (left.run ?? -1) - (right.run ?? -1);
        if ((left.shard ?? -1) !== (right.shard ?? -1)) return (left.shard ?? -1) - (right.shard ?? -1);
        return (left.attempt ?? -1) - (right.attempt ?? -1);
      }),
    (item) => `
      <li>
        <div class="split-line">
          <strong>run=${item.run ?? "n/a"} shard=${item.shard ?? "n/a"} attempt=${item.attempt ?? "n/a"}</strong>
          <span class="badge">${item.status}</span>
        </div>
        <div class="muted detail-line">
          strategy=${item.strategy} wall=${formatMs(item.execution_wall_ms)} io=${formatMs(item.io_ms)}
        </div>
        ${item.attempt >= 2 ? '<div class="muted detail-line">flaky_attempt=true</div>' : ""}
        ${item.status_details ? `<div class="muted detail-line">${escapeHtml(item.status_details)}</div>` : ""}
        ${
          item.outputs && item.outputs.length > 0
            ? `<div class="muted detail-line">outputs=${item.outputs.length}</div>
               <div class="attempt-output-list">${item.outputs
                 .map((output: any, index: number) => {
                 const outputName = escapeHtml(output.name || `output-${index + 1}`);
                   const outputUri = output.uri ? escapeHtml(output.uri) : null;
                   const isBytestream = typeof output.uri === "string" && output.uri.startsWith("bytestream://");
                   return `
                     <div class="attempt-output-item ${isBytestream ? "attempt-output-item-bytestream" : ""}">
                       <div class="attempt-output-name">${outputName}</div>
                       ${
                         outputUri
                           ? `<a class="attempt-output-link ${isBytestream ? "attempt-output-link-bytestream" : ""}" href="${outputUri}" target="_blank" rel="noreferrer">${outputUri}</a>`
                           : '<div class="muted">no uri</div>'
                       }
                     </div>
                   `;
                 })
                 .join("")}</div>`
            : ""
        }
      </li>
    `,
    label ? "No test attempts recorded." : "Select a flaky test.",
  );
}

export function renderBrowserInsights(insights: any, options: AnalysisRenderOptions) {
  renderTimeline(insights, options);

  createListItems(
    hostJvmArgsList,
    insights.hostJvmArgs,
    (item) => `
      <li><span class="mono">${item}</span></li>
    `,
    "No JVM startup options reported.",
  );

  createListItems(
    jvmMetricsList,
    insights.jvmMetrics
      ? [
          ["Used Heap Post Build", formatBytes(insights.jvmMetrics.used_heap_size_post_build)],
          ["Peak Post-GC Heap", formatBytes(insights.jvmMetrics.peak_post_gc_heap_size)],
          ["Peak Tenured Post-GC Heap", formatBytes(insights.jvmMetrics.peak_post_gc_tenured_space_heap_size)],
        ]
      : [],
    ([label, value]) => `
      <li class="split-line">
        <span>${label}</span>
        <span class="badge">${value}</span>
      </li>
    `,
    "No Bazel JVM heap metrics.",
  );

  createListItems(
    timingMetricsList,
    insights.timingMetrics
      ? [
          ["Wall Time", formatMs(insights.timingMetrics.wall_time_ms)],
          ["CPU Time", formatMs(insights.timingMetrics.cpu_time_ms)],
          ["Analysis Phase", formatMs(insights.timingMetrics.analysis_phase_time_ms)],
          ["Execution Phase", formatMs(insights.timingMetrics.execution_phase_time_ms)],
        ]
      : [],
    ([label, value]) => `
      <li class="split-line">
        <span>${label}</span>
        <span class="badge">${value}</span>
      </li>
    `,
    "No Bazel timing metrics.",
  );

  createListItems(
    networkMetricsList,
    insights.networkMetrics
      ? [
          ["Bytes Sent", formatBytes(insights.networkMetrics.bytes_sent)],
          ["Bytes Recv", formatBytes(insights.networkMetrics.bytes_recv)],
          ["Packets Sent", insights.networkMetrics.packets_sent ?? "n/a"],
          ["Packets Recv", insights.networkMetrics.packets_recv ?? "n/a"],
          ["Peak Send Throughput", `${formatBytes(insights.networkMetrics.peak_bytes_sent_per_sec)}/s`],
          ["Peak Recv Throughput", `${formatBytes(insights.networkMetrics.peak_bytes_recv_per_sec)}/s`],
        ]
      : [],
    ([label, value]) => `
      <li class="split-line">
        <span>${label}</span>
        <span class="badge">${value}</span>
      </li>
    `,
    "No network metrics.",
  );

  createListItems(
    workerStatsList,
    insights.workerMetrics,
    (item) => `
      <li>
        <div class="split-line">
          <strong>${item.mnemonic}</strong>
          <span class="badge">${item.worker_status}</span>
        </div>
        <div class="muted detail-line">
          actions=${item.actions_executed ?? "n/a"} prior_actions=${item.prior_actions_executed ?? "n/a"}
        </div>
        <div class="muted detail-line">
          memory=${item.worker_memory_kb === null ? "n/a" : formatBytes(item.worker_memory_kb * 1024)}
          prior_memory=${item.prior_worker_memory_kb === null ? "n/a" : formatBytes(item.prior_worker_memory_kb * 1024)}
        </div>
        <div class="muted detail-line">
          multiplex=${String(item.is_multiplex)} sandbox=${String(item.is_sandbox)}
        </div>
      </li>
    `,
    "No worker stats.",
  );

  createListItems(
    artifactReferencesList,
    insights.artifactReferences,
    (item) => `
      <li>
        <div class="split-line">
          <strong>${escapeHtml(item.name || item.source)}</strong>
          <span class="badge">${escapeHtml(item.source || "artifact")}</span>
        </div>
        ${
          item.uri
            ? `<div class="attempt-output-item ${item.is_bytestream ? "attempt-output-item-bytestream" : ""}">
                 <a class="attempt-output-link ${item.is_bytestream ? "attempt-output-link-bytestream" : ""}" href="${escapeHtml(item.uri)}" target="_blank" rel="noreferrer">${escapeHtml(item.uri)}</a>
               </div>`
            : ""
        }
        <div class="muted detail-line">
          ${[
            item.label ? `label=${escapeHtml(item.label)}` : null,
            item.output_group ? `output_group=${escapeHtml(item.output_group)}` : null,
            item.named_set_id ? `named_set=${escapeHtml(item.named_set_id)}` : null,
            item.attempt !== undefined && item.attempt !== null ? `attempt=${item.attempt}` : null,
            item.digest ? `digest=${escapeHtml(item.digest)}` : null,
            item.has_inline_contents ? "inline_contents=true" : null,
            item.symlink_target_path ? `symlink=${escapeHtml(item.symlink_target_path)}` : null,
          ]
            .filter(Boolean)
            .join(" ")}
        </div>
      </li>
    `,
    "No BEP file references were reported.",
  );

  createListItems(
    cacheOverviewList,
    insights.cacheOverview ? [insights.cacheOverview] : [],
    (item) => {
      const hits = item.action_hits;
      const misses = item.action_misses;
      const ratio = hits !== null && misses !== null && hits + misses > 0 ? hits / (hits + misses) : null;

      return `
        <li>
          <div class="split-line">
            <strong>Action Cache</strong>
            <span class="badge">${formatPercent(ratio)}</span>
          </div>
          <div class="muted detail-line">
            hits=${hits ?? "n/a"} misses=${misses ?? "n/a"} remote_hits=${item.remote_hits ?? "n/a"}
          </div>
        </li>
      `;
    },
    "No cache metrics in this BEP.",
  );

  createListItems(
    cacheMissReasonsList,
    insights.cacheMissReasons,
    ([reason, count]) => `
      <li class="split-line">
        <span>${reason}</span>
        <span class="badge">${count}</span>
      </li>
    `,
    "No cache miss reason breakdown.",
  );

  createListItems(
    compileTopList,
    insights.topCompileItems,
    (item) => `
      <li>
        <div class="split-line">
          <strong>${item.name}</strong>
          <span class="badge">span=${formatMs(item.duration_ms)}</span>
        </div>
        <div class="muted detail-line">
          actions=${item.actions_executed} cpu_user=${formatMs(item.user_time_ms)} cpu_system=${formatMs(item.system_time_ms)}
        </div>
      </li>
    `,
    "No compile-classified actions.",
  );

  createListItems(
    ioTopList,
    insights.topIoItems,
    (item) => `
      <li>
        <div class="split-line">
          <strong class="mono">${item.name}</strong>
          <span class="badge">${formatMs(item.duration_ms)}</span>
        </div>
        <div class="muted detail-line">
          strategy=${item.strategy} status=${item.status}
        </div>
      </li>
    `,
    "No IO-related test timing breakdown nodes were reported.",
  );

  createListItems(
    testExecWallTopList,
    insights.topTestExecutionWallItems,
    (item) => `
      <li>
        <div class="split-line">
          <strong class="mono">${item.name}</strong>
          <span class="badge">${formatMs(item.duration_ms)}</span>
        </div>
        <div class="muted detail-line">
          strategy=${item.strategy} status=${item.status}
        </div>
      </li>
    `,
    "No test execution wall-time data.",
  );

  createListItems(
    slowActionsList,
    insights.slowActions,
    (item) => `
      <li>
        <div class="split-line">
          <strong>${item.mnemonic}</strong>
          <span class="badge">${formatMs(item.duration_ms)}</span>
        </div>
        <div class="muted detail-line">
          label=${item.label} exit=${item.exit_code ?? "n/a"} success=${String(item.success)}
        </div>
        <div class="muted detail-line">
          output=${item.primary_output}
        </div>
        ${item.failure_detail ? `<div class="muted detail-line">failure=${item.failure_detail}</div>` : ""}
        <pre class="command-preview">${item.command_preview || "No command line reported."}</pre>
      </li>
    `,
    "No slow action execution records.",
  );

  createListItems(
    flakyTestsList,
    insights.flakyTests,
    (item) => `
      <li class="clickable-row ${options.activeFlakyLabel === item.label ? "clickable-row-active" : ""}" data-flaky-label="${escapeHtml(item.label)}">
        <div class="split-line">
          <strong class="mono">${item.label}</strong>
          <span class="badge">${formatMs(item.duration_ms)}</span>
        </div>
        <div class="muted detail-line">
          status=${item.status} attempts=${item.attempt_count ?? "n/a"} total_runs=${item.total_run_count ?? "n/a"}
        </div>
      </li>
    `,
    "No flaky test signal found.",
  );

  renderFlakyAttempts(insights, options.activeFlakyLabel);

  createListItems(
    slowTestsList,
    insights.topTests,
    (item) => `
      <li>
        <div class="split-line">
          <strong class="mono">${item.label}</strong>
          <span class="badge">${formatMs(item.duration_ms)}</span>
        </div>
        <div class="muted detail-line">
          status=${item.status} cached=${item.cached === null ? "n/a" : String(item.cached)} attempts=${item.attempt_count ?? "n/a"}
        </div>
      </li>
    `,
    "No test summaries.",
  );
}

export function renderAnalysis(payload: any, browserInsights: any, options: AnalysisRenderOptions) {
  renderSummary(payload.summary);
  renderKeywords(payload.notification_keywords);
  renderBrowserInsights(browserInsights, options);

  createListItems(
    findingsList,
    payload.findings,
    (item) => `
      <li class="finding-${item.severity}">
        <div class="split-line">
          <strong>${item.category}</strong>
          <span class="badge">${item.severity}</span>
        </div>
        <div class="muted detail-line">${item.message}</div>
      </li>
    `,
    "No findings.",
  );

  createListItems(
    failedTargetsList,
    payload.failed_targets,
    (item) => `
      <li><span class="mono">${item}</span></li>
    `,
    "No failed targets.",
  );

  createListItems(
    actionsList,
    payload.top_action_mnemonics,
    (item) => `
      <li>
        <div class="split-line">
          <strong>${item.mnemonic}</strong>
          <span class="badge">span=${formatMs(item.span_ms)}</span>
        </div>
        <div class="muted detail-line">
          actions=${item.actions_executed} cpu_user=${formatMs(item.user_time_ms)} cpu_system=${formatMs(item.system_time_ms)}
        </div>
      </li>
    `,
    "No action metrics.",
  );

  createListItems(
    runnerCountsList,
    Object.entries(payload.runner_counts || {}).sort((a: any, b: any) => b[1] - a[1]),
    ([name, count]) => `
      <li class="split-line">
        <span>${name}</span>
        <span class="badge">${count}</span>
      </li>
    `,
    "No runner counts.",
  );

  createListItems(
    timingBreakdownList,
    Object.entries(payload.timing_breakdown_ms || {}).sort((a: any, b: any) => b[1] - a[1]),
    ([name, value]) => `
      <li class="split-line">
        <span>${name}</span>
        <span class="badge">${formatMs(value)}</span>
      </li>
    `,
    "No timing breakdown.",
  );
}

export function resetReviewPanels(message = "No uploaded reviews yet.") {
  window.__lastBrowserInsights = null;
  summaryGrid.innerHTML = "";
  keywordList.innerHTML = `<li class="muted">${message}</li>`;
  timelineSummary.textContent = message;
  timelineChart.innerHTML = `<div class="muted">${message}</div>`;
  hostJvmArgsList.innerHTML = `<li class="muted">${message}</li>`;
  jvmMetricsList.innerHTML = `<li class="muted">${message}</li>`;
  timingMetricsList.innerHTML = `<li class="muted">${message}</li>`;
  networkMetricsList.innerHTML = `<li class="muted">${message}</li>`;
  workerStatsList.innerHTML = `<li class="muted">${message}</li>`;
  findingsList.innerHTML = `<li class="muted">${message}</li>`;
  failedTargetsList.innerHTML = `<li class="muted">${message}</li>`;
  cacheOverviewList.innerHTML = `<li class="muted">${message}</li>`;
  cacheMissReasonsList.innerHTML = `<li class="muted">${message}</li>`;
  flakyTestsList.innerHTML = `<li class="muted">${message}</li>`;
  flakyAttemptsList.innerHTML = `<li class="muted">${message}</li>`;
  compileTopList.innerHTML = `<li class="muted">${message}</li>`;
  ioTopList.innerHTML = `<li class="muted">${message}</li>`;
  testExecWallTopList.innerHTML = `<li class="muted">${message}</li>`;
  slowActionsList.innerHTML = `<li class="muted">${message}</li>`;
  slowTestsList.innerHTML = `<li class="muted">${message}</li>`;
  actionsList.innerHTML = `<li class="muted">${message}</li>`;
  runnerCountsList.innerHTML = `<li class="muted">${message}</li>`;
  timingBreakdownList.innerHTML = `<li class="muted">${message}</li>`;
}
