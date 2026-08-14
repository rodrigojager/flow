export const FLOW_STUDIO_SCHEMA_VERSION = 'flow-studio/v2' as const;

export type FlowStudioNodeType =
  | 'input'
  | 'context'
  | 'agent'
  | 'playbook'
  | 'action'
  | 'command'
  | 'memory_write'
  | 'router'
  | 'fork'
  | 'dynamic_parallel'
  | 'tournament'
  | 'join'
  | 'gate'
  | 'wait'
  | 'subgraph'
  | 'loop'
  | 'transform'
  | 'report'
  | 'end';

export type FlowStudioReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';
export type FlowStudioServiceTier = 'default' | 'fast' | 'flex';
export type FlowStudioRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting';
export type FlowStudioGateDecision = 'continue' | 'wait' | 'fail';
export type FlowStudioDirection = 'forward' | 'back';
export type FlowStudioRunnerKind = 'flow' | 'llm' | 'codex' | 'cybervinci' | 'opencode' | 'command' | 'http' | 'mcp' | 'worker';
export type FlowStudioRunnerCapability =
  | 'text'
  | 'reasoning'
  | 'tools'
  | 'vision'
  | 'files'
  | 'structured-output'
  | 'streaming'
  | 'sessions'
  | 'subagents';

export interface FlowStudioRunnerBinding {
  runnerId?: string;
  providerId: string;
  modelId?: string;
  profileId?: string;
  reasoningEffort?: FlowStudioReasoningEffort;
  serviceTier?: FlowStudioServiceTier;
  timeoutMs?: number;
  sessionId?: string;
  command?: string;
  requiredCapabilities?: FlowStudioRunnerCapability[];
  fallbacks?: FlowStudioRunnerBinding[];
}

/** Kept as the public name used by provider-oriented integrations. */
export type FlowStudioProviderBinding = FlowStudioRunnerBinding;

export interface FlowStudioModelProfile {
  id: string;
  name: string;
  providerId: string;
  modelId: string;
  runnerId?: string;
  description?: string;
  command?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  costPerMTokPrompt?: number;
  costPerMTokOutput?: number;
  tags?: string[];
  capabilities?: FlowStudioRunnerCapability[];
  reasonDefault?: FlowStudioReasoningEffort;
  serviceTierDefault?: FlowStudioServiceTier;
}

export interface FlowStudioRunnerDefinition {
  id: string;
  name: string;
  kind: FlowStudioRunnerKind;
  providerId?: string;
  command?: string;
  endpoint?: string;
  capabilities: FlowStudioRunnerCapability[];
  models?: string[];
  metadata?: Record<string, unknown>;
}

export interface FlowStudioToolBinding {
  id: string;
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  effect?: FlowStudioEffectKind;
  idempotencyKey?: string;
  requiredPermissions?: string[];
}

export interface FlowStudioToolDecision {
  id: string;
  label: string;
  toNodeId?: string;
  decision: FlowStudioGateDecision;
  note?: string;
}

export interface FlowStudioRagAttachment {
  markdown?: string;
  filePath?: string;
  maxBytes?: number;
}

export interface FlowStudioLoopControl {
  bodyStart: string;
  condition: string;
  maxIterations: number;
  breakWhen?: string;
}

export type FlowStudioJoinStrategy = 'all' | 'any' | 'quorum' | 'majority';

export interface FlowStudioForkConfig {
  branches: string[];
  join: string;
  maxConcurrency?: number;
  continueOnError?: boolean;
}

export interface FlowStudioJoinConfig {
  strategy: FlowStudioJoinStrategy;
  quorum?: number;
  cancelRemaining?: boolean;
  reducer?: string;
}

export type FlowStudioGateKind = 'human' | 'deterministic' | 'ai' | 'policy' | 'composite';

export interface FlowStudioGateRule {
  id: string;
  expression: string;
  message?: string;
  severity?: 'info' | 'warning' | 'blocker';
}

export interface FlowStudioGateConfig {
  kind: FlowStudioGateKind;
  prompt?: string;
  expression?: string;
  rules?: FlowStudioGateRule[];
  children?: FlowStudioGateConfig[];
  combine?: 'all' | 'any' | 'majority';
  reviewer?: FlowStudioRunnerBinding;
  requireEvidence?: boolean;
  timeoutMs?: number;
  onTimeout?: FlowStudioGateDecision;
}

export type FlowStudioWaitKind = 'duration' | 'until' | 'event';

export interface FlowStudioWaitConfig {
  kind: FlowStudioWaitKind;
  durationMs?: number;
  until?: string;
  eventName?: string;
  correlationKey?: string;
  timeoutMs?: number;
  onTimeout?: 'continue' | 'fail';
}

export interface FlowStudioSubgraphConfig {
  graphId?: string;
  graphRef?: string;
  inline?: FlowStudioGraph;
  input?: Record<string, string>;
  output?: Record<string, string>;
  isolated?: boolean;
}

export type FlowStudioMemoryScope = 'ide' | 'workspace' | 'project' | 'workflow' | 'run' | 'agent';

export interface FlowStudioContextConfig {
  query?: string;
  scopes?: FlowStudioMemoryScope[];
  statePaths?: string[];
  filePaths?: string[];
  tags?: string[];
  maxItems?: number;
  maxBytes?: number;
  outputPath?: string;
  required?: boolean;
  scopeId?: string;
}

export interface FlowStudioCommandConfig {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  effect?: FlowStudioEffectKind;
  idempotencyKey?: string;
  requiredPermissions?: string[];
}

export interface FlowStudioMemoryWriteConfig {
  scope: FlowStudioMemoryScope;
  candidatesFrom: string;
  candidateIds?: string[];
  policy?: 'approved-only';
  onEmpty?: 'skip' | 'fail';
  storeId?: string;
  kind?: 'fact' | 'decision' | 'preference' | 'instruction' | 'summary';
  outputPath?: string;
  idempotencyKey?: string;
  scopeId?: string;
}

export interface FlowStudioPlaybookConfig {
  playbookId: string;
  graphId?: string;
  graphRef?: string;
  inline?: FlowStudioGraph;
  input?: Record<string, string>;
  parameters?: Record<string, unknown>;
  output?: Record<string, string>;
  isolated?: boolean;
  idempotencyKey?: string;
}

export type FlowStudioDynamicParallelFailurePolicy = 'fail_fast' | 'best_effort' | 'threshold';
export type FlowStudioDynamicParallelJoinStrategy = 'collect' | 'best_effort' | 'require_all';

export interface FlowStudioDynamicParallelConfig {
  itemsFrom: string;
  itemVariable?: string;
  worker: FlowStudioNode;
  concurrency?: number;
  maxItems?: number;
  failurePolicy?: FlowStudioDynamicParallelFailurePolicy;
  failureThreshold?: number;
  joinStrategy?: FlowStudioDynamicParallelJoinStrategy;
  outputPath?: string;
}

export type FlowStudioTournamentStrategy = 'single_round' | 'bracket' | 'round_robin';
export type FlowStudioTournamentTieBreaker = 'judge_again' | 'score_total' | 'first_candidate';

export interface FlowStudioTournamentConfig {
  candidatesFrom: string;
  judge: FlowStudioNode;
  strategy?: FlowStudioTournamentStrategy;
  criteria?: string[];
  winnerCount?: number;
  maxComparisons?: number;
  tieBreaker?: FlowStudioTournamentTieBreaker;
  maxTieRounds?: number;
  outputPath?: string;
  blind?: boolean;
  identityFields?: string[];
}

export type FlowStudioReducerKind = 'replace' | 'merge' | 'append' | 'sum' | 'min' | 'max' | 'first' | 'last' | 'custom';

export interface FlowStudioReducerSpec {
  kind: FlowStudioReducerKind;
  expression?: string;
}

export interface FlowStudioStateNamespace {
  description?: string;
  schema?: Record<string, unknown>;
  initial?: FlowStudioContext;
  reducer?: FlowStudioReducerSpec;
}

export interface FlowStudioStateSpec {
  namespaces?: Record<string, FlowStudioStateNamespace>;
  initial?: FlowStudioContext;
  strictWrites?: boolean;
}

export interface FlowStudioPermissionSpec {
  allow?: string[];
  deny?: string[];
  requireApproval?: string[];
  fileRoots?: string[];
  networkHosts?: string[];
  commandPatterns?: string[];
}

export interface FlowStudioBudgetSpec {
  maxSteps?: number;
  maxDurationMs?: number;
  maxCostUsd?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxParallelism?: number;
}

export interface FlowStudioNode {
  id: string;
  type: FlowStudioNodeType;
  label: string;
  description?: string;
  prompt?: string;
  condition?: string;
  rag?: FlowStudioRagAttachment;
  provider?: FlowStudioProviderBinding;
  runner?: FlowStudioRunnerBinding;
  tools?: FlowStudioToolBinding[];
  outputs?: Record<string, string>;
  tags?: string[];
  next?: string;
  retries?: number;
  timeoutMs?: number;
  continueOnError?: boolean;
  retryDelayMs?: number;
  toolExecMode?: 'first' | 'all';
  loop?: FlowStudioLoopControl;
  gate?: FlowStudioGateConfig;
  gatePrompt?: string;
  gateDecisions?: FlowStudioToolDecision[];
  fork?: FlowStudioForkConfig;
  join?: FlowStudioJoinConfig;
  wait?: FlowStudioWaitConfig;
  subgraph?: FlowStudioSubgraphConfig;
  context?: FlowStudioContextConfig;
  command?: FlowStudioCommandConfig;
  memoryWrite?: FlowStudioMemoryWriteConfig;
  playbook?: FlowStudioPlaybookConfig;
  dynamicParallel?: FlowStudioDynamicParallelConfig;
  tournament?: FlowStudioTournamentConfig;
  permissions?: FlowStudioPermissionSpec;
  budget?: FlowStudioBudgetSpec;
  metadata?: Record<string, unknown>;
  position?: { x: number; y: number };
}

export interface FlowStudioEdge {
  id?: string;
  from: string;
  to: string;
  guard?: string;
  outcome?: FlowStudioDirection;
  priority?: number;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface FlowStudioGraph {
  version: typeof FLOW_STUDIO_SCHEMA_VERSION;
  id: string;
  name: string;
  description?: string;
  start: string;
  nodes: FlowStudioNode[];
  edges: FlowStudioEdge[];
  modelProfiles?: FlowStudioModelProfile[];
  runners?: FlowStudioRunnerDefinition[];
  subgraphs?: Record<string, FlowStudioGraph>;
  state?: FlowStudioStateSpec;
  permissions?: FlowStudioPermissionSpec;
  budget?: FlowStudioBudgetSpec;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface FlowStudioValidationIssue {
  kind: 'error' | 'warning';
  code: string;
  message: string;
  path: string;
  hint?: string;
}

export interface FlowStudioValidationResult {
  valid: boolean;
  errors: FlowStudioValidationIssue[];
  warnings: FlowStudioValidationIssue[];
}

export type FlowStudioEffectKind = 'none' | 'read' | 'write' | 'command' | 'network' | 'message' | 'deploy' | 'custom';

export interface FlowStudioArtifact {
  id: string;
  nodeId: string;
  kind: 'text' | 'json' | 'log' | 'tool-output' | 'report' | 'file' | 'diff' | 'evidence';
  name: string;
  payload: unknown;
  mimeType?: string;
  uri?: string;
  digest?: string;
  createdAt?: string;
}

export interface FlowStudioContext { [key: string]: unknown }

export interface FlowStudioUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface FlowStudioMemoryCandidate {
  id: string;
  status: 'candidate' | 'approved' | 'rejected' | 'written' | 'failed';
  revision: string | number;
  scope?: FlowStudioMemoryScope;
  kind?: 'fact' | 'decision' | 'preference' | 'instruction' | 'summary';
  key?: string;
  value: unknown;
  tags?: string[];
  approvedAt?: string;
  approvedBy?: string;
}

export interface FlowStudioMemoryWriteRecord {
  candidateId: string;
  revision: string | number;
  scope: FlowStudioMemoryScope;
  scopeId?: string;
  storeId?: string;
  status: 'written' | 'failed';
  digest?: string;
  writtenAt?: string;
  error?: string;
}

/** Host-trusted approval for one immutable memory candidate revision. */
export interface FlowStudioMemoryApproval {
  id: string;
  revision: string | number;
  scope: FlowStudioMemoryScope;
  /** Optional logical scope identifier of the exact Memory Write destination. */
  scopeId?: string;
  /** Optional backing store identifier of the exact Memory Write destination. */
  storeId?: string;
  /** Graph containing the Memory Write node this receipt authorizes. */
  graphId: string;
  /** Exact Memory Write node this receipt authorizes. */
  nodeId: string;
  candidateDigest: string;
  approvedAt?: string;
  approvedBy?: string;
  evidence?: FlowStudioArtifact[];
}

/** Internal run-wide step counter shared by nested subgraphs. */
export interface FlowStudioStepLedger {
  count: number;
  maxSteps: number;
}

export interface FlowStudioContextPack {
  summary?: string;
  memories?: unknown[];
  files?: Array<{ path: string; content?: string; digest?: string; truncated?: boolean }>;
  symbols?: unknown[];
  signals?: Record<string, unknown>;
  sections?: Array<{ title: string; content: unknown; provenance?: string }>;
  provenance?: Array<{ kind: string; ref: string; digest?: string }>;
  truncated?: boolean;
}

export interface FlowStudioEffectRecord {
  id: string;
  idempotencyKey: string;
  runId: string;
  nodeId: string;
  toolId?: string;
  kind: FlowStudioEffectKind;
  status: 'started' | 'completed' | 'failed' | 'uncertain' | 'skipped';
  startedAt: string;
  finishedAt?: string;
  inputDigest?: string;
  output?: Record<string, unknown>;
  error?: string;
}

export interface FlowStudioCheckpoint {
  id: string;
  runId: string;
  graphId: string;
  graphVersion: string;
  graphDigest: string;
  nodeId: string;
  nextNodeId?: string;
  reason: 'node-complete' | 'gate' | 'wait' | 'failure' | 'manual';
  context: FlowStudioContext;
  visited: string[];
  effects: FlowStudioEffectRecord[];
  artifacts?: FlowStudioArtifact[];
  usage: FlowStudioUsage;
  createdAt: string;
  wait?: FlowStudioWaitConfig;
  metadata?: Record<string, unknown>;
}

export interface FlowStudioRunEvent {
  kind:
    | 'run.started'
    | 'run.resumed'
    | 'run.cancelled'
    | 'node.enter'
    | 'node.output'
    | 'node.success'
    | 'node.failed'
    | 'node.requeued'
    | 'node.skipped'
    | 'branch.started'
    | 'branch.completed'
    | 'branch.waiting'
    | 'parallel.item.started'
    | 'parallel.item.completed'
    | 'parallel.item.failed'
    | 'tournament.comparison.started'
    | 'tournament.comparison.completed'
    | 'loop.iteration'
    | 'gate.required'
    | 'gate.resolved'
    | 'wait.started'
    | 'wait.resolved'
    | 'effect.started'
    | 'effect.completed'
    | 'effect.skipped'
    | 'checkpoint.created'
    | 'budget.updated'
    | 'run.completed'
    | 'run.failed';
  runId: string;
  nodeId?: string;
  edgeId?: string;
  message: string;
  detail?: Record<string, unknown>;
  step: number;
  at: string;
}

export interface FlowStudioGatePolicy {
  defaultAction?: FlowStudioGateDecision;
  defaultToNodeId?: string;
  byNode?: Record<string, { action?: FlowStudioGateDecision; toNodeId?: string; decisionId?: string }>;
}

export interface FlowStudioGateRequest {
  runId: string;
  nodeId: string;
  label: string;
  kind: FlowStudioGateKind;
  decisions: FlowStudioToolDecision[];
  context: FlowStudioContext;
  payload?: unknown;
}

export interface FlowStudioGateResult {
  decisionId?: string;
  toNodeId?: string;
  message?: string;
  action?: FlowStudioGateDecision;
  evidence?: FlowStudioArtifact[];
  score?: number;
  blockers?: string[];
  warnings?: string[];
  /** Explicit candidate revisions approved by the human decision. */
  memoryApprovals?: FlowStudioMemoryApproval[];
}

export interface FlowStudioInteractionEnvelope {
  type: 'gate' | 'permission' | 'wait';
  graphId: string;
  nodeId: string;
  kind?: FlowStudioGateKind | FlowStudioWaitKind;
  label?: string;
  decisions?: FlowStudioToolDecision[];
  requireEvidence?: boolean;
  pendingHumanPath?: string;
  permission?: string;
  toolId?: string;
  eventName?: string;
  correlationKey?: string;
  dueAt?: string;
  durationMs?: number;
  until?: string;
  timeoutMs?: number;
  onTimeout?: 'continue' | 'fail';
  memoryWriteTargets?: Array<{
    nodeId: string;
    label: string;
    scope: FlowStudioMemoryScope;
    scopeId?: string;
    storeId?: string;
  }>;
}

export interface FlowStudioResumeRequest {
  checkpoint: FlowStudioCheckpoint;
  signal?: Record<string, unknown>;
  gate?: FlowStudioGateResult;
  forkRun?: boolean;
}

export interface FlowStudioRunRequest {
  graph: FlowStudioGraph;
  runId?: string;
  input?: FlowStudioContext;
  maxSteps?: number;
  gatePolicy?: FlowStudioGatePolicy;
  onEvent?: (event: FlowStudioRunEvent) => void;
  onCheckpoint?: (checkpoint: FlowStudioCheckpoint) => void | Promise<void>;
  /** Write-ahead effect receipt hook. Resolves before an external effect starts and after it settles. */
  onEffect?: (effect: FlowStudioEffectRecord) => void | Promise<void>;
  onGate?: (request: FlowStudioGateRequest) => Promise<FlowStudioGateResult>;
  runnerAdapters?: Record<string, FlowStudioRunnerAdapter>;
  providerAdapters?: Record<string, FlowStudioProviderAdapter>;
  toolAdapters?: Record<string, FlowStudioToolAdapter>;
  memoryAdapter?: FlowStudioMemoryAdapter;
  playbookAdapters?: Record<string, FlowStudioPlaybookAdapter>;
  defaultProvider?: FlowStudioProviderBinding;
  defaultModelProfileId?: string;
  modelProfiles?: Record<string, FlowStudioModelProfile>;
  /** Trusted workspace base used to resolve relative RAG paths. */
  workspaceRoot?: string;
  resolveSubgraph?: (ref: string, graph: FlowStudioGraph) => Promise<FlowStudioGraph>;
  resume?: FlowStudioResumeRequest;
  effects?: FlowStudioEffectRecord[];
  /** Trusted approvals supplied by the host UI or produced by a human Gate. */
  memoryApprovals?: FlowStudioMemoryApproval[];
  signal?: AbortSignal;
  /** Current nesting depth used to bound recursive subgraphs. */
  subgraphDepth?: number;
  /** Maximum nested subgraphs for this execution. Defaults to 12. */
  maxSubgraphDepth?: number;
  /** Explicit preview mode. Production execution never falls back to simulated adapters. */
  simulationMode?: boolean;
  /** Internal run-wide limiter shared with nested subgraphs; callers normally omit it. */
  concurrencyLimiter?: FlowStudioConcurrencyLimiter;
  /** Internal run-wide step ledger shared with nested subgraphs; callers normally omit it. */
  stepLedger?: FlowStudioStepLedger;
}

export interface FlowStudioPlaybookDefinition {
  id: string;
  name?: string;
  description?: string;
}

export interface FlowStudioConcurrencyLimiter {
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface FlowStudioRunResult {
  runId: string;
  parentRunId?: string;
  graphId: string;
  status: FlowStudioRunStatus;
  statusMessage?: string;
  startedAt: string;
  finishedAt?: string;
  visited: string[];
  artifacts: FlowStudioArtifact[];
  finalContext: FlowStudioContext;
  events: FlowStudioRunEvent[];
  checkpoints: FlowStudioCheckpoint[];
  effects: FlowStudioEffectRecord[];
  usage: FlowStudioUsage;
  waiting?: { nodeId: string; kind: 'gate' | 'wait'; checkpointId: string; detail?: Record<string, unknown> };
  error?: string;
}

export interface FlowStudioRunnerOutput {
  summary?: string;
  output?: Record<string, unknown>;
  artifacts?: FlowStudioArtifact[];
  usage?: Partial<FlowStudioUsage>;
  sessionId?: string;
  /** Tool calls requested by an agent runner; every id must exist in node.tools. */
  toolCalls?: Array<{ toolId: string; args?: string[]; idempotencyKey?: string }>;
}

export type FlowStudioRunnerAdapter = (args: {
  node: FlowStudioNode;
  graph: FlowStudioGraph;
  runId: string;
  context: FlowStudioContext;
  input: FlowStudioContext;
  prompt: string;
  runner: FlowStudioRunnerBinding;
  model?: FlowStudioModelProfile;
  signal?: AbortSignal;
  onEvent?: (event: FlowStudioRunEvent) => void;
}) => Promise<FlowStudioRunnerOutput>;

export type FlowStudioProviderAdapter = FlowStudioRunnerAdapter;

export type FlowStudioToolAdapter = (args: {
  nodeId: string;
  runId: string;
  context: FlowStudioContext;
  tool: FlowStudioToolBinding;
  node: FlowStudioNode;
  signal?: AbortSignal;
  onEvent?: (event: FlowStudioRunEvent) => void;
}) => Promise<FlowStudioRunnerOutput>;

export interface FlowStudioMemoryAdapter {
  loadContext(args: {
    node: FlowStudioNode;
    runId: string;
    graph: FlowStudioGraph;
    context: FlowStudioContext;
    config: FlowStudioContextConfig;
    workspaceRoot?: string;
    signal?: AbortSignal;
  }): Promise<{ pack: FlowStudioContextPack; artifacts?: FlowStudioArtifact[] }>;
  writeCandidate(args: {
    node: FlowStudioNode;
    runId: string;
    graph: FlowStudioGraph;
    context: FlowStudioContext;
    config: FlowStudioMemoryWriteConfig;
    candidate: FlowStudioMemoryCandidate;
    approval: FlowStudioMemoryApproval;
    workspaceRoot?: string;
    signal?: AbortSignal;
  }): Promise<FlowStudioMemoryWriteRecord>;
}

export interface FlowStudioPlaybookRunResult {
  ok: boolean;
  stop?: boolean;
  message?: string;
  value?: unknown;
  output?: Record<string, unknown>;
  artifacts?: FlowStudioArtifact[];
  signals?: Record<string, unknown>;
  issues?: string[];
  diagnostics?: unknown[];
  usage?: Partial<FlowStudioUsage>;
}

export type FlowStudioPlaybookAdapter = (args: {
  node: FlowStudioNode;
  runId: string;
  graph: FlowStudioGraph;
  context: FlowStudioContext;
  config: FlowStudioPlaybookConfig;
  workspaceRoot?: string;
  signal?: AbortSignal;
  onEvent?: (event: FlowStudioRunEvent) => void;
}) => Promise<FlowStudioPlaybookRunResult>;

export interface FlowStudioAuthorRequest {
  instruction: string;
  currentGraph?: FlowStudioGraph;
  availableRunners?: FlowStudioRunnerDefinition[];
  availableModels?: FlowStudioModelProfile[];
  availableTools?: FlowStudioToolBinding[];
  availablePlaybooks?: FlowStudioPlaybookDefinition[];
  constraints?: string[];
}

export interface FlowStudioAuthorResult {
  graph: FlowStudioGraph;
  summary?: string;
  assumptions?: string[];
  validation: FlowStudioValidationResult;
  raw?: unknown;
}

export type FlowStudioAuthorAdapter = (args: {
  request: FlowStudioAuthorRequest;
  systemPrompt: string;
  schema: Record<string, unknown>;
  signal?: AbortSignal;
}) => Promise<unknown>;
