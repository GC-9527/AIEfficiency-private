import dagre from "@dagrejs/dagre";

const NODE_WIDTH = 260;
const NODE_HEIGHT = 120;

/**
 * Convert workflow steps array to React Flow nodes & edges.
 * If stepStates provided (monitor mode), merge status into node data.
 */
export function stepsToFlow(steps, stepStates = {}, roleStates = {}) {
  const hasPositions = steps.some((s) => s.position?.x != null);

  const nodes = steps.map((step) => ({
    id: step.id,
    type: "stepNode",
    position: hasPositions ? { x: step.position.x, y: step.position.y } : { x: 0, y: 0 },
    data: {
      ...step,
      status: stepStates[step.id]?.status || "idle",
      output: stepStates[step.id]?.output || "",
      startedAt: stepStates[step.id]?.startedAt,
      completedAt: stepStates[step.id]?.completedAt,
      inspect: step.inspect || false,
      inspections: roleStates[step.id]?.inspections || [],
      retryCount: roleStates[step.id]?.retryCount || 0,
    },
  }));

  const edges = [];
  for (const step of steps) {
    if (step.dependsOn) {
      for (const depId of step.dependsOn) {
        edges.push({
          id: `${depId}->${step.id}`,
          source: depId,
          target: step.id,
          type: "default",
          animated: stepStates[depId]?.status === "running",
          style: edgeStyle(stepStates[depId]?.status),
        });
      }
    }
  }

  if (!hasPositions) {
    return autoLayout(nodes, edges);
  }
  return { nodes, edges };
}

/**
 * Convert React Flow nodes & edges back to steps array (for saving).
 */
export function flowToSteps(nodes, edges) {
  const depsMap = {};
  for (const e of edges) {
    if (!depsMap[e.target]) depsMap[e.target] = [];
    depsMap[e.target].push(e.source);
  }

  return nodes.map((node) => ({
    id: node.id,
    title: node.data.title || "",
    prompt: node.data.prompt || "",
    engine: node.data.engine || "auto",
    skill: node.data.skill || "",
    dependsOn: depsMap[node.id] || [],
    timeout: node.data.timeout || 300,
    outputVar: node.data.outputVar || "",
    inspect: node.data.inspect || false,
    position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
  }));
}

/**
 * Auto-layout nodes using dagre (top-to-bottom).
 */
export function autoLayout(nodes, edges) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 80 });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const layoutNodes = nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 },
    };
  });

  return { nodes: layoutNodes, edges };
}

/**
 * Check if adding newEdge would create a cycle.
 */
export function wouldCreateCycle(edges, newEdge) {
  const adj = {};
  for (const e of edges) {
    if (!adj[e.source]) adj[e.source] = [];
    adj[e.source].push(e.target);
  }
  if (!adj[newEdge.source]) adj[newEdge.source] = [];
  adj[newEdge.source].push(newEdge.target);

  const visited = new Set();
  const stack = new Set();

  function dfs(node) {
    if (stack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    stack.add(node);
    for (const next of adj[node] || []) {
      if (dfs(next)) return true;
    }
    stack.delete(node);
    return false;
  }

  for (const node of Object.keys(adj)) {
    if (dfs(node)) return true;
  }
  return false;
}

function edgeStyle(status) {
  switch (status) {
    case "running":
      return { stroke: "#3b82f6", strokeWidth: 2 };
    case "completed":
      return { stroke: "rgba(34,197,94,0.4)", strokeWidth: 2 };
    case "failed":
      return { stroke: "rgba(239,68,68,0.4)", strokeWidth: 2 };
    default:
      return { stroke: "#52525b", strokeWidth: 1.5 };
  }
}

let stepCounter = 0;
export function createNewStep() {
  stepCounter++;
  return {
    id: `step_${Date.now()}_${stepCounter}`,
    title: "",
    prompt: "",
    engine: "auto",
    skill: "",
    dependsOn: [],
    timeout: 300,
    outputVar: "",
    inspect: false,
  };
}
