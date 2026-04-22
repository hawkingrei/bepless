import { useEffect } from "react";
import { ExecutionTab } from "./components/ExecutionTab";
import { HeroSection } from "./components/HeroSection";
import { HotspotsTab } from "./components/HotspotsTab";
import { RuntimeTab } from "./components/RuntimeTab";
import { SelectedReviewSection } from "./components/SelectedReviewSection";
import { SidebarReviews } from "./components/SidebarReviews";
import { SummaryTab } from "./components/SummaryTab";
import { TabStrip } from "./components/TabStrip";
import { TimelineTab } from "./components/TimelineTab";
import { bootstrapApp } from "./controller";

export function App() {
  useEffect(() => {
    void bootstrapApp();
  }, []);

  return (
    <main>
      <div className="shell">
        <div className="layout">
          <div className="content-column">
            <HeroSection />
            <SelectedReviewSection />
            <TabStrip />
            <SummaryTab />
            <TimelineTab />
            <RuntimeTab />
            <HotspotsTab />
            <ExecutionTab />
          </div>
          <SidebarReviews />
        </div>
      </div>
    </main>
  );
}
