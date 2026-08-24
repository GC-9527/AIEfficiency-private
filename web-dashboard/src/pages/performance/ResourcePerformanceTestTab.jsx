import React from "react";
import { ResourceRunWorkspace } from "./ResourcePerformanceTab.jsx";

export default function ResourcePerformanceTestTab(props) {
  return <ResourceRunWorkspace {...props} mode="test" />;
}
