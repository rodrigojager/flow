import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
    validateProductionReview, type FrozenProductionManifest, type ProductionReviewerRole,
    type ProductionReviewResult, type TrustedProductionReviewerAssignment,
    type VerifiedProductionVisualReceipt, type FlowStudioGraph, type FlowStudioNode,
    type FlowStudioToolAdapter
} from '@cybervinci/flow-shared';
import { FlowStudioRunManager } from './run-manager';
import { FlowStudioFileRunStore, type FlowStudioRunRecord } from './run-store';

export interface ProductionCatalogEntry { id: string; [key: string]: unknown }
export type ProductionPreparation = { status: 'READY'; brief: unknown } | { status: 'BLOCKED'; reasons: string[] };
export interface ProductionReceipt { invocationId: string; sessionId: string; [key: string]: unknown }
export interface ProductionFrozen {
    manifest: FrozenProductionManifest;
    producerSessionId: string;
    visualProbePassed: boolean;
    [key: string]: unknown;
}
/** Trusted host classification of a completed, correctable failure, never raw model output. */
export interface ProductionCorrection { status: 'REVISE'; reasons: string[]; [key: string]: unknown }
/** Host transport receipt for a real read-only policy enrollment, NOT an asset grade. */
export interface ProductionReviewerEnrollment {
    role: ProductionReviewerRole;
    invocationId: string;
    sessionId: string;
    modelId: string;
    scopeHash: string;
    rubricHash: string;
    ready: boolean;
    blockers: string[];
    metadata?: Record<string, unknown>;
}
/** Fixed order: artistic, technical. Enrollment IDs are the original invocationIds. */
export type ProductionReviewerEnrollments = [ProductionReviewerEnrollment, ProductionReviewerEnrollment];
export interface ProductionJudgeReview {
    assignment: TrustedProductionReviewerAssignment;
    visualReceipt: VerifiedProductionVisualReceipt;
    /** Required with enrollment enabled; trusted transport metadata, not model echoes. */
    enrollmentId?: string;
    modelId?: string;
    [key: string]: unknown;
}
type Outstanding = Record<ProductionReviewerRole, string[]>;
export interface ProductionRevisionOutputs {
    prepare?: ProductionPreparation;
    enrollArtistic?: ProductionReviewerEnrollment;
    enrollTechnical?: ProductionReviewerEnrollment;
    enrollment?: { ok: boolean; reasons: string[]; briefPolicyHash: string; sourceRunId: string; reviewerEnrollments?: ProductionReviewerEnrollments };
    produce?: ProductionReceipt;
    freeze?: ProductionFrozen | ProductionCorrection;
    verify?: { ok: boolean; reasons: string[]; correction?: true };
    artistic?: ProductionJudgeReview;
    technical?: ProductionJudgeReview;
    finalize?: ProductionReviewResult;
}
export interface ProductionRevisionHistory {
    assetId: string; revision: number; runId?: string; checkpointId?: string;
    outputs: ProductionRevisionOutputs; result: ProductionReviewResult;
    effectIds: string[];
}
export interface ProductionQueueState {
    version: 1; catalogHash: string; queue: ProductionCatalogEntry[];
    status: 'RUNNING' | 'WAITING' | 'PAUSED' | 'COMPLETED'; reasons: string[];
    current: number; revision: number; runIds: string[]; history: ProductionRevisionHistory[];
    unresolvedByRole: Outstanding;
    approvals: Array<{ assetId: string; revision: number; runId: string; manifestHash: string }>;
    pending?: { token: string; entry: ProductionCatalogEntry; revision: number; idempotencyKey: string; runId?: string };
    /** Superseded read-only preparation runs remain unchanged in runs/ and history. */
    preparationRetries?: Array<{ oldRunId: string; checkpointId: string; assetId: string; revision: number; catalogHash: string; reason: string; at: string }>;
}
export interface ProductionInvocation {
    entry: ProductionCatalogEntry; assetId: string; revision: number; idempotencyKey: string;
    runId: string; signal: AbortSignal; history: ProductionRevisionHistory[]; unresolvedByRole: Outstanding;
    reviewerEnrollments?: ProductionReviewerEnrollments;
    /** Original enrollment brief, unchanged even if later revision instructions change. */
    enrollmentBrief?: unknown;
}
export interface ProductionAdapters {
    prepare(args: ProductionInvocation): Promise<ProductionPreparation>;
    enrollReviewer?(role: ProductionReviewerRole, args: ProductionInvocation & { brief: unknown; readonly: true }): Promise<ProductionReviewerEnrollment>;
    produce(args: ProductionInvocation & { brief: unknown }): Promise<ProductionReceipt>;
    freeze(args: ProductionInvocation & { brief: unknown; receipt: ProductionReceipt }): Promise<ProductionFrozen | ProductionCorrection>;
    verifyFrozen(args: ProductionInvocation & { frozen: ProductionFrozen; phase: 'before-review' | 'before-approval' }): Promise<boolean>;
    review(role: ProductionReviewerRole, args: ProductionInvocation & { frozen: ProductionFrozen; enrollment?: ProductionReviewerEnrollment }): Promise<ProductionJudgeReview>;
    freezeEffect?: 'read' | 'command';
    /** Default read. Network invocations require an explicit host-enforced endpoint. */
    reviewEffect?: 'read' | 'network';
    reviewEndpoint?: string;
}
export interface ProductionQueueOptions {
    stateDir: string;
    queue: Array<string | ProductionCatalogEntry>;
    adapters: ProductionAdapters;
    /** Total revision invocations in this call, across all assets; required and finite. */
    maxRevisionsPerSession: number;
    maxAssetsPerSession?: number;
    /** Per revision, including host callbacks. Default: 30 minutes. */
    timeoutMs?: number;
    signal?: AbortSignal;
}
export interface ProductionPreparationRetryOptions {
    stateDir: string;
    expectedRunId: string;
    expectedCatalogHash: string;
    reason: string;
}

/** Host-only reconciliation, not replay: permits a NEW preparation invocation on
 * the next runProductionQueue call. No callbacks, approvals or old-run writes.
 * Existing run leases are always rejected here, even when apparently stale. */
export async function retryProductionPreparation(options: ProductionPreparationRetryOptions): Promise<ProductionQueueState> {
    const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
    const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
    if (!text(options.reason) || !text(options.stateDir) || !text(options.expectedRunId)
        || !/^[a-zA-Z0-9:_-]{8,160}$/.test(options.expectedRunId) || !/^[0-9a-f]{64}$/.test(options.expectedCatalogHash)) {
        throw new Error('Preparation retry requires a nonblank reason, stateDir and valid expected run/catalog IDs.');
    }
    const root = await fs.realpath(options.stateDir), target = path.join(root, 'queue.json');
    const release = await acquireProductionQueueLock(root);
    try {
        const serialized = await fs.readFile(target, 'utf8');
        const state: ProductionQueueState = JSON.parse(serialized);
        if (!state || state.version !== 1 || state.status !== 'WAITING' || state.catalogHash !== options.expectedCatalogHash
            || !Array.isArray(state.queue) || !state.queue.every(e => e && typeof e === 'object' && !Array.isArray(e) && text(e.id))
            || !ids(state.queue.map(e => e.id)) || hash(state.queue) !== state.catalogHash
            || !Number.isSafeInteger(state.current) || state.current < 0 || state.current >= state.queue.length
            || !Number.isSafeInteger(state.revision) || state.revision < 1 || !Array.isArray(state.reasons) || !state.reasons.every(text)
            || !ids(state.runIds) || state.runIds.at(-1) !== options.expectedRunId || !Array.isArray(state.history) || !state.history.length
            || !Array.isArray(state.approvals) || state.approvals.length !== state.current
            || !state.unresolvedByRole || !isDeepStrictEqual(Object.keys(state.unresolvedByRole).sort(), ['artistic', 'technical'])
            || !ids(state.unresolvedByRole.artistic) || !ids(state.unresolvedByRole.technical)) {
            throw new Error('Invalid canonical WAITING queue state or changed catalog; preparation retry denied.');
        }
        const entry = state.queue[state.current], pending = state.pending, latest = state.history.at(-1)!;
        const key = `production:${state.catalogHash}:${hash(entry.id)}:${state.revision}`;
        const preparation = latest?.outputs?.prepare;
        if (!pending || pending.runId !== options.expectedRunId || !text(pending.token) || pending.revision !== state.revision
            || pending.idempotencyKey !== key || !isDeepStrictEqual(pending.entry, entry)
            || latest?.runId !== pending.runId || latest.assetId !== entry.id || latest.revision !== state.revision
            || latest.result?.verdict !== 'WAIT' || !text(latest.checkpointId) || !ids(latest.effectIds) || latest.effectIds.length !== 1
            || !isDeepStrictEqual(Object.keys(latest.outputs), ['prepare']) || preparation?.status !== 'BLOCKED'
            || !Array.isArray(preparation.reasons) || !preparation.reasons.length || !preparation.reasons.every(text)
            || !isDeepStrictEqual(latest.result.reasons, preparation.reasons)
            || state.history.some((h, i) => !h || h.runId !== state.runIds[i]) || state.history.length !== state.runIds.length
            || state.history.slice(0, -1).some(h => h.assetId === entry.id && h.revision === state.revision
                && (!state.preparationRetries?.some(r => r.oldRunId === h.runId) || !isDeepStrictEqual(Object.keys(h.outputs), ['prepare'])))
            || state.approvals.some((a, i) => !a || a.assetId !== state.queue[i].id || !Number.isSafeInteger(a.revision) || a.revision < 1
                || !state.history.some(h => h.runId === a.runId && h.assetId === a.assetId && h.revision === a.revision
                    && h.result?.verdict === 'ACCEPT' && !isProductionCorrection(h.outputs.freeze) && h.outputs.freeze?.manifest.manifestHash === a.manifestHash))
            || (state.preparationRetries !== undefined && (!Array.isArray(state.preparationRetries)
                || !ids(state.preparationRetries.map(r => r?.oldRunId)) || state.preparationRetries.some(r => !r
                    || r.oldRunId === pending.runId || r.catalogHash !== state.catalogHash || !text(r.reason) || !Number.isFinite(Date.parse(r.at))
                    || !state.history.some(h => h.runId === r.oldRunId && h.assetId === r.assetId && h.revision === r.revision
                        && h.checkpointId === r.checkpointId && h.outputs?.prepare?.status === 'BLOCKED' && h.result?.verdict === 'WAIT'))))) {
            throw new Error('Pending revision is not the matching, completed BLOCKED preparation history.');
        }
        const store = new FlowStudioFileRunStore(path.join(root, 'runs'));
        if (!await store.get(pending.runId)) throw new Error('Preparation run is missing; retry denied.');
        const lease = await store.claimRunLease(pending.runId, { recoverStale: false });
        if (!lease) throw new Error('Preparation run already has a lease; stale recovery is disabled for preparation retry.');
        try {
            const record = await store.get(pending.runId), stages = ['prepare', 'ready', 'wait'];
            if (!record || record.status !== 'waiting' || record.error !== undefined || record.parentRunId !== undefined
                || record.result?.status !== 'waiting' || record.result.runId !== pending.runId || record.result.error !== undefined || record.result.parentRunId !== undefined
                || record.graph.id !== 'production-revision' || record.graph.version !== 'flow-studio/v2' || record.graph.start !== 'prepare'
                || record.result.graphId !== record.graph.id || !isDeepStrictEqual(record.result.visited, stages)
                || !isDeepStrictEqual(record.input.entry, entry) || record.input.revision !== state.revision || record.input.catalogHash !== state.catalogHash
                || !isDeepStrictEqual(record.input.unresolvedByRole, state.unresolvedByRole)
                || !isDeepStrictEqual(record.input.pending, { token: pending.token, entry, revision: state.revision, idempotencyKey: key })
                || record.effects.length !== 1 || !isDeepStrictEqual(record.effects.map(e => e.id), latest.effectIds)) {
                throw new Error('Persisted run is not the original waiting preparation-only invocation.');
            }
            const effect = record.effects[0], checkpoint = record.checkpoints.at(-1);
            const graphDigest = createHash('sha256').update(JSON.stringify(record.graph)).digest('hex');
            const tool = record.graph.nodes.find(n => n.id === 'prepare')?.tools?.[0];
            const events = ['run.started', 'node.enter', 'node.success', 'effect.started', 'effect.completed', 'checkpoint.created', 'wait.started', 'budget.updated'];
            // Compare the complete raw receipt, not deepMerge-sanitized checkpoint context.
            if (effect.nodeId !== 'prepare' || effect.toolId !== 'host:prepare' || effect.runId !== pending.runId
                || effect.status !== 'completed' || !['read', 'none'].includes(effect.kind) || effect.error !== undefined
                || effect.idempotencyKey !== `${key}:prepare` || !text(effect.inputDigest)
                || !Number.isFinite(Date.parse(effect.startedAt)) || !text(effect.finishedAt) || !Number.isFinite(Date.parse(effect.finishedAt))
                || Date.parse(effect.finishedAt) < Date.parse(effect.startedAt)
                || !isDeepStrictEqual(effect.output, latest.outputs)
                || tool?.id !== 'host:prepare' || tool.command !== 'host:prepare' || tool.effect !== effect.kind
                || tool.idempotencyKey !== effect.idempotencyKey || record.graph.nodes.find(n => n.id === 'prepare')?.type !== 'action'
                || record.graph.nodes.find(n => n.id === 'wait')?.type !== 'wait' || record.graph.nodes.find(n => n.id === 'wait')?.next !== 'end'
                || record.graph.nodes.find(n => n.id === 'end')?.type !== 'end'
                || !checkpoint || checkpoint.id !== latest.checkpointId || checkpoint.reason !== 'wait' || checkpoint.nodeId !== 'wait'
                || checkpoint.nextNodeId !== 'end' || checkpoint.wait?.kind !== 'event' || checkpoint.wait.eventName !== 'production.reconciled'
                || record.result.waiting?.checkpointId !== checkpoint.id || record.result.waiting.nodeId !== 'wait' || record.result.waiting.kind !== 'wait'
                || !isDeepStrictEqual(checkpoint.visited, stages) || !isDeepStrictEqual(record.checkpoints.map(c => c.nodeId), stages)
                || record.checkpoints.some((c, i) => c.runId !== pending.runId || c.graphId !== record.graph.id || c.graphVersion !== record.graph.version
                    || c.graphDigest !== graphDigest || c.reason !== (i === 2 ? 'wait' : 'node-complete') || c.metadata?.replayable === false
                    || c.nextNodeId !== ['ready', 'wait', 'end'][i] || !isDeepStrictEqual(c.visited, stages.slice(0, i + 1)) || !isDeepStrictEqual(c.effects, record.effects))
                || !isDeepStrictEqual(record.events.filter(e => e.kind === 'node.enter').map(e => e.nodeId), stages)
                || ['run.started', 'effect.started', 'effect.completed'].some(kind => record.events.filter(e => e.kind === kind).length !== 1)
                || record.events.some(e => e.runId !== pending.runId || !events.includes(e.kind) || (e.nodeId !== undefined && !stages.includes(e.nodeId))
                    || (e.kind.startsWith('effect.') && (e.nodeId !== 'prepare' || e.detail?.effectId !== effect.id))
                    || (e.kind === 'effect.started' && e.detail?.kind !== effect.kind))
                || (record.result.effects.length > 0 && !isDeepStrictEqual(record.result.effects, record.effects))
                || (record.result.checkpoints.length > 0 && !isDeepStrictEqual(record.result.checkpoints, record.checkpoints))
                || (record.result.events.length > 0 && !isDeepStrictEqual(record.result.events, record.events))) {
                throw new Error('Run receipts/checkpoints contain missing, changed, unsafe or non-preparation evidence; retry denied.');
            }
            await lease.assertOwned();
            if (await fs.readFile(target, 'utf8') !== serialized) throw new Error('Queue changed during preparation reconciliation.');
            state.preparationRetries = [...(state.preparationRetries || []), { oldRunId: pending.runId, checkpointId: checkpoint.id,
                assetId: entry.id, revision: state.revision, catalogHash: state.catalogHash, reason: options.reason, at: new Date().toISOString() }];
            state.status = 'PAUSED';
            delete state.pending;
            await atomicSave(target, state);
            return copy(state);
        } finally { await lease.release(); }
    } finally { await release(); }
}

/**
 * Trusted HOST API, not an agent tool. All callback data must be JSON; arguments
 * and returned values are copied, never references to owner state. The host MUST
 * isolate agents from stateDir (including runs/), control files and other writers.
 * prepare/verifyFrozen are read-only; freeze/review effects must describe reality.
 * freeze may return a host-audited ProductionCorrection for a completed INVALID
 * import. Its top-level status is reserved for REVISE, with nonblank reasons;
 * BLOCKED/malformed statuses wait, and exceptions remain uncertain, never retries.
 * verifyFrozen rehashes actual files, scope/rubric/references/evidence and verifies
 * signatures/attachments; visual flags and session IDs come from host verification,
 * not model echoes. Frozen files must remain immutable through the approval commit.
 * Callbacks must stop their entire invocation on signal abort; an in-process API
 * cannot sandbox JS, terminate an external agent, or enforce filesystem ACLs.
 * WAIT/pending never retries or replays. Reconciliation is explicitly host-owned.
 * PAUSED budgets may continue by calling again with the identical catalog.
 * Optional enrollReviewer must run independent read-only agents with no Blender
 * access or asset/control writes. Ready enrollments become idle policy receipts,
 * not long-lived/busy subprocesses. Later grades use fresh sessions, pinned models,
 * the original enrollmentBrief/metadata, enrollmentId and full asset history.
 * The first validated pair is reused, never replaced to seek favorable opinions.
 * Without both brief.scopeHash/rubricHash, the whole opaque brief is policy-bound
 * and must stay unchanged across revisions; frozen scope/rubric must still match.
 * Existing locks, even stale/malformed ones, are rejected: verify the owner PID
 * and reconcile pending effects before explicit offline recovery. No lock stealing.
 */
export async function runProductionQueue(options: ProductionQueueOptions): Promise<ProductionQueueState> {
    const source = options.adapters, signal = options.signal;
    for (const method of ['prepare', 'produce', 'freeze', 'verifyFrozen', 'review'] as const) {
        if (typeof source?.[method] !== 'function') throw new Error(`Production adapter ${method} must be a function.`);
    }
    if (source.enrollReviewer !== undefined && typeof source.enrollReviewer !== 'function') throw new Error('Production adapter enrollReviewer must be a function.');
    const host: ProductionAdapters = {
        prepare: source.prepare.bind(source), produce: source.produce.bind(source), freeze: source.freeze.bind(source),
        verifyFrozen: source.verifyFrozen.bind(source), review: source.review.bind(source),
        enrollReviewer: source.enrollReviewer?.bind(source),
        freezeEffect: source.freezeEffect, reviewEffect: source.reviewEffect, reviewEndpoint: source.reviewEndpoint
    };
    const limit = options.maxRevisionsPerSession, assets = options.maxAssetsPerSession ?? Number.MAX_SAFE_INTEGER;
    const timeout = options.timeoutMs ?? 30 * 60_000;
    if (![limit, assets, timeout].every(n => Number.isSafeInteger(n) && n > 0) || timeout > 2_147_483_647) {
        throw new Error('Session limits and timeout must be finite positive safe integers (timeout <= 2147483647).');
    }
    if (host.reviewEffect === 'network') {
        const endpoint = new URL(host.reviewEndpoint || '');
        if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
            throw new Error('reviewEndpoint requires an HTTP(S) URL without credentials, query or fragment.');
        }
    }
    const queue = copy(options.queue.map(entry => typeof entry === 'string' ? { id: entry } : entry));
    if (queue.some(entry => !entry || typeof entry.id !== 'string' || !entry.id.trim()) || new Set(queue.map(e => e.id)).size !== queue.length) {
        throw new Error('Queue requires unique nonblank asset IDs.');
    }
    const catalogHash = hash(queue), root = path.resolve(options.stateDir), target = path.join(root, 'queue.json');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const release = await acquireProductionQueueLock(root);
    const inFlight = new Set<Promise<unknown>>();
    let completion: Promise<FlowStudioRunRecord> | undefined;
    try {
        let state: ProductionQueueState;
        try { state = JSON.parse(await fs.readFile(target, 'utf8')); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            state = { version: 1, catalogHash, queue, status: 'PAUSED', reasons: [], current: 0, revision: 1,
                runIds: [], history: [], approvals: [], unresolvedByRole: { artistic: [], technical: [] } };
        }
        if (state.version !== 1 || state.catalogHash !== catalogHash || hash(state.queue) !== catalogHash
            || !Number.isSafeInteger(state.current) || state.current < 0 || state.current > queue.length
            || !Number.isSafeInteger(state.revision) || state.revision < 1 || state.approvals.length !== state.current) {
            throw new Error('Invalid queue state or changed catalog; refusing callbacks.');
        }
        if (state.pending || state.status === 'RUNNING' || state.status === 'WAITING') {
            state.status = 'WAITING';
            state.reasons = [...new Set([...state.reasons, 'Pending revision requires explicit host reconciliation; no automatic replay.'])];
            await atomicSave(target, state);
            return copy(state);
        }
        const manager = new FlowStudioRunManager(new FlowStudioFileRunStore(path.join(root, 'runs')));
        let revisions = 0, accepted = 0;
        while (state.current < queue.length && revisions < limit && accepted < assets && !signal?.aborted) {
            const entry = queue[state.current], revision = state.revision;
            const key = `production:${catalogHash}:${hash(entry.id)}:${revision}`;
            const history = copy(state.history.filter(item => item.assetId === entry.id));
            const enrollmentOrigin = history.find(h => ['enrollArtistic', 'enrollTechnical', 'enrollment'].some(k => Object.hasOwn(h.outputs, k)));
            if (enrollmentOrigin && !host.enrollReviewer) throw new Error('This asset already requires reviewer enrollment; removing the adapter cannot bypass it.');
            const unresolved = copy(state.unresolvedByRole), outputs: ProductionRevisionOutputs = {};
            state.pending = { token: randomUUID(), entry: copy(entry), revision, idempotencyKey: key };
            state.status = 'RUNNING'; state.reasons = [];
            await atomicSave(target, state);
            let arm!: () => void, armed = false, interrupted = false;
            const barrier = new Promise<void>(resolve => { arm = resolve; });
            let runId: string | undefined, record: FlowStudioRunRecord | undefined;
            let timer: ReturnType<typeof setTimeout> | undefined, grace: ReturnType<typeof setTimeout> | undefined;
            let stopWait!: (value: undefined) => void;
            const stopped = new Promise<undefined>(resolve => { stopWait = resolve; });
            const stop = () => {
                if (interrupted) return;
                interrupted = true;
                if (runId) manager.cancel(runId);
                grace = setTimeout(() => stopWait(undefined), 1000);
            };
            const adapters: Record<string, FlowStudioToolAdapter> = {};
            const bind = (id: keyof ProductionRevisionOutputs, fn: (args: ProductionInvocation, raw: ProductionRevisionOutputs) => Promise<unknown>) => {
                adapters[`host:${id}`] = async args => {
                    await barrier;
                    if (!armed || interrupted) throw new Error('Revision not armed or interrupted.');
                    args.signal!.throwIfAborted();
                    const task = (async () => {
                        // Engine context merges remove constructor/prototype/__proto__.
                        // Host callbacks and strict policy must consume the original snapshots.
                        const value = await fn({ ...copy({ entry, assetId: entry.id, revision, idempotencyKey: key,
                            history, unresolvedByRole: unresolved, ...(outputs.enrollment?.ok ? {
                                reviewerEnrollments: outputs.enrollment.reviewerEnrollments,
                                enrollmentBrief: ((enrollmentOrigin?.outputs.prepare ?? outputs.prepare) as { brief: unknown }).brief
                            } : {}) }), runId: args.runId, signal: args.signal! }, copy(outputs));
                        args.signal!.throwIfAborted();
                        const saved = copy(value);
                        Object.assign(outputs, { [id]: saved });
                        return { output: { [id]: copy(saved) } };
                    })();
                    inFlight.add(task);
                    try { return await task; } finally { inFlight.delete(task); }
                };
            };
            bind('prepare', async args => {
                const value = await host.prepare(args);
                if (!value || (value.status !== 'READY' && value.status !== 'BLOCKED')
                    || (value.status === 'READY' ? !Object.hasOwn(value, 'brief')
                        : !Array.isArray(value.reasons) || !value.reasons.length || value.reasons.some(r => typeof r !== 'string' || !r.trim()))) {
                    throw new Error('prepare must return READY + brief or BLOCKED + reasons.');
                }
                return value;
            });
            if (host.enrollReviewer) {
                for (const [id, role] of [['enrollArtistic', 'artistic'], ['enrollTechnical', 'technical']] as const) {
                    bind(id, (args, raw) => enrollmentOrigin
                        ? Promise.resolve(enrollmentOrigin.outputs[id])
                        : host.enrollReviewer!(role, { ...args, brief: (raw.prepare as { brief: unknown }).brief, readonly: true }));
                }
                bind('enrollment', async (args, raw) => {
                    const checked = validateReviewerEnrollments((raw.prepare as { brief: unknown }).brief,
                        [raw.enrollArtistic, raw.enrollTechnical], enrollmentOrigin);
                    if (!enrollmentOrigin) {
                        const prior = state.history.flatMap(h => [h.outputs.produce, h.outputs.artistic?.assignment, h.outputs.technical?.assignment,
                            h.outputs.enrollArtistic, h.outputs.enrollTechnical]);
                        if ([raw.enrollArtistic, raw.enrollTechnical].some(e => e && prior.some(p => p
                            && (p.sessionId === e.sessionId || p.invocationId === e.invocationId)))) {
                            checked.ok = false; checked.reasons.push('Enrollment requires distinct new invocation/session IDs.');
                            delete checked.reviewerEnrollments;
                        }
                    }
                    return { ...checked, sourceRunId: enrollmentOrigin?.runId ?? args.runId };
                });
            }
            bind('produce', (args, raw) => {
                if (host.enrollReviewer && (!raw.enrollment?.ok || !args.reviewerEnrollments)) throw new Error('Both reviewer enrollments must be verified before production.');
                return host.produce({ ...args, brief: (raw.prepare as { brief: unknown }).brief });
            });
            bind('freeze', (args, raw) => host.freeze({ ...args, brief: (raw.prepare as { brief: unknown }).brief, receipt: raw.produce! }));
            bind('verify', async (args, raw) => {
                const f = raw.freeze, p = raw.produce;
                if (isProductionCorrection(f)) return { ok: false, correction: true, reasons: f.reasons };
                if (f && Object.hasOwn(f, 'status')) return { ok: false, reasons: ['Invalid freeze correction; expected REVISE with nonempty nonblank reasons.'] };
                const bound = !!f?.manifest && f.manifest.assetId === entry.id && f.manifest.revision === revision
                    && f.visualProbePassed === true
                    && !!p?.invocationId?.trim() && !!p?.sessionId?.trim()
                    && f.manifest.producerInvocationId === p.invocationId && f.producerSessionId === p.sessionId
                    && (!host.enrollReviewer || (raw.enrollment?.ok === true && args.reviewerEnrollments?.every(e =>
                        e.scopeHash === f.manifest.scopeHash && e.rubricHash === f.manifest.rubricHash
                        && e.invocationId !== p.invocationId && e.sessionId !== p.sessionId)));
                const ok = bound && await host.verifyFrozen({ ...args, frozen: copy(f!), phase: 'before-review' }) === true;
                return { ok, reasons: ok ? [] : ['Frozen manifest binding or pre-review verification failed.'] };
            });
            for (const role of ['artistic', 'technical'] as const) bind(role, (args, raw) => {
                if (!raw.freeze || isProductionCorrection(raw.freeze)) throw new Error('Review requires a frozen candidate, not a correction.');
                return host.review(role, { ...args, frozen: raw.freeze,
                    ...(args.reviewerEnrollments ? { enrollment: args.reviewerEnrollments[role === 'artistic' ? 0 : 1] } : {}) });
            });
            bind('finalize', async (args, raw) => {
                const frozen = raw.freeze!, reviews = [raw.artistic!, raw.technical!];
                if (isProductionCorrection(frozen)) return { verdict: 'REVISE', reasons: frozen.reasons };
                if (await host.verifyFrozen({ ...args, frozen: copy(frozen), phase: 'before-approval' }) !== true) {
                    return { verdict: 'WAIT', reasons: ['Frozen files/signatures changed before approval.'] };
                }
                const result = validateProductionReview({ manifest: frozen.manifest, producerSessionId: frozen.producerSessionId,
                    visualProbePassed: frozen.visualProbePassed, reviewers: reviews.map(r => r?.assignment),
                    verifiedVisualReceipts: reviews.map(r => r?.visualReceipt), unresolvedByRole: unresolved });
                const prior = [...state.history.flatMap(item => [item.outputs.artistic?.assignment, item.outputs.technical?.assignment, item.outputs.produce,
                    item.outputs.enrollArtistic, item.outputs.enrollTechnical]), ...(args.reviewerEnrollments ?? [])];
                if (reviews.some((r, i) => r?.assignment?.role !== (i === 0 ? 'artistic' : 'technical')
                    || prior.some(p => p && (p.sessionId === r?.assignment?.sessionId || p.invocationId === r?.assignment?.invocationId)))) {
                    return { verdict: 'WAIT', reasons: [...result.reasons, 'Reviewer role mismatch or reused invocation/session.'] };
                }
                if (host.enrollReviewer && (!raw.enrollment?.ok || !args.reviewerEnrollments
                    || reviews.some((r, i) => r?.enrollmentId !== args.reviewerEnrollments![i].invocationId || r?.modelId !== args.reviewerEnrollments![i].modelId))) {
                    return { verdict: 'WAIT', reasons: [...result.reasons, 'Grade must bind to the original reviewer enrollment and pinned model.'] };
                }
                return result;
            });
            let failure: string | undefined;
            try {
                record = await manager.start({ graph: revisionGraph(key, timeout, host), toolAdapters: adapters,
                    input: { entry: copy(entry), revision, catalogHash, pending: copy(state.pending), unresolvedByRole: unresolved } });
                runId = record.id; state.pending.runId = runId; state.runIds.push(runId);
                await atomicSave(target, state);
                completion = manager.wait(runId);
                armed = true; arm();
                signal?.addEventListener('abort', stop, { once: true });
                timer = setTimeout(stop, timeout);
                if (signal?.aborted) stop();
                record = await Promise.race([completion, stopped]);
                if (record) completion = undefined;
            } catch (error) {
                failure = error instanceof Error ? error.message : String(error);
                if (runId) { manager.cancel(runId); completion ??= manager.wait(runId); }
            } finally {
                armed = false; arm();
                clearTimeout(timer); clearTimeout(grace);
                signal?.removeEventListener('abort', stop);
            }
            const ambiguous = record?.effects.some(e => e.status === 'uncertain' || e.status === 'started');
            const reasons = failure ? [failure] : interrupted ? ['Revision timed out or cancelled; reconcile effects.']
                : record?.error ? [record.error] : outputs.prepare?.status === 'BLOCKED' ? outputs.prepare.reasons
                    : outputs.enrollment?.ok === false ? outputs.enrollment.reasons
                        : outputs.verify?.ok === false ? outputs.verify.reasons : outputs.finalize?.reasons ?? [];
            const result: ProductionReviewResult = !failure && !interrupted && !ambiguous && record?.status === 'completed' && outputs.finalize
                ? copy(outputs.finalize) : { verdict: 'WAIT', reasons: reasons.length ? [...reasons] : ['Revision did not complete; reconcile effects.'] };
            state.history.push(copy({ assetId: entry.id, revision, runId, checkpointId: record?.result?.waiting?.checkpointId
                ?? record?.checkpoints.at(-1)?.id, outputs, result, effectIds: record?.effects.map(e => e.id) ?? [] }));
            updateOutstanding(state.unresolvedByRole, outputs, result.verdict !== 'WAIT');
            state.reasons = result.reasons;
            revisions++;
            if (result.verdict === 'ACCEPT' && !isProductionCorrection(outputs.freeze)) {
                state.approvals.push({ assetId: entry.id, revision, runId: runId!, manifestHash: outputs.freeze!.manifest.manifestHash });
                state.current++; state.revision = 1; accepted++;
                state.unresolvedByRole = { artistic: [], technical: [] };
            } else if (result.verdict === 'REVISE' && revision < Number.MAX_SAFE_INTEGER) state.revision++;
            else { state.status = 'WAITING'; await atomicSave(target, state); return copy(state); }
            delete state.pending;
            state.status = state.current === queue.length ? 'COMPLETED' : 'PAUSED';
            await atomicSave(target, state);
        }
        state.status = state.current === queue.length ? 'COMPLETED' : 'PAUSED';
        state.reasons = state.status === 'PAUSED' ? ['Session budget exhausted or cancelled before next revision; not an approval.'] : [];
        await atomicSave(target, state);
        return copy(state);
    } finally {
        // Engine timeout cannot forcibly stop arbitrary JS. Keep the host lock
        // until even non-cooperative callbacks settle, not merely the engine run.
        if (completion || inFlight.size) {
            void (async () => { await completion?.catch(() => undefined); await Promise.allSettled([...inFlight]); await release(); })().catch(() => undefined);
        } else await release();
    }
}

function revisionGraph(key: string, timeoutMs: number, host: ProductionAdapters): FlowStudioGraph {
    const action = (id: string, effect: 'read' | 'command' | 'network', next: string): FlowStudioNode => ({
        id, type: 'action', label: id, next, outputs: { [id]: id },
        tools: [{ id: `host:${id}`, name: id, command: `host:${id}`, effect, retries: 0, timeoutMs,
            args: effect === 'network' ? [host.reviewEndpoint!] : undefined,
            idempotencyKey: `${key}:${id}`, requiredPermissions: [`tool:${effect}`] }]
    });
    return {
        version: 'flow-studio/v2', id: 'production-revision', name: 'One frozen production revision', start: 'prepare',
        permissions: { allow: ['tool:read', 'tool:command', 'tool:network'],
            networkHosts: host.reviewEffect === 'network' ? [new URL(host.reviewEndpoint!).hostname] : undefined,
            commandPatterns: ['host:prepare', 'host:produce', 'host:freeze', 'host:verify', 'host:artistic', 'host:technical', 'host:finalize',
                ...(host.enrollReviewer ? ['host:enrollArtistic', 'host:enrollTechnical', 'host:enrollment'] : [])] },
        budget: { maxSteps: host.enrollReviewer ? 32 : 24, maxDurationMs: timeoutMs, maxParallelism: 2 },
        nodes: [action('prepare', 'read', 'ready'), { id: 'ready', type: 'router', label: 'Ready?' },
            ...(host.enrollReviewer ? [
                { id: 'enrollmentFork', type: 'fork', label: 'Initial read-only policy enrollment',
                    fork: { branches: ['enrollArtistic', 'enrollTechnical'], join: 'enrollmentJoined', maxConcurrency: 2 } },
                action('enrollArtistic', 'read', 'enrollmentJoined'), action('enrollTechnical', 'read', 'enrollmentJoined'),
                { id: 'enrollmentJoined', type: 'join', label: 'Both enrollments', join: { strategy: 'all' }, next: 'enrollment' },
                action('enrollment', 'read', 'enrollmentReady'), { id: 'enrollmentReady', type: 'router', label: 'Both enrolled and policy-bound?' }
            ] satisfies FlowStudioNode[] : []),
            action('produce', 'command', 'freeze'), action('freeze', host.freezeEffect ?? 'command', 'verify'),
            action('verify', 'read', 'frozen'), { id: 'frozen', type: 'router', label: 'Verified freeze?' },
            { id: 'reviews', type: 'fork', label: 'Independent judges', fork: { branches: ['artistic', 'technical'], join: 'joined', maxConcurrency: 2 } },
            action('artistic', host.reviewEffect ?? 'read', 'joined'), action('technical', host.reviewEffect ?? 'read', 'joined'),
            { id: 'joined', type: 'join', label: 'Both judges', join: { strategy: 'all' }, next: 'finalize' },
            action('finalize', 'read', 'decision'), { id: 'decision', type: 'router', label: 'Review verdict' },
            { id: 'wait', type: 'wait', label: 'Host reconciliation', wait: { kind: 'event', eventName: 'production.reconciled' }, next: 'end' },
            { id: 'end', type: 'end', label: 'ACCEPT or REVISE' }],
        edges: [
            { from: 'ready', to: host.enrollReviewer ? 'enrollmentFork' : 'produce', guard: 'context.prepare.status === "READY"', priority: 0 }, { from: 'ready', to: 'wait', priority: 1 },
            ...(host.enrollReviewer ? [
                { from: 'enrollArtistic', to: 'enrollmentJoined' }, { from: 'enrollTechnical', to: 'enrollmentJoined' },
                { from: 'enrollmentReady', to: 'produce', guard: 'context.enrollment.ok === true', priority: 0 },
                { from: 'enrollmentReady', to: 'wait', priority: 1 }
            ] : []),
            { from: 'frozen', to: 'finalize', guard: 'context.verify.correction === true', priority: 0 },
            { from: 'frozen', to: 'reviews', guard: 'context.verify.ok === true', priority: 1 }, { from: 'frozen', to: 'wait', priority: 2 },
            { from: 'artistic', to: 'joined' }, { from: 'technical', to: 'joined' },
            { from: 'decision', to: 'end', guard: 'context.finalize.verdict === "ACCEPT" || context.finalize.verdict === "REVISE"', priority: 0 },
            { from: 'decision', to: 'wait', priority: 1 }
        ]
    };
}

function validateReviewerEnrollments(brief: unknown, values: unknown[], previous?: ProductionRevisionHistory): Omit<NonNullable<ProductionRevisionOutputs['enrollment']>, 'sourceRunId'> {
    const reasons: string[] = [], fields = ['role', 'invocationId', 'sessionId', 'modelId', 'scopeHash', 'rubricHash', 'ready', 'blockers'];
    const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
    const policyHash = (value: unknown): string => value && typeof value === 'object' && Object.hasOwn(value, 'scopeHash') && Object.hasOwn(value, 'rubricHash')
        ? hash({ scopeHash: (value as Record<string, unknown>).scopeHash, rubricHash: (value as Record<string, unknown>).rubricHash }) : hash(value);
    const briefPolicyHash = policyHash(brief), pair = values as ProductionReviewerEnrollments;
    for (const [i, role] of ['artistic', 'technical'].entries()) {
        const e = pair[i];
        if (!e || typeof e !== 'object' || Array.isArray(e) || fields.some(k => !Object.hasOwn(e, k))
            || Object.keys(e).some(k => !fields.includes(k) && k !== 'metadata')) {
            reasons.push(`${role} enrollment: missing or unexpected fields (no grades allowed).`); continue;
        }
        if (e.role !== role) reasons.push(`${role} enrollment: wrong role.`);
        if (![e.invocationId, e.sessionId, e.modelId].every(text)) reasons.push(`${role} enrollment: trusted invocation/session/model IDs required.`);
        for (const field of ['scopeHash', 'rubricHash'] as const) {
            if (typeof e[field] !== 'string' || !/^[0-9a-f]{64}$/.test(e[field])) reasons.push(`${role} enrollment: invalid ${field}.`);
            if (brief && typeof brief === 'object' && Object.hasOwn(brief, field) && e[field] !== (brief as Record<string, unknown>)[field]) {
                reasons.push(`${role} enrollment: ${field} differs from the host brief.`);
            }
        }
        if (e.ready !== true) reasons.push(`${role} enrollment: reviewer is not ready.`);
        if (!Array.isArray(e.blockers) || !e.blockers.every(text)) reasons.push(`${role} enrollment: malformed blockers.`);
        else if (e.blockers.length) reasons.push(...e.blockers.map(b => `${role} enrollment blocked: ${b}`));
        if (Object.hasOwn(e, 'metadata') && (!e.metadata || typeof e.metadata !== 'object' || Array.isArray(e.metadata))) reasons.push(`${role} enrollment: malformed metadata.`);
    }
    if (pair[0] && pair[1]) {
        if (pair[0].invocationId === pair[1].invocationId || pair[0].sessionId === pair[1].sessionId) reasons.push('Reviewer enrollments require independent invocation/session IDs.');
        if (pair[0].scopeHash !== pair[1].scopeHash || pair[0].rubricHash !== pair[1].rubricHash) reasons.push('Reviewer enrollments must share the same scope and rubric.');
    }
    if (previous) {
        const stored = previous.outputs.enrollment, prepared = previous.outputs.prepare;
        if (stored?.ok !== true || !text(previous.runId) || stored.sourceRunId !== previous.runId || prepared?.status !== 'READY'
            || stored.briefPolicyHash !== policyHash(prepared.brief)
            || !isDeepStrictEqual([previous.outputs.enrollArtistic, previous.outputs.enrollTechnical], stored.reviewerEnrollments)
            || !isDeepStrictEqual(pair, stored.reviewerEnrollments)) reasons.push('First enrollment is unverified or changed; cannot replace it with a new opinion.');
        if (stored?.briefPolicyHash !== briefPolicyHash) reasons.push('Enrollment scope/rubric policy changed; new setup is not automatic.');
    }
    return { ok: reasons.length === 0, reasons, briefPolicyHash, ...(reasons.length ? {} : { reviewerEnrollments: copy(pair) }) };
}

function isProductionCorrection(value: unknown): value is ProductionCorrection {
    const correction = value as Partial<ProductionCorrection> | null;
    return !!correction && typeof correction === 'object' && !Array.isArray(correction)
        && Object.hasOwn(correction, 'status') && correction.status === 'REVISE'
        && Object.hasOwn(correction, 'reasons') && Array.isArray(correction.reasons) && correction.reasons.length > 0
        && correction.reasons.every(reason => typeof reason === 'string' && reason.trim().length > 0);
}

function updateOutstanding(outstanding: Outstanding, outputs: ProductionRevisionOutputs, valid: boolean): void {
    for (const role of ['artistic', 'technical'] as const) {
        const raw = outputs[role]?.assignment?.output as Record<string, unknown> | undefined;
        const resolved = valid && Array.isArray(raw?.resolvedFindingIds) ? raw.resolvedFindingIds : [];
        const ids = new Set(outstanding[role].filter(id => !resolved.includes(id)));
        for (const field of ['open_findings', 'unverified', 'improvements']) {
            if (Array.isArray(raw?.[field])) for (const finding of raw[field]) {
                if (typeof finding?.id === 'string' && finding.id.trim()) ids.add(finding.id);
            }
        }
        outstanding[role] = [...ids];
    }
}

async function acquireProductionQueueLock(root: string): Promise<() => Promise<void>> {
    const lockPath = path.join(root, 'queue.lock');
    const lock = await fs.open(lockPath, 'wx', 0o600).catch(error => {
        if (error.code === 'EEXIST') throw new Error('Production queue locked; verify owner PID before explicit offline recovery. Locks are never stolen.');
        throw error;
    });
    const release = async () => { await lock.close(); await fs.unlink(lockPath); };
    try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() }));
        await lock.sync();
        return release;
    } catch (error) { await release(); throw error; }
}

async function atomicSave(target: string, state: ProductionQueueState): Promise<void> {
    const temporary = `${target}.${randomUUID()}.tmp`;
    const file = await fs.open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); }
    finally { await file.close(); }
    try { await fs.rename(temporary, target); }
    finally { await fs.rm(temporary, { force: true }); }
}

function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function hash(value: unknown): string {
    const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
        : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)])) : item;
    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
