import { randomBytes } from 'node:crypto';
import {
    runFlowStudioGraph,
    type FlowStudioCheckpoint,
    type FlowStudioContext,
    type FlowStudioEffectRecord,
    type FlowStudioGateResult,
    type FlowStudioGraph,
    type FlowStudioInteractionEnvelope,
    type FlowStudioRunRequest,
    type FlowStudioRunResult,
    type FlowStudioToolDecision
} from '@cybervinci/flow-shared';
import {
    FlowStudioFileRunStore,
    FLOW_STUDIO_RUN_RECORD_VERSION,
    type FlowStudioRunLease,
    type FlowStudioRunRecord
} from './run-store';

const MAX_ACTIVE_RUNS = 64;

export interface FlowStudioRunLaunchOptions extends Omit<FlowStudioRunRequest, 'graph' | 'input' | 'runId' | 'resume' | 'onEvent' | 'onCheckpoint' | 'onEffect'> {
    graph: FlowStudioGraph;
    input?: FlowStudioContext;
}

export class FlowStudioRunConflictError extends Error {}
export class FlowStudioRunRequestError extends Error {}

export class FlowStudioRunManager {
    private readonly active = new Map<string, AbortController>();
    private readonly completions = new Map<string, Promise<FlowStudioRunRecord>>();
    private readonly transitions = new Map<string, Promise<void>>();
    private pendingStarts = 0;

    constructor(readonly store: FlowStudioFileRunStore) {}

    async recoverInterruptedRuns(): Promise<number> {
        const records = await this.store.list(500);
        let recovered = 0;
        for (const record of records) {
            if (record.status !== 'running') continue;
            const lease = await this.store.claimRunLease(record.id);
            if (!lease) continue;
            try {
                const current = await this.store.get(record.id);
                if (!current || current.status !== 'running') continue;
                const now = new Date().toISOString();
                current.status = 'failed';
                current.error = 'Execução interrompida pelo encerramento do processo. Crie um replay do último checkpoint para continuar com rastreabilidade.';
                current.updatedAt = now;
                current.events.push({
                    kind: 'run.failed',
                    runId: current.id,
                    message: current.error,
                    detail: { recoverable: current.checkpoints.length > 0, reason: 'process-restart' },
                    step: current.events.length,
                    at: now
                });
                await lease.assertOwned();
                await this.store.save(current);
                recovered += 1;
            } finally {
                await lease.release();
            }
        }
        return recovered;
    }

    async start(options: FlowStudioRunLaunchOptions, parentRunId?: string): Promise<FlowStudioRunRecord> {
        return this.startInternal(options, parentRunId);
    }

    private async startInternal(options: FlowStudioRunLaunchOptions, parentRunId?: string, resume?: FlowStudioRunRequest['resume'], effectLedger?: FlowStudioEffectRecord[]): Promise<FlowStudioRunRecord> {
        if (this.active.size + this.pendingStarts >= MAX_ACTIVE_RUNS) {
            throw new FlowStudioRunConflictError(`Limite de ${MAX_ACTIVE_RUNS} execuções simultâneas atingido.`);
        }
        this.pendingStarts += 1;
        try {
            const runId = randomBytes(16).toString('hex');
            const now = new Date().toISOString();
            const record: FlowStudioRunRecord = {
                version: FLOW_STUDIO_RUN_RECORD_VERSION,
                id: runId,
                graph: clone(options.graph),
                input: clone(options.input || {}),
                status: 'running',
                createdAt: now,
                updatedAt: now,
                parentRunId,
                events: [],
                checkpoints: [],
                effects: clone(effectLedger || [])
            };
            assertTerminalReceiptCapacity(record, this.store.limits.recordBytes);
            const lease = await this.store.claimRunLease(runId);
            if (!lease) throw new FlowStudioRunConflictError(`Run ${runId} já está sob execução de outro processo.`);
            let launched = false;
            try {
                await lease.assertOwned();
                await this.store.save(record);
                this.launch(record, options, resume, lease);
                launched = true;
                return clone(record);
            } finally {
                if (!launched) await lease.release();
            }
        } finally {
            this.pendingStarts -= 1;
        }
    }

    async runAndWait(options: FlowStudioRunLaunchOptions): Promise<FlowStudioRunRecord> {
        const record = await this.start(options);
        return this.wait(record.id);
    }

    async resume(runId: string, options: Omit<FlowStudioRunLaunchOptions, 'graph' | 'input'> & {
        checkpointId?: string;
        gate?: FlowStudioGateResult;
        resumeSignal?: Record<string, unknown>;
        fork?: boolean;
    }): Promise<FlowStudioRunRecord> {
        return this.withRunTransition(runId, async () => {
            const source = await this.require(runId);
            if (options.fork) {
                const sourceLease = await this.store.claimRunLease(runId);
                if (!sourceLease) throw new FlowStudioRunConflictError(`Run ${runId} ainda está em execução; aguarde uma fronteira estável antes do replay.`);
                try {
                    const current = await this.require(runId);
                    if (current.status === 'running') {
                        throw new FlowStudioRunConflictError(`Run ${runId} ainda está em execução; aguarde uma fronteira estável antes do replay.`);
                    }
                    const checkpoint = selectCheckpoint(current, options.checkpointId);
                    validateResumeRequest(current, checkpoint, options.gate);
                    await sourceLease.assertOwned();
                    return this.startInternal(
                        { ...options, graph: current.graph, input: current.input },
                        current.id,
                        { checkpoint, gate: options.gate, signal: options.resumeSignal, forkRun: true },
                        current.effects
                    );
                } finally {
                    await sourceLease.release();
                }
            }
            const checkpoint = selectAuthoritativeCheckpoint(source, options.checkpointId);
            validateResumeRequest(source, checkpoint, options.gate);
            const lease = await this.store.claimRunLease(runId);
            if (!lease) throw new FlowStudioRunConflictError(`Run ${runId} já está sob execução de outro processo.`);
            let launched = false;
            try {
                const current = await this.require(runId);
                if (current.status === 'running') throw new FlowStudioRunConflictError(`Run ${runId} ainda está em execução.`);
                if (current.status === 'completed') throw new FlowStudioRunConflictError(`Run ${runId} já foi concluído; use replay para criar uma nova execução.`);
                const currentCheckpoint = selectAuthoritativeCheckpoint(current, options.checkpointId);
                validateResumeRequest(current, currentCheckpoint, options.gate);
                const record: FlowStudioRunRecord = { ...current, status: 'running', updatedAt: new Date().toISOString(), error: undefined };
                assertTerminalReceiptCapacity(record, this.store.limits.recordBytes);
                await lease.assertOwned();
                await this.store.save(record);
                this.launch(record, { ...options, graph: current.graph, input: current.input }, { checkpoint: currentCheckpoint, gate: options.gate, signal: options.resumeSignal }, lease);
                launched = true;
                return clone(record);
            } finally {
                if (!launched) await lease.release();
            }
        });
    }

    async replay(runId: string, checkpointId?: string, options?: Omit<FlowStudioRunLaunchOptions, 'graph' | 'input'>): Promise<FlowStudioRunRecord> {
        return this.resume(runId, { ...(options || {}), checkpointId, fork: true });
    }

    async wait(runId: string): Promise<FlowStudioRunRecord> {
        const completion = this.completions.get(runId);
        return completion ? completion : this.require(runId);
    }

    async status(runId: string): Promise<FlowStudioRunRecord> {
        return this.require(runId);
    }

    async list(limit?: number): Promise<FlowStudioRunRecord[]> {
        return this.store.list(limit);
    }

    cancel(runId: string): boolean {
        const controller = this.active.get(runId);
        if (!controller) return false;
        controller.abort();
        return true;
    }

    private async withRunTransition<T>(runId: string, operation: () => Promise<T>): Promise<T> {
        const predecessor = this.transitions.get(runId) || Promise.resolve();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const tail = predecessor.then(() => held);
        this.transitions.set(runId, tail);
        await predecessor;
        try {
            return await operation();
        } finally {
            release();
            if (this.transitions.get(runId) === tail) this.transitions.delete(runId);
        }
    }

    private launch(record: FlowStudioRunRecord, options: FlowStudioRunLaunchOptions, resume: FlowStudioRunRequest['resume'], lease: FlowStudioRunLease): void {
        const controller = new AbortController();
        this.active.set(record.id, controller);
        const completion = (async (): Promise<FlowStudioRunRecord> => {
            let current = clone(record);
            let persistence = Promise.resolve();
            let persistenceFailure: unknown;
            const persist = async (): Promise<void> => {
                const snapshot = clone(current);
                const attempt = persistence.catch(() => undefined).then(async () => {
                    await lease.assertOwned();
                    await this.store.save(snapshot);
                });
                persistence = attempt.catch(() => undefined);
                try {
                    await attempt;
                } catch (error) {
                    persistenceFailure ??= error;
                    throw error;
                }
            };
            const onLeaseLost = (): void => controller.abort(lease.signal.reason);
            lease.signal.addEventListener('abort', onLeaseLost, { once: true });
            try {
                const result = await runFlowStudioGraph({
                    ...options,
                    graph: clone(record.graph),
                    input: clone(record.input),
                    runId: record.id,
                    resume,
                    // A replay starts from an older state checkpoint, but it must keep the
                    // complete source-run effect ledger. Otherwise an external effect that
                    // happened after that checkpoint could be executed a second time.
                    effects: current.effects,
                    signal: controller.signal,
                    onEvent: event => {
                        current.events.push(event);
                    },
                    onEffect: async effect => {
                        const index = current.effects.findIndex(item => item.id === effect.id);
                        if (index >= 0) current.effects[index] = effect;
                        else current.effects.push(effect);
                        current.updatedAt = new Date().toISOString();
                        await persist();
                    },
                    onCheckpoint: async checkpoint => {
                        current.checkpoints.push(checkpoint);
                        current.effects = clone(checkpoint.effects);
                        current.updatedAt = new Date().toISOString();
                        await persist();
                    }
                });
                current = mergeResult(current, result);
            } catch (error) {
                current.status = lease.signal.aborted ? 'failed' : controller.signal.aborted ? 'cancelled' : 'failed';
                current.error = error instanceof Error ? error.message : String(error);
                current.updatedAt = new Date().toISOString();
            } finally {
                if (persistenceFailure) {
                    const message = persistenceFailure instanceof Error ? persistenceFailure.message : String(persistenceFailure);
                    current.status = 'failed';
                    current.error = `Falha ao persistir o run de forma segura: ${message}`;
                    current.updatedAt = new Date().toISOString();
                    appendFailureEvent(current, current.error, 'persistence-failure');
                }
                try {
                    await persist();
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    current.status = 'failed';
                    current.error = `Falha ao persistir o run de forma segura: ${message}`;
                    current.updatedAt = new Date().toISOString();
                    appendFailureEvent(current, current.error, 'persistence-failure');
                    if (!lease.signal.aborted) {
                        try {
                            await lease.assertOwned();
                            const receipt = terminalPersistenceReceipt(current, current.error, this.store.limits.recordBytes);
                            await this.store.save(receipt);
                            current = receipt;
                        } catch (finalError) {
                            current.error = `${current.error} Falha no receipt terminal: ${finalError instanceof Error ? finalError.message : String(finalError)}`;
                        }
                    }
                } finally {
                    lease.signal.removeEventListener('abort', onLeaseLost);
                    this.active.delete(record.id);
                    this.completions.delete(record.id);
                    await lease.release().catch(() => undefined);
                }
            }
            return clone(current);
        })();
        this.completions.set(record.id, completion);
    }

    private async require(runId: string): Promise<FlowStudioRunRecord> {
        const record = await this.store.get(runId);
        if (!record) throw new Error(`Run não encontrado: ${runId}`);
        return record;
    }
}

function selectCheckpoint(record: FlowStudioRunRecord, checkpointId?: string): FlowStudioCheckpoint {
    const replayable = [...record.checkpoints].reverse().filter(item => item.metadata?.replayable !== false);
    const checkpoint = checkpointId
        ? record.checkpoints.find(item => item.id === checkpointId)
        : replayable.find(item => item.reason === 'gate' || item.reason === 'wait' || item.reason === 'failure') || replayable[0];
    if (!checkpoint) {
        if (checkpointId) throw new Error(`Checkpoint ${checkpointId} não foi encontrado no run ${record.id}.`);
        const blocked = [...record.checkpoints].reverse().find(item => item.metadata?.replayable === false);
        if (blocked) {
            throw new Error(typeof blocked.metadata?.replayBlockedReason === 'string'
                ? blocked.metadata.replayBlockedReason
                : `Run ${record.id} possui apenas checkpoints não reproduzíveis.`);
        }
        throw new Error(`Run ${record.id} não possui checkpoint.`);
    }
    if (checkpoint.metadata?.replayable === false) {
        throw new Error(typeof checkpoint.metadata.replayBlockedReason === 'string'
            ? checkpoint.metadata.replayBlockedReason
            : 'Este checkpoint interno não representa um snapshot global consistente. Escolha um checkpoint de limite do Fork/Loop.');
    }
    return clone(checkpoint);
}

function selectAuthoritativeCheckpoint(record: FlowStudioRunRecord, checkpointId?: string): FlowStudioCheckpoint {
    if (record.status === 'running') throw new FlowStudioRunConflictError(`Run ${record.id} ainda está em execução.`);
    if (record.status !== 'waiting') {
        throw new FlowStudioRunRequestError(
            `Run ${record.id} está ${record.status} e não possui uma fronteira ativa de espera. Use replay para continuar de um checkpoint persistido.`
        );
    }
    const waitingCheckpointId = record.result?.waiting?.checkpointId;
    if (!waitingCheckpointId) {
        throw new FlowStudioRunRequestError(`Run ${record.id} está aguardando, mas não possui checkpoint autoritativo. Use replay para recuperar um checkpoint persistido.`);
    }
    const authoritative = record.checkpoints.find(item => item.id === waitingCheckpointId);
    if (!authoritative) {
        throw new FlowStudioRunRequestError(`Checkpoint autoritativo ${waitingCheckpointId} não foi encontrado no run ${record.id}. Use replay para recuperar um checkpoint persistido.`);
    }
    if (checkpointId && checkpointId !== authoritative.id) {
        throw new FlowStudioRunRequestError(
            `Checkpoint ${checkpointId} não é mais a fronteira autoritativa do run ${record.id}. Use replay para executar a partir de um checkpoint histórico.`
        );
    }
    if (authoritative.metadata?.replayable === false) return selectCheckpoint(record, authoritative.id);
    return clone(authoritative);
}

function validateResumeRequest(record: FlowStudioRunRecord, checkpoint: FlowStudioCheckpoint, gate: FlowStudioGateResult | undefined): void {
    if (!gate) return;
    if (checkpoint.reason !== 'gate') {
        throw new FlowStudioRunRequestError(`Checkpoint ${checkpoint.id} não é um checkpoint de Gate e não aceita uma decisão.`);
    }
    const interaction = resumeInteraction(record, checkpoint);
    if (interaction && !['gate', 'permission'].includes(interaction.type)) {
        throw new FlowStudioRunRequestError(`Checkpoint ${checkpoint.id} não contém uma interação de Gate válida.`);
    }
    const node = interaction ? undefined : record.graph.nodes.find(item => item.id === checkpoint.nodeId);
    if (!interaction && !node) throw new FlowStudioRunRequestError(`Nó do Gate não encontrado para o checkpoint ${checkpoint.id}.`);
    const gateId = interaction?.nodeId || node!.id;
    if (!gate.decisionId?.trim()) throw new FlowStudioRunRequestError(`A retomada do Gate "${gateId}" exige decisionId declarado.`);
    if (gate.action !== undefined && !['continue', 'wait', 'fail'].includes(gate.action)) {
        throw new FlowStudioRunRequestError(`Ação "${gate.action}" não é válida para o Gate "${gateId}".`);
    }
    const decisions: FlowStudioToolDecision[] = interaction?.decisions?.length ? interaction.decisions : node?.gateDecisions?.length ? node.gateDecisions : [
        { id: 'continue', label: 'Continuar', decision: 'continue' as const, toNodeId: node?.next },
        { id: 'wait', label: 'Aguardar', decision: 'wait' as const },
        { id: 'fail', label: 'Falhar', decision: 'fail' as const }
    ];
    const decision = decisions.find(item => item.id === gate.decisionId);
    if (!decision) throw new FlowStudioRunRequestError(`Decisão "${gate.decisionId}" não existe no gate "${gateId}".`);
    const requireEvidence = interaction?.requireEvidence === true || node?.gate?.requireEvidence === true;
    if (requireEvidence && decision.decision === 'continue' && !gate.evidence?.length) {
        throw new FlowStudioRunRequestError(`Gate "${gateId}" exige evidência para a decisão "${decision.id}".`);
    }
    if (gate.toNodeId !== undefined && gate.toNodeId !== decision.toNodeId) {
        throw new FlowStudioRunRequestError(`Destino "${gate.toNodeId}" não pertence à decisão "${decision.id}" do gate "${gateId}".`);
    }
}

function resumeInteraction(record: FlowStudioRunRecord, checkpoint: FlowStudioCheckpoint): FlowStudioInteractionEnvelope | undefined {
    const checkpointInteraction = parseInteraction(checkpoint.metadata?.interaction);
    if (checkpointInteraction) return checkpointInteraction;
    const waiting = record.result?.waiting;
    return waiting?.checkpointId === checkpoint.id ? parseInteraction(waiting.detail?.interaction) : undefined;
}

function parseInteraction(value: unknown): FlowStudioInteractionEnvelope | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const candidate = value as Partial<FlowStudioInteractionEnvelope>;
    return ['gate', 'permission', 'wait'].includes(String(candidate.type))
        && typeof candidate.graphId === 'string'
        && typeof candidate.nodeId === 'string'
        ? clone(candidate as FlowStudioInteractionEnvelope)
        : undefined;
}

function appendFailureEvent(record: FlowStudioRunRecord, message: string, reason: string): void {
    record.events.push({
        kind: 'run.failed',
        runId: record.id,
        message,
        detail: { recoverable: record.checkpoints.length > 0, reason },
        step: record.events.length,
        at: new Date().toISOString()
    });
}

function terminalPersistenceReceipt(record: FlowStudioRunRecord, error: string, recordBytes: number): FlowStudioRunRecord {
    const failureEvent = record.events.slice().reverse().find(event => event.kind === 'run.failed');
    const terminalEvent = failureEvent ? compactEvent(failureEvent) : {
        kind: 'run.failed' as const,
        runId: record.id,
        message: truncate(error, 2_048),
        detail: { recoverable: false, reason: 'persistence-failure' },
        step: record.events.length,
        at: record.updatedAt
    };
    const receipt: FlowStudioRunRecord = {
        version: record.version,
        id: record.id,
        graph: clone(record.graph),
        input: clone(record.input),
        status: 'failed',
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        parentRunId: record.parentRunId,
        events: [terminalEvent],
        checkpoints: record.checkpoints.slice(-2).map(compactCheckpoint),
        effects: record.effects.map(compactEffect),
        error: truncate(error, 4_096)
    };
    if (serializedBytes(receipt) <= recordBytes) return receipt;
    // Checkpoint contexts are the likeliest remaining source of growth. The
    // compact form is useful for diagnostics but is deliberately expendable in
    // a terminal receipt whose primary job is to replace a stale `running`
    // record and preserve the effect ledger.
    receipt.checkpoints = [];
    if (serializedBytes(receipt) <= recordBytes) return receipt;
    throw new Error(`Run ${record.id} não possui espaço para um receipt terminal seguro dentro do limite de ${recordBytes} bytes.`);
}

function assertTerminalReceiptCapacity(record: FlowStudioRunRecord, recordBytes: number): void {
    try {
        terminalPersistenceReceipt(record, `Reserva para falha persistente: ${'x'.repeat(4_096)}`, recordBytes);
    } catch (error) {
        throw new FlowStudioRunRequestError(error instanceof Error ? error.message : String(error));
    }
}

function compactEvent(event: FlowStudioRunRecord['events'][number]): FlowStudioRunRecord['events'][number] {
    return {
        kind: event.kind,
        runId: event.runId,
        nodeId: event.nodeId,
        edgeId: event.edgeId,
        message: truncate(event.message, 2_048),
        detail: event.kind === 'run.failed' ? { recoverable: false, reason: 'persistence-failure' } : undefined,
        step: event.step,
        at: event.at
    };
}

function compactCheckpoint(checkpoint: FlowStudioCheckpoint): FlowStudioCheckpoint {
    return {
        id: checkpoint.id,
        runId: checkpoint.runId,
        graphId: checkpoint.graphId,
        graphVersion: checkpoint.graphVersion,
        graphDigest: checkpoint.graphDigest,
        nodeId: checkpoint.nodeId,
        nextNodeId: checkpoint.nextNodeId,
        reason: checkpoint.reason,
        context: { receiptNotice: 'Contexto omitido após exceder o limite persistente.' },
        visited: checkpoint.visited.slice(-256),
        effects: checkpoint.effects.map(compactEffect),
        artifacts: [],
        usage: clone(checkpoint.usage),
        createdAt: checkpoint.createdAt,
        wait: checkpoint.wait ? clone(checkpoint.wait) : undefined,
        metadata: {
            replayable: false,
            replayBlockedReason: 'O contexto deste checkpoint foi truncado porque o run excedeu o limite persistente.'
        }
    };
}

function compactEffect(effect: FlowStudioEffectRecord): FlowStudioEffectRecord {
    return {
        id: effect.id,
        idempotencyKey: effect.idempotencyKey,
        runId: effect.runId,
        nodeId: effect.nodeId,
        toolId: effect.toolId,
        kind: effect.kind,
        status: effect.status,
        startedAt: effect.startedAt,
        finishedAt: effect.finishedAt,
        inputDigest: effect.inputDigest,
        error: effect.error ? truncate(effect.error, 2_048) : undefined
    };
}

function serializedBytes(record: FlowStudioRunRecord): number {
    return Buffer.byteLength(`${JSON.stringify(record, null, 2)}\n`);
}

function truncate(value: string, maxLength: number): string {
    return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function mergeResult(record: FlowStudioRunRecord, result: FlowStudioRunResult): FlowStudioRunRecord {
    const eventKeys = new Set(record.events.map(event => `${event.runId}:${event.at}:${event.step}:${event.kind}`));
    for (const event of result.events) {
        const key = `${event.runId}:${event.at}:${event.step}:${event.kind}`;
        if (!eventKeys.has(key)) record.events.push(event);
    }
    const checkpointIds = new Set(record.checkpoints.map(item => item.id));
    for (const checkpoint of result.checkpoints) if (!checkpointIds.has(checkpoint.id)) record.checkpoints.push(checkpoint);
    return {
        ...record,
        status: result.status,
        updatedAt: new Date().toISOString(),
        effects: clone(result.effects),
        result: clone(result),
        error: result.error
    };
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}
