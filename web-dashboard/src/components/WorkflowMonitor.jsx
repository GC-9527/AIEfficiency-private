import React, { useState, useEffect, useRef } from "react";
import { createGatewayWebSocket, getApiUrl } from "../services/gateway.js";
import WorkflowCanvas from "./workflow/WorkflowCanvas.jsx";
import { stepsToFlow } from "./workflow/workflowUtils.js";
import { authenticatedFetch } from "../services/adminAuth.js";

export default function WorkflowMonitor({ runId, onBack }) {
  const [run, setRun] = useState(null);
  const [stepStates, setStepStates] = useState({});
  const [roleStates, setRoleStates] = useState({});
  const [workflowSteps, setWorkflowSteps] = useState([]);
  const wsRef = useRef(null);

  // Load run details
  useEffect(() => {
    if (!runId) return;
    authenticatedFetch(getApiUrl(`/api/workflow-runs/${runId}`))
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setRun(d.data);
          try { setStepStates(JSON.parse(d.data.step_states || "{}")); } catch {}
          try { setRoleStates(JSON.parse(d.data.role_states || "{}")); } catch {}
        }
      })
      .catch(() => {});
  }, [runId]);

  // Load workflow definition
  useEffect(() => {
    if (!run?.workflow_id) return;
    authenticatedFetch(getApiUrl(`/api/workflows/${run.workflow_id}`))
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          try {
            const steps = typeof d.data.steps === "string" ? JSON.parse(d.data.steps) : d.data.steps;
            setWorkflowSteps(steps);
          } catch {}
        }
      })
      .catch(() => {});
  }, [run?.workflow_id]);

  // WebSocket for real-time updates
  useEffect(() => {
    if (!runId) return;
    const ws = createGatewayWebSocket();
    wsRef.current = ws;

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "workflow_update" && msg.data.runId === runId) {
        const d = msg.data;
        if (d.stepStates) setStepStates(d.stepStates);
        if (d.status) setRun((prev) => prev ? { ...prev, status: d.status } : prev);
      }
    };

    return () => ws.close();
  }, [runId]);

  async function handleAbort() {
    await authenticatedFetch(getApiUrl(`/api/workflow-runs/${runId}/abort`), { method: "POST" });
  }

  if (!run || workflowSteps.length === 0) {
    return <div className="p-6 text-center text-sm text-zinc-500">加载中...</div>;
  }

  const { nodes, edges } = stepsToFlow(workflowSteps, stepStates, roleStates);

  return (
    <div className="h-[calc(100vh-10rem)]">
      <WorkflowCanvas
        mode="monitor"
        initialNodes={nodes}
        initialEdges={edges}
        name={run.workflow_name || "工作流运行"}
        runStatus={run.status}
        onCancel={onBack}
        onAbort={handleAbort}
      />
    </div>
  );
}
