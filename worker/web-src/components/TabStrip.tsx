import { useAppStore } from "../app/store";
import { activateTab } from "../controller";

const tabs = [
  ["summary", "Summary"],
  ["timeline", "Timeline"],
  ["runtime", "Runtime"],
  ["hotspots", "Hotspots"],
  ["execution", "Execution"],
] as const;

export function TabStrip() {
  const { activeTab } = useAppStore();

  return (
    <section className="tab-strip panel">
      {tabs.map(([key, label]) => (
        <button
          key={key}
          className={`tab-button${activeTab === key ? " tab-button-active" : ""}`}
          data-tab={key}
          type="button"
          onClick={() => activateTab(key)}
        >
          {label}
        </button>
      ))}
    </section>
  );
}
