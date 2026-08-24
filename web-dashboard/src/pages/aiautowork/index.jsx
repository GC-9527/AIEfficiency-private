// AI 工作台 — 路由根 + 子路由分发。
// /aiautowork → 工作概览
// /aiautowork/batches → 批次列表
// /aiautowork/batches/:id → 批次详情
// /aiautowork/confirmations → 配置待确认
// /aiautowork/settings → 工作台设置

import React, { Suspense, lazy } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./Layout.jsx";

const Overview = lazy(() => import("./Overview.jsx"));
const Batches = lazy(() => import("./Batches.jsx"));
const BatchDetail = lazy(() => import("./BatchDetail.jsx"));
const Confirmations = lazy(() => import("./Confirmations.jsx"));
const Acceptance = lazy(() => import("./Acceptance.jsx"));
const Settings = lazy(() => import("./Settings.jsx"));

const subFallback = (
  <div className="flex h-full items-center justify-center text-sm text-zinc-500">正在加载...</div>
);

export default function AiautoworkRoot() {
  return (
    <Layout>
      <Suspense fallback={subFallback}>
        <Routes>
          <Route index element={<Overview />} />
          <Route path="batches" element={<Batches />} />
          <Route path="batches/:id" element={<BatchDetail />} />
          <Route path="confirmations" element={<Confirmations />} />
          <Route path="acceptance" element={<Acceptance />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="" replace />} />
        </Routes>
      </Suspense>
    </Layout>
  );
}
