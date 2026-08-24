import React, { useState } from "react";
import Markdown from "./Markdown.jsx";

export default function Transcript({ transcript }) {
  const [expanded, setExpanded] = useState(false);
  if (!Array.isArray(transcript) || transcript.length === 0) return null;

  const stats = transcript.reduce(
    (acc, b) => {
      acc[b.type] = (acc[b.type] || 0) + 1;
      return acc;
    },
    {}
  );

  return (
    <div className="mt-2 border-t border-zinc-700/50 pt-2">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition"
      >
        <span>&#x1F4AD;</span>
        <span>思考轨迹</span>
        <span className="text-zinc-600">
          {stats.thinking ? `${stats.thinking} 思考 · ` : ""}
          {stats.tool_use ? `${stats.tool_use} 工具 · ` : ""}
          {stats.text ? `${stats.text} 回复` : ""}
        </span>
        <svg
          className={`w-3 h-3 transition-transform ${expanded ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="mt-2 space-y-2 bg-zinc-900/60 border border-zinc-700/50 rounded-lg p-3 max-h-96 overflow-y-auto">
          {transcript.map((block, i) => (
            <TranscriptBlock key={i} block={block} />
          ))}
        </div>
      )}
    </div>
  );
}

function TranscriptBlock({ block }) {
  if (block.type === "thinking") {
    return (
      <div className="border-l-2 border-purple-500/40 pl-2.5">
        <div className="text-[10px] uppercase tracking-wider text-purple-400/70 mb-0.5">Thinking</div>
        <pre className="whitespace-pre-wrap text-xs text-zinc-400 italic leading-relaxed">{block.content}</pre>
      </div>
    );
  }
  if (block.type === "tool_use") {
    return (
      <div className="border-l-2 border-amber-500/40 pl-2.5">
        <div className="text-[10px] uppercase tracking-wider text-amber-400/70 mb-0.5">Tool</div>
        <div className="flex items-center gap-1.5 text-xs">
          <span className="font-mono text-amber-300">&#x1F527; {block.content}</span>
        </div>
        {block.input && (
          <pre className="mt-1 whitespace-pre-wrap text-[11px] text-zinc-500 bg-zinc-950/60 rounded px-2 py-1 font-mono">{block.input}</pre>
        )}
      </div>
    );
  }
  if (block.type === "text") {
    return (
      <div className="border-l-2 border-blue-500/40 pl-2.5">
        <div className="text-[10px] uppercase tracking-wider text-blue-400/70 mb-0.5">Response</div>
        <div className="text-xs text-zinc-300">
          <Markdown>{block.content}</Markdown>
        </div>
      </div>
    );
  }
  return null;
}
