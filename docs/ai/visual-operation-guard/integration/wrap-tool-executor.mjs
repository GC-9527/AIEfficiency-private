import { VisualOperationGuard } from '../runtime/src/index.mjs';

/**
 * Minimal in-process adapter. Put this between the LLM tool router and the real executor.
 */
export class GuardedToolExecutor {
  constructor({ policy, executeTool, classifyTool, onHandoff = async () => {} }) {
    this.policy = policy;
    this.executeTool = executeTool;
    this.classifyTool = classifyTool;
    this.onHandoff = onHandoff;
    this.guards = new Map();
  }

  createTask(options) {
    const guard = new VisualOperationGuard(this.policy, options);
    this.guards.set(guard.taskId, guard);
    return guard.snapshot();
  }

  preflight(taskId, preflight) {
    return this.#guard(taskId).preflight(preflight);
  }

  async execute(taskId, toolCall) {
    const guard = this.#guard(taskId);
    const metadata = this.classifyTool(toolCall);
    const decision = guard.authorize({
      toolName: toolCall.name,
      targetId: toolCall.arguments?.targetId,
      estimatedRemainingActions: toolCall.arguments?.estimatedRemainingActions,
      regionScoped: toolCall.arguments?.regionScoped,
      screenshotKind: toolCall.arguments?.screenshotKind,
      sensitiveFlag: toolCall.arguments?.sensitiveFlag,
      ...metadata
    });

    if (!decision.allowed) {
      if (decision.handoff) await this.onHandoff({ taskId, decision, state: guard.snapshot() });
      return { executed: false, decision };
    }

    const started = guard.beginExecution({ authorizationId: decision.authorizationId });
    if (!started.allowed) {
      return { executed: false, decision: started, state: guard.snapshot() };
    }

    let result;
    try {
      result = await this.executeTool(toolCall);
    } catch (error) {
      const recorded = guard.recordResult({
        authorizationId: decision.authorizationId,
        success: false,
        progress: false,
        checkpoint: toolCall.arguments?.checkpoint,
        screenFingerprint: error.screenFingerprint
      });
      if (recorded.handoff) await this.onHandoff({ taskId, decision: recorded, state: guard.snapshot() });
      throw error;
    }

    const recorded = guard.recordResult({
      authorizationId: decision.authorizationId,
      success: result.success !== false,
      progress: result.progress === true,
      screenFingerprint: result.screenFingerprint,
      checkpoint: result.checkpoint,
      actualUsage: result.actualUsage,
      completed: result.completed === true
    });

    if (recorded.handoff) await this.onHandoff({ taskId, decision: recorded, state: guard.snapshot() });
    return { executed: true, result, decision: recorded, state: guard.snapshot() };
  }

  #guard(taskId) {
    const guard = this.guards.get(taskId);
    if (!guard) throw new Error(`Unknown task: ${taskId}`);
    return guard;
  }
}

export function defaultToolClassifier(toolCall) {
  const name = toolCall.name || '';
  const args = toolCall.arguments || {};

  if (/screenshot|capture_screen|take_snapshot/i.test(name)) {
    return { channel: args.channel || 'visual', operationType: 'screenshot', coordinateBased: false };
  }
  if (/computer\.(click|type|drag|scroll)|coordinate|mouse/i.test(name)) {
    return { channel: 'visual', operationType: 'visual_action', coordinateBased: true };
  }
  if (/playwright|browser\.(click|fill|select)|dom|cdp/i.test(name)) {
    return { channel: 'playwright', operationType: 'structured_ui', coordinateBased: false };
  }
  if (/uiautomator|appium|accessibility/i.test(name)) {
    return { channel: 'accessibility', operationType: 'structured_ui', coordinateBased: false };
  }
  if (/adb/i.test(name)) return { channel: 'adb', operationType: 'structured_command', coordinateBased: false };
  if (/mcp/i.test(name)) return { channel: 'mcp', operationType: 'structured_integration', coordinateBased: false };
  if (/http|rest|api/i.test(name)) return { channel: 'api', operationType: 'structured_integration', coordinateBased: false };
  return { channel: 'cli', operationType: 'structured_command', coordinateBased: false };
}
