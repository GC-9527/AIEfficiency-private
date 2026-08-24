// Reference only. Adapt names to your existing AIEfficiency Tool Router.

type GuardDecision = {
  allowed: boolean;
  code: string;
  authorizationId?: string;
  handoff?: {
    text: string;
    actions?: {
      releaseResourceLocks?: boolean;
      continueOtherTasks?: boolean;
    };
  };
};

export async function executeGuardedTool(ctx: {
  taskId: string;
  toolCall: { name: string; arguments: Record<string, unknown> };
  guard: {
    authorize(taskId: string, payload: Record<string, unknown>): Promise<{ decision: GuardDecision }>;
    begin(taskId: string, payload: Record<string, unknown>): Promise<{ decision: GuardDecision }>;
    result(taskId: string, payload: Record<string, unknown>): Promise<{ decision: GuardDecision }>;
  };
  registry: {
    metadata(name: string): {
      channel: string;
      operationType: string;
      coordinateBased: boolean;
    };
    execute(toolCall: unknown): Promise<Record<string, unknown>>;
  };
  taskStore: {
    saveCheckpoint(taskId: string, checkpoint: unknown): Promise<void>;
    markBlocked(taskId: string, reason: unknown): Promise<void>;
  };
  locks: { releaseAll(taskId: string): Promise<void> };
  notifier: { sendHumanHandoff(taskId: string, text: string): Promise<void> };
}) {
  const metadata = ctx.registry.metadata(ctx.toolCall.name);
  const authorization = await ctx.guard.authorize(ctx.taskId, {
    toolName: ctx.toolCall.name,
    ...metadata,
    ...ctx.toolCall.arguments
  });

  if (!authorization.decision.allowed) {
    const handoff = authorization.decision.handoff;
    if (handoff) {
      await ctx.taskStore.saveCheckpoint(ctx.taskId, handoff);
      await ctx.notifier.sendHumanHandoff(ctx.taskId, handoff.text);
      if (handoff.actions?.releaseResourceLocks) await ctx.locks.releaseAll(ctx.taskId);
      if (handoff.actions?.continueOtherTasks) await ctx.taskStore.markBlocked(ctx.taskId, handoff);
    }
    return { executed: false, decision: authorization.decision };
  }

  const started = await ctx.guard.begin(ctx.taskId, {
    authorizationId: authorization.decision.authorizationId
  });
  if (!started.decision.allowed) {
    return { executed: false, decision: started.decision };
  }

  const result = await ctx.registry.execute(ctx.toolCall);
  const recorded = await ctx.guard.result(ctx.taskId, {
    authorizationId: authorization.decision.authorizationId,
    success: result.success !== false,
    progress: result.progress === true,
    screenFingerprint: result.screenFingerprint,
    checkpoint: result.checkpoint,
    actualUsage: result.actualUsage
  });

  return { executed: true, result, decision: recorded.decision };
}
