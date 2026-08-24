import React, { useState, useEffect } from "react";
import { getApiUrl } from "../services/gateway.js";

export default function Tokens() {
  const [summary, setSummary] = useState([]);
  const [daily, setDaily] = useState([]);
  const [days, setDays] = useState(7);

  useEffect(() => {
    fetch(getApiUrl(`/api/tokens?days=${days}`))
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setSummary(d.data.summary);
          setDaily(d.data.daily);
        }
      })
      .catch(() => {});
  }, [days]);

  const totalInput = summary.reduce((s, r) => s + (r.total_input || 0), 0);
  const totalOutput = summary.reduce((s, r) => s + (r.total_output || 0), 0);
  const totalCalls = summary.reduce((s, r) => s + (r.call_count || 0), 0);

  // 按天聚合（合并引擎）
  const dateMap = {};
  for (const row of daily) {
    if (!dateMap[row.date]) dateMap[row.date] = { date: row.date, input: 0, output: 0, calls: 0, engines: {} };
    dateMap[row.date].input += row.input_tokens || 0;
    dateMap[row.date].output += row.output_tokens || 0;
    dateMap[row.date].calls += row.calls || 0;
    dateMap[row.date].engines[row.engine] = (dateMap[row.date].engines[row.engine] || 0) + row.calls;
  }
  const dailyData = Object.values(dateMap);
  const maxTokens = Math.max(...dailyData.map((d) => d.input + d.output), 1);

  return (
    <div className="p-6 overflow-y-auto h-full space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-300">Token 用量</h2>
        <select
          value={days}
          onChange={(e) => setDays(parseInt(e.target.value))}
          className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-zinc-300"
        >
          <option value={7}>近 7 天</option>
          <option value={14}>近 14 天</option>
          <option value={30}>近 30 天</option>
        </select>
      </div>

      {/* 汇总卡片 */}
      <div className="grid grid-cols-4 gap-4">
        <SummaryCard label="总调用次数" value={totalCalls.toLocaleString()} color="blue" />
        <SummaryCard label="输入 Tokens" value={formatNum(totalInput)} sub="估算值" color="violet" />
        <SummaryCard label="输出 Tokens" value={formatNum(totalOutput)} sub="估算值" color="cyan" />
        <SummaryCard label="总计 Tokens" value={formatNum(totalInput + totalOutput)} color="amber" />
      </div>

      {/* 引擎分布 */}
      <div className="grid grid-cols-2 gap-4">
        {summary.map((row) => (
          <div key={row.engine} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-zinc-200">{row.engine === "claude" ? "Claude Code" : "Gemini CLI"}</span>
              <span className="text-xs text-zinc-500">{row.call_count} 次调用</span>
            </div>
            <div className="space-y-2">
              <TokenBar label="输入" value={row.total_input || 0} max={Math.max(totalInput, totalOutput, 1)} color="bg-violet-500" />
              <TokenBar label="输出" value={row.total_output || 0} max={Math.max(totalInput, totalOutput, 1)} color="bg-cyan-500" />
            </div>
          </div>
        ))}
        {summary.length === 0 && (
          <div className="col-span-2 bg-zinc-900 border border-zinc-800 rounded-xl p-8 text-center text-sm text-zinc-600">
            暂无用量数据
          </div>
        )}
      </div>

      {/* 每日趋势 */}
      <div>
        <h3 className="text-sm font-medium text-zinc-300 mb-3">每日趋势</h3>
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          {dailyData.length === 0 ? (
            <div className="text-center text-sm text-zinc-600 py-8">暂无数据</div>
          ) : (
            <div className="space-y-2">
              {dailyData.map((day) => (
                <div key={day.date} className="flex items-center space-x-3">
                  <span className="text-xs text-zinc-500 w-20 shrink-0">{day.date.slice(5)}</span>
                  <div className="flex-1 flex items-center space-x-1 h-5">
                    <div
                      className="h-full bg-violet-500/60 rounded-l"
                      style={{ width: `${(day.input / maxTokens) * 100}%`, minWidth: day.input ? 2 : 0 }}
                      title={`输入: ${day.input}`}
                    />
                    <div
                      className="h-full bg-cyan-500/60 rounded-r"
                      style={{ width: `${(day.output / maxTokens) * 100}%`, minWidth: day.output ? 2 : 0 }}
                      title={`输出: ${day.output}`}
                    />
                  </div>
                  <span className="text-xs text-zinc-600 w-16 text-right shrink-0">{formatNum(day.input + day.output)}</span>
                  <span className="text-xs text-zinc-700 w-12 text-right shrink-0">{day.calls}次</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center space-x-4 mt-3 pt-3 border-t border-zinc-800">
            <span className="flex items-center text-xs text-zinc-500"><span className="w-3 h-2 bg-violet-500/60 rounded mr-1" /> 输入</span>
            <span className="flex items-center text-xs text-zinc-500"><span className="w-3 h-2 bg-cyan-500/60 rounded mr-1" /> 输出</span>
            <span className="text-xs text-zinc-600 ml-auto">Token 数据为估算值</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, sub, color }) {
  const colors = {
    blue: "from-blue-500/10 to-blue-600/5 text-blue-400",
    violet: "from-violet-500/10 to-violet-600/5 text-violet-400",
    cyan: "from-cyan-500/10 to-cyan-600/5 text-cyan-400",
    amber: "from-amber-500/10 to-amber-600/5 text-amber-400",
  };
  return (
    <div className={`bg-gradient-to-br ${colors[color]} rounded-xl p-4 border border-zinc-800`}>
      <p className="text-xs opacity-60">{label}</p>
      <p className="text-xl font-bold mt-1">{value}</p>
      {sub && <p className="text-xs opacity-40 mt-0.5">{sub}</p>}
    </div>
  );
}

function TokenBar({ label, value, max, color }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="flex items-center space-x-2">
      <span className="text-xs text-zinc-500 w-6">{label}</span>
      <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-zinc-500 w-14 text-right">{formatNum(value)}</span>
    </div>
  );
}

function formatNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}
