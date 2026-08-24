export type GuardMode = 'balanced' | 'acceptance' | 'exploration' | 'unattended' | 'strict_ci' | string;

export interface GuardTaskOptions {
  taskId?: string;
  mode?: GuardMode;
  taskType?: string;
  unattended?: boolean;
}

export interface GuardDecision {
  allowed: boolean;
  code: string;
  reason: string;
  taskId: string;
  at: string;
  authorizationId?: string;
  executionId?: string;
  expiresAt?: string;
  resultExpiresAt?: string;
  status?: string;
  handoff?: Record<string, unknown>;
  [key: string]: unknown;
}

export class VisualOperationGuard {
  constructor(rawPolicy: Record<string, unknown>, options?: GuardTaskOptions, existingState?: Record<string, unknown> | null);
  static fromState(rawPolicy: Record<string, unknown>, state: Record<string, unknown>): VisualOperationGuard;
  readonly taskId: string;
  preflight(input: Record<string, unknown>): GuardDecision;
  authorize(request: Record<string, unknown>): GuardDecision;
  beginExecution(input: string | { authorizationId: string }): GuardDecision;
  recordResult(result: Record<string, unknown>): GuardDecision;
  requestHandoff(details?: Record<string, unknown>): GuardDecision;
  resumeAfterHandoff(details?: Record<string, unknown>): GuardDecision;
  markCheckpoint(checkpoint: string): GuardDecision;
  snapshot(): Record<string, unknown>;
}

export function loadPolicy(path: string): Promise<Record<string, unknown>>;
export function resolvePolicy(policy: Record<string, unknown>, mode?: string): Record<string, unknown>;
export function validatePolicy(policy: Record<string, unknown>): true;
export function selectOperationStrategy(operationMap: Record<string, unknown>, operationId: string, options?: Record<string, unknown>): Record<string, unknown>;
