import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./workflow-canvas.css";
import StepNode from "./StepNode.jsx";
import NodeConfigPanel from "./NodeConfigPanel.jsx";
import CanvasToolbar from "./CanvasToolbar.jsx";
import { autoLayout, wouldCreateCycle, createNewStep } from "./workflowUtils.js";

const nodeTypes = { stepNode: StepNode };

function CanvasInner({
  mode,
  initialNodes,
  initialEdges,
  name: initName,
  description: initDesc,
  skills,
  runStatus,
  saving,
  onSave,
  onCancel,
  onAbort,
  error,
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [selectedNode, setSelectedNode] = useState(null);
  const [name, setName] = useState(initName || "");
  const [description, setDescription] = useState(initDesc || "");
  const { fitView } = useReactFlow();
  const isEdit = mode === "edit";
  const initDone = useRef(false);

  // Sync initialNodes/initialEdges when they change (monitor mode WebSocket updates)
  useEffect(() => {
    if (mode === "monitor" || !initDone.current) {
      setNodes(initialNodes);
      setEdges(initialEdges);
      initDone.current = true;
    }
  }, [initialNodes, initialEdges, mode, setNodes, setEdges]);

  // Fit view after initial render
  useEffect(() => {
    const timer = setTimeout(() => fitView({ padding: 0.2 }), 100);
    return () => clearTimeout(timer);
  }, [fitView]);

  const onConnect = useCallback(
    (connection) => {
      if (!isEdit) return;
      if (wouldCreateCycle(edges, { source: connection.source, target: connection.target })) {
        return; // block cycles
      }
      setEdges((eds) =>
        addEdge({ ...connection, type: "default", style: { stroke: "#52525b", strokeWidth: 1.5 } }, eds)
      );
    },
    [edges, isEdit, setEdges]
  );

  const onNodeClick = useCallback((_, node) => {
    setSelectedNode(node);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  function handleNodeConfigChange(updatedNode) {
    setNodes((nds) =>
      nds.map((n) => (n.id === updatedNode.id ? { ...n, data: updatedNode.data } : n))
    );
    setSelectedNode(updatedNode);
  }

  function handleAddStep() {
    const newStep = createNewStep();
    const newNode = {
      id: newStep.id,
      type: "stepNode",
      position: { x: 100 + Math.random() * 200, y: 100 + nodes.length * 150 },
      data: { ...newStep, status: "idle" },
    };
    setNodes((nds) => [...nds, newNode]);
  }

  function handleAutoLayout() {
    const { nodes: laid, edges: laidEdges } = autoLayout(nodes, edges);
    setNodes(laid);
    setEdges(laidEdges);
    setTimeout(() => fitView({ padding: 0.2 }), 50);
  }

  function handleSave() {
    onSave?.({ name, description, nodes, edges });
  }

  function handleFitView() {
    fitView({ padding: 0.2 });
  }

  // Delete selected nodes/edges with Delete key (edit mode only)
  const onKeyDown = useCallback(
    (e) => {
      if (!isEdit) return;
      // Skip when focus is on an input/textarea/select element
      const tag = e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        setNodes((nds) => {
          const selected = nds.filter((n) => n.selected).map((n) => n.id);
          if (selected.length === 0) return nds;
          setEdges((eds) =>
            eds.filter((e) => !selected.includes(e.source) && !selected.includes(e.target))
          );
          if (selectedNode && selected.includes(selectedNode.id)) setSelectedNode(null);
          return nds.filter((n) => !n.selected);
        });
        setEdges((eds) => eds.filter((e) => !e.selected));
      }
    },
    [isEdit, selectedNode, setNodes, setEdges]
  );

  return (
    <div className="flex flex-col h-full relative" onKeyDown={onKeyDown} tabIndex={0}>
      <CanvasToolbar
        mode={mode}
        name={name}
        setName={setName}
        description={description}
        setDescription={setDescription}
        status={runStatus}
        saving={saving}
        onAddStep={handleAddStep}
        onAutoLayout={handleAutoLayout}
        onSave={handleSave}
        onCancel={onCancel}
        onAbort={onAbort}
        onFitView={handleFitView}
      />

      {error && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-40 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex-1 relative">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={isEdit ? onNodesChange : undefined}
          onEdgesChange={isEdit ? onEdgesChange : undefined}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          nodeTypes={nodeTypes}
          nodesDraggable={isEdit}
          nodesConnectable={isEdit}
          elementsSelectable={true}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          deleteKeyCode={isEdit ? ["Delete", "Backspace"] : null}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#27272a" gap={20} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            nodeColor={(n) => {
              const s = n.data?.status;
              if (s === "running") return "#3b82f6";
              if (s === "completed") return "#22c55e";
              if (s === "failed") return "#ef4444";
              return "#52525b";
            }}
            maskColor="rgba(59, 130, 246, 0.08)"
          />
        </ReactFlow>

        {selectedNode && (
          <NodeConfigPanel
            node={selectedNode}
            skills={skills}
            mode={mode}
            onChange={isEdit ? handleNodeConfigChange : undefined}
            onClose={() => setSelectedNode(null)}
          />
        )}
      </div>
    </div>
  );
}

export default function WorkflowCanvas(props) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
