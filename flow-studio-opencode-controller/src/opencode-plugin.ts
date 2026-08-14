import { type Plugin, tool } from '@opencode-ai/plugin';
import { randomBytes } from 'node:crypto';
import type { FlowStudioContext, FlowStudioGateResult, FlowStudioGraph } from '@cybervinci/flow-shared';
import { FlowStudioControllerPool } from './controller-pool.js';
import type { FlowStudioControllerOptions, FlowStudioRunRecord } from './controller.js';

const z = tool.schema;
const jsonRecord = z.record(z.string(), z.unknown());
const runnerBinding = z.object({
    runnerId: z.string().optional(),
    providerId: z.string(),
    modelId: z.string().optional(),
    profileId: z.string().optional(),
    reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh']).optional(),
    serviceTier: z.enum(['default', 'fast', 'flex']).optional(),
    timeoutMs: z.number().int().positive().optional(),
    requiredCapabilities: z.array(z.string()).optional(),
    fallbacks: z.array(z.unknown()).optional()
});
const gateDecision = z.object({
    action: z.enum(['continue', 'wait', 'fail']).optional(),
    decisionId: z.string().optional(),
    toNodeId: z.string().optional(),
    message: z.string().optional(),
    evidence: z.array(z.unknown()).optional()
});

const FlowStudioOpenCodePlugin: Plugin = async ({ client }, rawOptions) => {
    const pool = new FlowStudioControllerPool(normalizePluginOptions(rawOptions));
    const proposals = new Map<string, { file: string; graph: FlowStudioGraph; summary?: string; assumptions?: string[] }>();
    const log = async (message: string, extra?: Record<string, unknown>): Promise<void> => {
        await client.app.log({ body: { service: 'flow', level: 'info', message, extra } }).catch(() => undefined);
    };

    return {
        tool: {
            flow_open: tool({
                description: 'Inicia ou reutiliza o Flow Studio CLI para este worktree e abre o editor visual seguro no navegador.',
                args: {
                    file: z.string().optional().describe('Arquivo GraphSpec v2 relativo ao diretório atual.'),
                    browser: z.boolean().default(true).describe('Abre a interface visual no navegador.')
                },
                execute: async (args, context) => {
                    const { controller, file } = await pool.get(context, args.file, args.browser);
                    const session = controller.activeSession;
                    context.metadata({ title: 'Flow Studio aberto', metadata: { file, pid: session?.pid } });
                    await log('Studio aberto', { file, pid: session?.pid });
                    return envelope('Flow Studio', { ok: true, action: 'open', file, pid: session?.pid, browserOpened: args.browser });
                }
            }),
            flow_author: tool({
                description: 'Cria ou evolui um grafo multiagente completo por IA, valida a proposta e só salva quando apply=true e a validação passa.',
                args: {
                    instruction: z.string().min(1).optional(),
                    file: z.string().optional(),
                    constraints: z.array(z.string()).optional(),
                    profileId: z.string().optional(),
                    proposalId: z.string().optional().describe('Id devolvido pelo preview; use-o com apply=true para aplicar exatamente a proposta revisada.'),
                    apply: z.boolean().default(false)
                },
                execute: async (args, context) => {
                    const { controller, file } = await pool.get(context, args.file);
                    const cached = args.proposalId ? proposals.get(args.proposalId) : undefined;
                    if (args.proposalId && (!cached || cached.file !== file)) throw new Error('Proposta inexistente, expirada ou pertencente a outro grafo. Gere um novo preview.');
                    if (!cached && !args.instruction) throw new Error('Informe instruction para gerar uma proposta ou proposalId para aplicar um preview existente.');
                    const authored = cached || await (async () => {
                        const current = await controller.loadGraph(file, context.abort);
                        return controller.author(args.instruction as string, current.graph, args.profileId, args.constraints, context.abort);
                    })();
                    const validation = await controller.validate(authored.graph, context.abort);
                    const applied = args.apply && validation.valid;
                    if (applied) await controller.saveGraph(authored.graph, file, context.abort);
                    const proposalId = args.proposalId || randomBytes(12).toString('hex');
                    if (applied) proposals.delete(proposalId);
                    else {
                        proposals.set(proposalId, { file, graph: authored.graph, summary: authored.summary, assumptions: authored.assumptions });
                        while (proposals.size > 50) proposals.delete(proposals.keys().next().value as string);
                    }
                    context.metadata({ title: applied ? 'Flow aplicado' : 'Preview do Flow', metadata: { file, valid: validation.valid, applied } });
                    await log('Autoria concluída', { file, valid: validation.valid, applied });
                    return envelope('Autoria do Flow Studio', {
                        ok: validation.valid,
                        action: 'author',
                        file,
                        applied,
                        proposalId: applied ? undefined : proposalId,
                        summary: authored.summary,
                        assumptions: authored.assumptions,
                        validation,
                        next: applied ? 'O grafo foi salvo sem regenerar a proposta.' : validation.valid ? `Revise a proposta e chame novamente com proposalId=${proposalId} e apply=true.` : 'Corrija os erros antes de aplicar.'
                    }, { graph: authored.graph });
                }
            }),
            flow_run: tool({
                description: 'Executa o GraphSpec v2 pelo CLI. Por padrão inicia de forma assíncrona para permitir status e cancelamento.',
                args: {
                    file: z.string().optional(),
                    input: jsonRecord.optional(),
                    maxSteps: z.number().int().positive().optional(),
                    defaultProvider: runnerBinding.optional(),
                    gatePolicy: jsonRecord.optional(),
                    wait: z.boolean().default(false)
                },
                execute: async (args, context) => {
                    const { controller, file } = await pool.get(context, args.file);
                    const { graph } = await controller.loadGraph(file, context.abort);
                    const options = { maxSteps: args.maxSteps, defaultProvider: args.defaultProvider, gatePolicy: args.gatePolicy };
                    const response = args.wait
                        ? await controller.run(graph, (args.input || {}) as FlowStudioContext, options, context.abort)
                        : await controller.startRun(graph, (args.input || {}) as FlowStudioContext, options, context.abort);
                    const run = response.run;
                    context.metadata({ title: `Flow ${run.status}`, metadata: { file, runId: run.id, status: run.status } });
                    await log('Run iniciado', { file, runId: run.id, status: run.status });
                    return envelope('Execução do Flow Studio', { ok: response.ok, action: 'run', file, runId: run.id, status: run.status, next: run.status === 'running' ? 'Use flow_status.' : nextForStatus(run.status) });
                }
            }),
            flow_status: tool({
                description: 'Consulta execuções do Flow Studio com nível de detalhe controlado para não poluir o contexto.',
                args: {
                    file: z.string().optional(),
                    runId: z.string().optional(),
                    compareToRunId: z.string().optional(),
                    limit: z.number().int().min(1).max(100).default(20),
                    detail: z.enum(['summary', 'checkpoints', 'events', 'effects', 'full']).default('summary'),
                    eventCursor: z.number().int().min(0).default(0)
                },
                execute: async (args, context) => {
                    const { controller, file } = await pool.get(context, args.file);
                    if (!args.runId) {
                        const { runs } = await controller.listRuns(args.limit, context.abort);
                        return envelope('Runs do Flow Studio', { ok: true, action: 'status', file, runs: runs.map(summarizeRun) });
                    }
                    if (args.compareToRunId) {
                        const comparison = await controller.compare(args.runId, args.compareToRunId, context.abort);
                        return envelope('Comparação de runs', { ok: comparison.ok, action: 'compare', file, comparison: comparison.comparison });
                    }
                    const { run } = await controller.status(args.runId, context.abort);
                    const detail = selectRunDetail(run, args.detail, args.eventCursor);
                    context.metadata({ title: `Flow ${run.status}`, metadata: { file, runId: run.id, status: run.status } });
                    return envelope('Status do Flow Studio', { ok: true, action: 'status', file, ...detail, next: nextForStatus(run.status) });
                }
            }),
            flow_resume: tool({
                description: 'Retoma uma execução suspensa em gate ou wait, preservando checkpoint, efeitos e estado.',
                args: {
                    runId: z.string().min(8),
                    file: z.string().optional(),
                    checkpointId: z.string().optional(),
                    gate: gateDecision.optional(),
                    resumeSignal: jsonRecord.optional(),
                    fork: z.boolean().default(false)
                },
                execute: async (args, context) => {
                    const { controller, file } = await pool.get(context, args.file);
                    const response = await controller.resume(args.runId, {
                        checkpointId: args.checkpointId,
                        gate: args.gate as FlowStudioGateResult | undefined,
                        signal: args.resumeSignal,
                        fork: args.fork
                    }, context.abort);
                    const run = response.run;
                    context.metadata({ title: `Flow retomado · ${run.status}`, metadata: { file, runId: run.id, status: run.status } });
                    return envelope('Retomada do Flow Studio', { ok: response.ok, action: 'resume', file, runId: run.id, status: run.status, next: nextForStatus(run.status) });
                }
            }),
            flow_replay: tool({
                description: 'Cria uma nova execução a partir de checkpoint persistido sem repetir efeitos já confirmados.',
                args: { runId: z.string().min(8), file: z.string().optional(), checkpointId: z.string().optional() },
                execute: async (args, context) => {
                    const { controller, file } = await pool.get(context, args.file);
                    const response = await controller.replay(args.runId, args.checkpointId, context.abort);
                    const run = response.run;
                    context.metadata({ title: `Replay ${run.status}`, metadata: { file, runId: run.id, parentRunId: args.runId } });
                    return envelope('Replay do Flow Studio', { ok: response.ok, action: 'replay', file, runId: run.id, parentRunId: args.runId, status: run.status, next: nextForStatus(run.status) });
                }
            }),
            flow_cancel: tool({
                description: 'Cancela explicitamente uma execução ativa do Flow Studio.',
                args: { runId: z.string().min(8), file: z.string().optional() },
                execute: async (args, context) => {
                    const { controller, file } = await pool.get(context, args.file);
                    const response = await controller.cancel(args.runId, context.abort);
                    context.metadata({ title: 'Cancelamento solicitado', metadata: { file, runId: args.runId } });
                    return envelope('Cancelamento do Flow Studio', { ok: response.ok, action: 'cancel', file, runId: args.runId, status: response.ok ? 'cancelling' : 'not-running' });
                }
            })
        },
        dispose: () => pool.stopAll()
    };
};

export default FlowStudioOpenCodePlugin;

function normalizePluginOptions(options: Record<string, unknown> | undefined): Omit<FlowStudioControllerOptions, 'workspace' | 'signal' | 'openBrowser'> {
    const strings = (value: unknown): string[] | undefined => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : typeof value === 'string' ? [value] : undefined;
    return {
        provider: typeof options?.provider === 'string' ? options.provider : undefined,
        model: typeof options?.model === 'string' ? options.model : undefined,
        providerHost: options?.providerHost === 'flow' ? 'flow' : options?.providerHost === 'opencode' ? 'opencode' : options?.providerHost === 'cybervinci' ? 'cybervinci' : undefined,
        providerExec: strings(options?.providerExec),
        toolExec: strings(options?.toolExec),
        playbookExec: strings(options?.playbookExec),
        memoryExec: typeof options?.memoryExec === 'string' ? options.memoryExec : undefined,
        allowGraphTools: options?.allowGraphTools === true,
        allowGraphRunners: options?.allowGraphRunners === true,
        allowCommands: strings(options?.allowCommands),
        allowRunnerHosts: strings(options?.allowRunnerHosts),
        authorExec: typeof options?.authorExec === 'string' ? options.authorExec : undefined,
        maxSteps: typeof options?.maxSteps === 'number' ? options.maxSteps : undefined,
        simulate: options?.simulate === true
    };
}

function summarizeRun(run: FlowStudioRunRecord): Record<string, unknown> {
    return { runId: run.id, status: run.status, error: run.error, events: run.events.length, checkpoints: run.checkpoints.length, effects: run.effects.length };
}

function selectRunDetail(run: FlowStudioRunRecord, detail: 'summary' | 'checkpoints' | 'events' | 'effects' | 'full', cursor: number): Record<string, unknown> {
    if (detail === 'full') return { run };
    const base = summarizeRun(run);
    if (detail === 'checkpoints') return { ...base, checkpoints: run.checkpoints };
    if (detail === 'events') return { ...base, eventCursor: cursor, events: run.events.slice(cursor), nextCursor: run.events.length };
    if (detail === 'effects') return { ...base, effects: run.effects };
    return base;
}

function nextForStatus(status: FlowStudioRunRecord['status']): string {
    if (status === 'running') return 'Use flow_status ou flow_cancel.';
    if (status === 'waiting') return 'Use flow_status com detail=checkpoints e depois flow_resume.';
    if (status === 'failed') return 'Inspecione detail=events e use flow_replay após corrigir a causa.';
    return 'Execução encerrada.';
}

function envelope(title: string, payload: Record<string, unknown>, metadata?: Record<string, unknown>): { title: string; output: string; metadata?: Record<string, unknown> } {
    return { title, output: JSON.stringify(payload), metadata };
}
