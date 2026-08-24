import React, { lazy } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, HashRouter, Routes, Route, Navigate } from "react-router-dom";
import App from "./App.jsx";

import "./index.css";

const Skills = lazy(() => import("./pages/Skills.jsx"));
const Agents = lazy(() => import("./pages/Agents.jsx"));
const Tokens = lazy(() => import("./pages/Tokens.jsx"));
const Logs = lazy(() => import("./pages/Logs.jsx"));
const Settings = lazy(() => import("./pages/Settings.jsx"));
const Devices = lazy(() => import("./pages/Devices.jsx"));
const Schedule = lazy(() => import("./pages/Schedule.jsx"));
const TbTasks = lazy(() => import("./pages/TbTasks.jsx"));
const FeishuProjectSync = lazy(() => import("./pages/FeishuProjectSync.jsx"));
const BugAnalysis = lazy(() => import("./pages/BugAnalysis.jsx"));
const CarDev = lazy(() => import("./pages/cardev/index.jsx"));
// DevBench 改由 App.jsx 控制 keep-alive 挂载（main.jsx 不再实例化路由元素）。
const WebNavDev = lazy(() => import("./pages/WebNavDev.jsx"));
const ProjectDev = lazy(() => import("./pages/projectdev/index.jsx"));
const Performance = lazy(() => import("./pages/Performance.jsx"));
const preloadAdminPlatform = () => import("./pages/AdminPlatform.jsx");
const AdminPlatform = lazy(preloadAdminPlatform);
const AiAutowork = lazy(() => import("./pages/aiautowork/index.jsx"));
const HelpCenter = lazy(() => import("./pages/help/index.jsx"));
const FeedbackNew = lazy(() => import("./pages/help/FeedbackNew.jsx"));
const FeedbackDetailPage = lazy(() => import("./pages/help/FeedbackDetailPage.jsx"));

const isFileProtocol = window.location.protocol === "file:";
const Router = isFileProtocol ? HashRouter : BrowserRouter;

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Router>
      <Routes>
          <Route path="/" element={<App />}>
            {/* 默认进工程开发：避免用户每次打开首页都先看到 chat（chat 入口已不在侧栏白名单）。
                用户仍可通过 URL 直达 /chat；chat 路由保留 keep-alive 模式以不卸载 React state。 */}
            <Route index element={<Navigate to="/devbench" replace />} />
            <Route path="chat" element={null} />
            <Route path="skills" element={<Skills />} />
            <Route path="agents" element={<Agents />} />
            <Route path="tokens" element={<Tokens />} />
            <Route path="logs" element={<Logs />} />
            <Route path="devices" element={<Devices />} />
            <Route path="schedule" element={<Schedule />} />
            <Route path="tb-tasks" element={<TbTasks />} />
            <Route path="feishu-project-sync" element={<FeishuProjectSync />} />
            <Route path="bug-agent" element={<BugAnalysis />} />
            <Route path="cardev" element={<CarDev />} />
            {/* devbench 走 keep-alive：由 App.jsx 控制挂载与可见性，避免切走时丢失 tabs/liveMap 等状态。
                路由表 element=null，使 React Router 不再为 /devbench 实例化 Outlet 元素。 */}
            <Route path="devbench" element={null} />
            <Route path="web-nav-dev" element={<WebNavDev />} />
            <Route path="project-dev" element={<ProjectDev />} />
            <Route path="help" element={<HelpCenter />} />
            <Route path="feedback/new" element={<FeedbackNew />} />
            <Route path="feedback/:id" element={<FeedbackDetailPage />} />
            <Route path="performance" element={<Performance />} />
            <Route path="admin" element={<AdminPlatform />} />
            <Route path="aiautowork/*" element={<AiAutowork />} />
            <Route path="settings" element={<Settings />} />
          </Route>
      </Routes>
    </Router>
  </React.StrictMode>
);
