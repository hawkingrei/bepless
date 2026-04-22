import { parseDurationMs, stripAnsi, toNumber } from "./utils";

function isCompileMnemonic(name) {
  const lower = String(name || "").toLowerCase();
  return (
    [
      "compile",
      "link",
      "javac",
      "kotlinc",
      "scalac",
      "swift",
      "rustc",
      "tsproject",
      "tsc",
      "protoc",
      "modulemap",
    ].some((keyword) => lower.includes(keyword)) || /^(go|cc|cpp|objc)/.test(lower)
  );
}

function isIOTimingName(name) {
  return [
    "parsetime",
    "fetchtime",
    "queuetime",
    "uploadtime",
    "setuptime",
    "processoutputstime",
    "networktime",
    "downloadtime",
    "cachechecktime",
    "filesystemtime",
    "iotime",
  ].includes(String(name || "").toLowerCase());
}

function sumIOTimingMs(node) {
  if (!node || typeof node !== "object") return 0;
  let total = 0;

  if (isIOTimingName(node.name)) {
    total += parseDurationMs(node.time) || 0;
  }

  if (Array.isArray(node.child)) {
    for (const child of node.child) {
      total += sumIOTimingMs(child);
    }
  }

  return total;
}

function timingBreakdownTotalMs(node) {
  if (!node || typeof node !== "object") return null;
  const explicit = parseDurationMs(node.time);
  if (explicit !== null) return explicit;

  if (Array.isArray(node.child) && node.child.length > 0) {
    let total = 0;
    let hasChild = false;
    for (const child of node.child) {
      const childMs = timingBreakdownTotalMs(child);
      if (childMs !== null) {
        total += childMs;
        hasChild = true;
      }
    }
    return hasChild ? total : null;
  }

  return null;
}

function parseCriticalPathMs(stderr) {
  const text = String(stderr || "");
  const index = text.indexOf("Critical Path:");
  if (index < 0) return null;
  const token = text
    .slice(index + "Critical Path:".length)
    .trim()
    .split(/\s+/)[0];
  return parseDurationMs(token);
}

function inferCommandFromOptionsParsed(optionsParsed) {
  for (const key of ["cmdLine", "explicitCmdLine"]) {
    for (const entry of optionsParsed?.[key] || []) {
      const token = String(entry || "").trim();
      if (["build", "test", "run", "query", "cquery", "aquery", "coverage", "fetch", "info", "clean"].includes(token)) {
        return token;
      }
    }
  }
  return null;
}

function foldTimingBreakdownTotals(node, totals) {
  if (!node || typeof node !== "object") return;
  const name = node.name ? String(node.name) : null;
  const durationMs = parseDurationMs(node.time);
  if (name && durationMs !== null) {
    totals[name] = (totals[name] || 0) + durationMs;
  }
  for (const child of node.child || []) {
    foldTimingBreakdownTotals(child, totals);
  }
}

function buildFindings(summary, slowestTests, topActionMnemonics, timingBreakdownMs) {
  const findings = [];

  if (summary.execution_phase_ms !== null && summary.wall_time_ms !== null && summary.wall_time_ms > 0) {
    if ((summary.execution_phase_ms * 100) / summary.wall_time_ms >= 70) {
      findings.push({
        severity: "high",
        category: "execution",
        message: `Execution dominates wall time: execution phase is ${summary.execution_phase_ms} ms out of ${summary.wall_time_ms} ms wall time.`,
      });
    }
  }

  if (summary.analysis_phase_ms !== null && summary.wall_time_ms !== null && summary.wall_time_ms > 0) {
    if ((summary.analysis_phase_ms * 100) / summary.wall_time_ms >= 30) {
      findings.push({
        severity: "medium",
        category: "analysis",
        message: `Analysis is a visible cost center: analysis phase is ${summary.analysis_phase_ms} ms out of ${summary.wall_time_ms} ms wall time.`,
      });
    }
  }

  if (summary.cache_hit_ratio !== null && summary.cache_hit_ratio !== undefined) {
    if (summary.cache_hit_ratio < 0.6) {
      findings.push({
        severity: "high",
        category: "cache",
        message: `Action cache hit ratio is low at ${(summary.cache_hit_ratio * 100).toFixed(1)}%. Expect unnecessary rebuild work.`,
      });
    } else if (summary.cache_hit_ratio < 0.85) {
      findings.push({
        severity: "medium",
        category: "cache",
        message: `Action cache hit ratio is only ${(summary.cache_hit_ratio * 100).toFixed(1)}%. There is room to reduce repeated execution.`,
      });
    }
  }

  if (summary.critical_path_ms !== null && slowestTests.length > 0 && summary.critical_path_ms > 0) {
    const slowestTest = slowestTests[0];
    if ((slowestTest.duration_ms * 100) / summary.critical_path_ms >= 50) {
      findings.push({
        severity: "medium",
        category: "tests",
        message: `A single test is consuming a large portion of the critical path: ${slowestTest.label} took ${slowestTest.duration_ms} ms, critical path is ${summary.critical_path_ms} ms.`,
      });
    }
  }

  if ((timingBreakdownMs.queueTime || 0) > 0) {
    findings.push({
      severity: "medium",
      category: "remote-execution",
      message: `Observed queueTime in test execution breakdowns: ${timingBreakdownMs.queueTime} ms aggregated. Scheduler pressure may be visible.`,
    });
  }

  if ((timingBreakdownMs.networkTime || 0) > 0) {
    findings.push({
      severity: "low",
      category: "remote-execution",
      message: `Observed networkTime in execution breakdowns: ${timingBreakdownMs.networkTime} ms aggregated.`,
    });
  }

  if (topActionMnemonics.length > 0 && topActionMnemonics[0].span_ms > 0) {
    const action = topActionMnemonics[0];
    findings.push({
      severity: "low",
      category: "actions",
      message: `Longest action mnemonic span is ${action.mnemonic} at ${action.span_ms} ms across ${action.actions_executed} executed actions.`,
    });
  }

  return findings;
}

function isFlakyTest(test) {
  if (!test) return false;
  if (test.status === "FLAKY") return true;
  const attemptCount = toNumber(test.attempt_count);
  const totalRunCount = toNumber(test.total_run_count);
  return (attemptCount !== null && attemptCount > 1) || (totalRunCount !== null && totalRunCount > 1);
}

export function isCompileMnemonicForTimeline(name) {
  return isCompileMnemonic(name);
}

function hashString(value) {
  let hash = 0;
  for (const char of String(value || "")) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }
  return hash;
}

export function mnemonicColor(mnemonic, success) {
  const hue = hashString(mnemonic);
  const saturation = success ? 64 : 72;
  const lightness = success ? 42 : 38;
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

export function summarizeBrowserInsights(input, storedAnalysis = null) {
  const compileItems = [];
  const ioItems = [];
  const testExecutionWallItems = [];
  const slowActions = [];
  const timelineActions = [];
  const timelineItems = [];
  const tests = [];
  const flakyTests = [];
  const flakyAttemptsByLabel = new Map();
  const cacheMissReasons = new Map();
  const hostJvmArgs = new Set();
  const failedTargets = [];
  const runnerCounts = {};
  const testStrategyCounts = {};
  const timingBreakdownMs = {};
  const topActionEntries = [];
  const artifactReferences = [];
  let abortReason = null;
  let abortDescription = null;
  let firstErrorLine = null;
  const storedSummary = storedAnalysis?.summary || {};
  const summary = {
    invocation_id: storedSummary.invocation_id || null,
    invocation_source: storedSummary.invocation_source || null,
    command: storedSummary.command || null,
    command_source: storedSummary.command_source || null,
    bazel_version: storedSummary.bazel_version || null,
    success: storedSummary.success ?? null,
    exit_code: storedSummary.exit_code || null,
    started_at_ms: storedSummary.started_at_ms ?? null,
    finished_at_ms: storedSummary.finished_at_ms ?? null,
    elapsed_ms: storedSummary.elapsed_ms ?? null,
    critical_path_ms: storedSummary.critical_path_ms ?? null,
    wall_time_ms: storedSummary.wall_time_ms ?? null,
    cpu_time_ms: storedSummary.cpu_time_ms ?? null,
    analysis_phase_ms: storedSummary.analysis_phase_ms ?? null,
    execution_phase_ms: storedSummary.execution_phase_ms ?? null,
    configured_targets: 0,
    configured_test_targets: 0,
    completed_targets: 0,
    failed_targets: 0,
    test_summaries: 0,
    failed_tests: 0,
    total_actions: storedSummary.total_actions ?? null,
    remote_cache_hits: storedSummary.remote_cache_hits ?? null,
    action_cache_hits: storedSummary.action_cache_hits ?? null,
    action_cache_misses: storedSummary.action_cache_misses ?? null,
    cache_hit_ratio: storedSummary.cache_hit_ratio ?? null,
  };
  let cacheOverview = null;
  let jvmMetrics = null;
  let timingMetrics = null;
  let networkMetrics = null;
  let invocationWindow = null;
  const workerMetrics = [];
  let timelineItemId = 0;

  function pushArtifactReference(source, file, extra = {}) {
    if (!file || typeof file !== "object") return;
    const uri = typeof file.uri === "string" && file.uri.trim() ? file.uri.trim() : null;
    const name = typeof file.name === "string" && file.name.trim() ? file.name.trim() : null;
    const pathPrefix = Array.isArray(file.pathPrefix) ? file.pathPrefix.filter(Boolean) : [];
    const digest = typeof file.digest === "string" && file.digest ? file.digest : null;
    const symlinkTargetPath =
      typeof file.symlinkTargetPath === "string" && file.symlinkTargetPath
        ? file.symlinkTargetPath
        : null;
    const hasInlineContents = typeof file.contentsBase64 === "string" && file.contentsBase64.length > 0;
    if (!uri && !hasInlineContents && !symlinkTargetPath) return;

    artifactReferences.push({
      source,
      name,
      uri,
      digest,
      path_prefix: pathPrefix,
      symlink_target_path: symlinkTargetPath,
      has_inline_contents: hasInlineContents,
      is_bytestream: typeof uri === "string" && uri.startsWith("bytestream://"),
      ...extra,
    });
  }

  function pushTimelineItem(item) {
    if (item.start_ms === null || item.start_ms === undefined) return;
    timelineItems.push({
      id: item.id || `timeline-${timelineItemId += 1}`,
      ...item,
    });
  }

  for (const rawLine of input.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const envelope = JSON.parse(line);
    const payload = envelope.bazel_event_proto_base64 ? null : envelope;
    const event = payload;
    if (!event) continue;

    const buildMetrics = event.buildMetrics;
    if (buildMetrics && buildMetrics.actionSummary) {
      const actionSummary = buildMetrics.actionSummary;
      const actionCacheStatistics = actionSummary.actionCacheStatistics || {};
      cacheOverview = {
        remote_hits: toNumber(actionSummary.remoteCacheHits),
        action_hits: toNumber(actionCacheStatistics.hits),
        action_misses: toNumber(actionCacheStatistics.misses),
      };
      summary.total_actions = toNumber(actionSummary.actionsExecuted) ?? summary.total_actions;
      summary.remote_cache_hits = cacheOverview.remote_hits;
      summary.action_cache_hits = cacheOverview.action_hits;
      summary.action_cache_misses = cacheOverview.action_misses;

      for (const detail of actionCacheStatistics.missDetails || []) {
        const reason = detail.reason || "UNKNOWN";
        const count = toNumber(detail.count) || 0;
        cacheMissReasons.set(reason, (cacheMissReasons.get(reason) || 0) + count);
      }

      for (const entry of actionSummary.actionData || []) {
        const mnemonic = entry.mnemonic || "unknown";
        const actionsExecuted = toNumber(entry.actionsExecuted) || 0;
        const firstStartedMs = toNumber(entry.firstStartedMs) || 0;
        const lastEndedMs = toNumber(entry.lastEndedMs) || 0;
        const spanMs = Math.max(0, lastEndedMs - firstStartedMs);
        runnerCounts[mnemonic] = runnerCounts[mnemonic] || 0;
        const topActionEntry = {
          mnemonic,
          actions_executed: actionsExecuted,
          span_ms: spanMs,
          user_time_ms: parseDurationMs(entry.userTime),
          system_time_ms: parseDurationMs(entry.systemTime),
        };
        topActionEntries.push(topActionEntry);
        if (!isCompileMnemonic(mnemonic)) continue;
        compileItems.push({
          name: mnemonic,
          actions_executed: actionsExecuted,
          duration_ms: spanMs,
          user_time_ms: topActionEntry.user_time_ms,
          system_time_ms: topActionEntry.system_time_ms,
        });
      }

      for (const entry of actionSummary.runnerCount || []) {
        const name = entry.name || "unknown";
        runnerCounts[name] = toNumber(entry.count) || 0;
      }
    }

    if (buildMetrics && buildMetrics.memoryMetrics) {
      const memoryMetrics = buildMetrics.memoryMetrics;
      jvmMetrics = {
        used_heap_size_post_build: toNumber(memoryMetrics.usedHeapSizePostBuild),
        peak_post_gc_heap_size: toNumber(memoryMetrics.peakPostGcHeapSize),
        peak_post_gc_tenured_space_heap_size: toNumber(memoryMetrics.peakPostGcTenuredSpaceHeapSize),
        garbage_metrics: Array.isArray(memoryMetrics.garbageMetrics) ? memoryMetrics.garbageMetrics : [],
      };
    }

    if (buildMetrics && buildMetrics.timingMetrics) {
      const metrics = buildMetrics.timingMetrics;
      timingMetrics = {
        wall_time_ms: toNumber(metrics.wallTimeInMs),
        cpu_time_ms: toNumber(metrics.cpuTimeInMs),
        analysis_phase_time_ms: toNumber(metrics.analysisPhaseTimeInMs),
        execution_phase_time_ms: toNumber(metrics.executionPhaseTimeInMs),
      };
      summary.wall_time_ms = timingMetrics.wall_time_ms;
      summary.cpu_time_ms = timingMetrics.cpu_time_ms;
      summary.analysis_phase_ms = timingMetrics.analysis_phase_time_ms;
      summary.execution_phase_ms = timingMetrics.execution_phase_time_ms;
    }

    if (buildMetrics && buildMetrics.networkMetrics && buildMetrics.networkMetrics.systemNetworkStats) {
      const stats = buildMetrics.networkMetrics.systemNetworkStats;
      networkMetrics = {
        bytes_sent: toNumber(stats.bytesSent),
        bytes_recv: toNumber(stats.bytesRecv),
        packets_sent: toNumber(stats.packetsSent),
        packets_recv: toNumber(stats.packetsRecv),
        peak_bytes_sent_per_sec: toNumber(stats.peakBytesSentPerSec),
        peak_bytes_recv_per_sec: toNumber(stats.peakBytesRecvPerSec),
        peak_packets_sent_per_sec: toNumber(stats.peakPacketsSentPerSec),
        peak_packets_recv_per_sec: toNumber(stats.peakPacketsRecvPerSec),
      };
    }

    if (buildMetrics && Array.isArray(buildMetrics.workerMetrics)) {
      for (const metric of buildMetrics.workerMetrics) {
        const latestStats = Array.isArray(metric.workerStats) && metric.workerStats.length > 0
          ? metric.workerStats[metric.workerStats.length - 1]
          : null;
        workerMetrics.push({
          mnemonic: metric.mnemonic || "unknown",
          worker_status: metric.workerStatus || "UNKNOWN",
          actions_executed: toNumber(metric.actionsExecuted),
          prior_actions_executed: toNumber(metric.priorActionsExecuted),
          is_multiplex: Boolean(metric.isMultiplex),
          is_sandbox: Boolean(metric.isSandbox),
          worker_memory_kb: latestStats ? toNumber(latestStats.workerMemoryInKb) : null,
          prior_worker_memory_kb: latestStats ? toNumber(latestStats.priorWorkerMemoryInKb) : null,
        });
      }
    }

    if (event.optionsParsed) {
      if (!summary.command) {
        const inferredCommand = inferCommandFromOptionsParsed(event.optionsParsed);
        if (inferredCommand) {
          summary.command = inferredCommand;
          summary.command_source = "optionsParsed.cmdLine";
        }
      }
      for (const option of event.optionsParsed.startupOptions || []) {
        if (String(option).includes("jvm")) {
          hostJvmArgs.add(option);
        }
      }
      for (const option of event.optionsParsed.explicitStartupOptions || []) {
        if (String(option).includes("jvm")) {
          hostJvmArgs.add(option);
        }
      }
    }

    if (event.aborted) {
      if (!abortReason && event.aborted.reason) {
        abortReason = String(event.aborted.reason);
      }
      if (!abortDescription && event.aborted.description) {
        abortDescription = String(event.aborted.description);
      }
    }

    if (event.id && event.id.actionCompleted && event.action) {
      const actionId = event.id.actionCompleted;
      const action = event.action;
      const startTimeMs = toNumber(action.startTimeMillis);
      const endTimeMs = toNumber(action.endTimeMillis);
      const durationMs =
        startTimeMs !== null && endTimeMs !== null ? Math.max(0, endTimeMs - startTimeMs) : null;
      const commandLine = Array.isArray(action.commandLine) ? action.commandLine.filter(Boolean) : [];

      slowActions.push({
        label: actionId.label || "<unknown>",
        mnemonic: action.type || "unknown",
        primary_output:
          action.primaryOutput?.name ||
          action.primaryOutput?.uri ||
          actionId.primaryOutput ||
          "n/a",
        duration_ms: durationMs,
        success: action.success,
        exit_code: toNumber(action.exitCode),
        command_line: commandLine,
        command_preview: commandLine.join(" "),
        failure_detail: action.failureDetail || "",
      });
      if (startTimeMs !== null && endTimeMs !== null) {
        timelineActions.push({
          label: actionId.label || "<unknown>",
          mnemonic: action.type || "unknown",
          start_ms: startTimeMs,
          end_ms: endTimeMs,
          duration_ms: Math.max(0, endTimeMs - startTimeMs),
          success: action.success,
        });
      }
      pushTimelineItem({
        group: "action",
        category: "action",
        start_ms: startTimeMs,
        end_ms: endTimeMs,
        content: action.type || "action",
        title: `${action.type || "action"} · ${actionId.label || "<unknown>"}`,
        detail: actionId.label || "<unknown>",
        failed: action.success === false,
      });
    }

    if (event.started) {
      if (!summary.invocation_id && event.started.uuid) {
        summary.invocation_id = event.started.uuid;
        summary.invocation_source = "started.uuid";
      }
      if (!summary.command && event.started.command) {
        summary.command = event.started.command;
        summary.command_source = "started.command";
      }
      if (!summary.bazel_version && event.started.buildToolVersion) {
        summary.bazel_version = event.started.buildToolVersion;
      }
      const startMs = toNumber(event.started.startTimeMillis);
      if (startMs !== null) {
        invocationWindow = invocationWindow || {};
        invocationWindow.started_at_ms = startMs;
        summary.started_at_ms = startMs;
        pushTimelineItem({
          id: "build-start",
          group: "build",
          category: "build",
          start_ms: startMs,
          content: "build start",
          title: "Build started",
          detail: summary.command || summary.invocation_id || "build",
          failed: false,
          item_type: "point",
        });
      }
    }

    if (event.finished) {
      const endMs = toNumber(event.finished.finishTimeMillis);
      if (endMs !== null) {
        invocationWindow = invocationWindow || {};
        invocationWindow.finished_at_ms = endMs;
        summary.finished_at_ms = endMs;
        pushTimelineItem({
          id: "build-finish",
          group: "build",
          category: "build",
          start_ms: endMs,
          content: "build finish",
          title: "Build finished",
          detail: event.finished.exitCode?.name || "finished",
          failed: event.finished.overallSuccess === false,
          item_type: "point",
        });
      }
      if (event.finished.overallSuccess !== undefined && event.finished.overallSuccess !== null) {
        summary.success = Boolean(event.finished.overallSuccess);
      }
      if (!summary.exit_code && event.finished.exitCode?.name) {
        summary.exit_code = event.finished.exitCode.name;
      }
    }

    if (event.progress?.stderr && summary.critical_path_ms === null) {
      const criticalPathMs = parseCriticalPathMs(event.progress.stderr);
      if (criticalPathMs !== null) {
        summary.critical_path_ms = criticalPathMs;
      }
    }

    if (event.progress?.stderr && !firstErrorLine) {
      const cleaned = stripAnsi(event.progress.stderr);
      const matchedLine = cleaned
        .split("\n")
        .map((entry) => entry.trim())
        .find((entry) => entry.includes("ERROR:") || entry.includes("WARNING:"));
      if (matchedLine) {
        firstErrorLine = matchedLine;
      }
    }

    if (event.id?.targetConfigured && event.configured) {
      summary.configured_targets += 1;
      if (event.configured.testSize) {
        summary.configured_test_targets += 1;
      }
    }

    if (event.id?.targetCompleted) {
      summary.completed_targets += 1;
      const label = event.id.targetCompleted.label || "<unknown>";
      const completedSuccess = event.completed?.success;
      const abortedReason = event.aborted?.reason;
      if (completedSuccess === false || abortedReason) {
        if (failedTargets.length < 20) {
          failedTargets.push(label);
        }
      }
      for (const file of event.completed?.importantOutput || []) {
        pushArtifactReference("importantOutput", file, { label });
      }
      for (const file of event.completed?.directoryOutput || []) {
        pushArtifactReference("directoryOutput", file, { label });
      }
      for (const outputGroup of event.completed?.outputGroup || []) {
        for (const file of outputGroup.inlineFiles || []) {
          pushArtifactReference("outputGroup.inlineFiles", file, {
            label,
            output_group: outputGroup.name || "unknown",
            incomplete: outputGroup.incomplete === true,
          });
        }
      }
    }

    if (event.id?.namedSet && event.namedSetOfFiles) {
      const namedSetId = event.id.namedSet.id || "<unnamed>";
      for (const file of event.namedSetOfFiles.files || []) {
        pushArtifactReference("namedSetOfFiles", file, { named_set_id: namedSetId });
      }
    }

    if (event.id?.buildToolLogs && event.buildToolLogs) {
      for (const file of event.buildToolLogs.log || []) {
        pushArtifactReference("buildToolLogs", file);
      }
    }

    if (event.id && event.id.testSummary && event.testSummary) {
      const testSummary = event.testSummary;
      const test = {
        label: event.id.testSummary.label || "<unknown>",
        status: testSummary.overallStatus || "UNKNOWN",
        duration_ms:
          toNumber(testSummary.totalRunDurationMillis) ??
          toNumber(testSummary.totalRunDurationInMs) ??
          parseDurationMs(testSummary.totalRunDuration) ??
          0,
        cached:
          testSummary.totalNumCached === null || testSummary.totalNumCached === undefined
            ? null
            : Number(testSummary.totalNumCached) > 0,
        attempt_count: toNumber(testSummary.attemptCount),
        run_count: toNumber(testSummary.runCount),
        total_run_count: toNumber(testSummary.totalRunCount),
      };

      tests.push(test);
      summary.test_summaries += 1;
      if (test.status !== "PASSED" && test.status !== "FLAKY") {
        summary.failed_tests += 1;
      }
      if (isFlakyTest(test)) {
        flakyTests.push(test);
      }
    }

    if (event.id && event.id.testResult && event.testResult) {
      const testId = event.id.testResult;
      const testResult = event.testResult;
      const timingBreakdown = testResult.executionInfo?.timingBreakdown;
      const ioMs = sumIOTimingMs(timingBreakdown);
      const executionWallMs = timingBreakdownTotalMs(timingBreakdown);
      const label = testId.label || "<unknown>";
      const attemptStartMs =
        toNumber(testResult.testAttemptStartMillisEpoch) ??
        toNumber(testResult.testAttemptStartMillis) ??
        null;
      const attemptDurationMs =
        toNumber(testResult.testAttemptDurationMillis) ??
        parseDurationMs(testResult.testAttemptDuration) ??
        executionWallMs;
      ioItems.push({
        name: label,
        duration_ms: ioMs,
        strategy: testResult.executionInfo?.strategy || "n/a",
        status: testResult.status || "UNKNOWN",
      });
      testExecutionWallItems.push({
        name: label,
        duration_ms: executionWallMs,
        strategy: testResult.executionInfo?.strategy || "n/a",
        status: testResult.status || "UNKNOWN",
      });
      pushTimelineItem({
        group: "test",
        category: "test",
        start_ms: attemptStartMs,
        end_ms:
          attemptStartMs !== null && attemptDurationMs !== null
            ? attemptStartMs + Math.max(0, attemptDurationMs)
            : null,
        content: label,
        title: `${label} · attempt ${toNumber(testId.attempt) ?? "n/a"} · ${testResult.status || "UNKNOWN"}`,
        detail: testResult.executionInfo?.strategy || "test",
        failed: (testResult.status || "UNKNOWN") !== "PASSED",
      });
      if (testResult.executionInfo?.strategy) {
        testStrategyCounts[testResult.executionInfo.strategy] =
          (testStrategyCounts[testResult.executionInfo.strategy] || 0) + 1;
      }
      foldTimingBreakdownTotals(timingBreakdown, timingBreakdownMs);
      const attempts = flakyAttemptsByLabel.get(label) || [];
      for (const file of testResult.testActionOutput || []) {
        pushArtifactReference("testActionOutput", file, {
          label,
          run: toNumber(testId.run),
          shard: toNumber(testId.shard),
          attempt: toNumber(testId.attempt),
          status: testResult.status || "UNKNOWN",
        });
      }
      attempts.push({
        label,
        run: toNumber(testId.run),
        shard: toNumber(testId.shard),
        attempt: toNumber(testId.attempt),
        status: testResult.status || "UNKNOWN",
        status_details: testResult.statusDetails || "",
        strategy: testResult.executionInfo?.strategy || "n/a",
        execution_wall_ms: executionWallMs,
        io_ms: ioMs,
        outputs: Array.isArray(testResult.testActionOutput) ? testResult.testActionOutput : [],
      });
      flakyAttemptsByLabel.set(label, attempts);
    }

    if (event.id?.actionCompleted && event.action) {
      const label = event.id.actionCompleted.label || "<unknown>";
      if (event.action.primaryOutput) {
        pushArtifactReference("action.primaryOutput", event.action.primaryOutput, {
          label,
          mnemonic: event.action.type || "action",
        });
      }
      if (event.action.stdout) {
        pushArtifactReference("action.stdout", event.action.stdout, {
          label,
          mnemonic: event.action.type || "action",
        });
      }
      if (event.action.stderr) {
        pushArtifactReference("action.stderr", event.action.stderr, {
          label,
          mnemonic: event.action.type || "action",
        });
      }
    }
  }

  compileItems.sort((left, right) => right.duration_ms - left.duration_ms);
  ioItems.sort((left, right) => right.duration_ms - left.duration_ms);
  testExecutionWallItems.sort((left, right) => (right.duration_ms ?? -1) - (left.duration_ms ?? -1));
  slowActions.sort((left, right) => (right.duration_ms ?? -1) - (left.duration_ms ?? -1));
  tests.sort((left, right) => right.duration_ms - left.duration_ms);
  flakyTests.sort((left, right) => right.duration_ms - left.duration_ms);
  const topActionMnemonics = topActionEntries
    .sort((left, right) => right.span_ms - left.span_ms)
    .slice(0, 8);

  if (summary.started_at_ms !== null && summary.finished_at_ms !== null && summary.finished_at_ms >= summary.started_at_ms) {
    summary.elapsed_ms = summary.finished_at_ms - summary.started_at_ms;
  }
  if (summary.action_cache_hits !== null && summary.action_cache_misses !== null) {
    const totalCacheEvents = summary.action_cache_hits + summary.action_cache_misses;
    if (totalCacheEvents > 0) {
      summary.cache_hit_ratio = summary.action_cache_hits / totalCacheEvents;
    }
  }
  if (cacheOverview) {
    const totalCacheEvents = (cacheOverview.action_hits || 0) + (cacheOverview.action_misses || 0);
    if (totalCacheEvents > 0) {
      summary.cache_hit_ratio = (cacheOverview.action_hits || 0) / totalCacheEvents;
    }
  }
  summary.failed_targets = failedTargets.length;
  if (summary.success === null && abortReason) {
    summary.success = false;
  }

  const findings = buildFindings(summary, tests.slice(0, 10), topActionMnemonics, timingBreakdownMs);
  if (abortReason) {
    findings.unshift({
      severity: "high",
      category: "abort",
      message: abortDescription
        ? `Build aborted before completion: ${abortReason}. ${abortDescription}`
        : `Build aborted before completion: ${abortReason}.`,
    });
  }
  if (firstErrorLine) {
    findings.unshift({
      severity: "high",
      category: "startup",
      message: firstErrorLine,
    });
  }

  if (summary.started_at_ms !== null) {
    if (summary.analysis_phase_ms !== null && summary.analysis_phase_ms > 0) {
      pushTimelineItem({
        id: "build-analysis-phase",
        group: "build",
        category: "build",
        start_ms: summary.started_at_ms,
        end_ms: summary.started_at_ms + summary.analysis_phase_ms,
        content: "analysis",
        title: "Analysis phase",
        detail: `${summary.analysis_phase_ms} ms`,
        failed: false,
      });
    }

    if (summary.execution_phase_ms !== null && summary.execution_phase_ms > 0) {
      const executionStartMs =
        summary.analysis_phase_ms !== null
          ? summary.started_at_ms + summary.analysis_phase_ms
          : summary.started_at_ms;
      pushTimelineItem({
        id: "build-execution-phase",
        group: "build",
        category: "build",
        start_ms: executionStartMs,
        end_ms: executionStartMs + summary.execution_phase_ms,
        content: "execution",
        title: "Execution phase",
        detail: `${summary.execution_phase_ms} ms`,
        failed: false,
      });
    }
  }

  if (summary.finished_at_ms !== null && summary.critical_path_ms !== null && summary.critical_path_ms > 0) {
    pushTimelineItem({
      id: "build-critical-path",
      group: "build",
      category: "build",
      start_ms: Math.max(0, summary.finished_at_ms - summary.critical_path_ms),
      end_ms: summary.finished_at_ms,
      content: "critical path",
      title: "Critical path hint",
      detail: `${summary.critical_path_ms} ms`,
      failed: summary.success === false,
    });
  }

  if (invocationWindow?.started_at_ms !== undefined && invocationWindow?.finished_at_ms !== undefined) {
    timelineItems.unshift({
      id: "build-span",
      group: "build",
      category: "build",
      start_ms: invocationWindow.started_at_ms,
      end_ms: invocationWindow.finished_at_ms,
      content: "",
      title: "Build span",
      detail: summary.command || summary.invocation_id || "build",
      failed: summary.success === false,
      item_type: "background",
    });
  }

  return {
    analysis: {
      summary,
      slowest_tests: tests.slice(0, 10),
      failed_targets: failedTargets,
      top_action_mnemonics: topActionMnemonics,
      runner_counts: runnerCounts,
      test_strategy_counts: testStrategyCounts,
      timing_breakdown_ms: timingBreakdownMs,
      findings,
    },
    cacheOverview,
    hostJvmArgs: Array.from(hostJvmArgs),
    jvmMetrics,
    timingMetrics,
    networkMetrics,
    invocationWindow,
    timelineItems: timelineItems
      .filter((item) => item.start_ms !== null && item.start_ms !== undefined)
      .sort((left, right) => left.start_ms - right.start_ms || ((right.end_ms ?? right.start_ms) - (left.end_ms ?? left.start_ms))),
    timelineActions: timelineActions
      .sort((left, right) => left.start_ms - right.start_ms || right.duration_ms - left.duration_ms),
    workerMetrics: workerMetrics
      .sort((left, right) => (right.worker_memory_kb ?? -1) - (left.worker_memory_kb ?? -1))
      .slice(0, 10),
    cacheMissReasons: Array.from(cacheMissReasons.entries()).sort((left, right) => right[1] - left[1]),
    topCompileItems: compileItems.slice(0, 10),
    topIoItems: ioItems.filter((item) => item.duration_ms > 0).slice(0, 10),
    topTestExecutionWallItems: testExecutionWallItems.filter((item) => item.duration_ms !== null).slice(0, 10),
    slowActions: slowActions.filter((item) => item.duration_ms !== null).slice(0, 10),
    topTests: tests.slice(0, 10),
    flakyTests: flakyTests.slice(0, 10),
    flakyAttemptsByLabel,
    artifactReferences: artifactReferences
      .sort((left, right) => {
        if (left.is_bytestream !== right.is_bytestream) return left.is_bytestream ? -1 : 1;
        return String(left.source || "").localeCompare(String(right.source || ""));
      })
      .slice(0, 80),
  };
}
