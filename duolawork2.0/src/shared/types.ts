export type DriverKind =
  | 'codex-app-server'
  | 'acp-stdio'
  | 'claude-cli'
  | 'remote-node'
  | 'remote-bridge'
  | 'webhook-bot'
  | 'mock';

export const EXCLUDED_CLAUDE_VPS_MEMBER_ID = 'member_bf4fdac30b4542c8988bb6725f47ec0b';

/**
 * Strictly excludes the protected VPS subscription Claude Code instance (`ClaudeVPS`)
 * while permitting local macOS `Claude` CLI (`driverKind: 'claude-cli'`, `location: 'local'`).
 */
export function isExcludedClaudeVps(target: {
  id?: string | null;
  name?: string | null;
  platformId?: string | null;
  driverKind?: string | null;
  location?: string | null;
}): boolean {
  if (!target) return false;
  if (target.id === EXCLUDED_CLAUDE_VPS_MEMBER_ID) return true;
  if ((target.name || '').toLowerCase().includes('claudevps')) return true;
  if (
    target.platformId === 'claude-code' &&
    (target.driverKind === 'remote-bridge' || target.location === 'remote-bridge')
  ) {
    return true;
  }
  return false;
}

/**
 * Unwraps the effective underlying driver kind when a member is hosted on an Execution Node (`remote-node`).
 */
export function resolveEffectiveDriverKind(
  member?: { driverKind?: string | null; config?: Record<string, unknown> | null } | null
): DriverKind {
  if (!member?.driverKind) return 'mock';
  if (
    member.driverKind === 'remote-node' &&
    typeof member.config?.localDriverKind === 'string' &&
    member.config.localDriverKind.trim()
  ) {
    return member.config.localDriverKind.trim() as DriverKind;
  }
  return member.driverKind as DriverKind;
}

/**
 * Returns true for local Coding Agents that operate directly on a local repository/project folder
 * (`Codex`, `Claude`, `Gemini (本机)`). Personal / cloud-only / remote Agents return false.
 */
export function isLocalCodingMember(
  member?: {
    driverKind?: string | null;
    location?: string | null;
    config?: Record<string, unknown> | null;
  } | null
): boolean {
  if (!member) return false;
  if (
    member.location === 'cloud-node' ||
    member.location === 'remote-bridge' ||
    member.location === 'webhook'
  ) {
    return false;
  }
  if (member.location === 'local' || member.location === 'local-node') return true;
  const eff = resolveEffectiveDriverKind(member);
  return eff === 'codex-app-server' || eff === 'claude-cli' || eff === 'acp-stdio';
}

export type MemberLocation = 'local' | 'local-node' | 'cloud-node' | 'remote-bridge' | 'webhook';

export interface MemberCapabilities {
  supportsIsolatedSessions: boolean;
  supportsSessionResume: boolean;
  supportsCancel: boolean;
  maxConcurrentRuns: number;
}

export type MemberStatus = 'ready' | 'busy' | 'offline' | 'auth_required';

export interface ModelPreference { model: string; effort: string | null }
export interface RuntimeModel { id: string; label: string; efforts: string[]; defaultEffort?: string }
export interface ModelCatalog { models: RuntimeModel[]; defaultModel?: string }
export interface MemberRecord {
  inference?: ModelPreference;
  id: string;
  name: string;
  platformId: string;
  driverKind: DriverKind;
  location: MemberLocation;
  nodeId?: string | null;
  capabilities: MemberCapabilities;
  status: MemberStatus;
  statusMessage: string;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionNodeRecord {
  id: string;
  name: string;
  kind: 'cloud' | 'local';
  platform: string;
  status: 'online' | 'offline';
  capabilities: {
    drivers: string[];
    allowWorkspaceBrowse?: boolean;
    allowedWorkspaceRoots?: string[];
  };
  lastHeartbeatAt: string | null;
  appVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSessionRecord {
  id: string;
  deviceName: string;
  userAgent: string;
  ip: string;
  expiresAt: string;
  createdAt: string;
  lastSeenAt: string;
  current?: boolean;
}

export interface ProviderUsageMetrics {
  observable: boolean;
  modelRequests: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  uncachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface ThreeTierUsage {
  workbenchDispatches: number;
  nativeTurns: number;
  providerUsage: ProviderUsageMetrics;
}

export type ToolPolicy = 'none' | 'duolabase_readonly' | 'duolabase_full';

export interface ThreadRecord {
  id: string;
  projectId: string;
  workspacePath: string | null;
  workspaceNodeId?: string | null;
  title: string;
  activeOwnerMemberId: string;
  boundArtifactId: string | null;
  status: 'active' | 'archived';
  pinnedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MessageAuthorKind = 'user' | 'agent' | 'system_task_card' | 'switch_notice' | 'task_receipt';
export type TurnStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';

export const turnPhases = ['processing', 'thinking', 'executing', 'writing', 'queued', 'waiting_reply', 'reconnecting'] as const;
export type TurnPhase = typeof turnPhases[number];

export interface TurnActivity {
  phase: TurnPhase;
  revision: number;
}

export interface ToolTraceItem {
  id?: string;
  name: string;
  summary?: string;
  status: 'running' | 'done' | 'error';
}

export type HandoffStrategy = 'full_thread_summary' | 'delta_since_target_last_seen';

export interface HandoffNoticeMeta {
  status: 'pending' | 'delivered';
  fromMemberId: string | null;
  toMemberId: string;
  strategy?: HandoffStrategy;
  reason?: 'member_switch' | 'session_reset' | 'late_arrival' | 'first_contact';
  handoffBytes?: number;
  budgetBytes?: number;
  includedCount?: number;
  includedFromSeq?: number | null;
  includedToSeq?: number | null;
  omittedCount?: number;
  omittedFromSeq?: number | null;
  omittedToSeq?: number | null;
  truncatedSeqs?: number[];
  lateArrivalSeqs?: number[];
  hasAnchor?: boolean;
  hasArtifact?: boolean;
  artifactTitle?: string | null;
  artifactVersion?: number | null;
  taskCount?: number;
  previewText?: string;
  deliveredAt?: string;
}

export interface ClarificationQuestionItem {
  id: string;
  question: string;
  options: string[];
  multiSelect?: boolean;
}

export interface ClarificationCardData {
  title: string;
  targetMemberName?: string;
  summary?: string;
  questions: ClarificationQuestionItem[];
  answered?: boolean;
  answeredSummary?: string;
  answeredAt?: string;
}

export interface ThreadMessageRecord {
  id: string;
  threadId: string;
  seq: number;
  authorKind: MessageAuthorKind;
  authorId: string;
  targetMemberId: string | null;
  attemptId: string | null;
  body: string;
  artifactRefs: string[];
  toolTrace?: ToolTraceItem[];
  continuedByMessageId?: string;
  activity?: TurnActivity;
  handoffMeta?: HandoffNoticeMeta | null;
  clarificationCard?: ClarificationCardData | null;
  taskCard: {
    taskId: string;
    runId?: string;
    kind: 'created' | 'started' | 'waiting_user' | 'delivered' | 'failed';
    outcomeLabel?: string;
    material?: StepProgress['material'];
  } | null;
  turnStatus: TurnStatus;
  usage: ThreeTierUsage | null;
  createdAt: string;
  updatedAt: string;
}

export interface HandoffCursorRecord {
  threadId: string;
  memberId: string;
  nativeSessionId: string | null;
  lastSeenSeq: number;
  contextEpoch: string;
  bridgeMeta?: Record<string, unknown> | null;
  deliveredRevisions?: Record<string, string>;
  updatedAt: string;
}

export type TaskKind = 'once' | 'scheduled';
export type MisfirePolicy = 'skip_stale' | 'catch_up_once';

export interface ExternalResultCheck {
  credentialId: string;
  url: string;
  field: string;
  equals: string | number | boolean;
}

export type TaskOutcome =
  | { kind: 'reply' }
  | { kind: 'material'; materialKind: 'file' | 'document'; name: string; folderPath?: string; expectedText?: string }
  | { kind: 'external'; readback?: ExternalResultCheck };

export interface StepProgress {
  stepId: string;
  canReadBack?: boolean;
  memberId: string;
  title: string;
  status: TaskStepStatus;
  result: 'reply' | 'material' | 'external';
  confirmation?: 'checking' | 'manual' | 'verified' | 'attested';
  material?: { kind: 'file' | 'document'; id: string; name: string };
}

export interface TaskStepTemplate {
  outcome?: TaskOutcome;
  stepOrder: number;
  title: string;
  assigneeMemberId: string;
  dependsOnOrders: number[];
  brief: string;
  acceptanceCriteria: string;
  toolPolicy?: ToolPolicy;
  useWorktree?: boolean;
}

export interface TaskSpec {
  goal: string;
  acceptanceCriteria: string;
  maxReviewRounds: number;
  stepTimeoutMs: number;
  workspaceRepoPath?: string | null;
  integrationTestCommand?: string | null;
  steps: TaskStepTemplate[];
}

export interface TaskRecord {
  requesterMemberId?: string | null;
  id: string;
  projectId: string;
  sourceThreadId: string;
  title: string;
  kind: TaskKind;
  cronExpr: string | null;
  intervalSeconds: number | null;
  timezone: string;
  misfirePolicy: MisfirePolicy;
  scheduleEnabled: boolean;
  templateVersion: number;
  leadMemberId: string;
  leadSessionKey: string;
  toolPolicy: ToolPolicy;
  spec: TaskSpec;
  status: 'active' | 'paused' | 'completed' | 'canceled';
  createdAt: string;
  updatedAt: string;
}

export type TaskRunStatus =
  | 'paused'
  | 'running'
  | 'waiting_user'
  | 'waiting_node_online'
  | 'completed'
  | 'timed_out'
  | 'failed'
  | 'canceled';

export type DeliveryStage = 'steps_running' | 'lead_final_review' | 'delivered';

export interface TaskRunRecord {
  progress?: StepProgress[];
  returnMemberId?: string | null;
  returnTurnStatus?: TurnStatus | null;
  id: string;
  taskId: string;
  runNumber: number;
  plannedSlotAt: string;
  templateVersion: number;
  triggerType: 'immediate' | 'manual' | 'cron';
  status: TaskRunStatus;
  deliveryStage: DeliveryStage;
  waitingQuestion: string | null;
  integrationWorktreePath: string | null;
  integrationBranch: string | null;
  finalArtifactId: string | null;
  summary: string | null;
  leadMemberId?: string | null;
  leadSessionKey?: string | null;
  toolPolicy?: ToolPolicy | null;
  spec?: TaskSpec | null;
  createdAt: string;
  updatedAt: string;
}

export type TaskStepStatus =
  | 'pending'
  | 'running'
  | 'submitted'
  | 'changes_requested'
  | 'accepted'
  | 'blocked'
  | 'timed_out'
  | 'failed'
  | 'canceled';

export interface TaskStepRecord {
  id: string;
  runId: string;
  taskId: string;
  stepOrder: number;
  title: string;
  assigneeMemberId: string;
  dependsOnStepIds: string[];
  brief: string;
  acceptanceCriteria: string;
  toolPolicy: ToolPolicy;
  useWorktree: boolean;
  status: TaskStepStatus;
  reviewRound: number;
  isolatedSessionKey: string;
  nativeSessionId: string | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  latestSubmissionVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface StepSubmissionRecord {
  id: string;
  stepId: string;
  runId: string;
  version: number;
  assigneeMemberId: string;
  attemptId: string | null;
  summary: string;
  content: string;
  artifactId: string | null;
  artifactVersion: number | null;
  commitSha: string | null;
  status: 'submitted' | 'blocked';
  createdAt: string;
}

export interface StepReviewRecord {
  id: string;
  stepId: string;
  runId: string;
  submissionVersion: number;
  leadMemberId: string;
  attemptId: string | null;
  verdict: 'accept' | 'changes_requested' | 'ask_user';
  comments: string;
  createdAt: string;
}

export interface ArtifactRecord {
  id: string;
  sourceThreadId: string;
  taskId: string | null;
  runId: string | null;
  title: string;
  headVersion: number;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactVersionRecord {
  id: string;
  artifactId: string;
  version: number;
  basedOnVersion: number;
  branchKind: 'main' | 'conflict_branch';
  writerKind: 'user' | 'agent';
  writerId: string;
  attemptId: string | null;
  title: string;
  content: string;
  createdAt: string;
}

export type DispatchAttemptStatus =
  | 'prepared'
  | 'dispatched'
  | 'running'
  | 'reconciling'
  | 'succeeded'
  | 'timed_out'
  | 'failed'
  | 'late_ignored';

export interface DispatchAttemptRecord {
  inference?: ModelPreference | null;
  id: string;
  targetKind: 'thread_message' | 'task_step' | 'lead_review' | 'lead_final';
  targetId: string;
  threadId: string;
  taskId: string | null;
  runId: string | null;
  stepId: string | null;
  memberId: string;
  idempotencyKey: string;
  scopeKey: string;
  nativeSessionId: string | null;
  nativeTurnId: string | null;
  bridgeMeta: Record<string, unknown> | null;
  status: DispatchAttemptStatus;
  slotHeld: boolean;
  baseArtifactId: string | null;
  baseArtifactVersion: number | null;
  promptDigest: string;
  promptBytes: number;
  handoffBytes: number;
  responseText: string | null;
  usage: ThreeTierUsage;
  errorMessage: string | null;
  dispatchedAt: string;
  settledAt: string | null;
}

export interface ScopedTurnClaims {
  token: string;
  principalKind: 'thread_owner' | 'task_lead' | 'task_worker';
  memberId: string;
  attemptId: string;
  threadId: string;
  taskId: string | null;
  runId: string | null;
  stepId: string | null;
  allowedArtifactIds: string[];
  toolPolicy: ToolPolicy;
  expiresAt: number;
}

export type SpaceItemKind = 'document' | 'file' | 'link';

export interface SpaceFolderRecord {
  id: string;
  threadId: string;
  parentFolderId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceFileRecord {
  id: string;
  threadId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  storageRelPath: string;
  sha256: string;
  uploaderId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceLinkRecord {
  id: string;
  threadId: string;
  title: string;
  url: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceItemView {
  kind: SpaceItemKind;
  id: string;
  threadId: string;
  title: string;
  folderId: string | null;
  pinnedAt: string | null;
  deletedAt: string | null;
  updatedAt: string;
  createdAt: string;
  previewKind?: 'markdown' | 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'binary' | 'link';
  version?: number;
  taskId?: string | null;
  runId?: string | null;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  url?: string;
  note?: string;
  excerpt?: string;
}

export interface WorkspaceFileEntry {
  name: string;
  relPath: string;
  kind: 'dir' | 'file';
  sizeBytes: number;
  updatedAt: string;
}

export type MaterialTaskRole = 'input' | 'output' | 'reference';

export interface MaterialTaskLinkRecord {
  id: string;
  threadId: string;
  objectKind: SpaceItemKind;
  objectId: string;
  taskId: string;
  taskTitle: string;
  role: MaterialTaskRole;
  resourceVersion: number;
  currentVersion: number;
  versionChanged: boolean;
  taskStatus: string;
  origin: 'manual' | 'generated';
  createdAt: string;
}

export interface MaterialContextResult {
  kind: SpaceItemKind;
  id: string;
  currentVersion: number;
  tasks: MaterialTaskLinkRecord[];
  sources: Array<{
    id: string;
    authorKind: string;
    authorId: string;
    body: string;
    createdAt: string;
  }>;
  url?: string;
}

export interface MemberUsageSummary {
  lastDispatchStatus: DispatchAttemptStatus | null;
  memberId: string;
  workbenchDispatches: number;
  nativeTurns: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  lastActiveAt: string | null;
}

export interface DuolaBasePublicStatus {
  enabled: boolean;
  endpoint: string;
  hasToken: boolean;
  tokenSource: 'env' | 'settings' | 'codex_config' | 'mock' | 'none';
  consoleUrl: string;
}
