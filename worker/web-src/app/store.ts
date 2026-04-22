import { useSyncExternalStore } from "react";

export type HistoryItem = {
  id: number;
  label: string;
  status: string;
  uploadedAtText: string;
  criticalText: string;
  wallText: string;
  active: boolean;
};

type AppStoreState = {
  activeTab: string;
  statusText: string;
  historyItems: HistoryItem[];
  currentReviewId: number | null;
  analysisPayload: any | null;
  browserInsights: any | null;
  activeFlakyLabel: string | null;
  activeTimelineFilter: string;
  timelineRowLimit: number;
  reviewMessage: string | null;
};

let state: AppStoreState = {
  activeTab: "summary",
  statusText: "Loading uploaded reviews...",
  historyItems: [],
  currentReviewId: null,
  analysisPayload: null,
  browserInsights: null,
  activeFlakyLabel: null,
  activeTimelineFilter: "all",
  timelineRowLimit: 48,
  reviewMessage: null,
};

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

export function getAppStoreState() {
  return state;
}

export function setAppStoreState(patch: Partial<AppStoreState>) {
  state = { ...state, ...patch };
  emit();
}

export function subscribeAppStore(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppStore() {
  return useSyncExternalStore(subscribeAppStore, getAppStoreState, getAppStoreState);
}
