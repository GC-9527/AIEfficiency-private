import React, { useState } from "react";
import { useLocation } from "react-router-dom";
import TutorialWiki from "./TutorialWiki.jsx";
import Feedback from "./Feedback.jsx";

// 帮助中心：教程（Wiki）+ 反馈（类简约 TB 单）
export default function HelpCenter() {
  const loc = useLocation();
  const initTab = new URLSearchParams(loc.search).get("tab") === "feedback" ? "feedback" : "tutorial";
  const [tab, setTab] = useState(initTab);

  const TabBtn = ({ id, label }) => (
    <button onClick={() => setTab(id)}
      className={`px-3.5 py-1.5 text-sm rounded-lg transition ${tab === id ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"}`}>{label}</button>
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-800 shrink-0">
        <h2 className="text-sm font-medium text-zinc-300 mr-2">帮助中心</h2>
        <TabBtn id="tutorial" label="📚 教程" />
        <TabBtn id="feedback" label="🐞 反馈" />
      </div>
      <div className="flex-1 overflow-hidden">
        {tab === "tutorial" ? <TutorialWiki /> : <Feedback />}
      </div>
    </div>
  );
}
