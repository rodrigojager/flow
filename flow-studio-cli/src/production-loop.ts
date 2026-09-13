import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
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
export interface ProductionJudgeReview {
    assignment: TrustedProductionReviewerAssignment;
    visualReceipt: VerifiedProductionVisualReceipt;
    [key: string]: unknown;
}
type Outstanding = Record<ProductionReviewerRole, string[]>;
export interface ProductionRevisionOutputs {
    prepare?: ProductionPreparation;
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
}
export interface ProductionInvocation {
    entry: ProductionCatalogEntry; assetId: string; revision: number; idempotencyKey: string;
    runId: string; signal: AbortSignal; history: ProductionRevisionHistory[]; unresolvedByRole: Outstanding;
}
export interface ProductionAdapters {
    prepare(args: ProductionInvocation): Promise<ProductionPreparation>;
    produce(args: ProductionInvocation & { brief: unknown }): Promise<ProductionReceipt>;
    freeze(args: ProductionInvocation & { brief: unknown; receipt: ProductionReceipt }): Promise<ProductionFrozen | ProductionCorrection>;
    verifyFrozen(args: ProductionInvocation & { frozen: ProductionFrozen; phase: 'before-review' | 'before-approval' }): Promise<boolean>;
    review(role: ProductionReviewerRole, args: ProductionInvocation & { frozen: ProductionFrozen }): Promise<ProductionJudgeReview>;
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
 * Existing locks, even stale/malformed ones, are rejected: verify the owner PID
 * and reconcile pending effects before explicit offline recovery. No lock stealing.
 */
export async function runProductionQueue(options: ProductionQueueOptions): Promise<ProductionQueueState> {
    const source = options.adapters, signal = options.signal;
    for (const method of ['prepare', 'produce', 'freeze', 'verifyFrozen', 'review'] as const) {
        if (typeof source?.[method] !== 'function') throw new Error(`Production adapter ${method} must be a function.`);
    }
    const host: ProductionAdapters = {
        prepare: source.prepare.bind(source), produce: source.produce.bind(source), freeze: source.freeze.bind(source),
        verifyFrozen: source.verifyFrozen.bind(source), review: source.review.bind(source),
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
    const lockPath = path.join(root, 'queue.lock');
    const lock = await fs.open(lockPath, 'wx', 0o600).catch(error => {
        if (error.code === 'EEXIST') throw new Error('Production queue locked; verify owner PID before explicit offline recovery. Locks are never stolen.');
        throw error;
    });
    const inFlight = new Set<Promise<unknown>>();
    let completion: Promise<FlowStudioRunRecord> | undefined;
    const release = async () => { await lock.close(); await fs.unlink(lockPath); };
    try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() }));
        await lock.sync();
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
                            history, unresolvedByRole: unresolved }), runId: args.runId, signal: args.signal! }, copy(outputs));
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
            bind('produce', (args, raw) => host.produce({ ...args, brief: (raw.prepare as { brief: unknown }).brief }));
            bind('freeze', (args, raw) => host.freeze({ ...args, brief: (raw.prepare as { brief: unknown }).brief, receipt: raw.produce! }));
            bind('verify', async (args, raw) => {
                const f = raw.freeze, p = raw.produce;
                if (isProductionCorrection(f)) return { ok: false, correction: true, reasons: f.reasons };
                if (f && Object.hasOwn(f, 'status')) return { ok: false, reasons: ['Invalid freeze correction; expected REVISE with nonempty nonblank reasons.'] };
                const bound = !!f?.manifest && f.manifest.assetId === entry.id && f.manifest.revision === revision
                    && f.visualProbePassed === true
                    && !!p?.invocationId?.trim() && !!p?.sessionId?.trim()
                    && f.manifest.producerInvocationId === p.invocationId && f.producerSessionId === p.sessionId;
                const ok = bound && await host.verifyFrozen({ ...args, frozen: copy(f!), phase: 'before-review' }) === true;
                return { ok, reasons: ok ? [] : ['Frozen manifest binding or pre-review verification failed.'] };
            });
            for (const role of ['artistic', 'technical'] as const) bind(role, (args, raw) => {
                if (!raw.freeze || isProductionCorrection(raw.freeze)) throw new Error('Review requires a frozen candidate, not a correction.');
                return host.review(role, { ...args, frozen: raw.freeze });
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
                const prior = state.history.flatMap(item => [item.outputs.artistic?.assignment, item.outputs.technical?.assignment, item.outputs.produce]);
                if (reviews.some((r, i) => r?.assignment?.role !== (i === 0 ? 'artistic' : 'technical')
                    || prior.some(p => p && (p.sessionId === r?.assignment?.sessionId || p.invocationId === r?.assignment?.invocationId)))) {
                    return { verdict: 'WAIT', reasons: [...result.reasons, 'Reviewer role mismatch or reused invocation/session.'] };
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
            commandPatterns: ['host:prepare', 'host:produce', 'host:freeze', 'host:verify', 'host:artistic', 'host:technical', 'host:finalize'] },
        budget: { maxSteps: 24, maxDurationMs: timeoutMs, maxParallelism: 2 },
        nodes: [action('prepare', 'read', 'ready'), { id: 'ready', type: 'router', label: 'Ready?' },
            action('produce', 'command', 'freeze'), action('freeze', host.freezeEffect ?? 'command', 'verify'),
            action('verify', 'read', 'frozen'), { id: 'frozen', type: 'router', label: 'Verified freeze?' },
            { id: 'reviews', type: 'fork', label: 'Independent judges', fork: { branches: ['artistic', 'technical'], join: 'joined', maxConcurrency: 2 } },
            action('artistic', host.reviewEffect ?? 'read', 'joined'), action('technical', host.reviewEffect ?? 'read', 'joined'),
            { id: 'joined', type: 'join', label: 'Both judges', join: { strategy: 'all' }, next: 'finalize' },
            action('finalize', 'read', 'decision'), { id: 'decision', type: 'router', label: 'Review verdict' },
            { id: 'wait', type: 'wait', label: 'Host reconciliation', wait: { kind: 'event', eventName: 'production.reconciled' }, next: 'end' },
            { id: 'end', type: 'end', label: 'ACCEPT or REVISE' }],
        edges: [
            { from: 'ready', to: 'produce', guard: 'context.prepare.status === "READY"', priority: 0 }, { from: 'ready', to: 'wait', priority: 1 },
            { from: 'frozen', to: 'finalize', guard: 'context.verify.correction === true', priority: 0 },
            { from: 'frozen', to: 'reviews', guard: 'context.verify.ok === true', priority: 1 }, { from: 'frozen', to: 'wait', priority: 2 },
            { from: 'artistic', to: 'joined' }, { from: 'technical', to: 'joined' },
            { from: 'decision', to: 'end', guard: 'context.finalize.verdict === "ACCEPT" || context.finalize.verdict === "REVISE"', priority: 0 },
            { from: 'decision', to: 'wait', priority: 1 }
        ]
    };
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
