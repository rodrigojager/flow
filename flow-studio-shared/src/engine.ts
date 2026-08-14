import * as vm from 'node:vm';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { context as otelContext, metrics, Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { FLOW_STUDIO_SCHEMA_VERSION } from './types';
import type {
    FlowStudioArtifact,
    FlowStudioBudgetSpec,
    FlowStudioCheckpoint,
    FlowStudioContext,
    FlowStudioContextPack,
    FlowStudioConcurrencyLimiter,
    FlowStudioEdge,
    FlowStudioEffectKind,
    FlowStudioEffectRecord,
    FlowStudioGateConfig,
    FlowStudioGateRequest,
    FlowStudioGateResult,
    FlowStudioGraph,
    FlowStudioJoinConfig,
    FlowStudioInteractionEnvelope,
    FlowStudioModelProfile,
    FlowStudioMemoryApproval,
    FlowStudioMemoryCandidate,
    FlowStudioNode,
    FlowStudioNodeType,
    FlowStudioPermissionSpec,
    FlowStudioProviderAdapter,
    FlowStudioProviderBinding,
    FlowStudioReducerSpec,
    FlowStudioRunEvent,
    FlowStudioRunnerAdapter,
    FlowStudioRunnerBinding,
    FlowStudioRunnerCapability,
    FlowStudioRunnerDefinition,
    FlowStudioRunnerOutput,
    FlowStudioRunRequest,
    FlowStudioRunResult,
    FlowStudioRunStatus,
    FlowStudioStepLedger,
    FlowStudioToolAdapter,
    FlowStudioToolBinding,
    FlowStudioToolDecision,
    FlowStudioUsage,
    FlowStudioValidationIssue,
    FlowStudioValidationResult,
    FlowStudioWaitConfig
} from './types';

export const FLOW_STUDIO_MAX_STEPS_DEFAULT = 4_000;
export const FLOW_STUDIO_MAX_VISITS_PER_NODE_DEFAULT = 100;
export const FLOW_STUDIO_MAX_NODE_OUTPUT_BYTES = 4 * 1024 * 1024;
export const FLOW_STUDIO_MAX_CONTEXT_BYTES = 16 * 1024 * 1024;
export const FLOW_STUDIO_MAX_ARTIFACTS = 2_048;
export const FLOW_STUDIO_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const FLOW_STUDIO_MAX_ARTIFACT_TOTAL_BYTES = 64 * 1024 * 1024;
export const FLOW_STUDIO_MAX_EVENTS = 50_000;
export const FLOW_STUDIO_MAX_EVENT_TOTAL_BYTES = 32 * 1024 * 1024;
export const FLOW_STUDIO_MAX_CHECKPOINTS = 4_096;
export const FLOW_STUDIO_MAX_CHECKPOINT_TOTAL_BYTES = 128 * 1024 * 1024;
const FLOW_STUDIO_MAX_DURATION_DEFAULT = 24 * 60 * 60 * 1_000;
const FLOW_STUDIO_TRACER = trace.getTracer('@cybervinci/flow-engine', '1.74.0');
const FLOW_STUDIO_METER = metrics.getMeter('@cybervinci/flow-engine', '1.74.0');
const FLOW_STUDIO_RUNS = FLOW_STUDIO_METER.createCounter('flow_studio.runs', { description: 'Flow Studio runs by terminal status.' });
const FLOW_STUDIO_DURATION = FLOW_STUDIO_METER.createHistogram('flow_studio.run.duration', { unit: 'ms', description: 'End-to-end Flow Studio run duration.' });
const FLOW_STUDIO_COST = FLOW_STUDIO_METER.createHistogram('flow_studio.run.cost', { unit: 'USD', description: 'Reported or estimated Flow Studio run cost.' });
const FLOW_STUDIO_TOKENS = FLOW_STUDIO_METER.createHistogram('flow_studio.run.tokens', { unit: '{token}', description: 'Total input plus output tokens.' });
const INTERNAL_RUN_REQUEST = Symbol('flow-studio-internal-run-request');
const INTERNAL_GRAPH_DIGEST = Symbol('flow-studio-internal-graph-digest');

type InternalFlowStudioRunRequest = FlowStudioRunRequest & {
    [INTERNAL_RUN_REQUEST]?: boolean;
    [INTERNAL_GRAPH_DIGEST]?: string;
};

const NODE_TYPES: FlowStudioNodeType[] = [
    'input', 'context', 'agent', 'playbook', 'action', 'command', 'memory_write',
    'router', 'fork', 'dynamic_parallel', 'tournament', 'join', 'gate',
    'wait', 'subgraph', 'loop', 'transform', 'report', 'end'
];

export const FLOW_STUDIO_DEFAULT_MODEL_PROFILES: Record<string, FlowStudioModelProfile> = {
    'cybervinci/default': {
        id: 'cybervinci/default',
        name: 'CyberVinci · configuração atual',
        providerId: 'cybervinci',
        runnerId: 'cybervinci',
        modelId: 'default',
        description: 'Reutiliza o login, o modelo padrão e as sessões do CyberVinci CLI.',
        tags: ['local', 'coding', 'reasoning', 'tools'],
        capabilities: ['text', 'reasoning', 'tools', 'files', 'structured-output', 'sessions', 'subagents'],
        reasonDefault: 'high'
    },
    'opencode/gpt-5.5': {
        id: 'opencode/gpt-5.5',
        name: 'OpenCode GPT-5.5',
        providerId: 'opencode',
        runnerId: 'opencode',
        modelId: 'opencode/gpt-5.5',
        description: 'Perfil de coordenação e raciocínio profundo.',
        tags: ['coding', 'reasoning', 'default'],
        capabilities: ['text', 'reasoning', 'tools', 'files', 'structured-output', 'sessions', 'subagents'],
        reasonDefault: 'high'
    },
    'codex/gpt-5.5-codex': {
        id: 'codex/gpt-5.5-codex',
        name: 'Codex GPT-5.5',
        providerId: 'codex',
        runnerId: 'codex',
        modelId: 'gpt-5.5-codex',
        description: 'Perfil para execução de engenharia via Codex CLI.',
        tags: ['coding', 'tools', 'reasoning'],
        capabilities: ['text', 'reasoning', 'tools', 'files', 'structured-output', 'streaming', 'sessions', 'subagents'],
        reasonDefault: 'high'
    },
    'opencode-go/minimax-m3': {
        id: 'opencode-go/minimax-m3',
        name: 'OpenCode Go MiniMax M3',
        providerId: 'opencode-go',
        runnerId: 'opencode',
        modelId: 'opencode-go/minimax-m3',
        description: 'Perfil rápido e econômico para execução principal.',
        tags: ['fast', 'budget'],
        capabilities: ['text', 'tools', 'structured-output'],
        costPerMTokPrompt: 0.5,
        costPerMTokOutput: 0.9,
        reasonDefault: 'medium'
    },
    'opencode-go/deepseek-v4-flash': {
        id: 'opencode-go/deepseek-v4-flash',
        name: 'OpenCode Go DeepSeek Flash',
        providerId: 'opencode-go',
        runnerId: 'opencode',
        modelId: 'opencode-go/deepseek-v4-flash',
        description: 'Perfil barato para triagem, transformação e classificação.',
        tags: ['fast', 'cheap'],
        capabilities: ['text', 'structured-output'],
        costPerMTokPrompt: 0.18,
        costPerMTokOutput: 0.6,
        reasonDefault: 'low'
    }
};

export interface FlowStudioTemplate { graph: FlowStudioGraph }

export function createFlowStudioTemplate(name = 'Novo fluxo'): FlowStudioGraph {
    const reviewGraph: FlowStudioGraph = {
        version: FLOW_STUDIO_SCHEMA_VERSION,
        id: 'subgraph-revisao',
        name: 'Revisão independente',
        start: 'revisor',
        nodes: [
            {
                id: 'revisor',
                type: 'agent',
                label: 'Revisar evidências',
                prompt: 'Revise o resultado em {{resultado}}. Retorne approved, blockers e summary.',
                provider: { providerId: 'codex', reasoningEffort: 'high', fallbacks: [{ providerId: 'cybervinci', reasoningEffort: 'high' }, { providerId: 'opencode', reasoningEffort: 'high' }] },
                outputs: { approved: 'review.approved', blockers: 'review.blockers', summary: 'review.summary' },
                next: 'fim-revisao'
            },
            { id: 'fim-revisao', type: 'end', label: 'Fim da revisão' }
        ],
        edges: [{ id: 'review-end', from: 'revisor', to: 'fim-revisao' }]
    };

    return {
        version: FLOW_STUDIO_SCHEMA_VERSION,
        id: `flow-${Date.now()}`,
        name,
        description: 'Fluxo multiagente com roteamento, paralelo, gate, loop seguro e revisão reutilizável.',
        start: 'entrada',
        budget: { maxSteps: 500, maxDurationMs: 30 * 60_000, maxCostUsd: 10, maxParallelism: 4 },
        permissions: { allow: ['runner:invoke', 'tool:read'], requireApproval: ['tool:command', 'tool:write', 'tool:network'] },
        state: {
            strictWrites: false,
            namespaces: {
                flow: { description: 'Estado principal', reducer: { kind: 'merge' } },
                branches: { description: 'Resultados paralelos', reducer: { kind: 'merge' } },
                review: { description: 'Revisão independente', reducer: { kind: 'merge' } }
            }
        },
        modelProfiles: Object.values(FLOW_STUDIO_DEFAULT_MODEL_PROFILES),
        subgraphs: { review: reviewGraph },
        runners: [
            { id: 'flow', name: 'Flow standalone', kind: 'flow', providerId: 'flow', capabilities: ['text', 'reasoning', 'tools', 'files', 'structured-output', 'streaming', 'sessions'] },
            { id: 'cybervinci', name: 'CyberVinci', kind: 'cybervinci', providerId: 'cybervinci', capabilities: ['text', 'reasoning', 'tools', 'files', 'structured-output', 'sessions', 'subagents'] },
            { id: 'opencode', name: 'OpenCode', kind: 'opencode', providerId: 'opencode', capabilities: ['text', 'reasoning', 'tools', 'files', 'structured-output', 'sessions', 'subagents'] },
            { id: 'codex', name: 'Codex CLI', kind: 'codex', providerId: 'codex', capabilities: ['text', 'reasoning', 'tools', 'files', 'structured-output', 'streaming', 'sessions', 'subagents'] }
        ],
        nodes: [
            {
                id: 'entrada', type: 'input', label: 'Pedido', next: 'planejador',
                outputs: { prompt: 'flow.request' }, position: { x: 40, y: 100 }
            },
            {
                id: 'planejador', type: 'agent', label: 'Planejar',
                prompt: 'Crie um plano verificável para: {{flow.request}}',
                provider: { runnerId: 'codex', providerId: 'codex', reasoningEffort: 'high', fallbacks: [{ runnerId: 'cybervinci', providerId: 'cybervinci', reasoningEffort: 'high' }, { runnerId: 'opencode', providerId: 'opencode', reasoningEffort: 'high' }] },
                outputs: { plan: 'flow.plan', risk: 'flow.risk' }, next: 'rotear-risco', position: { x: 290, y: 100 }
            },
            {
                id: 'rotear-risco', type: 'router', label: 'Risco aceitável?',
                condition: 'Boolean(context.flow?.plan) && context.flow?.risk !== "high"', position: { x: 540, y: 100 }
            },
            {
                id: 'gate-risco', type: 'gate', label: 'Aprovar risco',
                gate: { kind: 'human', prompt: 'O plano de risco alto pode prosseguir?', requireEvidence: true },
                gateDecisions: [
                    { id: 'aprovar', label: 'Aprovar', decision: 'continue', toNodeId: 'executar-paralelo' },
                    { id: 'aguardar', label: 'Aguardar', decision: 'wait' },
                    { id: 'rejeitar', label: 'Rejeitar', decision: 'fail' }
                ], position: { x: 540, y: 300 }
            },
            {
                id: 'executar-paralelo', type: 'fork', label: 'Executar em paralelo',
                fork: { branches: ['executor', 'pesquisador'], join: 'consolidar', maxConcurrency: 2 }, position: { x: 790, y: 100 }
            },
            {
                id: 'executor', type: 'agent', label: 'Executar', prompt: 'Execute o plano {{flow.plan}} e devolva resultado e evidências.',
                provider: { runnerId: 'codex', providerId: 'codex', reasoningEffort: 'high', fallbacks: [{ runnerId: 'cybervinci', providerId: 'cybervinci', reasoningEffort: 'high' }, { runnerId: 'opencode', providerId: 'opencode', reasoningEffort: 'high' }] },
                outputs: { result: 'branches.execution', evidence: 'branches.executionEvidence' }, next: 'consolidar', position: { x: 1040, y: 20 }
            },
            {
                id: 'pesquisador', type: 'agent', label: 'Pesquisar', prompt: 'Pesquise riscos e alternativas para {{flow.plan}}.',
                provider: { runnerId: 'codex', providerId: 'codex', reasoningEffort: 'low', fallbacks: [{ runnerId: 'cybervinci', providerId: 'cybervinci', reasoningEffort: 'low' }, { runnerId: 'opencode', providerId: 'opencode', reasoningEffort: 'low' }] },
                outputs: { result: 'branches.research' }, next: 'consolidar', position: { x: 1040, y: 180 }
            },
            {
                id: 'consolidar', type: 'join', label: 'Consolidar', join: { strategy: 'all', reducer: 'branches' },
                next: 'revisar', position: { x: 1290, y: 100 }
            },
            {
                id: 'revisar', type: 'subgraph', label: 'Revisão independente',
                subgraph: { graphId: 'review', input: { 'branches.execution': 'resultado' }, output: { 'review.approved': 'review.approved', 'review.blockers': 'review.blockers' } },
                next: 'corrigir', position: { x: 1540, y: 100 }
            },
            {
                id: 'corrigir', type: 'loop', label: 'Corrigir blockers',
                loop: { bodyStart: 'correcao', condition: 'context.review?.approved === false', maxIterations: 3, breakWhen: 'context.review?.approved === true' },
                next: 'relatorio', position: { x: 1790, y: 100 }
            },
            {
                id: 'correcao', type: 'agent', label: 'Aplicar correções',
                prompt: 'Corrija os blockers: {{review.blockers}}', provider: { runnerId: 'codex', providerId: 'codex', reasoningEffort: 'high', fallbacks: [{ runnerId: 'cybervinci', providerId: 'cybervinci', reasoningEffort: 'high' }, { runnerId: 'opencode', providerId: 'opencode', reasoningEffort: 'high' }] },
                outputs: { result: 'branches.execution', approved: 'review.approved' }, next: 'corrigir', position: { x: 1790, y: 300 }
            },
            {
                id: 'relatorio', type: 'report', label: 'Relatório final',
                prompt: 'Produza um relatório curto com resultado, evidências e revisão.',
                provider: { runnerId: 'codex', providerId: 'codex', reasoningEffort: 'medium', fallbacks: [{ runnerId: 'cybervinci', providerId: 'cybervinci', reasoningEffort: 'medium' }, { runnerId: 'opencode', providerId: 'opencode', reasoningEffort: 'medium' }] },
                outputs: { report: 'flow.report' }, next: 'final', position: { x: 2040, y: 100 }
            },
            { id: 'final', type: 'end', label: 'Concluído', position: { x: 2290, y: 100 } }
        ],
        edges: [
            { id: 'entrada-planejador', from: 'entrada', to: 'planejador' },
            { id: 'planejador-router', from: 'planejador', to: 'rotear-risco' },
            { id: 'risco-ok', from: 'rotear-risco', to: 'executar-paralelo', guard: 'condition === true', label: 'sim', priority: 0 },
            { id: 'risco-gate', from: 'rotear-risco', to: 'gate-risco', guard: 'condition === false', label: 'revisar', priority: 1 },
            { id: 'gate-fork', from: 'gate-risco', to: 'executar-paralelo' },
            { id: 'fork-executor', from: 'executar-paralelo', to: 'executor' },
            { id: 'fork-pesquisa', from: 'executar-paralelo', to: 'pesquisador' },
            { id: 'executor-join', from: 'executor', to: 'consolidar' },
            { id: 'pesquisa-join', from: 'pesquisador', to: 'consolidar' },
            { id: 'join-review', from: 'consolidar', to: 'revisar' },
            { id: 'review-loop', from: 'revisar', to: 'corrigir' },
            { id: 'correcao-loop', from: 'correcao', to: 'corrigir', outcome: 'back' },
            { id: 'loop-report', from: 'corrigir', to: 'relatorio' },
            { id: 'report-end', from: 'relatorio', to: 'final' }
        ]
    };
}

export function validateFlowStudioGraph(graph: FlowStudioGraph): FlowStudioValidationResult {
    return validateFlowStudioGraphInternal(graph, new Set<FlowStudioGraph>());
}

function validateFlowStudioGraphInternal(graph: FlowStudioGraph, seen: Set<FlowStudioGraph>): FlowStudioValidationResult {
    const issues: FlowStudioValidationIssue[] = [];
    const error = (code: string, message: string, path: string, hint?: string): void => {
        issues.push({ kind: 'error', code, message, path, hint });
    };
    const warn = (code: string, message: string, path: string, hint?: string): void => {
        issues.push({ kind: 'warning', code, message, path, hint });
    };

    if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
        return { valid: false, errors: [{ kind: 'error', code: 'graph.invalid', message: 'O grafo deve ser um objeto.', path: 'root' }], warnings: [] };
    }
    if (seen.has(graph)) {
        return { valid: false, errors: [{ kind: 'error', code: 'graph.recursive-object', message: 'O GraphSpec contém uma referência circular em memória.', path: 'root' }], warnings: [] };
    }
    seen.add(graph);
    for (const issue of validateGraphSpecSchema(graph)) {
        error('schema.invalid', issue.message, issue.path);
    }
    if (graph.version !== FLOW_STUDIO_SCHEMA_VERSION) {
        error('graph.version', `A versão deve ser "${FLOW_STUDIO_SCHEMA_VERSION}".`, 'version', 'Crie um grafo v2; não há compatibilidade implícita com versões anteriores.');
    }
    if (!graph.id?.trim()) error('graph.id', 'O id do fluxo é obrigatório.', 'id');
    if (!graph.name?.trim()) error('graph.name', 'O nome do fluxo é obrigatório.', 'name');
    if (!graph.start?.trim()) error('graph.start', 'O nó inicial é obrigatório.', 'start');
    if (isRecord(graph.state?.initial) && hasReservedRoot(graph.state?.initial)) error('state.reserved', 'state.initial não pode declarar o namespace interno _flowStudio.', 'state/initial');
    if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) error('graph.nodes', 'O fluxo precisa de pelo menos um nó.', 'nodes');
    if (!Array.isArray(graph.edges)) error('graph.edges', 'edges deve ser uma lista.', 'edges');

    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph.edges) ? graph.edges : [];
    const nodeById = new Map<string, FlowStudioNode>();
    const profileById = resolveModelProfiles(graph, undefined);
    const runnerById = new Map((graph.runners || []).map(runner => [runner.id, runner]));

    for (const [index, runner] of (graph.runners || []).entries()) {
        const base = `runners/${index}`;
        if (!runner.id?.trim() || !runner.name?.trim()) error('runner.invalid', 'Cada runner precisa de id e name.', base);
        if (runner.kind === 'command' || runner.kind === 'mcp') {
            if (!runner.command?.trim()) error('runner.command', `O runner "${runner.id}" exige command.`, `${base}/command`);
        }
        if (runner.kind === 'http' || runner.kind === 'worker' || runner.kind === 'llm') {
            if (!runner.endpoint && !runner.command) error('runner.endpoint', `O runner "${runner.id}" exige endpoint ou command.`, base);
            if (runner.endpoint) {
                try {
                    const endpoint = new URL(runner.endpoint);
                    if (!['http:', 'https:'].includes(endpoint.protocol)) error('runner.endpoint.protocol', `O endpoint de "${runner.id}" precisa usar HTTP(S).`, `${base}/endpoint`);
                    if (!networkHostAllowed(endpoint, graph.permissions?.networkHosts || [])) error('runner.endpoint.permission', `O host ${endpoint.host} não está autorizado em permissions.networkHosts.`, `${base}/endpoint`);
                } catch {
                    error('runner.endpoint.invalid', `O endpoint de "${runner.id}" não é uma URL válida.`, `${base}/endpoint`);
                }
            }
        }
    }

    for (const [index, node] of nodes.entries()) {
        const base = `nodes/${index}`;
        if (!node || typeof node !== 'object') {
            error('node.invalid', 'Cada nó deve ser um objeto.', base);
            continue;
        }
        if (!node.id?.trim()) {
            error('node.id', 'Cada nó precisa de id.', `${base}/id`);
            continue;
        }
        if (nodeById.has(node.id)) error('node.duplicate', `Id de nó duplicado: "${node.id}".`, `${base}/id`);
        nodeById.set(node.id, node);
        if (!isValidNodeType(node.type)) error('node.type', `Tipo não suportado: "${String(node.type)}".`, `${base}/type`);
        if (!node.label?.trim()) error('node.label', `O nó "${node.id}" precisa de label.`, `${base}/label`);

        const binding = node.runner || node.provider;
        if (['agent', 'report'].includes(node.type)) {
            if (!node.prompt?.trim()) warn('node.prompt', `O nó "${node.id}" não possui prompt.`, `${base}/prompt`);
            if (!binding?.providerId?.trim()) warn('node.runner.default', `O nó "${node.id}" usará o runner padrão da execução.`, `${base}/runner`);
        }
        if (binding) {
            const profile = resolveModel(binding, profileById);
            if (binding.profileId && !profileById[binding.profileId]) error('runner.profile.unknown', `Perfil "${binding.profileId}" não existe.`, `${base}/runner/profileId`);
            if (binding.modelId && !profile) error('runner.model.unknown', `Modelo "${binding.modelId}" não existe no catálogo.`, `${base}/runner/modelId`);
            if (binding.runnerId && !runnerById.has(binding.runnerId)) error('runner.unknown', `Runner "${binding.runnerId}" não existe no catálogo.`, `${base}/runner/runnerId`);
            const available = new Set<FlowStudioRunnerCapability>([
                ...(profile?.capabilities || []), ...(binding.runnerId ? runnerById.get(binding.runnerId)?.capabilities || [] : [])
            ]);
            for (const capability of binding.requiredCapabilities || []) {
                if (!available.has(capability)) error('runner.capability', `O runner de "${node.id}" não declara a capability "${capability}".`, `${base}/runner/requiredCapabilities`);
            }
            for (const [fallbackIndex, fallback] of (binding.fallbacks || []).entries()) validateRunnerBindingTree(fallback, `${base}/runner/fallbacks/${fallbackIndex}`, profileById, runnerById, error);
        }
        if (node.type === 'action' && (!node.tools?.length)) error('action.tools', `A Action "${node.id}" precisa de pelo menos uma ferramenta.`, `${base}/tools`);
        if (node.type === 'context') {
            const config = node.context;
            if (!config || (!config.query?.trim() && !config.statePaths?.length && !config.filePaths?.length && !config.tags?.length)) error('context.sources', `O Context "${node.id}" precisa de query, paths, arquivos ou tags.`, `${base}/context`);
            for (const [field, values] of [['statePaths', config?.statePaths], ['filePaths', config?.filePaths]] as Array<[string, string[] | undefined]>) {
                for (const value of values || []) if (!isSafeStatePath(value.replace(/[\\/]/g, '.'))) error('context.path.unsafe', `O Context "${node.id}" contém path proibido.`, `${base}/context/${field}`);
            }
            if (config?.outputPath && !isSafeStatePath(config.outputPath)) error('context.output.unsafe', `O destino do Context "${node.id}" é proibido.`, `${base}/context/outputPath`);
            if (config?.scopes?.includes('agent') && !config.scopeId?.trim()) error('context.scope.agent', `O Context "${node.id}" exige scopeId para o escopo agent.`, `${base}/context/scopeId`);
        }
        if (node.type === 'command') {
            const config = node.command;
            if (!config?.command?.trim()) error('command.required', `O Command "${node.id}" precisa de executável.`, `${base}/command/command`);
            const effect = config?.effect || 'command';
            if (effect !== 'none' && effect !== 'read' && !config?.idempotencyKey) error('command.idempotency', `O Command "${node.id}" mutável exige idempotencyKey.`, `${base}/command/idempotencyKey`);
            if (effect !== 'none' && effect !== 'read' && (config?.retries || 0) > 0) error('command.retry.unsafe', `O Command "${node.id}" mutável não pode repetir automaticamente após resultado ambíguo.`, `${base}/command/retries`);
            if (!hasPermissionDeclaration(graph.permissions, node.permissions, config?.requiredPermissions || [permissionForEffect(effect)])) warn('command.permission', `O Command "${node.id}" não possui permissão explícita.`, `${base}/permissions`);
        }
        if (node.type === 'memory_write') {
            const config = node.memoryWrite;
            if (!config?.candidatesFrom?.trim()) error('memory.candidates', `O Memory Write "${node.id}" precisa de candidatesFrom.`, `${base}/memoryWrite/candidatesFrom`);
            if (config?.candidatesFrom && !isSafeStatePath(config.candidatesFrom)) error('memory.candidates.unsafe', `O Memory Write "${node.id}" contém candidatesFrom proibido.`, `${base}/memoryWrite/candidatesFrom`);
            if (config?.outputPath && !isSafeStatePath(config.outputPath)) error('memory.output.unsafe', `O destino do Memory Write "${node.id}" é proibido.`, `${base}/memoryWrite/outputPath`);
            if (!config?.idempotencyKey) warn('memory.idempotency', `O Memory Write "${node.id}" usará a identidade candidato+revisão como chave idempotente.`, `${base}/memoryWrite/idempotencyKey`);
            if (config?.scope === 'agent' && !config.scopeId?.trim()) error('memory.scope.agent', `O Memory Write "${node.id}" exige scopeId para o escopo agent.`, `${base}/memoryWrite/scopeId`);
        }
        if (node.type === 'playbook') {
            const config = node.playbook;
            if (!config?.playbookId?.trim()) error('playbook.id', `O Playbook "${node.id}" precisa de playbookId.`, `${base}/playbook/playbookId`);
            if (!config?.graphId && !config?.graphRef && !config?.inline && !config?.idempotencyKey) error('playbook.idempotency', `O Playbook externo "${node.id}" exige idempotencyKey.`, `${base}/playbook/idempotencyKey`);
            for (const [source, target] of Object.entries(config?.input || {})) if (!isSafeStatePath(source) || !isSafeStatePath(target)) error('playbook.input.unsafe', `Mapeamento de entrada proibido no Playbook "${node.id}".`, `${base}/playbook/input`);
            for (const [source, target] of Object.entries(config?.output || {})) if (!isSafeStatePath(source) || !isSafeStatePath(target)) error('playbook.output.unsafe', `Mapeamento de saída proibido no Playbook "${node.id}".`, `${base}/playbook/output`);
        }
        if (node.type === 'router' && !node.condition?.trim() && !edges.some(edge => edge.from === node.id && edge.guard)) error('router.condition', `O Router "${node.id}" precisa de condição ou guards nas arestas.`, `${base}/condition`);
        if (node.condition?.trim()) validateExpression(node.condition, `${base}/condition`, error);
        if (node.type === 'fork') {
            if (!node.fork?.branches?.length) error('fork.branches', `O Fork "${node.id}" precisa de branches.`, `${base}/fork/branches`);
            if (!node.fork?.join) error('fork.join', `O Fork "${node.id}" precisa indicar o Join.`, `${base}/fork/join`);
        }
        if (node.type === 'dynamic_parallel') {
            const config = node.dynamicParallel;
            if (!config?.itemsFrom?.trim() || !config?.worker) error('dynamic.config', `O Dynamic Parallel "${node.id}" precisa de itemsFrom e worker.`, `${base}/dynamicParallel`);
            if (config?.itemsFrom) validateExpression(config.itemsFrom, `${base}/dynamicParallel/itemsFrom`, error);
            if (config?.itemVariable && !isSafeStatePath(config.itemVariable)) error('dynamic.item_variable.unsafe', `itemVariable proibido no Dynamic Parallel "${node.id}".`, `${base}/dynamicParallel/itemVariable`);
            if (config?.outputPath && !isSafeStatePath(config.outputPath)) error('dynamic.output.unsafe', `Destino proibido no Dynamic Parallel "${node.id}".`, `${base}/dynamicParallel/outputPath`);
            if (config?.failurePolicy === 'threshold' && config.failureThreshold === undefined) error('dynamic.threshold', `O Dynamic Parallel "${node.id}" exige failureThreshold.`, `${base}/dynamicParallel/failureThreshold`);
            if (config?.worker) validateEmbeddedNode(config.worker, `${base}/dynamicParallel/worker`, 'worker', error, graph, profileById, runnerById);
        }
        if (node.type === 'tournament') {
            const config = node.tournament;
            if (!config?.candidatesFrom?.trim() || !config?.judge) error('tournament.config', `O Tournament "${node.id}" precisa de candidatesFrom e judge.`, `${base}/tournament`);
            if (config?.candidatesFrom) validateExpression(config.candidatesFrom, `${base}/tournament/candidatesFrom`, error);
            if (!config?.criteria?.length || config.criteria.some(item => !item.trim())) error('tournament.criteria', `O Tournament "${node.id}" precisa de critérios não vazios.`, `${base}/tournament/criteria`);
            if (config?.outputPath && !isSafeStatePath(config.outputPath)) error('tournament.output.unsafe', `Destino proibido no Tournament "${node.id}".`, `${base}/tournament/outputPath`);
            if (config?.judge) validateEmbeddedNode(config.judge, `${base}/tournament/judge`, 'judge', error, graph, profileById, runnerById);
        }
        if (node.type === 'join') {
            const inbound = edges.filter(edge => edge.to === node.id).length;
            if (inbound < 2) warn('join.inbound', `O Join "${node.id}" possui menos de duas entradas.`, base);
            if (node.join?.strategy === 'quorum' && (!node.join.quorum || node.join.quorum < 1)) error('join.quorum', `O Join "${node.id}" exige quorum positivo.`, `${base}/join/quorum`);
        }
        if (node.type === 'loop') {
            if (!node.loop?.bodyStart || !node.loop.condition) error('loop.config', `O Loop "${node.id}" precisa de bodyStart e condition.`, `${base}/loop`);
            if (!Number.isInteger(node.loop?.maxIterations) || (node.loop?.maxIterations || 0) < 1) error('loop.bound', `O Loop "${node.id}" exige maxIterations positivo.`, `${base}/loop/maxIterations`);
            if (node.loop?.condition) validateExpression(node.loop.condition, `${base}/loop/condition`, error);
            if (node.loop?.breakWhen) validateExpression(node.loop.breakWhen, `${base}/loop/breakWhen`, error);
        }
        if (node.type === 'wait') validateWait(node, base, error);
        if (node.type === 'subgraph' && !node.subgraph?.inline && !node.subgraph?.graphId && !node.subgraph?.graphRef) error('subgraph.ref', `O Subgraph "${node.id}" precisa de inline, graphId ou graphRef.`, `${base}/subgraph`);
        if (node.type === 'gate') validateGate(node, base, warn, error);

        for (const tool of node.tools || []) {
            if (!tool.id?.trim() || !tool.command?.trim()) error('tool.invalid', `Ferramenta inválida no nó "${node.id}".`, `${base}/tools`);
            if (tool.effect && tool.effect !== 'none' && tool.effect !== 'read' && !tool.idempotencyKey) warn('effect.idempotency', `A ferramenta "${tool.id}" deve declarar idempotencyKey para replay seguro.`, `${base}/tools/${tool.id}`);
            const inferredPermission = permissionForEffect(tool.effect || 'command');
            if (!hasPermissionDeclaration(graph.permissions, node.permissions, tool.requiredPermissions || [inferredPermission])) {
                warn('permission.undeclared', `O efeito da ferramenta "${tool.id}" não possui permissão/approval explícito.`, `${base}/tools/${tool.id}/requiredPermissions`);
            }
        }
        for (const [source, target] of Object.entries(node.outputs || {})) {
            if (!source.trim() || !target.trim()) error('state.output.invalid', `Mapeamento de saída inválido no nó "${node.id}".`, `${base}/outputs`);
            if (!isSafeStatePath(source) || !isSafeStatePath(target)) error('state.output.unsafe', `Mapeamento de saída contém caminho proibido no nó "${node.id}".`, `${base}/outputs/${source}`);
            const namespace = target.split('.')[0];
            if (graph.state?.strictWrites && !graph.state.namespaces?.[namespace]) error('state.namespace.unknown', `A saída "${target}" escreve em namespace não declarado.`, `${base}/outputs/${source}`);
        }
        for (const target of configuredOutputPaths(node)) {
            if (!isSafeStatePath(target)) error('state.output.unsafe', `O destino "${target}" do nó "${node.id}" é proibido.`, base);
            const namespace = target.split('.')[0];
            if (graph.state?.strictWrites && !graph.state.namespaces?.[namespace]) error('state.namespace.unknown', `A saída "${target}" escreve em namespace não declarado.`, base);
        }
        if (node.next && !nodes.some(candidate => candidate.id === node.next)) error('node.next', `O próximo nó "${node.next}" não existe.`, `${base}/next`);
    }

    if (graph.start && !nodeById.has(graph.start)) error('graph.start.unknown', `O nó inicial "${graph.start}" não existe.`, 'start');
    const edgeIds = new Set<string>();
    for (const [index, edge] of edges.entries()) {
        const base = `edges/${index}`;
        if (!edge?.from || !edge.to) {
            error('edge.endpoints', 'Cada aresta precisa de from e to.', base);
            continue;
        }
        if (!nodeById.has(edge.from)) error('edge.from', `Origem inexistente: "${edge.from}".`, `${base}/from`);
        if (!nodeById.has(edge.to)) error('edge.to', `Destino inexistente: "${edge.to}".`, `${base}/to`);
        if (edge.guard?.trim()) validateExpression(edge.guard, `${base}/guard`, error);
        const id = edge.id || `${edge.from}->${edge.to}`;
        if (edgeIds.has(id)) error('edge.duplicate', `Aresta duplicada: "${id}".`, base);
        edgeIds.add(id);
    }

    for (const node of nodes) {
        const refs: Array<[string | undefined, string]> = [
            [node.loop?.bodyStart, 'loop/bodyStart'], [node.fork?.join, 'fork/join'],
            ...((node.fork?.branches || []).map((ref): [string, string] => [ref, 'fork/branches'])),
            ...((node.gateDecisions || []).map((decision): [string | undefined, string] => [decision.toNodeId, `gateDecisions/${decision.id}`]))
        ];
        for (const [ref, field] of refs) if (ref && !nodeById.has(ref)) error('node.reference', `O nó "${node.id}" referencia "${ref}", que não existe.`, `nodes/${node.id}/${field}`);
        if (node.type === 'fork' && node.fork?.join && nodeById.get(node.fork.join)?.type !== 'join') error('fork.join.type', `O destino "${node.fork.join}" precisa ser um Join.`, `nodes/${node.id}/fork/join`);
        if (node.type === 'fork' && node.fork?.join && nodeById.get(node.fork.join)?.type === 'join') {
            const branches = node.fork.branches || [];
            if (new Set(branches).size !== branches.length) error('fork.branch.duplicate', `O Fork "${node.id}" contém branches duplicadas.`, `nodes/${node.id}/fork/branches`);
            for (const branch of branches) {
                if (nodeById.has(branch) && !canReachNode(graph, branch, node.fork.join)) error('fork.branch.join', `A branch "${branch}" não alcança o Join "${node.fork.join}".`, `nodes/${node.id}/fork/branches`);
            }
            const join = nodeById.get(node.fork.join)?.join || { strategy: 'all' as const };
            if (requiredJoinResults(join, branches.length) > branches.length) error('join.impossible', `O Join "${node.fork.join}" exige mais resultados do que o Fork pode produzir.`, `nodes/${node.fork.join}/join`);
        }
    }

    const reachable = collectReachable(graph, nodeById);
    for (const node of nodes) if (!reachable.has(node.id)) warn('node.unreachable', `O nó "${node.id}" é inalcançável a partir de "${graph.start}".`, `nodes/${node.id}`);
    if (!nodes.some(node => node.type === 'end')) warn('graph.no-end', 'O fluxo não possui nó End explícito.', 'nodes');
    if (!graph.budget?.maxCostUsd && nodes.some(node => node.type === 'agent' || node.type === 'report')) warn('budget.cost.unbounded', 'O fluxo usa modelos sem limite global de custo.', 'budget/maxCostUsd');
    if (!graph.budget?.maxDurationMs) warn('budget.duration.unbounded', 'Defina maxDurationMs para execuções duráveis previsíveis.', 'budget/maxDurationMs');
    for (const [namespace, spec] of Object.entries(graph.state?.namespaces || {})) {
        if (!isSafeStatePath(namespace)) error('state.namespace.unsafe', `Namespace proibido: "${namespace}".`, `state/namespaces/${namespace}`);
        if (spec.reducer?.kind === 'custom') {
            if (!spec.reducer.expression) error('state.reducer.expression', `Reducer custom de "${namespace}" exige expression.`, `state/namespaces/${namespace}/reducer/expression`);
            else validateExpression(spec.reducer.expression, `state/namespaces/${namespace}/reducer/expression`, error);
        }
    }
    validateForkWriteConflicts(graph, nodeById, warn);

    const nestedGraphs: Array<{ path: string; graph: FlowStudioGraph }> = [
        ...Object.entries(graph.subgraphs || {}).map(([id, nested]) => ({ path: `subgraphs/${id}`, graph: nested })),
        ...nodes.flatMap((node, index) => [
            ...(node.subgraph?.inline ? [{ path: `nodes/${index}/subgraph/inline`, graph: node.subgraph.inline }] : []),
            ...(node.playbook?.inline ? [{ path: `nodes/${index}/playbook/inline`, graph: node.playbook.inline }] : [])
        ])
    ];
    for (const nested of nestedGraphs) {
        const result = validateFlowStudioGraphInternal(nested.graph, new Set(seen));
        for (const issue of [...result.errors, ...result.warnings]) {
            issues.push({ ...issue, path: `${nested.path}/${issue.path}` });
        }
    }

    return { valid: issues.every(issue => issue.kind !== 'error'), errors: issues.filter(issue => issue.kind === 'error'), warnings: issues.filter(issue => issue.kind === 'warning') };
}

type IssueWriter = (code: string, message: string, path: string, hint?: string) => void;

function validateGraphSpecSchema(value: unknown): Array<{ path: string; message: string }> {
    // Loaded lazily to keep authoring -> engine imports acyclic during module initialization.
    const schema = require('./authoring') as typeof import('./authoring');
    return schema.validateFlowStudioGraphSchema(value);
}

function validateWait(node: FlowStudioNode, base: string, error: IssueWriter): void {
    const wait = node.wait;
    if (!wait) return error('wait.config', `O Wait "${node.id}" precisa de configuração.`, `${base}/wait`);
    if (wait.kind === 'duration' && (!wait.durationMs || wait.durationMs < 1)) error('wait.duration', `O Wait "${node.id}" exige durationMs positivo.`, `${base}/wait/durationMs`);
    if (wait.kind === 'until' && (!wait.until || !Number.isFinite(Date.parse(wait.until)))) {
        error('wait.until', `O Wait "${node.id}" exige uma data válida em until.`, `${base}/wait/until`);
    }
    if (wait.kind === 'event' && !wait.eventName) error('wait.event', `O Wait "${node.id}" exige eventName.`, `${base}/wait/eventName`);
}

function validateGate(node: FlowStudioNode, base: string, warn: IssueWriter, error: IssueWriter): void {
    const gate = normalizeGate(node);
    validateGateConfig(gate, `${base}/gate`, node, error);
    const decisions = declaredGateDecisions(node);
    if (!decisions.some(item => item.decision === 'fail')) warn('gate.failure-path', `O Gate "${node.id}" não declara um caminho de falha.`, `${base}/gateDecisions`);
}

function validateGateConfig(gate: FlowStudioGateConfig, base: string, node: FlowStudioNode, error: IssueWriter): void {
    if (gate.kind === 'deterministic' && !gate.expression) error('gate.expression', `O Gate "${node.id}" exige expression.`, `${base}/expression`);
    if (gate.kind === 'policy' && !gate.rules?.length) error('gate.rules', `O Gate "${node.id}" exige regras.`, `${base}/rules`);
    if (gate.kind === 'ai' && !gate.reviewer && !node.runner && !node.provider) error('gate.reviewer', `O Gate IA "${node.id}" exige reviewer/runner.`, `${base}/reviewer`);
    if (gate.kind === 'composite' && !gate.children?.length) error('gate.children', `O Gate composto "${node.id}" exige children.`, `${base}/children`);
    if (gate.expression) validateExpression(gate.expression, `${base}/expression`, error);
    for (const [index, rule] of (gate.rules || []).entries()) {
        if (rule.expression) validateExpression(rule.expression, `${base}/rules/${index}/expression`, error);
    }
    for (const [index, child] of (gate.children || []).entries()) validateGateConfig(child, `${base}/children/${index}`, node, error);
}

function validateForkWriteConflicts(graph: FlowStudioGraph, nodeById: Map<string, FlowStudioNode>, warn: IssueWriter): void {
    const outgoing = buildOutgoing(graph.nodes, graph.edges);
    for (const node of graph.nodes) {
        if (node.type !== 'fork' || !node.fork?.branches?.length) continue;
        const writes = new Map<string, string[]>();
        for (const branchId of node.fork.branches) {
            for (const namespace of collectBranchWriteNamespaces(branchId, node.fork.join, nodeById, outgoing)) {
                const owners = writes.get(namespace) || [];
                owners.push(branchId);
                writes.set(namespace, owners);
            }
        }
        for (const [namespace, owners] of writes) {
            if (owners.length < 2) continue;
            const reducer = graph.state?.namespaces?.[namespace]?.reducer;
            if (!reducer) warn('state.concurrent-write', `Branches ${owners.join(', ')} escrevem em "${namespace}" sem reducer.`, `nodes/${node.id}/fork`, 'Defina um reducer de namespace ou use namespaces separados.');
        }
    }
}

function collectBranchWriteNamespaces(
    start: string,
    stop: string,
    nodeById: Map<string, FlowStudioNode>,
    outgoing: Map<string, FlowStudioEdge[]>
): Set<string> {
    const namespaces = new Set<string>();
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length) {
        const id = queue.shift() as string;
        if (id === stop || seen.has(id)) continue;
        seen.add(id);
        const node = nodeById.get(id);
        if (!node) continue;
        for (const target of Object.values(node.outputs || {})) namespaces.add(target.split('.')[0]);
        const refs = [node.next, node.loop?.bodyStart, ...(node.fork?.branches || []), ...(node.gateDecisions || []).map(item => item.toNodeId), ...(outgoing.get(id) || []).map(edge => edge.to)];
        for (const ref of refs) if (ref && ref !== stop && !seen.has(ref)) queue.push(ref);
    }
    return namespaces;
}

export async function runFlowStudioGraph(request: FlowStudioRunRequest): Promise<FlowStudioRunResult> {
    const runtime = new FlowStudioRuntime(request);
    return runtime.run();
}

export function flowStudioMemoryCandidateDigest(candidate: FlowStudioMemoryCandidate, scope = candidate.scope): string {
    return digest({ id: candidate.id, revision: String(candidate.revision), scope, kind: candidate.kind, key: candidate.key, value: candidate.value, tags: candidate.tags || [] });
}

interface ExecutionOutcome {
    context: FlowStudioContext;
    terminal?: boolean;
    stoppedAt?: string;
}

interface ForkBranchState {
    branch: string;
    status: 'completed' | 'failed' | 'waiting' | 'cancelled';
    context?: FlowStudioContext;
    error?: string;
    checkpoint?: FlowStudioCheckpoint;
    completionOrder?: number;
}

interface ForkResumeState {
    forkNodeId: string;
    baseContext: FlowStudioContext;
    branches: ForkBranchState[];
}

interface LoopResumeState {
    loopNodeId: string;
    iteration: number;
    context: FlowStudioContext;
    checkpoint: FlowStudioCheckpoint;
}

interface DynamicItemResult {
    index: number;
    key: string;
    status: 'completed' | 'failed' | 'cancelled';
    item: unknown;
    output?: FlowStudioContext;
    error?: string;
}

interface TournamentCandidate {
    id: string;
    index: number;
    value: unknown;
}

interface TournamentJudgment {
    winnerIds: string[];
    scores: Record<string, number>;
    reason?: string;
    evidence?: unknown;
}

interface PermissionApprovalReceipt {
    permission: string;
    nodeId: string;
    toolId?: string;
    inputDigest: string;
    approvedAt?: string;
    approvedBy?: string;
    decisionId?: string;
    evidence?: FlowStudioArtifact[];
}

interface CompositeGateCheckpointState {
    humanResults: Record<string, FlowStudioGateResult>;
    pendingHumanPath: string;
}

interface CompositeGateEvaluation extends FlowStudioGateResult {
    pendingHumanPaths?: string[];
    humanResults?: Record<string, FlowStudioGateResult>;
}

interface GateCheckpointResolution {
    node: FlowStudioNode;
    result: FlowStudioGateResult;
    start?: string;
    permissionGate: boolean;
}

class FlowStudioRuntime {
    private readonly graph: FlowStudioGraph;
    private readonly graphDigest: string;
    private readonly runId: string;
    private readonly startedAt = new Date().toISOString();
    private readonly nodeById: Map<string, FlowStudioNode>;
    private readonly outgoing: Map<string, FlowStudioEdge[]>;
    private readonly structurallyScopedNodes: Set<string>;
    private readonly modelProfiles: Record<string, FlowStudioModelProfile>;
    private readonly events: FlowStudioRunEvent[] = [];
    private readonly checkpoints: FlowStudioCheckpoint[] = [];
    private readonly effects: FlowStudioEffectRecord[];
    private readonly artifacts: FlowStudioArtifact[] = [];
    private artifactBytes = 0;
    private eventBytes = 0;
    private checkpointBytes = 0;
    private readonly usageByNode = new Map<string, FlowStudioUsage>();
    private readonly forkResumeOverrides = new Map<string, ForkResumeState>();
    private readonly loopResumeOverrides = new Map<string, LoopResumeState>();
    private readonly subgraphResumeOverrides = new Map<string, FlowStudioCheckpoint>();
    private readonly consumedSubgraphResumeBoundaries = new Set<string>();
    private readonly runSpan: Span;
    private readonly nodeSpans = new Map<string, Span[]>();
    private readonly concurrencyLimiter: FlowStudioConcurrencyLimiter;
    private readonly stepLedger: FlowStudioStepLedger;
    private readonly visited: string[] = [];
    private readonly visits = new Map<string, number>();
    private readonly nodeEnteredAt = new Map<string, number[]>();
    private readonly nodeWallTimeMs = new Map<string, number>();
    private readonly permissionApprovalReceipts = new Map<string, PermissionApprovalReceipt>();
    private readonly memoryApprovalReceipts = new Map<string, NonNullable<FlowStudioRunRequest['memoryApprovals']>[number]>();
    private readonly runnerSessions: Record<string, Record<string, string>> = {};
    private readonly usage: FlowStudioUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };
    private activeDurationBeforeSegmentMs = 0;
    private pendingCompositeGateState?: CompositeGateCheckpointState;
    private status: FlowStudioRunStatus = 'running';
    private statusMessage?: string;
    private error?: string;
    private waiting?: FlowStudioRunResult['waiting'];

    constructor(private readonly request: FlowStudioRunRequest) {
        this.graph = request.graph;
        this.graphDigest = (request as InternalFlowStudioRunRequest)[INTERNAL_GRAPH_DIGEST] || digest(this.graph);
        this.runId = request.runId || randomHex();
        this.runSpan = FLOW_STUDIO_TRACER.startSpan('flow.run', { attributes: {
            'flow.run.id': this.runId,
            'flow.graph.id': this.graph.id,
            'flow.graph.version': this.graph.version,
            'flow.graph.name': this.graph.name
        } });
        this.concurrencyLimiter = request.concurrencyLimiter || new RunConcurrencyLimiter(this.graph.budget?.maxParallelism || Number.POSITIVE_INFINITY);
        const resumedSteps = readGlobalStepCount(request.resume?.checkpoint.metadata) ?? request.resume?.checkpoint.visited.length ?? 0;
        this.stepLedger = request.stepLedger || {
            count: resumedSteps,
            maxSteps: request.maxSteps || this.graph.budget?.maxSteps || FLOW_STUDIO_MAX_STEPS_DEFAULT
        };
        this.nodeById = new Map(this.graph.nodes.map(node => [node.id, node]));
        this.outgoing = buildOutgoing(this.graph.nodes, this.graph.edges);
        this.structurallyScopedNodes = collectStructuredInteriorNodes(this.graph, this.outgoing);
        this.modelProfiles = resolveModelProfiles(this.graph, request.modelProfiles);
        this.effects = clone(request.effects || request.resume?.checkpoint.effects || []);
        const internalRequest = Boolean((request as InternalFlowStudioRunRequest)[INTERNAL_RUN_REQUEST]);
        this.recordMemoryApprovals(request.memoryApprovals, internalRequest ? 'internal' : 'host', internalRequest);
    }

    async run(): Promise<FlowStudioRunResult> {
        const validation = validateFlowStudioGraph(this.graph);
        if (!validation.valid) throw new Error(`Grafo inválido: ${validation.errors.map(issue => issue.message).join('; ')}`);
        if (!(this.request as InternalFlowStudioRunRequest)[INTERNAL_RUN_REQUEST]) assertNoReservedRoot(this.request.input, 'input da execução');

        const resume = this.request.resume;
        if (resume && (resume.checkpoint.graphId !== this.graph.id || resume.checkpoint.graphVersion !== this.graph.version || resume.checkpoint.graphDigest !== this.graphDigest)) {
            throw new Error(`Checkpoint incompatível: esperado ${this.graph.id}@${this.graph.version}, recebido ${resume.checkpoint.graphId}@${resume.checkpoint.graphVersion}.`);
        }
        if (resume?.checkpoint.metadata?.replayable === false) {
            throw new Error(typeof resume.checkpoint.metadata.replayBlockedReason === 'string'
                ? resume.checkpoint.metadata.replayBlockedReason
                : 'Este checkpoint pertence ao interior de uma região estruturada e não representa um snapshot global consistente.');
        }
        if (resume) {
            this.visited.push(...resume.checkpoint.visited);
            for (const nodeId of resume.checkpoint.visited) this.visits.set(nodeId, (this.visits.get(nodeId) || 0) + 1);
            Object.assign(this.usage, resume.checkpoint.usage);
            this.activeDurationBeforeSegmentMs = Number.isFinite(resume.checkpoint.usage.durationMs)
                ? Math.max(0, resume.checkpoint.usage.durationMs)
                : 0;
            for (const [nodeId, usage] of readUsageByNode(resume.checkpoint.metadata)) this.usageByNode.set(nodeId, usage);
            for (const [nodeId, duration] of readWallTimeByNode(resume.checkpoint.metadata)) this.nodeWallTimeMs.set(nodeId, duration);
            this.addArtifacts(resume.checkpoint.artifacts || []);
            for (const receipt of readPermissionApprovalReceipts(resume.checkpoint.metadata)) this.recordPermissionApproval(receipt, undefined, 'checkpoint');
            this.recordMemoryApprovals(readMemoryApprovalReceipts(resume.checkpoint.metadata), 'checkpoint', true);
            Object.assign(this.runnerSessions, readRunnerSessions(resume.checkpoint.metadata));
        }
        let context = resume ? clone(resume.checkpoint.context) : initialContext(this.graph, this.request.input || {});
        if (resume?.signal) context = deepMerge(context, { signal: resume.signal });
        const start = resume?.checkpoint.nextNodeId || this.graph.start;
        this.emit(resume ? 'run.resumed' : 'run.started', undefined, undefined, resume ? `Execução retomada do checkpoint ${resume.checkpoint.id}.` : `Executando "${this.graph.name}".`);

        try {
            this.assertContextSize(context);
            const nestedCheckpoint = nestedSubgraphCheckpoint(resume?.checkpoint.metadata);
            const forkState = readForkResumeState(resume?.checkpoint.metadata);
            const loopState = readLoopResumeState(resume?.checkpoint.metadata);
            if (resume && forkState) {
                const outcome = await this.executeFrom(forkState.forkNodeId, context);
                context = outcome.context;
            } else if (resume && loopState) {
                const outcome = await this.executeFrom(loopState.loopNodeId, context);
                context = outcome.context;
            } else if (resume && nestedCheckpoint) {
                const outcome = await this.executeFrom(resume.checkpoint.nodeId, context);
                context = outcome.context;
            } else if (resume?.checkpoint.reason === 'wait') {
                const waitResolution = resolveWaitResume(resume.checkpoint.wait, resume.checkpoint.metadata, resume.signal);
                if (waitResolution === 'waiting') {
                    const waitingContext = clone(resume.checkpoint.context);
                    const checkpoint = await this.refreshWaitingCheckpoint(resume.checkpoint, waitingContext);
                    throw new WaitingSignal('A condição de espera ainda não foi atendida.', waitingContext, {
                        nodeId: checkpoint.nodeId,
                        kind: 'wait',
                        checkpointId: checkpoint.id,
                        detail: { wait: checkpoint.wait, ...checkpoint.metadata }
                    });
                }
                if (waitResolution === 'timeout-fail') throw new Error(`Wait "${resume.checkpoint.nodeId}" excedeu o prazo configurado.`);
                this.emit('wait.resolved', resume.checkpoint.nodeId, undefined, 'Espera resolvida; execução retomada.', { signal: resume.signal });
                if (start) {
                    const outcome = await this.executeFrom(start, context);
                    context = outcome.context;
                }
            } else if (resume?.checkpoint.reason === 'gate') {
                if (!resume.gate) {
                    const waitingContext = clone(resume.checkpoint.context);
                    const checkpoint = await this.refreshWaitingCheckpoint(resume.checkpoint, waitingContext);
                    throw new WaitingSignal('Aguardando uma decisão declarada para o Gate.', waitingContext, {
                        nodeId: checkpoint.nodeId,
                        kind: 'gate',
                        checkpointId: checkpoint.id,
                        detail: { ...checkpoint.metadata, interaction: readInteractionEnvelope(checkpoint.metadata) }
                    });
                }
                const resolution = await this.resolveGateCheckpoint(resume.checkpoint, context, resume.gate, this.request.signal);
                if (resolution.result.action === 'wait') await this.pauseForGate(resolution.node, context, resolution.result);
                this.emit('gate.resolved', resolution.node.id, undefined, resolution.result.message
                    || (resolution.permissionGate ? 'Permissão aprovada.' : `Gate resolvido: ${resolution.result.decisionId || resolution.result.action || 'continue'}.`));
                const outcome = await this.executeFrom(resolution.start as string, context);
                context = outcome.context;
            } else if (start) {
                const outcome = await this.executeFrom(start, context);
                context = outcome.context;
            }
            if (this.status === 'running') {
                this.status = 'completed';
                this.emit('run.completed', undefined, undefined, 'Fluxo concluído.');
            }
        } catch (caught) {
            if (caught instanceof WaitingSignal) {
                this.status = 'waiting';
                this.statusMessage = caught.message;
                this.waiting = caught.waiting;
                context = caught.context;
            } else if (isAbortError(caught) || this.request.signal?.aborted) {
                this.status = 'cancelled';
                this.statusMessage = 'Execução cancelada.';
                this.emit('run.cancelled', undefined, undefined, this.statusMessage);
            } else {
                this.status = 'failed';
                this.error = caught instanceof Error ? caught.message : String(caught);
                this.statusMessage = this.error;
                this.emit('run.failed', undefined, undefined, this.error);
                const failedNodeId = this.visited[this.visited.length - 1];
                const failedNode = failedNodeId ? this.nodeById.get(failedNodeId) || this.nodeById.get(failedNodeId.split('::', 1)[0]) : undefined;
                if (failedNode) await this.checkpoint(failedNode, context, failedNode.id, 'failure', undefined, { error: this.error });
            }
        }
        return this.finishResult(context, resume);
    }

    private finishResult(context: FlowStudioContext, resume?: FlowStudioRunRequest['resume']): FlowStudioRunResult {
        this.usage.durationMs = this.activeDurationMs();
        const attributes = { 'flow.graph.id': this.graph.id, 'flow.run.status': this.status };
        FLOW_STUDIO_RUNS.add(1, attributes);
        FLOW_STUDIO_DURATION.record(this.usage.durationMs, attributes);
        FLOW_STUDIO_COST.record(this.usage.costUsd, attributes);
        FLOW_STUDIO_TOKENS.record(this.usage.inputTokens + this.usage.outputTokens, attributes);
        this.runSpan.setAttributes({
            ...attributes,
            'flow.run.steps': this.visited.length,
            'flow.run.cost_usd': this.usage.costUsd,
            'flow.run.input_tokens': this.usage.inputTokens,
            'flow.run.output_tokens': this.usage.outputTokens
        });
        if (this.status === 'failed') this.runSpan.setStatus({ code: SpanStatusCode.ERROR, message: this.error });
        else this.runSpan.setStatus({ code: SpanStatusCode.OK });
        for (const spans of this.nodeSpans.values()) for (const span of spans) span.end();
        this.nodeSpans.clear();
        this.runSpan.end();
        return {
            runId: this.runId,
            parentRunId: resume?.forkRun ? resume.checkpoint.runId : undefined,
            graphId: this.graph.id,
            status: this.status,
            statusMessage: this.statusMessage,
            startedAt: this.startedAt,
            finishedAt: new Date().toISOString(),
            visited: [...this.visited],
            artifacts: clone(this.artifacts),
            finalContext: clone(context),
            events: clone(this.events),
            checkpoints: clone(this.checkpoints),
            effects: clone(this.effects),
            usage: { ...this.usage },
            waiting: this.waiting,
            error: this.error
        };
    }

    private async executeFrom(startNodeId: string, startContext: FlowStudioContext, stopAt = new Set<string>(), signal = this.request.signal): Promise<ExecutionOutcome> {
        let nodeId: string | undefined = startNodeId;
        let context = clone(startContext);
        while (nodeId) {
            this.assertRuntimeBudget(signal);
            if (stopAt.has(nodeId)) return { context, stoppedAt: nodeId };
            const node = this.nodeById.get(nodeId);
            if (!node) throw new Error(`Nó desconhecido: "${nodeId}".`);
            this.enterNode(node, signal);
            const outgoing = this.outgoing.get(node.id) || [];
            let nextNodeId: string | undefined;

            if (node.type === 'input') {
                context = deepMerge(context, collectInputValues(node, this.request.input || {}));
                nextNodeId = pickNextEdge(node, outgoing, context)?.to;
            } else if (node.type === 'context') {
                context = await this.runContext(node, context, signal);
                nextNodeId = pickNextEdge(node, outgoing, context)?.to;
            } else if (node.type === 'agent' || node.type === 'report') {
                context = await this.runAgent(node, context, signal);
                nextNodeId = pickNextEdge(node, outgoing, context)?.to;
            } else if (node.type === 'playbook') {
                const playbook = await this.runPlaybook(node, context, signal);
                context = playbook.context;
                if (playbook.stop) {
                    this.emit('node.success', node.id, undefined, `Playbook "${node.label}" solicitou encerramento.`);
                    await this.checkpoint(node, context, undefined, 'node-complete');
                    return { context, terminal: true };
                }
                nextNodeId = pickNextEdge(node, outgoing, context)?.to;
            } else if (node.type === 'action') {
                context = await this.runAction(node, context, signal);
                nextNodeId = pickNextEdge(node, outgoing, context)?.to;
            } else if (node.type === 'command') {
                context = await this.runCommand(node, context, signal);
                nextNodeId = pickNextEdge(node, outgoing, context)?.to;
            } else if (node.type === 'memory_write') {
                context = await this.runMemoryWrite(node, context, signal);
                nextNodeId = pickNextEdge(node, outgoing, context)?.to;
            } else if (node.type === 'transform') {
                const transformed = evaluate(node.condition || node.prompt || '({})', context, {});
                if (!isRecord(transformed)) throw new Error(`Transform "${node.id}" precisa retornar um objeto.`);
                assertNoReservedRoot(transformed, `saída do Transform "${node.id}"`);
                context = applyNodeOutputs(context, node, transformed, this.graph.state?.strictWrites === true);
                this.emit('node.output', node.id, undefined, `Transform "${node.label}" produziu ${Object.keys(transformed).length} campos.`, transformed);
                this.emit('node.success', node.id, undefined, `Transform "${node.label}" concluído.`);
                nextNodeId = pickNextEdge(node, outgoing, context)?.to;
            } else if (node.type === 'router') {
                const condition = node.condition ? evaluateBoolean(node.condition, context, false, { nodeId: node.id }) : undefined;
                nextNodeId = pickNextEdge(node, outgoing, context, { condition })?.to;
                if (!nextNodeId) this.emit('node.skipped', node.id, undefined, `Router "${node.label}" não encontrou rota.`);
                else this.emit('node.success', node.id, undefined, `Router escolheu "${nextNodeId}".`, { condition });
            } else if (node.type === 'gate') {
                const result = enforceGateEvidence(node, normalizeGateResult(node, await this.runGate(node, context, signal)));
                if (result.action === 'wait') await this.pauseForGate(node, context, result);
                if (result.action === 'fail') {
                    this.emit('gate.resolved', node.id, undefined, result.message || `Gate "${node.label}" bloqueou a execução.`, { action: 'fail', score: result.score, blockers: result.blockers, warnings: result.warnings });
                    throw new Error(result.message || `Gate "${node.label}" bloqueou a execução.`);
                }
                this.recordMemoryApprovals(result.memoryApprovals);
                nextNodeId = this.resolveGateRoute(node, result, context);
                if (!nextNodeId) throw new Error(`Gate "${node.id}" não possui rota de continuação.`);
                if (result.evidence?.length) this.addArtifacts(result.evidence);
                this.emit('gate.resolved', node.id, undefined, result.message || `Gate "${node.label}" aprovado.`, { decisionId: result.decisionId, toNodeId: nextNodeId, score: result.score, blockers: result.blockers, warnings: result.warnings });
            } else if (node.type === 'wait') {
                nextNodeId = pickNextEdge(node, outgoing, context)?.to;
                await this.pauseForWait(node, context, nextNodeId);
            } else if (node.type === 'fork') {
                context = await this.runFork(node, context, signal);
                nextNodeId = node.fork?.join;
            } else if (node.type === 'dynamic_parallel') {
                context = await this.runDynamicParallel(node, context, signal);
                nextNodeId = pickNextEdge(node, outgoing, context)?.to;
            } else if (node.type === 'tournament') {
                context = await this.runTournament(node, context, signal);
                nextNodeId = pickNextEdge(node, outgoing, context)?.to;
            } else if (node.type === 'join') {
                this.emit('node.success', node.id, undefined, `Join "${node.label}" consolidado com estratégia ${node.join?.strategy || 'all'}.`);
                nextNodeId = pickNextEdge(node, outgoing, context)?.to;
            } else if (node.type === 'loop') {
                context = await this.runLoop(node, context, signal);
                nextNodeId = pickNextEdge(node, outgoing, context)?.to;
            } else if (node.type === 'subgraph') {
                context = await this.runSubgraph(node, context, signal);
                nextNodeId = pickNextEdge(node, outgoing, context)?.to;
            } else if (node.type === 'end') {
                this.assertContextSize(context);
                this.assertStateSchemas(context, node);
                this.emit('node.success', node.id, undefined, `End "${node.label}" alcançado.`);
                await this.checkpoint(node, context, undefined, 'node-complete');
                return { context, terminal: true };
            }

            this.assertContextSize(context);
            this.assertStateSchemas(context, node);
            await this.checkpoint(node, context, nextNodeId, 'node-complete');
            nodeId = nextNodeId;
        }
        return { context };
    }

    private enterNode(node: FlowStudioNode, signal = this.request.signal): void {
        if (signal?.aborted) throw abortError();
        this.consumeGlobalStep(node.id);
        const count = (this.visits.get(node.id) || 0) + 1;
        this.visits.set(node.id, count);
        const maxVisits = node.budget?.maxSteps || FLOW_STUDIO_MAX_VISITS_PER_NODE_DEFAULT;
        if (count > maxVisits) throw new Error(`O nó "${node.id}" excedeu ${maxVisits} visitas.`);
        this.visited.push(node.id);
        this.nodeEnteredAt.set(node.id, [...(this.nodeEnteredAt.get(node.id) || []), Date.now()]);
        const parent = trace.setSpan(otelContext.active(), this.runSpan);
        const span = FLOW_STUDIO_TRACER.startSpan('flow.node', { attributes: {
            'flow.run.id': this.runId,
            'flow.graph.id': this.graph.id,
            'flow.node.id': node.id,
            'flow.node.type': node.type,
            'flow.node.label': node.label,
            'flow.node.visit': count
        } }, parent);
        this.nodeSpans.set(node.id, [...(this.nodeSpans.get(node.id) || []), span]);
        this.emit('node.enter', node.id, undefined, `Entrando em ${node.type} "${node.label}".`);
    }

    private async runAgent(node: FlowStudioNode, context: FlowStudioContext, signal = this.request.signal): Promise<FlowStudioContext> {
        await this.authorizePermission(node, 'runner:invoke', context, signal);
        const primary = normalizeBinding(node.runner || node.provider || this.request.defaultProvider || { providerId: 'opencode' });
        const bindings = flattenRunnerBindings(primary);
        const prompt = renderPrompt(node.prompt || '', context);
        const rag = await renderRag(node, context, this.graph.permissions, this.request.workspaceRoot);
        let output: FlowStudioRunnerOutput | undefined;
        let selectedModel: FlowStudioModelProfile | undefined;
        let selectedBinding: FlowStudioRunnerBinding | undefined;
        let lastError: unknown;
        for (const [index, binding] of bindings.entries()) {
            selectedModel = resolveModel(binding, this.modelProfiles);
            const effectiveBinding: FlowStudioRunnerBinding = {
                ...binding,
                runnerId: binding.runnerId || selectedModel?.runnerId,
                providerId: binding.providerId || selectedModel?.providerId || 'opencode',
                modelId: binding.modelId || selectedModel?.modelId,
                reasoningEffort: binding.reasoningEffort || selectedModel?.reasonDefault,
                serviceTier: binding.serviceTier || selectedModel?.serviceTierDefault
            };
            if (!effectiveBinding.sessionId) effectiveBinding.sessionId = this.runnerSessions[node.id]?.[runnerSessionKey(effectiveBinding)];
            const adapter = resolveRunnerAdapter(this.request.runnerAdapters || this.request.providerAdapters || {}, effectiveBinding, selectedModel)
                || (this.request.simulationMode ? defaultProviderAdapter : unavailableRunnerAdapter);
            try {
                output = await withRetry(
                    () => this.concurrencyLimiter.run(() => withAbortableTimeout(attemptSignal => adapter({
                        node, graph: isEmbeddedJudge(node) ? judgeVisibleGraph(this.graph, node, this.request.workspaceRoot) : this.graph, runId: this.runId, context: clone(context), input: node.id.includes('::') ? clone(context) : clone(this.request.input || {}),
                        prompt: `${prompt}${rag}`, runner: effectiveBinding, model: selectedModel,
                        signal: attemptSignal, onEvent: event => this.forwardAdapterEvent(node.id, event)
                    }), this.nodeRuntimeTimeout(node, node.timeoutMs, binding.timeoutMs), signal), signal),
                    node.retries || 0, node.retryDelayMs || 0,
                    attempt => this.emit('node.requeued', node.id, undefined, `Tentativa ${attempt} de "${node.label}".`),
                    signal, () => this.runtimeTimeout()
                );
                selectedBinding = effectiveBinding;
                break;
            } catch (caught) {
                lastError = caught;
                if (index < bindings.length - 1) this.emit('node.requeued', node.id, undefined, `Runner ${binding.providerId} falhou; usando fallback ${bindings[index + 1].providerId}.`);
            }
        }
        if (!output) throw lastError instanceof Error ? lastError : new Error(`Nenhum runner executou "${node.label}".`);
        assertNoReservedRoot(output.output, `saída do runner em "${node.id}"`);
        this.consumeRunnerOutput(node, output, selectedModel);
        let next = applyNodeOutputs(context, node, output.output || {}, this.graph.state?.strictWrites === true);
        if (output.sessionId && selectedBinding) {
            if (!this.runnerSessions[node.id]) this.runnerSessions[node.id] = {};
            this.runnerSessions[node.id][runnerSessionKey(selectedBinding)] = output.sessionId;
        }
        if (output.toolCalls?.length) {
            const declared = new Map((node.tools || []).map(tool => [tool.id, tool]));
            const requested = output.toolCalls.map(call => {
                const tool = declared.get(call.toolId);
                if (!tool) throw new Error(`O agente "${node.id}" solicitou ferramenta não declarada: "${call.toolId}".`);
                if (call.args && !call.args.every(item => typeof item === 'string')) throw new Error(`Argumentos inválidos para a ferramenta "${call.toolId}".`);
                const args = call.args || tool.args;
                return {
                    ...tool,
                    args,
                    // A model cannot choose effect identity. The key is derived only
                    // from the declared binding plus the concrete invocation args.
                    idempotencyKey: `${tool.idempotencyKey || `${this.graph.id}:${node.id}:${tool.id}`}:args:${digest(args || [])}`
                };
            });
            next = await this.runAction({ ...node, type: 'action', label: `${node.label} · ferramentas`, tools: requested, outputs: undefined }, next, signal);
        }
        this.emit('node.output', node.id, undefined, `Saída de "${node.label}".`, output.output || {});
        this.emit('node.success', node.id, undefined, output.summary || `Agente "${node.label}" concluído.`);
        return next;
    }

    private async runAction(node: FlowStudioNode, context: FlowStudioContext, signal = this.request.signal, localAdapters: Record<string, FlowStudioToolAdapter> = {}, forceStrictWrites = false, permissionOverride?: string): Promise<FlowStudioContext> {
        const tools = node.toolExecMode === 'first' ? (node.tools || []).slice(0, 1) : (node.tools || []);
        let result = clone(context);
        const actionController = linkedAbortController(signal);
        const effectKeys = tools.map(tool => {
            const rendered = renderPrompt(tool.idempotencyKey || `${this.graph.id}:${node.id}:${tool.id}:${digest({ args: tool.args, context })}`, context);
            return node.id.includes('::') ? `${rendered}:occurrence:${node.id}` : rendered;
        });
        const duplicatedKey = effectKeys.find((key, index) => effectKeys.indexOf(key) !== index);
        if (duplicatedKey) {
            unlinkAbortController(actionController);
            throw new Error(`A Action "${node.id}" gerou chave idempotente duplicada "${duplicatedKey}". Nenhum efeito foi iniciado.`);
        }
        const execute = async (tool: FlowStudioToolBinding, key: string): Promise<FlowStudioRunnerOutput | undefined> => {
            const permission = permissionOverride || permissionForEffect(tool.effect || 'command');
            await this.authorizeTool(node, tool, permission, context, actionController.signal);
            const previous = [...this.effects].reverse().find(effect => effect.idempotencyKey === key);
            if (previous?.status === 'completed') {
                this.emit('effect.skipped', node.id, undefined, `Efeito "${tool.name}" já concluído; replay não o repetiu.`, { idempotencyKey: key });
                return { output: previous.output || {} };
            }
            if (previous?.status === 'started' || previous?.status === 'uncertain') {
                throw new Error(`Efeito "${tool.name}" possui receipt iniciado sem conclusão comprovada (estado ambíguo). Reconcilie o efeito antes de retomar para evitar duplicação.`);
            }
            const effect: FlowStudioEffectRecord = {
                id: randomHex(), idempotencyKey: key, runId: this.runId, nodeId: node.id, toolId: tool.id,
                kind: tool.effect || 'command', status: 'started', startedAt: new Date().toISOString(), inputDigest: digest({ context, tool })
            };
            this.effects.push(effect);
            await this.request.onEffect?.(clone(effect));
            this.emit('effect.started', node.id, undefined, `Efeito "${tool.name}" iniciado.`, { effectId: effect.id, kind: effect.kind });
            try {
                const localAdapter = resolveToolAdapter(localAdapters, tool);
                const adapter = localAdapter || resolveToolAdapter(this.request.toolAdapters || {}, tool)
                    || (this.request.simulationMode ? defaultToolAdapter : unavailableToolAdapter);
                const timeoutMs = this.nodeRuntimeTimeout(node, tool.timeoutMs, node.timeoutMs);
                const mutating = !['none', 'read'].includes(tool.effect || 'command');
                const output = await withRetry(
                    () => this.concurrencyLimiter.run(() => withAbortableTimeout(attemptSignal => adapter({ nodeId: node.id, runId: this.runId, context: clone(context), tool, node, signal: attemptSignal, onEvent: event => this.forwardAdapterEvent(node.id, event) }), timeoutMs, actionController.signal), actionController.signal),
                    mutating ? 0 : tool.retries ?? node.retries ?? 0, tool.retryDelayMs ?? node.retryDelayMs ?? 0,
                    attempt => this.emit('node.requeued', node.id, undefined, `Tentativa ${attempt} da ferramenta "${tool.name}".`),
                    actionController.signal, () => this.runtimeTimeout()
                );
                if (!localAdapter) assertNoReservedRoot(output.output, `saída da ferramenta "${tool.id}"`);
                effect.status = 'completed';
                effect.finishedAt = new Date().toISOString();
                effect.output = output.output || {};
                await this.request.onEffect?.(clone(effect));
                this.consumeRunnerOutput(node, output);
                this.emit('effect.completed', node.id, undefined, `Efeito "${tool.name}" concluído.`, { effectId: effect.id });
                return output;
            } catch (caught) {
                const mutating = !['none', 'read'].includes(tool.effect || 'command');
                effect.status = mutating ? 'uncertain' : 'failed';
                effect.finishedAt = new Date().toISOString();
                effect.error = caught instanceof Error ? caught.message : String(caught);
                await this.request.onEffect?.(clone(effect));
                if (mutating || !node.continueOnError) throw caught;
                this.emit('node.failed', node.id, undefined, `Ferramenta "${tool.name}" falhou; continueOnError manteve o fluxo.`, { error: effect.error });
                return undefined;
            }
        };
        const outputs: Array<FlowStudioRunnerOutput | undefined> = new Array(tools.length);
        const maxParallelism = Math.max(1, Math.min(
            tools.length || 1,
            node.budget?.maxParallelism || Number.POSITIVE_INFINITY,
            this.graph.budget?.maxParallelism || Number.POSITIVE_INFINITY
        ));
        let cursor = 0;
        let firstError: unknown;
        const worker = async (): Promise<void> => {
            while (!firstError && cursor < tools.length) {
                const index = cursor++;
                try {
                    outputs[index] = await execute(tools[index], effectKeys[index]);
                } catch (error) {
                    firstError ??= error;
                    actionController.abort();
                }
            }
        };
        await Promise.allSettled(Array.from({ length: maxParallelism }, () => worker()));
        unlinkAbortController(actionController);
        if (firstError) throw firstError;
        this.assertNodeBudget(node, this.usageByNode.get(node.id) || normalizeUsage());
        for (const output of outputs) if (output) result = applyNodeOutputs(result, node, output.output || {}, forceStrictWrites || this.graph.state?.strictWrites === true);
        this.emit('node.success', node.id, undefined, `Action "${node.label}" concluiu ${outputs.filter(Boolean).length}/${tools.length} ferramenta(s).`);
        return result;
    }

    private async runContext(node: FlowStudioNode, context: FlowStudioContext, signal = this.request.signal): Promise<FlowStudioContext> {
        const config = node.context;
        if (!config) throw new Error(`Context "${node.id}" sem configuração.`);
        const adapter = this.request.memoryAdapter;
        if (!adapter && !this.request.simulationMode) {
            if (config.required === true) throw new Error(`Context "${node.id}" exige um MemoryAdapter do host.`);
            this.emit('node.skipped', node.id, undefined, `Context "${node.label}" ignorado: MemoryAdapter indisponível.`);
            return context;
        }
        const toolId = `context:${node.id}`;
        const localAdapter: FlowStudioToolAdapter = async args => {
            if (!adapter) {
                return { output: { contextPack: { summary: 'Contexto simulado.', provenance: [] } } };
            }
            const loaded = await adapter.loadContext({ node, runId: this.runId, graph: this.graph, context: clone(args.context), config, workspaceRoot: this.request.workspaceRoot, signal: args.signal });
            if (config.required && !hasContextPackContent(loaded.pack)) throw new Error(`Context "${node.id}" não encontrou conteúdo nas fontes obrigatórias.`);
            return { output: { contextPack: loaded.pack }, artifacts: loaded.artifacts };
        };
        const synthetic: FlowStudioNode = {
            ...node,
            type: 'action',
            tools: [{ id: toolId, name: `Carregar contexto · ${node.label}`, command: 'flow-studio:context', effect: 'read', requiredPermissions: ['memory:read'], idempotencyKey: `${this.graph.id}:${node.id}:context:${digest({ config, context })}` }],
            outputs: { contextPack: config.outputPath || 'context.pack' }
        };
        const result = await this.runAction(synthetic, context, signal, { [toolId]: localAdapter }, false, 'memory:read');
        this.emit('node.success', node.id, undefined, `Context "${node.label}" carregado.`);
        return result;
    }

    private async runCommand(node: FlowStudioNode, context: FlowStudioContext, signal = this.request.signal): Promise<FlowStudioContext> {
        const config = node.command;
        if (!config?.command) throw new Error(`Command "${node.id}" sem executável.`);
        const tool: FlowStudioToolBinding = {
            id: `command:${node.id}`,
            name: node.label,
            command: config.command,
            args: config.args,
            cwd: config.cwd,
            timeoutMs: config.timeoutMs,
            retries: config.retries,
            retryDelayMs: config.retryDelayMs,
            effect: config.effect || 'command',
            idempotencyKey: config.idempotencyKey,
            requiredPermissions: config.requiredPermissions || [permissionForEffect(config.effect || 'command')]
        };
        return this.runAction({ ...node, type: 'action', tools: [tool], toolExecMode: 'first' }, context, signal);
    }

    private async runMemoryWrite(node: FlowStudioNode, context: FlowStudioContext, signal = this.request.signal): Promise<FlowStudioContext> {
        const config = node.memoryWrite;
        if (!config) throw new Error(`Memory Write "${node.id}" sem configuração.`);
        const resolved = evaluateCollection(config.candidatesFrom, context);
        const requested = new Set(config.candidateIds || []);
        const scopeMismatch = resolved.find(value => isMemoryCandidate(value) && ['candidate', 'approved'].includes(value.status) && value.scope !== undefined && value.scope !== config.scope);
        if (scopeMismatch && isMemoryCandidate(scopeMismatch)) throw new Error(`Candidato "${scopeMismatch.id}" tentou gravar no escopo "${scopeMismatch.scope}", diferente do escopo autorizado "${config.scope}".`);
        const candidates = resolved.filter((value): value is FlowStudioMemoryCandidate => isMemoryCandidate(value))
            .filter(candidate => ['candidate', 'approved'].includes(candidate.status)
                && this.memoryApprovalReceipts.has(memoryApprovalKey({
                    id: candidate.id,
                    revision: candidate.revision,
                    scope: config.scope,
                    scopeId: config.scopeId,
                    storeId: config.storeId,
                    graphId: this.graph.id,
                    nodeId: node.id,
                    candidateDigest: flowStudioMemoryCandidateDigest(candidate, config.scope)
                }))
                && (!requested.size || requested.has(candidate.id)));
        if (!candidates.length) {
            if ((config.onEmpty || 'skip') === 'fail') throw new Error(`Memory Write "${node.id}" não encontrou candidatos aprovados.`);
            this.emit('node.skipped', node.id, undefined, `Memory Write "${node.label}" não encontrou candidatos aprovados; nada foi persistido.`);
            return context;
        }
        if (!this.request.memoryAdapter && !this.request.simulationMode) throw new Error(`Memory Write "${node.id}" exige um MemoryAdapter do host.`);
        const tools: FlowStudioToolBinding[] = [];
        const localAdapters: Record<string, FlowStudioToolAdapter> = {};
        const candidateKeys = new Set<string>();
        for (const source of candidates) {
            const candidateDigest = flowStudioMemoryCandidateDigest(source, config.scope);
            const candidateKey = memoryApprovalKey({
                id: source.id,
                revision: source.revision,
                scope: config.scope,
                scopeId: config.scopeId,
                storeId: config.storeId,
                graphId: this.graph.id,
                nodeId: node.id,
                candidateDigest
            });
            if (candidateKeys.has(candidateKey)) throw new Error(`Memory Write "${node.id}" recebeu o candidato duplicado "${source.id}" revisão "${source.revision}". Nenhum efeito foi iniciado.`);
            candidateKeys.add(candidateKey);
            const approval = this.memoryApprovalReceipts.get(candidateKey);
            if (!approval) throw new Error(`Approval receipt ausente para "${source.id}".`);
            const candidate = clone({
                ...source,
                status: 'approved' as const,
                scope: config.scope,
                kind: source.kind || config.kind,
                approvedAt: approval.approvedAt,
                approvedBy: approval.approvedBy
            });
            const toolId = `memory:${candidate.id}:${candidate.revision}`;
            tools.push({
                id: toolId,
                name: `Gravar memória · ${candidate.id}`,
                command: 'flow-studio:memory-write',
                args: [candidate.id, String(candidate.revision)],
                effect: 'write',
                requiredPermissions: ['memory:write'],
                idempotencyKey: `${config.idempotencyKey || `${this.graph.id}:${node.id}`}:${candidate.id}:${candidate.revision}:${candidate.scope}:${config.scopeId || ''}:${config.storeId || ''}:${candidateDigest}`
            });
            localAdapters[toolId] = async args => {
                if (!this.request.memoryAdapter) {
                    return { output: { memoryWritesById: { [candidate.id]: { candidateId: candidate.id, revision: candidate.revision, scope: candidate.scope || config.scope, scopeId: config.scopeId, storeId: config.storeId, status: 'written', digest: digest(candidate), writtenAt: new Date().toISOString(), simulated: true } } } };
                }
                const record = await this.request.memoryAdapter.writeCandidate({ node, runId: this.runId, graph: this.graph, context: clone(args.context), config, candidate, approval: clone(approval), workspaceRoot: this.request.workspaceRoot, signal: args.signal });
                if (record.status !== 'written'
                    || record.candidateId !== candidate.id
                    || String(record.revision) !== String(candidate.revision)
                    || record.scope !== candidate.scope
                    || (record.scopeId || '') !== (config.scopeId || '')
                    || (record.storeId || '') !== (config.storeId || '')) {
                    throw new Error(`MemoryAdapter devolveu receipt inválido para "${candidate.id}".`);
                }
                return { output: { memoryWritesById: { [candidate.id]: record } } };
            };
        }
        const outputPath = config.outputPath || 'memory.writes';
        const result = await this.runAction({ ...node, type: 'action', tools, outputs: { memoryWritesById: outputPath } }, context, signal, localAdapters, false, 'memory:write');
        this.emit('node.success', node.id, undefined, `Memory Write "${node.label}" persistiu ${candidates.length} candidato(s) aprovado(s).`);
        return result;
    }

    private async runPlaybook(node: FlowStudioNode, context: FlowStudioContext, signal = this.request.signal): Promise<{ context: FlowStudioContext; stop: boolean }> {
        const config = node.playbook;
        if (!config) throw new Error(`Playbook "${node.id}" sem configuração.`);
        const graphId = config.graphId || (this.graph.subgraphs?.[config.playbookId] ? config.playbookId : undefined);
        if (config.inline || graphId || config.graphRef) {
            const playbookContext = deepMerge(context, { _flowStudio: { playbook: { id: config.playbookId, parameters: config.parameters || {}, prompt: node.prompt } } });
            const result = await this.runSubgraph({
                ...node,
                type: 'subgraph',
                subgraph: {
                    graphId,
                    graphRef: config.graphRef,
                    inline: config.inline,
                    input: config.isolated ? { '_flowStudio.playbook': '_flowStudio.playbook', ...(config.input || {}) } : config.input,
                    output: config.output,
                    isolated: config.isolated
                }
            }, playbookContext, signal);
            return { context: withoutInternalPlaybookState(result), stop: false };
        }
        const adapter = this.request.playbookAdapters?.[config.playbookId] || this.request.playbookAdapters?.['*'];
        if (!adapter && !this.request.simulationMode) throw new Error(`Playbook "${config.playbookId}" não possui adapter disponível no host.`);
        const toolId = `playbook:${config.playbookId}`;
        let stop = false;
        const localAdapter: FlowStudioToolAdapter = async args => {
            if (!adapter) return { output: { playbook: { id: config.playbookId, ok: true, simulated: true } } };
            const adapterContext = config.input ? projectContext(args.context, config.input) : config.isolated ? {} : clone(args.context);
            const result = await adapter({ node, runId: this.runId, graph: this.graph, context: adapterContext, config, workspaceRoot: this.request.workspaceRoot, signal: args.signal, onEvent: event => this.forwardAdapterEvent(node.id, event) });
            if (!result.ok) throw new Error(result.message || `Playbook "${config.playbookId}" falhou.`);
            stop = result.stop === true;
            return {
                output: {
                    ...(result.output || {}),
                    playbook: { id: config.playbookId, ok: result.ok, stop, message: result.message, value: result.value, signals: result.signals, issues: result.issues, diagnostics: result.diagnostics }
                },
                artifacts: result.artifacts,
                usage: result.usage
            };
        };
        const synthetic: FlowStudioNode = {
            ...node,
            type: 'action',
            tools: [{ id: toolId, name: `Playbook · ${config.playbookId}`, command: `playbook:${config.playbookId}`, effect: 'custom', requiredPermissions: ['playbook:run'], idempotencyKey: config.idempotencyKey }],
            outputs: { playbook: '_flowStudio.playbookResult', ...(config.output || {}) }
        };
        const result = await this.runAction(synthetic, context, signal, { [toolId]: localAdapter }, config.isolated === true || config.output !== undefined, 'playbook:run');
        const receipt = getPath(result, '_flowStudio.playbookResult');
        stop = stop || (isRecord(receipt) && receipt.stop === true);
        return { context: withoutInternalPlaybookState(result), stop };
    }

    private async executeEmbeddedNode(parent: FlowStudioNode, embedded: FlowStudioNode, context: FlowStudioContext, invocationKey: string, signal: AbortSignal | undefined): Promise<FlowStudioContext> {
        this.assertRuntimeBudget(signal);
        const node: FlowStudioNode = {
            ...clone(embedded),
            id: `${parent.id}::${invocationKey}::${embedded.id}`,
            next: undefined,
            permissions: intersectPermissions(parent.permissions, embedded.permissions, this.request.workspaceRoot),
            budget: intersectBudget(parent.budget, embedded.budget),
            metadata: { ...(clone(embedded.metadata || {})), _flowStudioEmbeddedRole: parent.type === 'tournament' ? 'judge' : 'worker' }
        };
        this.consumeGlobalStep(node.id);
        this.visited.push(node.id);
        this.emit('node.enter', node.id, undefined, `Executando ${node.type} embutido "${node.label}".`, { parentNodeId: parent.id, invocationKey });
        if (node.type === 'agent' || node.type === 'report') return this.runAgent(node, context, signal);
        if (node.type === 'action') return this.runAction(node, context, signal);
        if (node.type === 'command') return this.runCommand(node, context, signal);
        if (node.type === 'context') return this.runContext(node, context, signal);
        if (node.type === 'memory_write') return this.runMemoryWrite(node, context, signal);
        if (node.type === 'playbook') return (await this.runPlaybook(node, context, signal)).context;
        if (node.type === 'subgraph') return this.runSubgraph(node, context, signal);
        if (node.type === 'transform') {
            const transformed = evaluate(node.condition || node.prompt || '({})', context, {});
            if (!isRecord(transformed)) throw new Error(`Transform embutido "${node.id}" precisa retornar objeto.`);
            assertNoReservedRoot(transformed, `saída do Transform embutido "${node.id}"`);
            return applyNodeOutputs(context, node, transformed, this.graph.state?.strictWrites === true);
        }
        throw new Error(`Tipo embutido não suportado: "${node.type}".`);
    }

    private async runDynamicParallel(node: FlowStudioNode, context: FlowStudioContext, signal = this.request.signal): Promise<FlowStudioContext> {
        return withAbortableTimeout(
            deadlineSignal => this.runDynamicParallelWithinDeadline(node, context, deadlineSignal),
            this.nodeRuntimeTimeout(node, node.timeoutMs),
            signal
        );
    }

    private async runDynamicParallelWithinDeadline(node: FlowStudioNode, context: FlowStudioContext, signal: AbortSignal): Promise<FlowStudioContext> {
        const config = node.dynamicParallel;
        if (!config) throw new Error(`Dynamic Parallel "${node.id}" sem configuração.`);
        const items = evaluateCollection(config.itemsFrom, context);
        if (!items.length) throw new Error(`Dynamic Parallel "${node.id}" recebeu uma coleção vazia.`);
        if (items.length > (config.maxItems || 0)) throw new Error(`Dynamic Parallel "${node.id}" recebeu ${items.length} itens, acima do limite ${config.maxItems}.`);
        const concurrency = Math.max(1, Math.min(items.length, config.concurrency || 4, node.budget?.maxParallelism || Number.POSITIVE_INFINITY, this.graph.budget?.maxParallelism || Number.POSITIVE_INFINITY));
        const results: DynamicItemResult[] = new Array(items.length);
        const controllers = new Set<AbortController>();
        let cursor = 0;
        let cancelled = false;
        const thresholdExceeded = (): boolean => {
            const failures = results.filter(item => item?.status === 'failed').length;
            if (!failures) return false;
            if ((config.failurePolicy || 'best_effort') === 'fail_fast') return true;
            if (config.failurePolicy !== 'threshold') return false;
            const threshold = config.failureThreshold || 0;
            return threshold > 0 && threshold < 1 ? failures / items.length > threshold : failures > Math.floor(threshold);
        };
        const worker = async (): Promise<void> => {
            while (!cancelled) {
                this.assertRuntimeBudget(signal);
                const index = cursor++;
                if (index >= items.length) return;
                const item = items[index];
                const key = `${index}:${digest(item).slice(0, 12)}`;
                const controller = linkedAbortController(signal);
                controllers.add(controller);
                this.emit('parallel.item.started', node.id, undefined, `Item ${index + 1}/${items.length} iniciado.`, { index, key });
                try {
                    const itemContext = clone(context);
                    this.writeState(node, itemContext, config.itemVariable || 'item', item);
                    setPath(itemContext, '_flowStudio.dynamic', { parentNodeId: node.id, index, key, count: items.length });
                    const output = await this.executeEmbeddedNode(node, config.worker, itemContext, `item-${index}`, controller.signal);
                    results[index] = { index, key, item: clone(item), status: 'completed', output: contextDelta(itemContext, output) };
                    this.emit('parallel.item.completed', node.id, undefined, `Item ${index + 1}/${items.length} concluído.`, { index, key });
                } catch (error) {
                    if (isAbortError(error) && cancelled) results[index] = { index, key, item: clone(item), status: 'cancelled', error: 'Cancelado pela política de falha.' };
                    else {
                        results[index] = { index, key, item: clone(item), status: 'failed', error: error instanceof Error ? error.message : String(error) };
                        this.emit('parallel.item.failed', node.id, undefined, `Item ${index + 1}/${items.length} falhou.`, { index, key, error: results[index].error });
                    }
                } finally {
                    controllers.delete(controller);
                    unlinkAbortController(controller);
                }
                if (thresholdExceeded()) {
                    cancelled = true;
                    for (const active of controllers) active.abort();
                }
            }
        };
        await Promise.all(Array.from({ length: concurrency }, () => worker()));
        for (let index = 0; index < items.length; index += 1) if (!results[index]) results[index] = { index, key: `${index}:${digest(items[index]).slice(0, 12)}`, item: clone(items[index]), status: 'cancelled', error: 'Não iniciado após cancelamento.' };
        const failures = results.filter(item => item.status === 'failed').length;
        if ((config.joinStrategy || 'collect') === 'require_all' && failures) throw new Error(`Dynamic Parallel "${node.id}" exige todos os itens, mas ${failures} falharam.`);
        if (thresholdExceeded()) {
            const firstFailure = results.find(item => item.status === 'failed')?.error;
            throw new Error(`Dynamic Parallel "${node.id}" ultrapassou a política de falhas (${failures}/${items.length})${firstFailure ? `: ${firstFailure}` : '.'}`);
        }
        const visible = config.joinStrategy === 'best_effort' ? results.filter(item => item.status === 'completed') : results;
        const aggregate = { type: 'dynamic_parallel', itemCount: items.length, successCount: results.filter(item => item.status === 'completed').length, failureCount: failures, results: visible };
        const next = clone(context);
        this.writeState(node, next, config.outputPath || 'parallel.results', aggregate);
        this.addArtifacts([createArtifact(node.id, 'json', `${node.id}.dynamic-parallel.json`, aggregate)]);
        this.emit('node.output', node.id, undefined, `Dynamic Parallel "${node.label}" produziu ${visible.length} resultado(s).`, aggregate);
        return next;
    }

    private async runTournament(node: FlowStudioNode, context: FlowStudioContext, signal = this.request.signal): Promise<FlowStudioContext> {
        return withAbortableTimeout(
            deadlineSignal => this.runTournamentWithinDeadline(node, context, deadlineSignal),
            this.nodeRuntimeTimeout(node, node.timeoutMs),
            signal
        );
    }

    private async runTournamentWithinDeadline(node: FlowStudioNode, context: FlowStudioContext, signal: AbortSignal): Promise<FlowStudioContext> {
        const config = node.tournament;
        if (!config) throw new Error(`Tournament "${node.id}" sem configuração.`);
        const values = evaluateCollection(config.candidatesFrom, context);
        if (values.length < 2) throw new Error(`Tournament "${node.id}" exige ao menos dois candidatos.`);
        if ((config.winnerCount || 1) > values.length) throw new Error(`Tournament "${node.id}" pede mais vencedores do que candidatos.`);
        const candidates: TournamentCandidate[] = values.map((value, index) => ({ id: `candidate-${digest({ graphId: this.graph.id, nodeId: node.id, index, value }).slice(0, 12)}`, index, value: clone(value) }));
        const maxComparisons = config.maxComparisons || 1;
        const strategy = config.strategy || 'single_round';
        const mandatoryComparisons = strategy === 'single_round' ? 1 : strategy === 'bracket' ? values.length - (config.winnerCount || 1) : values.length * (values.length - 1) / 2;
        const tieBreaker = config.tieBreaker || 'judge_again';
        const reservedTieComparisons = strategy === 'round_robin' && tieBreaker === 'judge_again' ? Math.max(1, config.maxTieRounds || 1) : 0;
        if (mandatoryComparisons + reservedTieComparisons > maxComparisons) {
            throw new Error(`Tournament "${node.id}" exige orçamento de ao menos ${mandatoryComparisons + reservedTieComparisons} comparação(ões), mas maxComparisons=${maxComparisons}. Nenhum juiz foi chamado.`);
        }
        let comparisons = 0;
        const judgments: Array<{ candidates: string[]; judgment: TournamentJudgment }> = [];
        const judge = async (pool: TournamentCandidate[], phase: string, requestedWinners = Math.min(config.winnerCount || 1, pool.length)): Promise<TournamentJudgment> => {
            if (++comparisons > maxComparisons) throw new Error(`Tournament "${node.id}" excedeu maxComparisons=${maxComparisons}.`);
            this.assertRuntimeBudget(signal);
            const visiblePool = config.blind === false ? [...pool] : [...pool].sort((left, right) =>
                digest({ runId: this.runId, nodeId: node.id, phase, comparison: comparisons, candidateId: left.id })
                    .localeCompare(digest({ runId: this.runId, nodeId: node.id, phase, comparison: comparisons, candidateId: right.id }))
            );
            const anonymous = visiblePool.map(candidate => ({ id: candidate.id, value: config.blind === false ? candidate.value : anonymizeTournamentValue(candidate.value, config.identityFields) }));
            const judgeContext: FlowStudioContext = { tournament: { candidates: anonymous, criteria: config.criteria, winnerCount: requestedWinners, strategy: config.strategy || 'single_round', tieBreaker: config.tieBreaker || 'judge_again', phase } };
            const judgeNode: FlowStudioNode = {
                ...clone(config.judge),
                outputs: undefined,
                prompt: [config.judge.prompt || 'Julgue os candidatos.', 'Responda em JSON com winnerIds (ids permitidos), scores numéricos por id, reason e evidence.', `Critérios: ${(config.criteria || []).join('; ')}`].join('\n\n')
            };
            this.emit('tournament.comparison.started', node.id, undefined, `Comparação ${comparisons} iniciada.`, { comparison: comparisons, phase, candidateIds: pool.map(item => item.id) });
            const output = await this.executeEmbeddedNode(node, judgeNode, judgeContext, `comparison-${comparisons}`, signal);
            const judgment = parseTournamentJudgment(output, pool, requestedWinners);
            judgments.push({ candidates: pool.map(item => item.id), judgment });
            this.emit('tournament.comparison.completed', node.id, undefined, `Comparação ${comparisons} concluída.`, { comparison: comparisons, phase, winnerIds: judgment.winnerIds });
            return judgment;
        };
        let winners: TournamentCandidate[];
        let ranking: TournamentCandidate[] = [];
        const scoreTotals = new Map(candidates.map(candidate => [candidate.id, 0]));
        const record = (result: TournamentJudgment): void => {
            for (const [id, score] of Object.entries(result.scores)) scoreTotals.set(id, (scoreTotals.get(id) || 0) + score);
            for (const id of result.winnerIds) scoreTotals.set(id, (scoreTotals.get(id) || 0) + 1);
        };
        if ((config.strategy || 'single_round') === 'single_round') {
            const result = await judge(candidates, 'single-round');
            record(result);
            winners = result.winnerIds.map(id => candidates.find(candidate => candidate.id === id) as TournamentCandidate);
            const winnerIds = new Set(winners.map(candidate => candidate.id));
            ranking = [...winners, ...candidates.filter(candidate => !winnerIds.has(candidate.id)).sort((left, right) => (scoreTotals.get(right.id) || 0) - (scoreTotals.get(left.id) || 0) || left.index - right.index)];
        } else if (config.strategy === 'bracket') {
            let round = [...candidates];
            let roundIndex = 1;
            while (round.length > (config.winnerCount || 1)) {
                const nextRound: TournamentCandidate[] = [];
                const comparisonsThisRound = Math.min(Math.floor(round.length / 2), round.length - (config.winnerCount || 1));
                let cursor = 0;
                for (let match = 0; match < comparisonsThisRound; match += 1) {
                    const pair = round.slice(cursor, cursor + 2);
                    cursor += 2;
                    const result = await judge(pair, `bracket-${roundIndex}`, 1);
                    record(result);
                    nextRound.push(pair.find(candidate => candidate.id === result.winnerIds[0]) as TournamentCandidate);
                }
                nextRound.push(...round.slice(cursor));
                round = nextRound;
                roundIndex += 1;
            }
            winners = round.slice(0, config.winnerCount || 1);
            const winnerIds = new Set(winners.map(candidate => candidate.id));
            ranking = [...winners, ...candidates.filter(candidate => !winnerIds.has(candidate.id)).sort((left, right) => (scoreTotals.get(right.id) || 0) - (scoreTotals.get(left.id) || 0) || left.index - right.index)];
        } else {
            for (let left = 0; left < candidates.length; left += 1) {
                for (let right = left + 1; right < candidates.length; right += 1) {
                    const pair = [candidates[left], candidates[right]];
                    const result = await judge(pair, 'round-robin', 1);
                    record(result);
                }
            }
            ranking = [...candidates].sort((left, right) => (scoreTotals.get(right.id) || 0) - (scoreTotals.get(left.id) || 0) || left.index - right.index);
            const winnerCount = config.winnerCount || 1;
            const cutoff = scoreTotals.get(ranking[Math.min(ranking.length, winnerCount) - 1].id) || 0;
            const before = ranking.filter(candidate => (scoreTotals.get(candidate.id) || 0) > cutoff);
            const tied = ranking.filter(candidate => (scoreTotals.get(candidate.id) || 0) === cutoff);
            const after = ranking.filter(candidate => (scoreTotals.get(candidate.id) || 0) < cutoff);
            const slots = Math.max(0, winnerCount - before.length);
            if (tied.length > slots && tieBreaker === 'judge_again') {
                const votes = new Map(tied.map(candidate => [candidate.id, 0]));
                for (let tieRound = 1; tieRound <= Math.max(1, config.maxTieRounds || 1); tieRound += 1) {
                    const tie = await judge(tied, `tie-break-${tieRound}`, slots);
                    record(tie);
                    for (const id of tie.winnerIds) votes.set(id, (votes.get(id) || 0) + 1);
                    tied.sort((left, right) => (votes.get(right.id) || 0) - (votes.get(left.id) || 0) || (scoreTotals.get(right.id) || 0) - (scoreTotals.get(left.id) || 0) || left.index - right.index);
                    const boundary = votes.get(tied[Math.max(0, slots - 1)]?.id) || 0;
                    const next = votes.get(tied[slots]?.id) ?? -1;
                    if (boundary > next) break;
                }
            } else if (tieBreaker === 'first_candidate') {
                tied.sort((left, right) => left.index - right.index);
            }
            ranking = [...before, ...tied, ...after];
            winners = ranking.slice(0, winnerCount);
        }
        const aggregate = {
            type: 'tournament', strategy: config.strategy || 'single_round', criteria: config.criteria || [], comparisonCount: comparisons,
            winners: winners.map(candidate => ({ id: candidate.id, index: candidate.index, value: candidate.value, score: scoreTotals.get(candidate.id) || 0 })),
            ranking: ranking.map(candidate => ({ id: candidate.id, index: candidate.index, score: scoreTotals.get(candidate.id) || 0 })),
            judgments
        };
        const next = clone(context);
        this.writeState(node, next, config.outputPath || 'tournament.result', aggregate);
        this.addArtifacts([createArtifact(node.id, 'json', `${node.id}.tournament.json`, aggregate)]);
        this.emit('node.output', node.id, undefined, `Tournament "${node.label}" selecionou ${winners.length} vencedor(es).`, aggregate);
        return next;
    }

    private async runFork(node: FlowStudioNode, context: FlowStudioContext, signal = this.request.signal): Promise<FlowStudioContext> {
        const config = node.fork;
        if (!config) throw new Error(`Fork "${node.id}" sem configuração.`);
        const joinNode = this.nodeById.get(config.join);
        if (!joinNode || joinNode.type !== 'join') throw new Error(`Fork "${node.id}" aponta para Join inválido.`);
        const join = joinNode.join || { strategy: 'all' };
        const saved = this.forkResumeOverrides.get(node.id) || readForkResumeState(this.request.resume?.checkpoint.metadata);
        const required = requiredJoinResults(join, config.branches.length);
        let results: ForkBranchState[];

        if (saved?.forkNodeId === node.id) {
            results = clone(saved.branches);
            const completed = results.filter(item => item.status === 'completed').length;
            if (!join.cancelRemaining || completed < required) {
                const pendingIndex = results.findIndex(item => item.status === 'waiting');
                if (pendingIndex >= 0) results[pendingIndex] = await this.resumeForkBranch(results[pendingIndex], node, config.join, signal);
            }
        } else {
            results = await this.executeForkBranches(node, context, join, signal);
        }

        const successful = results
            .filter((item): item is ForkBranchState & { context: FlowStudioContext; completionOrder: number } => item.status === 'completed' && Boolean(item.context))
            .sort((left, right) => left.completionOrder - right.completionOrder);
        const pending = results.filter(item => item.status === 'waiting' && item.checkpoint);
        if (pending.length && !(join.cancelRemaining && successful.length >= required)) {
            const first = pending[0];
            const childCheckpoint = first.checkpoint as FlowStudioCheckpoint;
            const compositeState = readCompositeGateState(childCheckpoint.metadata);
            const interaction = readInteractionEnvelope(childCheckpoint.metadata);
            const state: ForkResumeState = { forkNodeId: node.id, baseContext: clone(context), branches: clone(results) };
            const parentCheckpoint = await this.checkpoint(node, context, node.id, childCheckpoint.reason === 'wait' ? 'wait' : 'gate', childCheckpoint.wait, { forkState: state });
            this.emit('branch.waiting', node.id, undefined, `Fork "${node.label}" aguarda a branch "${first.branch}".`, { branch: first.branch, childNodeId: childCheckpoint.nodeId });
            throw new WaitingSignal(`Branch "${first.branch}" aguarda entrada.`, context, {
                nodeId: childCheckpoint.nodeId,
                kind: childCheckpoint.reason === 'wait' ? 'wait' : 'gate',
                checkpointId: parentCheckpoint.id,
                detail: { forkNodeId: node.id, branch: first.branch, childNodeId: childCheckpoint.nodeId, pendingHumanPath: compositeState?.pendingHumanPath, interaction }
            });
        }

        try {
            enforceJoin(join, successful.length, config.branches.length, joinNode.id);
        } catch (caught) {
            const failures = results.filter(item => item.status === 'failed' && item.error).map(item => `${item.branch}: ${item.error}`);
            throw new Error(`${caught instanceof Error ? caught.message : String(caught)}${failures.length ? ` Falhas: ${failures.join('; ')}` : ''}`);
        }
        const selected = selectJoinResults(join, successful);
        let merged = mergeBranchContexts(this.graph, context, selected.map(item => item.context));
        if (join.reducer && !this.graph.state?.namespaces?.[join.reducer]) {
            const reduced = evaluate(join.reducer, { base: context, branches: selected.map(item => item.context), merged }, {});
            if (!isRecord(reduced)) throw new Error(`Reducer do Join "${joinNode.id}" precisa retornar um objeto.`);
            merged = deepMerge(context, reduced);
        }
        if (successful.length < config.branches.length && !config.continueOnError && !node.continueOnError && join.strategy === 'all') {
            throw new Error(`Fork "${node.id}" possui branch com falha e não permite continueOnError.`);
        }
        this.emit('node.success', node.id, undefined, `Fork "${node.label}" concluiu ${successful.length}/${config.branches.length} branches.`);
        return merged;
    }

    private async executeForkBranches(node: FlowStudioNode, context: FlowStudioContext, join: FlowStudioJoinConfig, signal = this.request.signal): Promise<ForkBranchState[]> {
        const config = node.fork as NonNullable<FlowStudioNode['fork']>;
        const concurrency = Math.max(1, Math.min(
            config.maxConcurrency || config.branches.length,
            node.budget?.maxParallelism || Number.POSITIVE_INFINITY,
            this.graph.budget?.maxParallelism || config.branches.length
        ));
        const required = requiredJoinResults(join, config.branches.length);
        const results: ForkBranchState[] = new Array(config.branches.length);
        const controllers = new Set<AbortController>();
        let cursor = 0;
        let completionOrder = 0;
        let successes = 0;
        let thresholdReached = false;

        const worker = async (): Promise<void> => {
            while (!thresholdReached) {
                const index = cursor++;
                if (index >= config.branches.length) return;
                const branch = config.branches[index];
                const controller = linkedAbortController(signal);
                controllers.add(controller);
                this.emit('branch.started', node.id, undefined, `Branch "${branch}" iniciada.`, { branch });
                const state = await this.executeForkBranch(branch, context, config.join, controller.signal);
                controllers.delete(controller);
                unlinkAbortController(controller);
                if (state.status === 'completed') {
                    state.completionOrder = ++completionOrder;
                    successes += 1;
                    this.emit('branch.completed', node.id, undefined, `Branch "${branch}" concluída.`, { branch, completionOrder });
                } else if (state.status === 'failed') {
                    this.emit('node.failed', node.id, undefined, `Branch "${branch}" falhou.`, { error: state.error, branch });
                }
                results[index] = state;
                if (join.cancelRemaining && successes >= required) {
                    thresholdReached = true;
                    for (const active of controllers) active.abort();
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, config.branches.length) }, () => worker()));
        for (let index = 0; index < config.branches.length; index += 1) {
            if (!results[index]) results[index] = { branch: config.branches[index], status: 'cancelled', error: 'Cancelada após o Join atingir o resultado necessário.' };
        }
        return results;
    }

    private async executeForkBranch(branch: string, context: FlowStudioContext, joinNodeId: string, signal?: AbortSignal): Promise<ForkBranchState> {
        try {
            const outcome = await this.executeFrom(branch, clone(context), new Set([joinNodeId]), signal);
            if (outcome.stoppedAt !== joinNodeId) return { branch, status: 'failed', error: `Branch "${branch}" não alcançou o Join "${joinNodeId}".` };
            return { branch, status: 'completed', context: outcome.context };
        } catch (caught) {
            if (caught instanceof WaitingSignal) {
                const checkpoint = this.checkpoints.find(item => item.id === caught.waiting.checkpointId);
                if (!checkpoint) return { branch, status: 'failed', error: 'Branch aguardou sem checkpoint persistido.' };
                return { branch, status: 'waiting', context: caught.context, checkpoint: clone(checkpoint) };
            }
            if (signal?.aborted && !this.request.signal?.aborted) return { branch, status: 'cancelled', error: 'Branch cancelada pelo Join.' };
            return { branch, status: 'failed', error: caught instanceof Error ? caught.message : String(caught) };
        }
    }

    private async resumeForkBranch(state: ForkBranchState, forkNode: FlowStudioNode, joinNodeId: string, signal = this.request.signal): Promise<ForkBranchState> {
        const checkpoint = state.checkpoint;
        const resume = this.request.resume;
        if (!checkpoint || !resume) return state;
        let context = clone(checkpoint.context);
        let start: string | undefined;
        try {
            const nestedFork = readForkResumeState(checkpoint.metadata);
            if (nestedFork) {
                this.forkResumeOverrides.set(nestedFork.forkNodeId, nestedFork);
                try {
                    const resumed = await this.executeForkBranch(nestedFork.forkNodeId, context, joinNodeId, signal);
                    return { ...resumed, branch: state.branch, completionOrder: resumed.status === 'completed' ? Date.now() : undefined };
                } finally {
                    this.forkResumeOverrides.delete(nestedFork.forkNodeId);
                }
            }
            const nestedLoop = readLoopResumeState(checkpoint.metadata);
            if (nestedLoop) {
                this.loopResumeOverrides.set(nestedLoop.loopNodeId, nestedLoop);
                try {
                    const resumed = await this.executeForkBranch(nestedLoop.loopNodeId, context, joinNodeId, signal);
                    return { ...resumed, branch: state.branch, completionOrder: resumed.status === 'completed' ? Date.now() : undefined };
                } finally {
                    this.loopResumeOverrides.delete(nestedLoop.loopNodeId);
                }
            }
            const nestedSubgraph = nestedSubgraphCheckpoint(checkpoint.metadata);
            if (nestedSubgraph) {
                this.subgraphResumeOverrides.set(checkpoint.nodeId, checkpoint);
                try {
                    const resumed = await this.executeForkBranch(checkpoint.nodeId, context, joinNodeId, signal);
                    return { ...resumed, branch: state.branch, completionOrder: resumed.status === 'completed' ? Date.now() : undefined };
                } finally {
                    this.subgraphResumeOverrides.delete(checkpoint.nodeId);
                }
            }
            if (checkpoint.reason === 'wait') {
                const resolution = resolveWaitResume(checkpoint.wait, checkpoint.metadata, resume.signal);
                if (resolution === 'waiting') return state;
                if (resolution === 'timeout-fail') throw new Error(`Wait "${checkpoint.nodeId}" excedeu o prazo configurado.`);
                this.emit('wait.resolved', checkpoint.nodeId, undefined, 'Espera da branch resolvida.', { branch: state.branch, signal: resume.signal });
                start = checkpoint.nextNodeId;
            } else {
                if (!resume.gate) return state;
                const resolution = await this.resolveGateCheckpoint(checkpoint, context, resume.gate, signal);
                if (resolution.result.action === 'wait') {
                    try {
                        await this.pauseForGate(resolution.node, context, resolution.result);
                    } catch (caught) {
                        if (!(caught instanceof WaitingSignal)) throw caught;
                        const nextCheckpoint = this.checkpoints.find(item => item.id === caught.waiting.checkpointId);
                        if (!nextCheckpoint) throw new Error('Gate da branch aguardou sem checkpoint persistido.');
                        return { branch: state.branch, status: 'waiting', context: caught.context, checkpoint: clone(nextCheckpoint) };
                    }
                }
                start = resolution.start;
                this.emit('gate.resolved', resolution.node.id, undefined, resolution.result.message || 'Gate da branch resolvido.', { branch: state.branch });
            }
            if (!start) return { branch: state.branch, status: 'completed', context, completionOrder: state.completionOrder || Date.now() };
            const resumed = await this.executeForkBranch(start, context, joinNodeId, signal);
            return { ...resumed, branch: state.branch, completionOrder: resumed.status === 'completed' ? Date.now() : undefined };
        } catch (caught) {
            return { branch: state.branch, status: 'failed', error: caught instanceof Error ? caught.message : String(caught) };
        }
    }

    private async runLoop(node: FlowStudioNode, context: FlowStudioContext, signal = this.request.signal): Promise<FlowStudioContext> {
        if (!node.loop) throw new Error(`Loop "${node.id}" sem configuração.`);
        const saved = this.loopResumeOverrides.get(node.id) || readLoopResumeState(this.request.resume?.checkpoint.metadata);
        let current = clone(saved?.context || context);
        let iteration = saved?.iteration || 0;
        if (saved?.loopNodeId === node.id) {
            const resumed = await this.resumeForkBranch({ branch: node.loop.bodyStart, status: 'waiting', checkpoint: saved.checkpoint }, node, node.id, signal);
            if (resumed.status === 'waiting' && resumed.checkpoint) await this.pauseLoopBranch(node, current, iteration, resumed.checkpoint);
            if (resumed.status === 'failed') throw new Error(resumed.error || `Loop "${node.id}" não pôde ser retomado.`);
            if (resumed.status !== 'completed' || !resumed.context) throw new Error(`Loop "${node.id}" retornou estado inválido ao retomar.`);
            current = resumed.context;
            iteration += 1;
            if (node.loop.breakWhen && evaluateBoolean(node.loop.breakWhen, current, false, { iteration })) {
                this.emit('node.success', node.id, undefined, `Loop "${node.label}" encerrou após ${iteration} iteração(ões).`, { iteration });
                return current;
            }
        }
        while (iteration < node.loop.maxIterations && evaluateBoolean(node.loop.condition, current, false, { iteration })) {
            this.emit('loop.iteration', node.id, undefined, `Iteração ${iteration + 1}/${node.loop.maxIterations}.`, { iteration: iteration + 1 });
            let outcome: ExecutionOutcome;
            try {
                outcome = await this.executeFrom(node.loop.bodyStart, current, new Set([node.id]), signal);
            } catch (caught) {
                if (!(caught instanceof WaitingSignal)) throw caught;
                const childCheckpoint = this.checkpoints.find(item => item.id === caught.waiting.checkpointId);
                if (!childCheckpoint) throw new Error(`Loop "${node.id}" aguardou sem checkpoint persistido.`);
                await this.pauseLoopBranch(node, current, iteration, childCheckpoint);
                throw caught;
            }
            if (outcome.terminal) throw new Error(`O corpo do Loop "${node.id}" alcançou End antes de retornar ao próprio Loop.`);
            if (outcome.stoppedAt !== node.id) throw new Error(`O corpo do Loop "${node.id}" escapou da região iterativa sem retornar ao Loop.`);
            current = outcome.context;
            iteration += 1;
            if (node.loop.breakWhen && evaluateBoolean(node.loop.breakWhen, current, false, { iteration })) break;
        }
        this.emit('node.success', node.id, undefined, `Loop "${node.label}" encerrou após ${iteration} iteração(ões).`, { iteration });
        return current;
    }

    private async pauseLoopBranch(node: FlowStudioNode, context: FlowStudioContext, iteration: number, childCheckpoint: FlowStudioCheckpoint): Promise<never> {
        const compositeState = readCompositeGateState(childCheckpoint.metadata);
        const interaction = readInteractionEnvelope(childCheckpoint.metadata);
        const state: LoopResumeState = { loopNodeId: node.id, iteration, context: clone(context), checkpoint: clone(childCheckpoint) };
        const parentCheckpoint = await this.checkpoint(node, context, node.id, childCheckpoint.reason === 'wait' ? 'wait' : 'gate', childCheckpoint.wait, { loopState: state });
        throw new WaitingSignal(`Loop "${node.label}" aguarda entrada.`, context, {
            nodeId: childCheckpoint.nodeId,
            kind: childCheckpoint.reason === 'wait' ? 'wait' : 'gate',
            checkpointId: parentCheckpoint.id,
            detail: { loopNodeId: node.id, iteration, childNodeId: childCheckpoint.nodeId, pendingHumanPath: compositeState?.pendingHumanPath, interaction }
        });
    }

    private async runSubgraph(node: FlowStudioNode, context: FlowStudioContext, signal = this.request.signal): Promise<FlowStudioContext> {
        const config = node.subgraph;
        if (!config) throw new Error(`Subgraph "${node.id}" sem configuração.`);
        const depth = this.request.subgraphDepth || 0;
        const maxDepth = this.request.maxSubgraphDepth || 12;
        if (depth >= maxDepth) throw new Error(`Subgraph "${node.id}" excedeu a profundidade máxima de ${maxDepth}.`);
        let graph = config.inline || (config.graphId ? this.graph.subgraphs?.[config.graphId] : undefined);
        if (!graph && config.graphRef && this.request.resolveSubgraph) graph = await this.request.resolveSubgraph(config.graphRef, this.graph);
        if (!graph) throw new Error(`Subgrafo de "${node.id}" não encontrado.`);
        const effectivePermissions = intersectPermissions(this.graph.permissions, node.permissions, this.request.workspaceRoot);
        // Runtime restrictions may contain a shrinking duration/cost/token budget. That
        // effective budget must keep enforcing the parent's remaining allowance, but it
        // is not part of the child's logical identity: otherwise each resume produces a
        // different digest for the same declared graph. Bind the stable identity to the
        // full parent chain and effective permission ceiling so the nested checkpoint
        // cannot be detached and resumed as an unrestricted top-level graph.
        const childGraphDigest = digest({
            kind: 'flow-studio-subgraph',
            graph,
            parentGraphDigest: this.graphDigest,
            parentNodeId: node.id,
            permissions: effectivePermissions
        });
        const structuredResumeBoundary = this.subgraphResumeOverrides.get(node.id);
        if (structuredResumeBoundary) this.subgraphResumeOverrides.delete(node.id);
        const topLevelResumeCandidate = this.request.resume?.checkpoint;
        const topLevelResumeBoundary = topLevelResumeCandidate?.nodeId === node.id
            && !this.consumedSubgraphResumeBoundaries.has(topLevelResumeCandidate.id)
            ? topLevelResumeCandidate
            : undefined;
        if (topLevelResumeBoundary) this.consumedSubgraphResumeBoundaries.add(topLevelResumeBoundary.id);
        const resumeBoundary = structuredResumeBoundary || topLevelResumeBoundary;
        const childCheckpoint = nestedSubgraphCheckpoint(resumeBoundary?.metadata);
        const priorNodeUsage = this.usageByNode.get(node.id) || normalizeUsage();
        const nodeEnteredAt = this.nodeEnteredAt.get(node.id)?.at(-1);
        const nodeActiveDurationMs = (this.nodeWallTimeMs.get(node.id) || 0)
            + (nodeEnteredAt === undefined ? 0 : Math.max(0, Date.now() - nodeEnteredAt));
        const incrementalBudget = intersectBudget(
            remainingBudget(this.graph.budget, this.usage, this.activeDurationMs()),
            remainingBudget(node.budget, priorNodeUsage, nodeActiveDurationMs)
        );
        // A resumed child restores cumulative usage from its own checkpoint. Parent and
        // node ceilings above are incremental (remaining allowance), so translate them
        // into that cumulative coordinate before intersecting with the child's declared
        // lifetime budget. Otherwise the child's history is charged a second time.
        const effectiveBudget = rebaseRemainingBudget(incrementalBudget, childCheckpoint?.usage);
        graph = restrictSubgraphGraph(graph, effectivePermissions, effectiveBudget, this.request.workspaceRoot);
        const input = config.input ? projectContext(context, config.input) : config.isolated ? {} : clone(context);
        const childRequest = {
            ...this.request,
            graph,
            runId: `${this.runId}:${node.id}:${randomHex().slice(0, 8)}`,
            input,
            resume: childCheckpoint && this.request.resume ? {
                checkpoint: childCheckpoint,
                gate: this.request.resume.gate,
                signal: this.request.resume.signal
            } : undefined,
            effects: this.effects,
            memoryApprovals: [...this.memoryApprovalReceipts.values()].map(value => clone(value)),
            signal,
            concurrencyLimiter: this.concurrencyLimiter,
            stepLedger: this.stepLedger,
            subgraphDepth: depth + 1,
            maxSubgraphDepth: maxDepth,
            onEvent: event => this.emit(event.kind, node.id, event.edgeId, `[${graph.name}] ${event.message}`, { childRunId: event.runId, childNodeId: event.nodeId, ...event.detail }),
            onCheckpoint: undefined
        } as InternalFlowStudioRunRequest;
        childRequest[INTERNAL_RUN_REQUEST] = true;
        childRequest[INTERNAL_GRAPH_DIGEST] = childGraphDigest;
        const child = await runFlowStudioGraph(childRequest);
        const priorChildVisits = childCheckpoint?.visited.length || 0;
        this.visited.push(...child.visited.slice(priorChildVisits).map(childNodeId => `${node.id}::${childNodeId}`));
        this.addArtifacts(child.artifacts);
        mergeEffectsInPlace(this.effects, child.effects);
        const childUsageDelta = subtractUsage(child.usage, childCheckpoint?.usage);
        addUsage(this.usage, childUsageDelta);
        const nodeUsage = priorNodeUsage;
        addUsage(nodeUsage, childUsageDelta);
        this.usageByNode.set(node.id, nodeUsage);
        this.assertNodeBudget(node, nodeUsage);
        this.assertRuntimeBudget(signal);
        if (child.status === 'waiting') {
            const checkpoint = child.checkpoints.find(item => item.id === child.waiting?.checkpointId)
                || (childCheckpoint?.id === child.waiting?.checkpointId ? childCheckpoint : undefined)
                || child.checkpoints[child.checkpoints.length - 1];
            if (!checkpoint) throw new Error(`Subgrafo "${graph.name}" aguardou sem produzir checkpoint.`);
            const parentCheckpoint = await this.checkpoint(node, context, node.id, checkpoint.reason === 'wait' ? 'wait' : 'gate', checkpoint.wait, {
                subgraphCheckpoint: checkpoint,
                childGraphId: graph.id,
                childRunId: child.runId,
                childWaiting: child.waiting,
                interaction: child.waiting?.detail?.interaction
            });
            throw new WaitingSignal(child.statusMessage || `Subgrafo "${graph.name}" aguarda entrada.`, context, {
                nodeId: checkpoint.nodeId,
                kind: checkpoint.reason === 'wait' ? 'wait' : 'gate',
                checkpointId: parentCheckpoint.id,
                detail: { childGraphId: graph.id, childNodeId: checkpoint.nodeId, childWaiting: child.waiting, interaction: child.waiting?.detail?.interaction }
            });
        }
        if (child.status !== 'completed') throw new Error(child.error || `Subgrafo "${graph.name}" terminou em ${child.status}.`);
        const mapped = config.output ? projectContext(child.finalContext, config.output) : config.isolated ? {} : child.finalContext;
        this.emit('node.success', node.id, undefined, `Subgrafo "${graph.name}" concluído.`, { childRunId: child.runId });
        return config.isolated ? deepMerge(context, mapped) : deepMerge(context, child.finalContext, mapped);
    }

    private async resolveGateCheckpoint(
        checkpoint: FlowStudioCheckpoint,
        context: FlowStudioContext,
        supplied: FlowStudioGateResult,
        signal = this.request.signal
    ): Promise<GateCheckpointResolution> {
        const node = this.nodeById.get(checkpoint.nodeId);
        if (!node) throw new Error(`Nó de gate não encontrado: ${checkpoint.nodeId}`);
        const compositeState = readCompositeGateState(checkpoint.metadata);
        let normalized: FlowStudioGateResult;
        if (node.type === 'gate' && normalizeGate(node).kind === 'composite' && compositeState) {
            const pendingConfig = gateConfigAtPath(normalizeGate(node), compositeState.pendingHumanPath);
            const humanDecision = enforceGateConfigEvidence(node, pendingConfig, normalizeGateResult(node, supplied, true));
            if (humanDecision.action === 'wait') {
                this.pendingCompositeGateState = compositeState;
                normalized = humanDecision;
            } else {
                compositeState.humanResults[compositeState.pendingHumanPath] = clone(humanDecision);
                const compositeResult = enforceGateEvidence(node, normalizeGateResult(node, await this.runGate(node, context, signal, compositeState.humanResults)));
                if (humanDecision.action === 'fail') {
                    // A declared human rejection is authoritative. In particular, an
                    // `any` composite must not let another criterion turn that external
                    // fail decision into a continuation.
                    normalized = {
                        ...compositeResult,
                        action: 'fail',
                        decisionId: humanDecision.decisionId,
                        toNodeId: humanDecision.toNodeId,
                        message: humanDecision.message || compositeResult.message || `Gate "${node.label}" recusado pela decisão humana.`
                    };
                } else if (humanDecision.action === 'continue' && compositeResult.action === 'continue') {
                    // The composite aggregation intentionally recalculates criteria, but
                    // routing still belongs to the already validated declared decision.
                    normalized = {
                        ...compositeResult,
                        decisionId: humanDecision.decisionId,
                        toNodeId: humanDecision.toNodeId
                    };
                } else {
                    normalized = compositeResult;
                }
            }
        } else {
            normalized = enforceGateEvidence(node, normalizeGateResult(node, supplied, true));
        }
        if (normalized.action === 'wait') return { node, result: normalized, permissionGate: node.type !== 'gate' };
        if (normalized.action === 'fail') throw new Error(normalized.message || `Gate "${node.label}" recusado.`);
        if (normalized.evidence?.length) this.addArtifacts(normalized.evidence);
        this.recordMemoryApprovals(normalized.memoryApprovals);
        if (node.type === 'gate') {
            const start = this.resolveGateRoute(node, normalized, context);
            if (!start) throw new Error(`Gate "${node.id}" não possui rota aprovada.`);
            return { node, result: normalized, start, permissionGate: false };
        }
        const approval = readPermissionApprovalRequest(checkpoint.metadata);
        if (approval) this.recordPermissionApproval(approval, normalized);
        return { node, result: normalized, start: node.id, permissionGate: true };
    }

    private async runGate(node: FlowStudioNode, context: FlowStudioContext, signal = this.request.signal, humanResults: Record<string, FlowStudioGateResult> = {}): Promise<FlowStudioGateResult> {
        const gate = normalizeGate(node);
        const policy = this.request.gatePolicy?.byNode?.[node.id];
        if (policy?.action) return { action: policy.action, toNodeId: policy.toNodeId, decisionId: policy.decisionId };
        try {
            const evaluated = await withAbortableTimeout(async attemptSignal => {
                if (gate.kind !== 'human') return this.evaluateGateConfig(node, gate, context, attemptSignal, 'root', humanResults);
                if (this.request.onGate) return normalizeGateResult(node, await this.request.onGate(this.gateRequest(node, gate, context)), true);
                const fallback = this.request.gatePolicy?.defaultAction;
                return fallback ? { action: fallback, toNodeId: this.request.gatePolicy?.defaultToNodeId } : { action: 'wait', message: 'Aguardando decisão humana.' };
            }, this.nodeRuntimeTimeout(node, gate.timeoutMs), signal);
            const composite = evaluated as CompositeGateEvaluation;
            if (gate.kind === 'composite' && composite.action === 'wait' && composite.pendingHumanPaths?.length) {
                this.pendingCompositeGateState = {
                    humanResults: clone(composite.humanResults || humanResults),
                    pendingHumanPath: composite.pendingHumanPaths[0]
                };
            } else {
                this.pendingCompositeGateState = undefined;
            }
            const { pendingHumanPaths: _pending, humanResults: _human, ...result } = composite;
            return result;
        } catch (caught) {
            if (gate.timeoutMs && caught instanceof Error && caught.message.startsWith('Timeout')) {
                return { action: gate.onTimeout || 'fail', message: `Gate "${node.label}" excedeu ${gate.timeoutMs}ms.` };
            }
            throw caught;
        }
    }

    private async evaluateGateConfig(
        node: FlowStudioNode,
        gate: FlowStudioGateConfig,
        context: FlowStudioContext,
        signal = this.request.signal,
        path = 'root',
        humanResults: Record<string, FlowStudioGateResult> = {}
    ): Promise<CompositeGateEvaluation> {
        if (gate.kind === 'human') {
            const preserved = humanResults[path];
            if (preserved) return { ...clone(preserved), humanResults };
            if (this.request.onGate) {
                const response = enforceGateConfigEvidence(node, gate, normalizeGateResult(node, await this.request.onGate({
                    ...this.gateRequest(node, gate, context),
                    kind: 'human',
                    payload: { compositeGate: { path } }
                }), true));
                if (response.action !== 'wait') humanResults[path] = clone(response);
                return { ...response, pendingHumanPaths: response.action === 'wait' ? [path] : [], humanResults };
            }
            const fallback = this.request.gatePolicy?.defaultAction;
            if (fallback) {
                const response = normalizeGateResult(node, { action: fallback, toNodeId: this.request.gatePolicy?.defaultToNodeId });
                humanResults[path] = clone(response);
                return { ...response, humanResults };
            }
            return { action: 'wait', message: `Gate composto aguarda decisão humana (${path}).`, pendingHumanPaths: [path], humanResults };
        }
        if (gate.kind === 'deterministic') {
            const approved = evaluateBoolean(gate.expression || 'false', context, false, {});
            return {
                action: approved ? 'continue' : 'fail',
                message: approved ? undefined : gate.prompt || 'Condição do gate não atendida.',
                score: approved ? 1 : 0,
                blockers: approved ? [] : [gate.prompt || 'Condição determinística não atendida.'],
                evidence: gate.requireEvidence ? [gateEvidenceArtifact(node, 'Avaliação determinística', { expression: gate.expression || 'false', approved })] : undefined
            };
        }
        if (gate.kind === 'policy') {
            const evaluations = (gate.rules || []).map(rule => ({ rule, passed: evaluateBoolean(rule.expression, context, false, { ruleId: rule.id }) }));
            const failed = evaluations.filter(item => !item.passed).map(item => item.rule);
            const blockers = failed.filter(rule => rule.severity === undefined || rule.severity === 'blocker');
            const warnings = failed.filter(rule => rule.severity === 'warning' || rule.severity === 'info');
            const score = evaluations.length ? evaluations.filter(item => item.passed).length / evaluations.length : 0;
            return {
                action: blockers.length ? 'fail' : 'continue',
                message: blockers.length ? blockers.map(rule => rule.message || rule.id).join('; ') : undefined,
                score,
                blockers: blockers.map(rule => rule.message || rule.id),
                warnings: warnings.map(rule => rule.message || rule.id),
                evidence: gate.requireEvidence ? [gateEvidenceArtifact(node, 'Avaliação de política', { rules: gate.rules || [], score, blockers: blockers.map(rule => rule.id), warnings: warnings.map(rule => rule.id) })] : undefined
            };
        }
        if (gate.kind === 'ai') {
            await this.authorizePermission(node, 'runner:invoke', context, signal);
            const primary = normalizeBinding(gate.reviewer || node.runner || node.provider || this.request.defaultProvider || { providerId: 'opencode' });
            const bindings = flattenRunnerBindings(primary);
            let output: FlowStudioRunnerOutput | undefined;
            let selectedModel: FlowStudioModelProfile | undefined;
            let selectedBinding: FlowStudioRunnerBinding | undefined;
            let lastError: unknown;
            const sessionOwner = `${node.id}::gate:${path}`;
            for (const [index, binding] of bindings.entries()) {
                selectedModel = resolveModel(binding, this.modelProfiles);
                const effectiveBinding: FlowStudioRunnerBinding = {
                    ...binding,
                    runnerId: binding.runnerId || selectedModel?.runnerId,
                    providerId: binding.providerId || selectedModel?.providerId || 'opencode',
                    modelId: binding.modelId || selectedModel?.modelId,
                    reasoningEffort: binding.reasoningEffort || selectedModel?.reasonDefault,
                    serviceTier: binding.serviceTier || selectedModel?.serviceTierDefault
                };
                if (!effectiveBinding.sessionId) effectiveBinding.sessionId = this.runnerSessions[sessionOwner]?.[runnerSessionKey(effectiveBinding)];
                const adapter = resolveRunnerAdapter(this.request.runnerAdapters || this.request.providerAdapters || {}, effectiveBinding, selectedModel)
                    || (this.request.simulationMode ? defaultProviderAdapter : unavailableRunnerAdapter);
                try {
                    output = await withRetry(
                        () => this.concurrencyLimiter.run(() => withAbortableTimeout(attemptSignal => adapter({
                            node,
                            graph: this.graph,
                            runId: this.runId,
                            context: clone(context),
                            input: clone(this.request.input || {}),
                            prompt: renderPrompt(gate.prompt || 'Avalie e retorne approved e evidence.', context),
                            runner: effectiveBinding,
                            model: selectedModel,
                            signal: attemptSignal,
                            onEvent: event => this.forwardAdapterEvent(node.id, event)
                        }), this.nodeRuntimeTimeout(node, gate.timeoutMs, effectiveBinding.timeoutMs), signal), signal),
                        node.retries || 0,
                        node.retryDelayMs || 0,
                        attempt => this.emit('node.requeued', node.id, undefined, `Tentativa ${attempt} do revisor de IA "${node.label}".`),
                        signal,
                        () => this.nodeRuntimeTimeout(node, gate.timeoutMs, effectiveBinding.timeoutMs)
                    );
                    selectedBinding = effectiveBinding;
                    break;
                } catch (caught) {
                    lastError = caught;
                    if (index < bindings.length - 1) this.emit('node.requeued', node.id, undefined, `Revisor ${binding.providerId} falhou; usando fallback ${bindings[index + 1].providerId}.`);
                }
            }
            if (!output) throw lastError instanceof Error ? lastError : new Error(`Nenhum revisor de IA executou o gate "${node.label}".`);
            this.consumeRunnerOutput(node, output, selectedModel);
            if (output.sessionId && selectedBinding) {
                if (!this.runnerSessions[sessionOwner]) this.runnerSessions[sessionOwner] = {};
                this.runnerSessions[sessionOwner][runnerSessionKey(selectedBinding)] = output.sessionId;
            }
            const approved = output.output?.approved === true || output.output?.decision === 'continue';
            const evidence = [...(output.artifacts || [])];
            if (evidence.length === 0 && output.output?.evidence !== undefined) evidence.push(gateEvidenceArtifact(node, 'Evidência do revisor de IA', output.output.evidence));
            if (gate.requireEvidence && evidence.length === 0) return { action: 'fail', message: 'Gate IA não apresentou evidência.' };
            const blockers = Array.isArray(output.output?.blockers) ? output.output.blockers.filter((item): item is string => typeof item === 'string') : approved ? [] : [output.summary || 'Revisor de IA recusou o gate.'];
            const warnings = Array.isArray(output.output?.warnings) ? output.output.warnings.filter((item): item is string => typeof item === 'string') : [];
            const score = typeof output.output?.score === 'number' ? output.output.score : approved ? 1 : 0;
            return { action: approved ? 'continue' : 'fail', message: output.summary, evidence, score, blockers, warnings };
        }
        if (gate.kind === 'composite') {
            const results = await Promise.all((gate.children || []).map((child, index) => this.evaluateGateConfig(node, child, context, signal, `${path}.${index}`, humanResults)));
            const approved = results.filter(result => result.action === 'continue').length;
            const waiting = results.filter(result => result.action === 'wait').length;
            const required = gate.combine === 'any' ? 1 : gate.combine === 'majority' ? Math.floor(results.length / 2) + 1 : results.length;
            const evidence = results.flatMap(result => result.evidence || []);
            const score = results.length ? results.reduce((total, result) => total + (result.score ?? (result.action === 'continue' ? 1 : 0)), 0) / results.length : 0;
            const blockers = results.flatMap(result => result.blockers || (result.action === 'fail' && result.message ? [result.message] : []));
            const warnings = results.flatMap(result => result.warnings || []);
            const pendingHumanPaths = results.flatMap(result => result.pendingHumanPaths || []);
            const memoryApprovals = results.filter(result => result.action === 'continue').flatMap(result => result.memoryApprovals || []);
            const common = { score, blockers, warnings, pendingHumanPaths, humanResults, memoryApprovals };
            if (approved >= required) return { ...common, action: 'continue', evidence: gate.requireEvidence && evidence.length === 0 ? [gateEvidenceArtifact(node, 'Avaliação de gate composto', { results, score, blockers, warnings })] : evidence };
            if (approved + waiting >= required) return { ...common, action: 'wait', message: pendingHumanPaths.length ? `Gate composto aguarda decisão humana (${pendingHumanPaths[0]}).` : 'Gate composto aguarda decisões pendentes.' };
            return { ...common, action: 'fail', message: results.filter(item => item.action !== 'continue').map(item => item.message).filter(Boolean).join('; ') };
        }
        return { action: 'wait' };
    }

    private gateRequest(node: FlowStudioNode, gate: FlowStudioGateConfig, context: FlowStudioContext): FlowStudioGateRequest {
        return {
            runId: this.runId, nodeId: node.id, label: gate.prompt || node.gatePrompt || node.label,
            kind: gate.kind, decisions: declaredGateDecisions(node), context: clone(context)
        };
    }

    private async pauseForGate(node: FlowStudioNode, context: FlowStudioContext, result: FlowStudioGateResult): Promise<never> {
        this.emit('gate.required', node.id, undefined, result.message || `Gate "${node.label}" aguarda decisão.`);
        const compositeState = this.pendingCompositeGateState ? clone(this.pendingCompositeGateState) : undefined;
        const interaction = gateInteractionEnvelope(this.graph, node, compositeState?.pendingHumanPath);
        const metadata = { ...(compositeState ? { compositeGate: compositeState } : {}), interaction };
        const checkpoint = await this.checkpoint(node, context, undefined, 'gate', undefined, metadata);
        this.pendingCompositeGateState = undefined;
        throw new WaitingSignal(result.message || 'Aguardando gate.', context, {
            nodeId: node.id,
            kind: 'gate',
            checkpointId: checkpoint.id,
            detail: { interaction, ...(compositeState ? { pendingHumanPath: compositeState.pendingHumanPath } : {}) }
        });
    }

    private async pauseForWait(node: FlowStudioNode, context: FlowStudioContext, nextNodeId?: string): Promise<never> {
        const wait = node.wait as FlowStudioWaitConfig;
        const dueAt = resolveDueAt(wait);
        const interaction = waitInteractionEnvelope(this.graph, node, wait, dueAt);
        this.emit('wait.started', node.id, undefined, `Wait "${node.label}" aguardando ${wait.kind}.`, { wait, dueAt });
        const checkpoint = await this.checkpoint(node, context, nextNodeId, 'wait', wait, { dueAt, interaction });
        throw new WaitingSignal(`Aguardando ${wait.kind}.`, context, { nodeId: node.id, kind: 'wait', checkpointId: checkpoint.id, detail: { wait, dueAt, interaction } });
    }

    private resolveGateRoute(node: FlowStudioNode, result: FlowStudioGateResult, context: FlowStudioContext): string | undefined {
        const decision = result.decisionId ? declaredGateDecisions(node).find(item => item.id === result.decisionId) : undefined;
        return result.toNodeId || decision?.toNodeId || pickNextEdge(node, this.outgoing.get(node.id) || [], context, { decision: result.decisionId || result.action })?.to;
    }

    private async authorizePermission(node: FlowStudioNode, permission: string, context: FlowStudioContext, signal = this.request.signal): Promise<void> {
        const declared = hasPermissionDeclaration(this.graph.permissions, node.permissions, [permission]);
        const decision = permissionDecision(this.graph.permissions, node.permissions, permission);
        if (decision === 'deny') throw new Error(`Permissão negada para "${permission}" no nó "${node.id}"${declared ? '' : ' (não declarada)'}.`);
        const approval: PermissionApprovalReceipt = { permission, nodeId: node.id, inputDigest: digest({ permission, context }) };
        if (decision !== 'approval' || this.permissionApprovalReceipts.has(permissionApprovalKey(approval))) return;
        if (!this.request.onGate) {
            const interaction = permissionInteractionEnvelope(this.graph, node, permission);
            this.emit('gate.required', node.id, undefined, `A permissão "${permission}" exige aprovação humana.`, { permission });
            const checkpoint = await this.checkpoint(node, context, node.id, 'gate', undefined, { approvalRequest: approval, interaction });
            throw new WaitingSignal(`Aguardando aprovação de "${permission}".`, context, { nodeId: node.id, kind: 'gate', checkpointId: checkpoint.id, detail: { permission, interaction } });
        }
        const response = normalizeGateResult(node, await withTimeout(this.request.onGate({
            runId: this.runId,
            nodeId: node.id,
            label: `Autorizar ${permission} para ${node.label}?`,
            kind: 'human',
            decisions: defaultGateDecisions(node),
            context: clone(context),
            payload: { permission }
        }), this.nodeRuntimeTimeout(node, node.timeoutMs), signal), true);
        if (response.action !== 'continue') throw new Error(response.message || `Permissão "${permission}" não aprovada.`);
        this.recordPermissionApproval(approval, response);
        this.recordMemoryApprovals(response.memoryApprovals);
    }

    private async authorizeTool(node: FlowStudioNode, tool: FlowStudioToolBinding, permission: string, context: FlowStudioContext, signal = this.request.signal): Promise<void> {
        await enforceToolScope(this.graph.permissions, node.permissions, tool, this.request.workspaceRoot);
        const required = [...new Set([permission, ...(tool.requiredPermissions || [])])];
        for (const item of required) {
            const decision = permissionDecision(this.graph.permissions, node.permissions, item);
            if (decision === 'deny') throw new Error(`Permissão negada para "${item}" no nó "${node.id}".`);
            if (decision === 'approval') {
                const approval: PermissionApprovalReceipt = { permission: item, nodeId: node.id, toolId: tool.id, inputDigest: digest({ item, context, tool }) };
                if (this.permissionApprovalReceipts.has(permissionApprovalKey(approval))) continue;
                if (!this.request.onGate) {
                    const interaction = permissionInteractionEnvelope(this.graph, node, item, tool.id, tool.name);
                    this.emit('gate.required', node.id, undefined, `A permissão "${item}" exige aprovação humana.`, { permission: item, toolId: tool.id });
                    const checkpoint = await this.checkpoint(node, context, node.id, 'gate', undefined, { approvalRequest: approval, interaction });
                    throw new WaitingSignal(`Aguardando aprovação de "${item}".`, context, { nodeId: node.id, kind: 'gate', checkpointId: checkpoint.id, detail: { permission: item, toolId: tool.id, interaction } });
                }
                const response = normalizeGateResult(node, await withTimeout(this.request.onGate({
                    runId: this.runId, nodeId: node.id, label: `Autorizar ${item} para ${tool.name}?`, kind: 'human',
                    decisions: defaultGateDecisions(node), context: clone(context), payload: { permission: item, tool }
                }), this.nodeRuntimeTimeout(node, tool.timeoutMs, node.timeoutMs), signal), true);
                if (response.action !== 'continue') throw new Error(response.message || `Permissão "${item}" não aprovada.`);
                this.recordPermissionApproval(approval, response);
                this.recordMemoryApprovals(response.memoryApprovals);
            }
        }
    }

    private recordMemoryApprovals(approvals: FlowStudioRunRequest['memoryApprovals'] | undefined, defaultApprover = 'human-gate', trustedRestore = false): void {
        for (const approval of approvals || []) {
            if (!approval.id?.trim() || !String(approval.revision).trim() || !approval.candidateDigest?.trim()
                || !approval.graphId?.trim() || !approval.nodeId?.trim()) continue;
            const normalized = trustedRestore
                ? { ...clone(approval), approvedAt: approval.approvedAt || new Date().toISOString(), approvedBy: approval.approvedBy || defaultApprover }
                : { ...clone(approval), approvedAt: new Date().toISOString(), approvedBy: defaultApprover };
            this.memoryApprovalReceipts.set(memoryApprovalKey(normalized), normalized);
        }
    }

    private recordPermissionApproval(receipt: PermissionApprovalReceipt, decision?: FlowStudioGateResult, defaultApprover = 'human-gate'): void {
        const normalized: PermissionApprovalReceipt = {
            ...clone(receipt), approvedAt: receipt.approvedAt || new Date().toISOString(), approvedBy: receipt.approvedBy || defaultApprover,
            decisionId: decision?.decisionId || receipt.decisionId,
            evidence: clone(decision?.evidence || receipt.evidence || [])
        };
        this.permissionApprovalReceipts.set(permissionApprovalKey(receipt), normalized);
    }

    private writeState(node: FlowStudioNode, context: FlowStudioContext, statePath: string, value: unknown): void {
        if (!isSafeStatePath(statePath)) throw new Error(`O nó "${node.id}" tentou escrever no caminho reservado ou inválido "${statePath}".`);
        const namespace = statePath.split('.')[0];
        if (this.graph.state?.strictWrites && !this.graph.state.namespaces?.[namespace]) {
            throw new Error(`O nó "${node.id}" tentou escrever no namespace não declarado "${namespace}".`);
        }
        setPath(context, statePath, value);
    }

    private consumeRunnerOutput(node: FlowStudioNode, output: FlowStudioRunnerOutput, model?: FlowStudioModelProfile): void {
        assertSerializedLimit(output.output || {}, FLOW_STUDIO_MAX_NODE_OUTPUT_BYTES, `Saída do nó "${node.id}"`);
        if (output.artifacts?.length) this.addArtifacts(output.artifacts.map(artifact => ({ ...artifact, createdAt: artifact.createdAt || new Date().toISOString() })));
        const usage = normalizeUsage(output.usage);
        if (!usage.costUsd && model) usage.costUsd = estimateCost(usage, model);
        addUsage(this.usage, usage);
        const nodeUsage = this.usageByNode.get(node.id) || normalizeUsage();
        addUsage(nodeUsage, usage);
        this.usageByNode.set(node.id, nodeUsage);
        const embeddedParentId = node.id.includes('::') ? node.id.split('::', 1)[0] : undefined;
        const embeddedParent = embeddedParentId ? this.nodeById.get(embeddedParentId) : undefined;
        if (embeddedParent) {
            const parentUsage = this.usageByNode.get(embeddedParent.id) || normalizeUsage();
            addUsage(parentUsage, usage);
            this.usageByNode.set(embeddedParent.id, parentUsage);
            this.assertNodeBudget(embeddedParent, parentUsage);
        }
        this.emit('budget.updated', node.id, undefined, `Uso atualizado: $${this.usage.costUsd.toFixed(4)}, ${this.usage.inputTokens + this.usage.outputTokens} tokens.`, { usage: { ...this.usage } });
        this.assertNodeBudget(node, nodeUsage);
        this.assertRuntimeBudget();
    }

    private assertNodeBudget(node: FlowStudioNode, usage: FlowStudioUsage): void {
        const budget = node.budget;
        if (!budget) return;
        if (budget.maxCostUsd !== undefined && usage.costUsd > budget.maxCostUsd) throw new Error(`Nó "${node.id}" excedeu custo de $${budget.maxCostUsd}.`);
        if (budget.maxInputTokens !== undefined && usage.inputTokens > budget.maxInputTokens) throw new Error(`Nó "${node.id}" excedeu tokens de entrada.`);
        if (budget.maxOutputTokens !== undefined && usage.outputTokens > budget.maxOutputTokens) throw new Error(`Nó "${node.id}" excedeu tokens de saída.`);
        if (budget.maxDurationMs !== undefined && (this.nodeWallTimeMs.get(node.id) || 0) > budget.maxDurationMs) throw new Error(`Nó "${node.id}" excedeu duração acumulada de ${budget.maxDurationMs}ms.`);
    }

    private assertStateSchemas(context: FlowStudioContext, node: FlowStudioNode): void {
        for (const [namespace, spec] of Object.entries(this.graph.state?.namespaces || {})) {
            if (!spec.schema) continue;
            const errors = validateJsonValue(getPath(context, namespace), spec.schema, namespace);
            if (errors.length) throw new Error(`Estado inválido após "${node.id}": ${errors.join('; ')}`);
        }
    }

    private assertContextSize(context: FlowStudioContext): void {
        assertSerializedLimit(context, FLOW_STUDIO_MAX_CONTEXT_BYTES, 'Contexto da execução');
    }

    private addArtifacts(items: FlowStudioArtifact[]): void {
        const keys = new Set(this.artifacts.map(artifact => artifact.id || `${artifact.kind}:${artifact.uri || ''}:${artifact.name}`));
        for (const source of items) {
            const artifact = clone(source);
            const key = artifact.id || `${artifact.kind}:${artifact.uri || ''}:${artifact.name}`;
            if (keys.has(key)) continue;
            const bytes = serializedSize(artifact);
            if (bytes > FLOW_STUDIO_MAX_ARTIFACT_BYTES) throw new Error(`Artefato "${artifact.name}" excedeu ${FLOW_STUDIO_MAX_ARTIFACT_BYTES} bytes.`);
            if (this.artifacts.length >= FLOW_STUDIO_MAX_ARTIFACTS) throw new Error(`Execução excedeu ${FLOW_STUDIO_MAX_ARTIFACTS} artefatos.`);
            if (this.artifactBytes + bytes > FLOW_STUDIO_MAX_ARTIFACT_TOTAL_BYTES) throw new Error(`Artefatos da execução excederam ${FLOW_STUDIO_MAX_ARTIFACT_TOTAL_BYTES} bytes.`);
            this.artifacts.push(artifact);
            this.artifactBytes += bytes;
            keys.add(key);
        }
    }

    private runtimeTimeout(...localLimits: Array<number | undefined>): number {
        const graphLimit = this.graph.budget?.maxDurationMs || FLOW_STUDIO_MAX_DURATION_DEFAULT;
        const remaining = graphLimit - this.activeDurationMs();
        if (remaining <= 0) throw new Error('Execução excedeu o limite de duração.');
        const limits = localLimits.filter((value): value is number => typeof value === 'number' && value > 0);
        return Math.max(1, Math.min(remaining, ...limits));
    }

    private nodeRuntimeTimeout(node: FlowStudioNode, ...localLimits: Array<number | undefined>): number {
        const completed = this.nodeWallTimeMs.get(node.id) || 0;
        const entered = this.nodeEnteredAt.get(node.id)?.at(-1);
        const current = entered === undefined ? 0 : Date.now() - entered;
        const nodeRemaining = node.budget?.maxDurationMs === undefined ? undefined : node.budget.maxDurationMs - completed - current;
        if (nodeRemaining !== undefined && nodeRemaining <= 0) throw new Error(`Nó "${node.id}" excedeu duração acumulada de ${node.budget?.maxDurationMs}ms.`);
        return this.runtimeTimeout(nodeRemaining, ...localLimits);
    }

    private assertRuntimeBudget(signal = this.request.signal): void {
        if (signal?.aborted) throw abortError();
        const budget: FlowStudioBudgetSpec = { ...this.graph.budget };
        const duration = this.activeDurationMs();
        if (duration > (budget.maxDurationMs || FLOW_STUDIO_MAX_DURATION_DEFAULT)) throw new Error('Execução excedeu o limite de duração.');
        if (budget.maxCostUsd !== undefined && this.usage.costUsd > budget.maxCostUsd) throw new Error(`Execução excedeu o orçamento de $${budget.maxCostUsd}.`);
        if (budget.maxInputTokens !== undefined && this.usage.inputTokens > budget.maxInputTokens) throw new Error('Execução excedeu tokens de entrada.');
        if (budget.maxOutputTokens !== undefined && this.usage.outputTokens > budget.maxOutputTokens) throw new Error('Execução excedeu tokens de saída.');
    }

    private consumeGlobalStep(nodeId: string): void {
        if (this.stepLedger.count >= this.stepLedger.maxSteps) throw new Error(`Execução excedeu ${this.stepLedger.maxSteps} passos de nós antes de entrar em "${nodeId}".`);
        const localMaxSteps = this.graph.budget?.maxSteps;
        if (localMaxSteps !== undefined && this.visited.length >= localMaxSteps) throw new Error(`Execução local excedeu ${localMaxSteps} passos de nós antes de entrar em "${nodeId}".`);
        this.stepLedger.count += 1;
    }

    private activeDurationMs(): number {
        return this.activeDurationBeforeSegmentMs + Math.max(0, Date.now() - Date.parse(this.startedAt));
    }

    private async checkpoint(node: FlowStudioNode, context: FlowStudioContext, nextNodeId: string | undefined, reason: FlowStudioCheckpoint['reason'], wait?: FlowStudioWaitConfig, metadata?: Record<string, unknown>): Promise<FlowStudioCheckpoint> {
        const starts = this.nodeEnteredAt.get(node.id);
        const enteredAt = starts?.pop();
        if (enteredAt !== undefined) this.nodeWallTimeMs.set(node.id, (this.nodeWallTimeMs.get(node.id) || 0) + (Date.now() - enteredAt));
        // A failure checkpoint is evidence of the original exception. Revalidating the
        // budget here would replace that exception and could also make failure
        // persistence recurse forever when the budget itself caused the failure.
        if (reason !== 'failure') this.assertNodeBudget(node, this.usageByNode.get(node.id) || normalizeUsage());
        const contextWithinLimit = serializedSize(context) <= FLOW_STUDIO_MAX_CONTEXT_BYTES;
        if (!contextWithinLimit && reason !== 'failure') this.assertContextSize(context);
        const replayMetadata = !contextWithinLimit
            ? {
                replayable: false,
                replayBlockedReason: `Checkpoint de falha não reproduzível: o contexto excedeu ${FLOW_STUDIO_MAX_CONTEXT_BYTES} bytes e o snapshot foi omitido. Execute o fluxo novamente desde o início.`
            }
            : this.structurallyScopedNodes.has(node.id)
                ? { replayable: false, replayBlockedReason: `Checkpoint interno de "${node.label}"; use o checkpoint de limite do Fork/Loop para preservar todo o estado.` }
                : {};
        const checkpoint: FlowStudioCheckpoint = {
            id: randomHex(), runId: this.runId, graphId: this.graph.id, graphVersion: this.graph.version, graphDigest: this.graphDigest,
            nodeId: node.id, nextNodeId, reason, context: contextWithinLimit ? clone(context) : {}, visited: [...this.visited], effects: clone(this.effects),
            artifacts: clone(this.artifacts), usage: { ...this.usage, durationMs: this.activeDurationMs() }, createdAt: new Date().toISOString(), wait,
            metadata: {
                ...(metadata || {}), ...replayMetadata,
                permissionApprovals: [...this.permissionApprovalReceipts.values()].map(value => clone(value)),
                memoryApprovals: [...this.memoryApprovalReceipts.values()].map(value => clone(value)),
                globalStepCount: this.stepLedger.count,
                runnerSessions: clone(this.runnerSessions),
                usageByNode: Object.fromEntries([...this.usageByNode].map(([id, usage]) => [id, { ...usage }])),
                wallTimeByNode: Object.fromEntries(this.nodeWallTimeMs)
            }
        };
        const checkpointBytes = serializedSize(checkpoint);
        if (this.checkpoints.length >= FLOW_STUDIO_MAX_CHECKPOINTS || this.checkpointBytes + checkpointBytes > FLOW_STUDIO_MAX_CHECKPOINT_TOTAL_BYTES) {
            if (reason === 'failure') return checkpoint;
            throw new Error(`Execução excedeu o limite de checkpoints (${FLOW_STUDIO_MAX_CHECKPOINTS} itens ou ${FLOW_STUDIO_MAX_CHECKPOINT_TOTAL_BYTES} bytes).`);
        }
        this.checkpoints.push(checkpoint);
        this.checkpointBytes += checkpointBytes;
        const spans = this.nodeSpans.get(node.id);
        const span = spans?.pop();
        if (span) {
            span.setAttributes({ 'flow.checkpoint.reason': reason, 'flow.node.next_id': nextNodeId || '' });
            if (reason === 'failure') span.setStatus({ code: SpanStatusCode.ERROR, message: typeof metadata?.error === 'string' ? metadata.error : undefined });
            span.end();
        }
        await this.request.onCheckpoint?.(clone(checkpoint));
        if (reason !== 'failure') this.emit('checkpoint.created', node.id, undefined, `Checkpoint após "${node.label}".`, { checkpointId: checkpoint.id, reason });
        return checkpoint;
    }

    private async refreshWaitingCheckpoint(source: FlowStudioCheckpoint, context: FlowStudioContext): Promise<FlowStudioCheckpoint> {
        if (source.reason !== 'gate' && source.reason !== 'wait') throw new Error(`Checkpoint "${source.id}" não representa uma espera retomável.`);
        const node = this.nodeById.get(source.nodeId);
        if (!node) throw new Error(`Nó desconhecido no checkpoint de espera: "${source.nodeId}".`);
        // A failed resume attempt is still active runtime work. Persist a successor so
        // its duration, receipts and ledgers become the next authoritative boundary;
        // reusing the source would let repeated polling reset cumulative duration.
        this.assertRuntimeBudget();
        return this.checkpoint(node, context, source.nextNodeId, source.reason, source.wait, clone(source.metadata));
    }

    private forwardAdapterEvent(nodeId: string, event: FlowStudioRunEvent): void {
        this.emit(event.kind, nodeId, event.edgeId, event.message, event.detail);
    }

    private emit(kind: FlowStudioRunEvent['kind'], nodeId: string | undefined, edgeId: string | undefined, message: string, detail?: Record<string, unknown>): void {
        const event: FlowStudioRunEvent = { kind, runId: this.runId, nodeId, edgeId, message, detail, step: this.events.length + 1, at: new Date().toISOString() };
        const bytes = serializedSize(event);
        if (this.events.length >= FLOW_STUDIO_MAX_EVENTS || this.eventBytes + bytes > FLOW_STUDIO_MAX_EVENT_TOTAL_BYTES) {
            if (kind === 'run.failed' || kind === 'run.cancelled' || kind === 'run.completed') return;
            throw new Error(`Execução excedeu o limite de eventos (${FLOW_STUDIO_MAX_EVENTS} itens ou ${FLOW_STUDIO_MAX_EVENT_TOTAL_BYTES} bytes).`);
        }
        this.events.push(event);
        this.eventBytes += bytes;
        this.request.onEvent?.(event);
    }
}

class WaitingSignal extends Error {
    constructor(message: string, readonly context: FlowStudioContext, readonly waiting: NonNullable<FlowStudioRunResult['waiting']>) { super(message); }
}

class RunConcurrencyLimiter implements FlowStudioConcurrencyLimiter {
    private active = 0;
    private readonly queue: Array<{ resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal; onAbort?: () => void }> = [];
    private drainScheduled = false;

    constructor(private readonly maximum: number) {}

    async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        await this.acquire(signal);
        try {
            if (signal?.aborted) throw abortError();
            return await task();
        } finally {
            this.release();
        }
    }

    private async acquire(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) throw abortError();
        if (this.active < this.maximum && this.queue.length === 0 && !this.drainScheduled) {
            this.active += 1;
            return;
        }
        await new Promise<void>((resolve, reject) => {
            const waiter: { resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal; onAbort?: () => void } = { resolve, reject, signal };
            waiter.onAbort = () => {
                const index = this.queue.indexOf(waiter);
                if (index >= 0) this.queue.splice(index, 1);
                reject(abortError());
            };
            signal?.addEventListener('abort', waiter.onAbort, { once: true });
            this.queue.push(waiter);
        });
    }

    private release(): void {
        this.active -= 1;
        if (!this.queue.length || this.drainScheduled) return;
        this.drainScheduled = true;
        setTimeout(() => {
            this.drainScheduled = false;
            while (this.active < this.maximum && this.queue.length) {
                const waiter = this.queue.shift() as { resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal; onAbort?: () => void };
                if (waiter.onAbort) waiter.signal?.removeEventListener('abort', waiter.onAbort);
                if (waiter.signal?.aborted) {
                    waiter.reject(abortError());
                    continue;
                }
                this.active += 1;
                waiter.resolve();
            }
        }, 0);
    }
}

function buildOutgoing(nodes: FlowStudioNode[], edges: FlowStudioEdge[]): Map<string, FlowStudioEdge[]> {
    const result = new Map<string, FlowStudioEdge[]>(nodes.map(node => [node.id, []]));
    for (const edge of edges) {
        const list = result.get(edge.from);
        if (list) list.push(edge);
    }
    for (const list of result.values()) list.sort((left, right) => (left.priority || 0) - (right.priority || 0));
    return result;
}

function collectStructuredInteriorNodes(graph: FlowStudioGraph, outgoing: Map<string, FlowStudioEdge[]>): Set<string> {
    const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
    const scoped = new Set<string>();
    const walk = (start: string | undefined, stop: string): void => {
        const queue = start ? [start] : [];
        const local = new Set<string>();
        while (queue.length) {
            const id = queue.shift() as string;
            if (id === stop || local.has(id) || !nodeById.has(id)) continue;
            local.add(id);
            scoped.add(id);
            const node = nodeById.get(id) as FlowStudioNode;
            const refs = [
                node.next,
                ...(outgoing.get(id) || []).map(edge => edge.to),
                ...(node.gateDecisions || []).map(decision => decision.toNodeId),
                ...(node.fork?.branches || []),
                node.fork?.join,
                node.loop?.bodyStart
            ];
            for (const ref of refs) if (ref && ref !== stop && !local.has(ref)) queue.push(ref);
        }
    };
    for (const node of graph.nodes) {
        if (node.type === 'fork' && node.fork) for (const branch of node.fork.branches) walk(branch, node.fork.join);
        if (node.type === 'loop' && node.loop) walk(node.loop.bodyStart, node.id);
    }
    return scoped;
}

function pickNextEdge(node: FlowStudioNode, edges: FlowStudioEdge[], context: FlowStudioContext, extras?: { condition?: boolean; decision?: string }): FlowStudioEdge | undefined {
    if (node.next) return { id: `${node.id}::next`, from: node.id, to: node.next, priority: Number.MAX_SAFE_INTEGER };
    return edges.find(edge => !edge.guard || evaluateBoolean(edge.guard, context, false, extras || {}));
}

function collectInputValues(node: FlowStudioNode, input: FlowStudioContext): FlowStudioContext {
    if (!node.outputs) return clone(input);
    const mapped: FlowStudioContext = {};
    for (const [source, target] of Object.entries(node.outputs)) if (hasPath(input, source)) setPath(mapped, target, getPath(input, source));
    return mapped;
}

function applyNodeOutputs(context: FlowStudioContext, node: FlowStudioNode, output: Record<string, unknown>, strictWrites = false): FlowStudioContext {
    const mapped: FlowStudioContext = {};
    for (const [source, target] of Object.entries(node.outputs || {})) if (hasPath(output, source)) setPath(mapped, target, getPath(output, source));
    return strictWrites ? deepMerge(context, mapped) : deepMerge(context, output, mapped);
}

function configuredOutputPaths(node: FlowStudioNode): string[] {
    const paths: Array<string | undefined> = [];
    if (node.type === 'context') paths.push(node.context?.outputPath || 'context.pack');
    if (node.type === 'memory_write') paths.push(node.memoryWrite?.outputPath || 'memory.writes');
    if (node.type === 'playbook') paths.push(...Object.values(node.playbook?.output || {}));
    if (node.type === 'dynamic_parallel') paths.push(node.dynamicParallel?.itemVariable || 'item', node.dynamicParallel?.outputPath || 'parallel.results');
    if (node.type === 'tournament') paths.push(node.tournament?.outputPath || 'tournament.result');
    return paths.filter((value): value is string => Boolean(value));
}

function projectContext(source: FlowStudioContext, mapping: Record<string, string>): FlowStudioContext {
    const result: FlowStudioContext = {};
    for (const [sourcePath, targetPath] of Object.entries(mapping)) if (hasPath(source, sourcePath)) setPath(result, targetPath, getPath(source, sourcePath));
    return result;
}

function resolveModel(binding: FlowStudioRunnerBinding, available: Record<string, FlowStudioModelProfile>): FlowStudioModelProfile | undefined {
    const keys = [binding.profileId, binding.modelId, normalizeProviderModelRef(binding.providerId, binding.modelId)].filter((item): item is string => Boolean(item));
    for (const key of keys) if (available[key]) return available[key];
    return undefined;
}

function resolveModelProfiles(graph: FlowStudioGraph, override: Record<string, FlowStudioModelProfile> | undefined): Record<string, FlowStudioModelProfile> {
    const result = { ...FLOW_STUDIO_DEFAULT_MODEL_PROFILES };
    for (const profile of graph.modelProfiles || []) if (profile?.id) result[profile.id] = profile;
    return { ...result, ...(override || {}) };
}

function resolveRunnerAdapter(adapters: Record<string, FlowStudioRunnerAdapter>, binding: FlowStudioRunnerBinding, model?: FlowStudioModelProfile): FlowStudioRunnerAdapter | undefined {
    const candidates = [binding.runnerId, binding.profileId, model?.id, binding.modelId, normalizeProviderModelRef(binding.providerId, binding.modelId), binding.providerId];
    for (const candidate of candidates) if (candidate && adapters[candidate]) return adapters[candidate];
    return undefined;
}

function resolveToolAdapter(adapters: Record<string, FlowStudioToolAdapter>, tool: FlowStudioToolBinding): FlowStudioToolAdapter | undefined {
    return adapters[tool.id] || adapters[tool.command] || adapters['*'];
}

function normalizeBinding(binding: FlowStudioProviderBinding): FlowStudioRunnerBinding {
    return { ...binding, providerId: binding.providerId || binding.runnerId || 'opencode' };
}

function flattenRunnerBindings(primary: FlowStudioRunnerBinding, maxDepth = 4): FlowStudioRunnerBinding[] {
    const result: FlowStudioRunnerBinding[] = [];
    const visit = (binding: FlowStudioRunnerBinding, depth: number, ancestry: Set<FlowStudioRunnerBinding>): void => {
        if (depth > maxDepth) throw new Error(`Fallback de runner excedeu a profundidade máxima ${maxDepth}.`);
        if (ancestry.has(binding)) throw new Error('Fallback de runner contém ciclo.');
        const nextAncestry = new Set(ancestry).add(binding);
        const normalized = normalizeBinding(binding);
        result.push({ ...normalized, fallbacks: undefined });
        for (const fallback of binding.fallbacks || []) visit(fallback, depth + 1, nextAncestry);
    };
    visit(primary, 0, new Set());
    return result;
}

function isEmbeddedJudge(node: FlowStudioNode): boolean {
    return node.metadata?._flowStudioEmbeddedRole === 'judge';
}

function judgeVisibleGraph(graph: FlowStudioGraph, judge: FlowStudioNode, workspaceRoot?: string): FlowStudioGraph {
    return {
        version: graph.version,
        id: graph.id,
        name: graph.name,
        description: 'Tournament judge execution surface.',
        start: judge.id,
        nodes: [{ ...clone(judge), metadata: undefined }],
        edges: [],
        permissions: intersectPermissions(graph.permissions, judge.permissions, workspaceRoot),
        budget: intersectBudget(graph.budget, judge.budget)
    };
}

function runnerSessionKey(binding: FlowStudioRunnerBinding): string {
    return digest({ runnerId: binding.runnerId || '', providerId: binding.providerId, modelId: binding.modelId || '', profileId: binding.profileId || '' }).slice(0, 20);
}

function isValidNodeType(value: string): value is FlowStudioNodeType { return NODE_TYPES.includes(value as FlowStudioNodeType); }

function renderPrompt(prompt: string, context: FlowStudioContext): string {
    return prompt.replace(/\{\{([^}]+)\}\}/g, (_match, token: string) => {
        const value = getPath(context, token.trim());
        return value === undefined || value === null ? '' : safeSerialize(value);
    });
}

async function renderRag(node: FlowStudioNode, context: FlowStudioContext, graphPermissions?: FlowStudioPermissionSpec, workspaceRoot?: string): Promise<string> {
    let markdown = node.rag?.markdown ? renderPrompt(node.rag.markdown, context) : '';
    if (node.rag?.filePath) {
        const base = path.resolve(workspaceRoot || process.cwd());
        const graphRoots = await Promise.all((graphPermissions?.fileRoots?.length ? graphPermissions.fileRoots : workspaceRoot ? [workspaceRoot] : []).map(root => fs.realpath(path.resolve(base, root))));
        const nodeRoots = await Promise.all((node.permissions?.fileRoots || []).map(root => fs.realpath(path.resolve(base, root))));
        const roots = nodeRoots.length ? intersectRoots(graphRoots, nodeRoots) : graphRoots;
        if (!roots.length) throw new Error(`RAG filePath de "${node.id}" exige uma raiz de workspace ou permissions.fileRoots.`);
        const resolved = path.resolve(base, node.rag.filePath);
        const canonical = await fs.realpath(resolved);
        if (!roots.some(root => isPathInside(canonical, root))) throw new Error(`RAG filePath fora das raízes permitidas: ${resolved}`);
        const stat = await fs.stat(canonical);
        const maxBytes = node.rag.maxBytes || 1_000_000;
        if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Arquivo RAG inválido ou maior que ${maxBytes} bytes: ${resolved}`);
        const contents = await fs.readFile(canonical, 'utf-8');
        markdown = [markdown, contents].filter(Boolean).join('\n\n');
    }
    return markdown ? `\n\n## Contexto RAG\n${markdown}\n` : '';
}

function evaluate(expression: string, context: FlowStudioContext, metadata: Record<string, unknown>): unknown {
    assertSafeExpressionSource(expression);
    const clonedContext = clone(context);
    const clonedMetadata = clone(metadata);
    const bindings = { ...clonedContext, ...clonedMetadata };
    const payload = JSON.stringify({ context: clonedContext, bindings });
    const declarations = Object.keys(bindings)
        .filter(isSafeExpressionBinding)
        .map(key => `const ${key} = __payload.bindings[${JSON.stringify(key)}];`)
        .join('\n');
    // Parse all caller data inside the isolated realm. Passing host-created
    // objects or constructors as sandbox globals would expose their host
    // prototype chain and make Function-constructor escapes possible.
    const source = `"use strict";\nconst __payload = JSON.parse(${JSON.stringify(payload)});\nconst context = __payload.context;\nconst contexto = __payload.context;\n${declarations}\n(${expression})`;
    const script = new vm.Script(source, { filename: 'flow-studio-expression' });
    return script.runInNewContext(Object.create(null), { timeout: 120, contextCodeGeneration: { strings: false, wasm: false } });
}

const EXPRESSION_FORBIDDEN_NAMES = /\b(?:constructor|prototype|__proto__|process|require|module|exports|global|globalThis|Function|eval|WebAssembly)\b/iu;
const EXPRESSION_RESERVED_BINDINGS = new Set([
    'context', 'contexto', '__payload', 'Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'Reflect',
    'Date', 'RegExp', 'Promise', 'Proxy', 'Symbol', 'BigInt', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'Intl',
    'undefined', 'NaN', 'Infinity', 'true', 'false', 'null', 'this', 'new', 'class', 'function', 'return', 'let', 'const', 'var'
]);

function assertSafeExpressionSource(expression: string): void {
    if (EXPRESSION_FORBIDDEN_NAMES.test(expression)) throw new Error('Expressão contém acesso a runtime/prototype proibido.');
}

function isSafeExpressionBinding(key: string): boolean {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) && !EXPRESSION_RESERVED_BINDINGS.has(key);
}

function evaluateBoolean(expression: string, context: FlowStudioContext, fallback: boolean, metadata: Record<string, unknown>): boolean {
    try { return Boolean(evaluate(expression, context, metadata)); } catch { return fallback; }
}

function collectReachable(graph: FlowStudioGraph, nodeById: Map<string, FlowStudioNode>): Set<string> {
    const seen = new Set<string>();
    const queue = graph.start ? [graph.start] : [];
    while (queue.length) {
        const id = queue.shift() as string;
        if (seen.has(id) || !nodeById.has(id)) continue;
        seen.add(id);
        const node = nodeById.get(id) as FlowStudioNode;
        const refs = [node.next, node.loop?.bodyStart, node.fork?.join, ...(node.fork?.branches || []), ...(node.gateDecisions || []).map(item => item.toNodeId), ...graph.edges.filter(edge => edge.from === id).map(edge => edge.to)];
        for (const ref of refs) if (ref && !seen.has(ref)) queue.push(ref);
    }
    return seen;
}

function canReachNode(graph: FlowStudioGraph, start: string, target: string): boolean {
    const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
    const outgoing = buildOutgoing(graph.nodes, graph.edges);
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length) {
        const id = queue.shift() as string;
        if (id === target) return true;
        if (seen.has(id)) continue;
        seen.add(id);
        const node = nodeById.get(id);
        if (!node || node.type === 'end') continue;
        const refs = [node.next, node.loop?.bodyStart, node.fork?.join, ...(node.fork?.branches || []), ...(node.gateDecisions || []).map(item => item.toNodeId), ...(outgoing.get(id) || []).map(edge => edge.to)];
        for (const ref of refs) if (ref && !seen.has(ref)) queue.push(ref);
    }
    return false;
}

function initialContext(graph: FlowStudioGraph, input: FlowStudioContext): FlowStudioContext {
    let result = clone(graph.state?.initial || {});
    for (const [namespace, spec] of Object.entries(graph.state?.namespaces || {})) setPath(result, namespace, clone(spec.initial || {}));
    return deepMerge(result, input);
}

function mergeBranchContexts(graph: FlowStudioGraph, base: FlowStudioContext, branches: FlowStudioContext[]): FlowStudioContext {
    const result = clone(base);
    const namespaces = new Set<string>();
    for (const branch of branches) for (const key of Object.keys(branch)) namespaces.add(key);
    for (const namespace of namespaces) {
        const values = branches.map(branch => branch[namespace]).filter(value => value !== undefined);
        if (!values.length) continue;
        result[namespace] = applyReducer(graph.state?.namespaces?.[namespace]?.reducer || { kind: 'merge' }, result[namespace], values);
    }
    return result;
}

function nestedSubgraphCheckpoint(metadata: Record<string, unknown> | undefined): FlowStudioCheckpoint | undefined {
    const value = metadata?.subgraphCheckpoint;
    if (!isRecord(value)) return undefined;
    return value as unknown as FlowStudioCheckpoint;
}

function readCompositeGateState(metadata: Record<string, unknown> | undefined): CompositeGateCheckpointState | undefined {
    const value = metadata?.compositeGate;
    if (!isRecord(value) || !isRecord(value.humanResults) || typeof value.pendingHumanPath !== 'string' || !value.pendingHumanPath) return undefined;
    const humanResults: Record<string, FlowStudioGateResult> = {};
    for (const [path, result] of Object.entries(value.humanResults)) {
        if (!isPoisonKey(path) && isRecord(result) && ['continue', 'wait', 'fail'].includes(String(result.action))) {
            humanResults[path] = clone(result as FlowStudioGateResult);
        }
    }
    return { humanResults, pendingHumanPath: value.pendingHumanPath };
}

function remainingBudget(budget: FlowStudioBudgetSpec | undefined, usage: FlowStudioUsage, activeDurationMs: number): FlowStudioBudgetSpec | undefined {
    if (!budget) return undefined;
    const subtract = (limit: number | undefined, used: number): number | undefined => limit === undefined ? undefined : Math.max(0, limit - used);
    return {
        ...budget,
        maxDurationMs: subtract(budget.maxDurationMs, activeDurationMs),
        maxCostUsd: subtract(budget.maxCostUsd, usage.costUsd),
        maxInputTokens: subtract(budget.maxInputTokens, usage.inputTokens),
        maxOutputTokens: subtract(budget.maxOutputTokens, usage.outputTokens)
    };
}

function rebaseRemainingBudget(budget: FlowStudioBudgetSpec | undefined, prior: FlowStudioUsage | undefined): FlowStudioBudgetSpec | undefined {
    if (!budget || !prior) return budget;
    const add = (remaining: number | undefined, used: number): number | undefined => remaining === undefined ? undefined : remaining + used;
    return {
        ...budget,
        maxDurationMs: add(budget.maxDurationMs, prior.durationMs || 0),
        maxCostUsd: add(budget.maxCostUsd, prior.costUsd || 0),
        maxInputTokens: add(budget.maxInputTokens, prior.inputTokens || 0),
        maxOutputTokens: add(budget.maxOutputTokens, prior.outputTokens || 0)
    };
}

function restrictSubgraphGraph(graph: FlowStudioGraph, parentPermissions: FlowStudioPermissionSpec | undefined, parentBudget: FlowStudioBudgetSpec | undefined, workspaceRoot?: string): FlowStudioGraph {
    const child = clone(graph);
    child.budget = intersectBudget(parentBudget, child.budget);
    child.permissions = intersectPermissions(parentPermissions, child.permissions, workspaceRoot);
    return child;
}

function intersectBudget(parent: FlowStudioBudgetSpec | undefined, child: FlowStudioBudgetSpec | undefined): FlowStudioBudgetSpec | undefined {
    if (!parent) return child ? { ...child } : undefined;
    if (!child) return { ...parent };
    const result: FlowStudioBudgetSpec = {};
    for (const key of ['maxSteps', 'maxDurationMs', 'maxCostUsd', 'maxInputTokens', 'maxOutputTokens', 'maxParallelism'] as const) {
        const values = [parent[key], child[key]].filter((value): value is number => value !== undefined);
        if (values.length) result[key] = Math.min(...values);
    }
    return result;
}

function intersectPermissions(parent: FlowStudioPermissionSpec | undefined, child: FlowStudioPermissionSpec | undefined, workspaceRoot?: string): FlowStudioPermissionSpec | undefined {
    if (!parent) return child ? clone(child) : undefined;
    if (!child) return clone(parent);
    const parentPermitted = [...(parent.allow || []), ...(parent.requireApproval || [])];
    const childPermitted = [...(child.allow || []), ...(child.requireApproval || [])];
    const permitted = parentPermitted.length && childPermitted.length ? intersectPatterns(parentPermitted, childPermitted) : [];
    const approvals = permitted.filter(pattern => matchesAny(pattern, parent.requireApproval || []) || matchesAny(pattern, child.requireApproval || []));
    return {
        allow: permitted.filter(pattern => !approvals.includes(pattern)),
        deny: [...new Set([...(parent.deny || []), ...(child.deny || [])])],
        requireApproval: approvals,
        fileRoots: intersectRoots(parent.fileRoots || [], child.fileRoots || [], workspaceRoot),
        networkHosts: intersectHostPatterns(parent.networkHosts || [], child.networkHosts || []),
        commandPatterns: intersectPatterns(parent.commandPatterns || [], child.commandPatterns || [])
    };
}

function intersectHostPatterns(parent: string[], child: string[]): string[] {
    if (!parent.length) return [...child];
    if (!child.length) return [...parent];
    const result = new Set<string>();
    for (const left of parent) for (const right of child) {
        if (hostPatternContains(left, right)) result.add(right);
        else if (hostPatternContains(right, left)) result.add(left);
    }
    return result.size ? [...result] : ['__flow_studio_deny_all__'];
}

function intersectPatterns(parent: string[], child: string[]): string[] {
    if (!parent.length) return [...child];
    if (!child.length) return [...parent];
    const result = new Set<string>();
    for (const left of parent) for (const right of child) {
        if (left === '*' || matchesAny(right, [left])) result.add(right);
        else if (right === '*' || matchesAny(left, [right])) result.add(left);
    }
    // An empty intersection must remain an explicit deny-all constraint. An
    // empty array means "not configured" to the permission evaluator.
    return result.size ? [...result] : ['__flow_studio_deny_all__'];
}

function intersectRoots(parent: string[], child: string[], workspaceRoot?: string): string[] {
    if (!parent.length) return [...child];
    if (!child.length) return [...parent];
    const base = path.resolve(workspaceRoot || process.cwd());
    const canonical = (root: string): string => {
        const resolved = path.resolve(base, root);
        try { return realpathSync(resolved); } catch { return resolved; }
    };
    const result = new Set<string>();
    for (const left of parent.map(canonical)) for (const right of child.map(canonical)) {
        if (isPathInside(right, left)) result.add(right);
        else if (isPathInside(left, right)) result.add(left);
    }
    return result.size ? [...result] : [path.join(base, '.flow-studio-deny-all-root')];
}

function applyReducer(spec: FlowStudioReducerSpec, base: unknown, values: unknown[]): unknown {
    if (spec.kind === 'replace' || spec.kind === 'last') return clone(values[values.length - 1]);
    if (spec.kind === 'first') return clone(values[0]);
    if (spec.kind === 'append') return [...(Array.isArray(base) ? base : []), ...values.flatMap(value => Array.isArray(value) ? value : [value])];
    if (spec.kind === 'sum') return values.reduce<number>((total, value) => total + Number(value || 0), Number(base || 0));
    if (spec.kind === 'min') return Math.min(...values.map(Number));
    if (spec.kind === 'max') return Math.max(...values.map(Number));
    if (spec.kind === 'custom' && spec.expression) return evaluate(spec.expression, { base, values }, {});
    if (values.every(isRecord)) return values.reduce<FlowStudioContext>((acc, value) => deepMerge(acc, value as FlowStudioContext), isRecord(base) ? clone(base) : {});
    return clone(values[values.length - 1]);
}

function enforceJoin(join: FlowStudioJoinConfig, successes: number, total: number, nodeId: string): void {
    const required = requiredJoinResults(join, total);
    if (successes < required) throw new Error(`Join "${nodeId}" recebeu ${successes}/${required} resultados necessários.`);
}

function selectJoinResults<T>(join: FlowStudioJoinConfig, values: T[]): T[] { return join.strategy === 'any' ? values.slice(0, 1) : values; }

function requiredJoinResults(join: FlowStudioJoinConfig, total: number): number {
    return join.strategy === 'any' ? 1 : join.strategy === 'quorum' ? (join.quorum || 1) : join.strategy === 'majority' ? Math.floor(total / 2) + 1 : total;
}

const LINKED_ABORT_CLEANUPS = new WeakMap<AbortController, () => void>();

function linkedAbortController(parent?: AbortSignal): AbortController {
    const controller = new AbortController();
    if (parent?.aborted) controller.abort();
    else if (parent) {
        const onAbort = (): void => controller.abort();
        parent.addEventListener('abort', onAbort, { once: true });
        LINKED_ABORT_CLEANUPS.set(controller, () => parent.removeEventListener('abort', onAbort));
        controller.signal.addEventListener('abort', () => unlinkAbortController(controller), { once: true });
    }
    return controller;
}

function unlinkAbortController(controller: AbortController): void {
    LINKED_ABORT_CLEANUPS.get(controller)?.();
    LINKED_ABORT_CLEANUPS.delete(controller);
}

function readForkResumeState(metadata: Record<string, unknown> | undefined): ForkResumeState | undefined {
    const value = metadata?.forkState;
    if (!value || typeof value !== 'object') return undefined;
    const candidate = value as Partial<ForkResumeState>;
    if (typeof candidate.forkNodeId !== 'string' || !isRecord(candidate.baseContext) || !Array.isArray(candidate.branches)) return undefined;
    return clone(candidate as ForkResumeState);
}

function readLoopResumeState(metadata: Record<string, unknown> | undefined): LoopResumeState | undefined {
    const value = metadata?.loopState;
    if (!value || typeof value !== 'object') return undefined;
    const candidate = value as Partial<LoopResumeState>;
    if (typeof candidate.loopNodeId !== 'string' || !Number.isInteger(candidate.iteration) || !isRecord(candidate.context) || !candidate.checkpoint) return undefined;
    return clone(candidate as LoopResumeState);
}

function readUsageByNode(metadata: Record<string, unknown> | undefined): Array<[string, FlowStudioUsage]> {
    const value = metadata?.usageByNode;
    if (!isRecord(value)) return [];
    return Object.entries(value).filter((entry): entry is [string, FlowStudioUsage] => {
        const usage = entry[1];
        return isRecord(usage)
            && typeof usage.inputTokens === 'number'
            && typeof usage.outputTokens === 'number'
            && typeof usage.costUsd === 'number'
            && typeof usage.durationMs === 'number';
    }).map(([id, usage]) => [id, normalizeUsage(usage)]);
}

function readWallTimeByNode(metadata: Record<string, unknown> | undefined): Array<[string, number]> {
    const value = metadata?.wallTimeByNode;
    if (!isRecord(value)) return [];
    return Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0);
}

function normalizeGate(node: FlowStudioNode): FlowStudioGateConfig { return node.gate || { kind: 'human', prompt: node.gatePrompt }; }

function gateConfigAtPath(root: FlowStudioGateConfig, path: string): FlowStudioGateConfig | undefined {
    const indexes = path.split('.').slice(1).map(value => Number(value));
    let current: FlowStudioGateConfig | undefined = root;
    for (const index of indexes) {
        if (!Number.isInteger(index) || index < 0 || current?.kind !== 'composite') return undefined;
        current = current.children?.[index];
    }
    return current;
}

function graphMemoryWriteTargets(graph: FlowStudioGraph): NonNullable<FlowStudioInteractionEnvelope['memoryWriteTargets']> {
    return graph.nodes.flatMap(node => node.type === 'memory_write' && node.memoryWrite ? [{
        nodeId: node.id,
        label: node.label,
        scope: node.memoryWrite.scope,
        ...(node.memoryWrite.scopeId ? { scopeId: node.memoryWrite.scopeId } : {}),
        ...(node.memoryWrite.storeId ? { storeId: node.memoryWrite.storeId } : {})
    }] : []);
}

function gateInteractionEnvelope(graph: FlowStudioGraph, node: FlowStudioNode, pendingHumanPath?: string): FlowStudioInteractionEnvelope {
    const root = normalizeGate(node);
    const gate = pendingHumanPath ? gateConfigAtPath(root, pendingHumanPath) || root : root;
    return {
        type: 'gate',
        graphId: graph.id,
        nodeId: node.id,
        kind: gate.kind,
        label: gate.prompt || node.gatePrompt || node.label,
        decisions: clone(declaredGateDecisions(node)),
        requireEvidence: gate.requireEvidence === true,
        pendingHumanPath,
        memoryWriteTargets: graphMemoryWriteTargets(graph)
    };
}

function permissionInteractionEnvelope(graph: FlowStudioGraph, node: FlowStudioNode, permission: string, toolId?: string, toolLabel?: string): FlowStudioInteractionEnvelope {
    return {
        type: 'permission',
        graphId: graph.id,
        nodeId: node.id,
        kind: 'human',
        label: toolLabel ? `Autorizar ${permission} para ${toolLabel}?` : `Autorizar ${permission} para ${node.label}?`,
        decisions: clone(defaultGateDecisions(node)),
        requireEvidence: false,
        permission,
        toolId,
        memoryWriteTargets: graphMemoryWriteTargets(graph)
    };
}

function waitInteractionEnvelope(graph: FlowStudioGraph, node: FlowStudioNode, wait: FlowStudioWaitConfig, dueAt?: string): FlowStudioInteractionEnvelope {
    return {
        type: 'wait',
        graphId: graph.id,
        nodeId: node.id,
        kind: wait.kind,
        label: node.label,
        eventName: wait.eventName,
        correlationKey: wait.correlationKey,
        dueAt,
        durationMs: wait.durationMs,
        until: wait.until,
        timeoutMs: wait.timeoutMs,
        onTimeout: wait.onTimeout,
        memoryWriteTargets: graphMemoryWriteTargets(graph)
    };
}

function readInteractionEnvelope(metadata: Record<string, unknown> | undefined): FlowStudioInteractionEnvelope | undefined {
    const value = metadata?.interaction;
    return isRecord(value) && ['gate', 'permission', 'wait'].includes(String(value.type)) && typeof value.graphId === 'string' && typeof value.nodeId === 'string'
        ? clone(value as unknown as FlowStudioInteractionEnvelope)
        : undefined;
}

function defaultGateDecisions(node: FlowStudioNode): FlowStudioToolDecision[] {
    return [
        { id: 'continue', label: 'Continuar', decision: 'continue', toNodeId: node.next },
        { id: 'wait', label: 'Aguardar', decision: 'wait' },
        { id: 'fail', label: 'Falhar', decision: 'fail' }
    ];
}

function declaredGateDecisions(node: FlowStudioNode): FlowStudioToolDecision[] {
    return node.gateDecisions?.length ? node.gateDecisions : defaultGateDecisions(node);
}

function resolveDueAt(wait: FlowStudioWaitConfig): string | undefined {
    if (wait.kind === 'until') return wait.until;
    if (wait.kind === 'duration') return new Date(Date.now() + (wait.durationMs || 0)).toISOString();
    if (wait.kind === 'event' && wait.timeoutMs) return new Date(Date.now() + wait.timeoutMs).toISOString();
    return undefined;
}

function resolveWaitResume(wait: FlowStudioWaitConfig | undefined, metadata: Record<string, unknown> | undefined, signal: Record<string, unknown> | undefined): 'ready' | 'waiting' | 'timeout-fail' {
    if (!wait) return 'waiting';
    if (wait.kind === 'duration' || wait.kind === 'until') {
        const dueAt = typeof metadata?.dueAt === 'string' ? Date.parse(metadata.dueAt) : Number.NaN;
        return Number.isFinite(dueAt) && Date.now() >= dueAt ? 'ready' : 'waiting';
    }
    const dueAt = typeof metadata?.dueAt === 'string' ? Date.parse(metadata.dueAt) : Number.NaN;
    if (Number.isFinite(dueAt) && Date.now() >= dueAt) return wait.onTimeout === 'continue' ? 'ready' : 'timeout-fail';
    const eventName = typeof signal?.eventName === 'string' ? signal.eventName : typeof signal?.name === 'string' ? signal.name : undefined;
    if (eventName === wait.eventName && (!wait.correlationKey || signal?.correlationKey === wait.correlationKey)) return 'ready';
    return 'waiting';
}

function normalizeGateResult(node: FlowStudioNode, value: unknown, requireDecisionId = false): FlowStudioGateResult {
    if (!isRecord(value)) throw new Error(`Resposta de Gate inválida para "${node.id}": era esperado um objeto.`);
    if (value.decisionId !== undefined && (typeof value.decisionId !== 'string' || !value.decisionId.trim())) throw new Error(`Resposta de Gate inválida para "${node.id}": decisionId deve ser uma string não vazia.`);
    if (requireDecisionId && (typeof value.decisionId !== 'string' || !value.decisionId.trim())) throw new Error(`Resposta externa do Gate "${node.id}" exige decisionId declarado.`);
    if (value.action !== undefined && !['continue', 'wait', 'fail'].includes(String(value.action))) throw new Error(`Resposta de Gate inválida para "${node.id}": action deve ser continue, wait ou fail.`);
    if (value.toNodeId !== undefined && typeof value.toNodeId !== 'string') throw new Error(`Resposta de Gate inválida para "${node.id}": toNodeId deve ser string.`);
    if (value.message !== undefined && typeof value.message !== 'string') throw new Error(`Resposta de Gate inválida para "${node.id}": message deve ser string.`);
    if (value.score !== undefined && (typeof value.score !== 'number' || !Number.isFinite(value.score))) throw new Error(`Resposta de Gate inválida para "${node.id}": score deve ser finito.`);
    for (const field of ['blockers', 'warnings'] as const) {
        const items = value[field];
        if (items !== undefined && (!Array.isArray(items) || items.some(item => typeof item !== 'string'))) throw new Error(`Resposta de Gate inválida para "${node.id}": ${field} deve conter somente strings.`);
    }
    if (value.evidence !== undefined && (!Array.isArray(value.evidence) || value.evidence.some(item => !isRecord(item)))) throw new Error(`Resposta de Gate inválida para "${node.id}": evidence deve conter artefatos.`);
    if (value.memoryApprovals !== undefined && (!Array.isArray(value.memoryApprovals) || value.memoryApprovals.some(item => !isMemoryApprovalReceipt(item)))) {
        throw new Error(`Resposta de Gate inválida para "${node.id}": memoryApprovals contém receipt inválido.`);
    }
    const result = value as unknown as FlowStudioGateResult;
    const decisions = declaredGateDecisions(node);
    const decision = result.decisionId ? decisions.find(item => item.id === result.decisionId) : undefined;
    if (result.decisionId && !decision) throw new Error(`Decisão "${result.decisionId}" não existe no gate "${node.id}".`);
    if (decision && result.toNodeId !== undefined && result.toNodeId !== decision.toNodeId) {
        throw new Error(`Destino "${result.toNodeId}" não pertence à decisão "${decision.id}" do gate "${node.id}".`);
    }
    const allowedTargets = new Set([node.next, ...decisions.map(item => item.toNodeId)].filter((item): item is string => Boolean(item)));
    const target = decision ? decision.toNodeId : result.toNodeId;
    if (target && !allowedTargets.has(target)) throw new Error(`Destino "${target}" não foi declarado pelo gate "${node.id}".`);
    return {
        ...result,
        action: decision?.decision || result.action || 'wait',
        toNodeId: target
    };
}

function enforceGateEvidence(node: FlowStudioNode, result: FlowStudioGateResult): FlowStudioGateResult {
    if (normalizeGate(node).requireEvidence && result.action === 'continue' && !result.evidence?.length) {
        return { ...result, action: 'fail', message: `Gate "${node.label}" exige evidência para aprovação.` };
    }
    return result;
}

function enforceGateConfigEvidence(node: FlowStudioNode, gate: FlowStudioGateConfig | undefined, result: FlowStudioGateResult): FlowStudioGateResult {
    if (gate?.requireEvidence && result.action === 'continue' && !result.evidence?.length) {
        return { ...result, action: 'fail', message: `Critério humano do Gate "${node.label}" exige evidência para aprovação.` };
    }
    return result;
}

function gateEvidenceArtifact(node: FlowStudioNode, name: string, payload: unknown): FlowStudioArtifact {
    return {
        id: `evidence-${node.id}-${randomHex()}`,
        nodeId: node.id,
        kind: 'evidence',
        name,
        payload: clone(payload),
        createdAt: new Date().toISOString()
    };
}

function createArtifact(nodeId: string, kind: FlowStudioArtifact['kind'], name: string, payload: unknown): FlowStudioArtifact {
    return { id: randomHex(), nodeId, kind, name, payload: clone(payload), createdAt: new Date().toISOString(), digest: digest(payload) };
}

function evaluateCollection(source: string, context: FlowStudioContext): unknown[] {
    let value: unknown;
    if (isSafeStatePath(source) && hasPath(context, source)) value = getPath(context, source);
    else value = evaluate(source, context, {});
    if (!Array.isArray(value)) throw new Error(`A fonte "${source}" precisa resultar em uma lista.`);
    return clone(value);
}

function contextDelta(base: FlowStudioContext, value: FlowStudioContext): FlowStudioContext {
    const result: FlowStudioContext = {};
    for (const [key, candidate] of Object.entries(value)) {
        if (JSON.stringify(candidate) !== JSON.stringify(base[key])) result[key] = clone(candidate);
    }
    return result;
}

function isMemoryCandidate(value: unknown): value is FlowStudioMemoryCandidate {
    if (!isRecord(value)) return false;
    return typeof value.id === 'string' && value.id.trim().length > 0
        && ['candidate', 'approved', 'rejected', 'written', 'failed'].includes(String(value.status))
        && ((typeof value.revision === 'string' && value.revision.trim().length > 0) || (typeof value.revision === 'number' && Number.isFinite(value.revision)))
        && (value.scope === undefined || ['ide', 'workspace', 'project', 'workflow', 'run', 'agent'].includes(String(value.scope)))
        && (value.kind === undefined || ['fact', 'decision', 'preference', 'instruction', 'summary'].includes(String(value.kind)))
        && Object.prototype.hasOwnProperty.call(value, 'value');
}

function hasContextPackContent(pack: FlowStudioContextPack): boolean {
    if (pack.memories?.length || pack.files?.length || pack.symbols?.length) return true;
    if (pack.signals && Object.values(pack.signals).some(value => value !== undefined && value !== null)) return true;
    return Boolean(pack.sections?.some(section => {
        if (section.title.toLocaleLowerCase().includes('diagn')) return false;
        const content = section.content;
        if (Array.isArray(content)) return content.length > 0;
        if (isRecord(content)) return Object.keys(content).length > 0;
        return content !== undefined && content !== null && content !== '';
    }));
}

function anonymizeTournamentValue(value: unknown, configuredFields?: string[]): unknown {
    const fields = (configuredFields?.length ? configuredFields : ['id', 'name', 'identity', 'author', 'provider', 'model', 'source'])
        .map(field => field.trim().toLocaleLowerCase()).filter(Boolean);
    const exactPaths = new Set(fields.filter(field => field.includes('.')));
    const keys = new Set(fields.filter(field => !field.includes('.')));
    const visit = (current: unknown, parts: string[]): unknown => {
        if (Array.isArray(current)) return current.map((item, index) => visit(item, [...parts, String(index)]));
        if (!isRecord(current)) return clone(current);
        return Object.fromEntries(Object.entries(current).flatMap(([key, child]) => {
            const nextParts = [...parts, key.toLocaleLowerCase()];
            const withoutIndexes = nextParts.filter(part => !/^\d+$/.test(part)).join('.');
            if (keys.has(key.toLocaleLowerCase()) || exactPaths.has(withoutIndexes)) return [];
            return [[key, visit(child, nextParts)]];
        }));
    };
    return visit(value, []);
}

function parseTournamentJudgment(output: FlowStudioContext, candidates: TournamentCandidate[], requestedWinners: number): TournamentJudgment {
    const nested = isRecord(output.result) ? output.result : output;
    const allowed = new Set(candidates.map(candidate => candidate.id));
    const rawWinnerIds = Array.isArray(nested.winnerIds)
        ? nested.winnerIds
        : Array.isArray(nested.winners)
            ? nested.winners
            : typeof nested.winnerId === 'string'
                ? [nested.winnerId]
                : [];
    const winnerIds = rawWinnerIds.map(value => String(value));
    if (!winnerIds.length && Array.isArray(nested.winnerIndexes)) {
        for (const raw of nested.winnerIndexes) {
            const candidate = candidates[Number(raw)];
            if (candidate) winnerIds.push(candidate.id);
        }
    }
    if (!winnerIds.length && Number.isInteger(nested.winnerIndex)) {
        const candidate = candidates[Number(nested.winnerIndex)];
        if (candidate) winnerIds.push(candidate.id);
    }
    if (winnerIds.length < requestedWinners) throw new Error(`O juiz retornou ${winnerIds.length} vencedor(es), mas eram necessários ${requestedWinners}.`);
    if (new Set(winnerIds).size !== winnerIds.length || winnerIds.some(id => !allowed.has(id))) throw new Error('O juiz retornou winnerIds duplicados ou desconhecidos.');
    const rawScores = isRecord(nested.scores) ? nested.scores : {};
    const scores: Record<string, number> = {};
    for (const [id, raw] of Object.entries(rawScores)) {
        const score = typeof raw === 'number' ? raw : Number.NaN;
        if (!allowed.has(id) || !Number.isFinite(score)) throw new Error(`Score inválido do juiz para "${id}".`);
        scores[id] = score;
    }
    return { winnerIds: winnerIds.slice(0, requestedWinners), scores, reason: typeof nested.reason === 'string' ? nested.reason : undefined, evidence: nested.evidence };
}

function permissionForEffect(effect: FlowStudioEffectKind): string {
    if (effect === 'none' || effect === 'read') return 'tool:read';
    return `tool:${effect}`;
}

function permissionDecision(graph: FlowStudioPermissionSpec | undefined, node: FlowStudioPermissionSpec | undefined, permission: string): 'allow' | 'deny' | 'approval' {
    const denied = [...(graph?.deny || []), ...(node?.deny || [])];
    if (matchesAny(permission, denied)) return 'deny';
    const approval = [...(graph?.requireApproval || []), ...(node?.requireApproval || [])];
    const graphPermitted = [...(graph?.allow || []), ...(graph?.requireApproval || [])];
    const nodePermitted = [...(node?.allow || []), ...(node?.requireApproval || [])];
    if (!graphPermitted.length && !nodePermitted.length) return 'deny';
    if (graphPermitted.length && !matchesAny(permission, graphPermitted)) return 'deny';
    if (nodePermitted.length && !matchesAny(permission, nodePermitted)) return 'deny';
    if (matchesAny(permission, approval)) return 'approval';
    return 'allow';
}

function hasPermissionDeclaration(graph: FlowStudioPermissionSpec | undefined, node: FlowStudioPermissionSpec | undefined, permissions: string[]): boolean {
    const declared = [...(graph?.allow || []), ...(graph?.deny || []), ...(graph?.requireApproval || []), ...(node?.allow || []), ...(node?.deny || []), ...(node?.requireApproval || [])];
    return permissions.every(permission => matchesAny(permission, declared));
}

function matchesAny(value: string, patterns: string[]): boolean {
    return patterns.some(pattern => pattern === '*' || pattern === value || (pattern.endsWith('*') && value.startsWith(pattern.slice(0, -1))));
}

function hostMatchesPattern(host: string, pattern: string): boolean {
    const normalizedHost = host.toLocaleLowerCase();
    const normalizedPattern = pattern.toLocaleLowerCase();
    return normalizedPattern === '*'
        || normalizedPattern === normalizedHost
        || (normalizedPattern.startsWith('*.') && normalizedHost.endsWith(normalizedPattern.slice(1)));
}

function hostPatternContains(container: string, candidate: string): boolean {
    const normalizedContainer = container.toLocaleLowerCase();
    const normalizedCandidate = candidate.toLocaleLowerCase();
    if (normalizedContainer === '*') return true;
    if (normalizedCandidate === '*') return normalizedContainer === '*';
    if (!normalizedContainer.startsWith('*.')) return normalizedContainer === normalizedCandidate;
    if (normalizedCandidate.startsWith('*.')) return normalizedCandidate.slice(1).endsWith(normalizedContainer.slice(1));
    return hostMatchesPattern(normalizedCandidate, normalizedContainer);
}

function networkHostAllowed(endpoint: URL, patterns: string[]): boolean {
    return patterns.some(pattern => hostMatchesPattern(endpoint.host, pattern) || hostMatchesPattern(endpoint.hostname, pattern));
}

function permissionApprovalKey(receipt: PermissionApprovalReceipt): string {
    return digest({ permission: receipt.permission, nodeId: receipt.nodeId, toolId: receipt.toolId || '', inputDigest: receipt.inputDigest });
}

function readPermissionApprovalReceipts(metadata: Record<string, unknown> | undefined): PermissionApprovalReceipt[] {
    const value = metadata?.permissionApprovals;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is PermissionApprovalReceipt => isRecord(item)
        && typeof item.permission === 'string'
        && typeof item.nodeId === 'string'
        && typeof item.inputDigest === 'string'
        && (item.toolId === undefined || typeof item.toolId === 'string'));
}

function readPermissionApprovalRequest(metadata: Record<string, unknown> | undefined): PermissionApprovalReceipt | undefined {
    const value = metadata?.approvalRequest;
    if (!isRecord(value) || typeof value.permission !== 'string' || typeof value.nodeId !== 'string' || typeof value.inputDigest !== 'string') return undefined;
    if (value.toolId !== undefined && typeof value.toolId !== 'string') return undefined;
    return value as unknown as PermissionApprovalReceipt;
}

function memoryApprovalKey(approval: Pick<FlowStudioMemoryApproval, 'id' | 'revision' | 'scope' | 'scopeId' | 'storeId' | 'graphId' | 'nodeId' | 'candidateDigest'>): string {
    return digest({
        id: approval.id,
        revision: String(approval.revision),
        scope: approval.scope,
        scopeId: approval.scopeId || '',
        storeId: approval.storeId || '',
        graphId: approval.graphId,
        nodeId: approval.nodeId,
        candidateDigest: approval.candidateDigest
    });
}

function readMemoryApprovalReceipts(metadata: Record<string, unknown> | undefined): NonNullable<FlowStudioRunRequest['memoryApprovals']> {
    const value = metadata?.memoryApprovals;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is NonNullable<FlowStudioRunRequest['memoryApprovals']>[number] => isMemoryApprovalReceipt(item));
}

function isMemoryApprovalReceipt(item: unknown): item is NonNullable<FlowStudioRunRequest['memoryApprovals']>[number] {
    return isRecord(item)
        && typeof item.id === 'string'
        && (typeof item.revision === 'string' || typeof item.revision === 'number')
        && ['ide', 'workspace', 'project', 'workflow', 'run', 'agent'].includes(String(item.scope))
        && (item.scopeId === undefined || typeof item.scopeId === 'string')
        && (item.storeId === undefined || typeof item.storeId === 'string')
        && typeof item.graphId === 'string'
        && typeof item.nodeId === 'string'
        && typeof item.candidateDigest === 'string';
}

function readGlobalStepCount(metadata: Record<string, unknown> | undefined): number | undefined {
    const value = metadata?.globalStepCount;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readRunnerSessions(metadata: Record<string, unknown> | undefined): Record<string, Record<string, string>> {
    const value = metadata?.runnerSessions;
    if (!isRecord(value)) return {};
    const result: Record<string, Record<string, string>> = {};
    for (const [nodeId, sessions] of Object.entries(value)) {
        if (!isRecord(sessions) || isPoisonKey(nodeId)) continue;
        result[nodeId] = Object.fromEntries(Object.entries(sessions).filter((entry): entry is [string, string] => !isPoisonKey(entry[0]) && typeof entry[1] === 'string'));
    }
    return result;
}

async function enforceToolScope(graph: FlowStudioPermissionSpec | undefined, node: FlowStudioPermissionSpec | undefined, tool: FlowStudioToolBinding, workspaceRoot?: string): Promise<void> {
    const commandLine = [tool.command, ...(tool.args || [])].join(' ');
    if (!matchesEveryConfiguredLayer([commandLine, tool.command], graph?.commandPatterns, node?.commandPatterns)) {
        throw new Error(`Comando fora da allowlist: ${tool.command}`);
    }
    const base = path.resolve(workspaceRoot || process.cwd());
    const toolCwd = tool.cwd ? path.resolve(base, tool.cwd) : base;
    const canonicalCwd = await fs.realpath(toolCwd);
    const graphRoots = await Promise.all((graph?.fileRoots || []).map(root => fs.realpath(path.resolve(base, root))));
    const nodeRoots = await Promise.all((node?.fileRoots || []).map(root => fs.realpath(path.resolve(base, root))));
    const rootsConfigured = graphRoots.length > 0 || nodeRoots.length > 0;
    const insideGraph = !graphRoots.length || graphRoots.some(root => isPathInside(canonicalCwd, root));
    const insideNode = !nodeRoots.length || nodeRoots.some(root => isPathInside(canonicalCwd, root));
    if (rootsConfigured && (!insideGraph || !insideNode)) {
        throw new Error(`cwd fora das raízes permitidas: ${tool.cwd}`);
    }
    if (rootsConfigured) {
        for (const raw of tool.args || []) {
            if (/^[a-z]+:\/\//i.test(raw)) continue;
            const explicitTraversal = /^(\.\.[\\/])/.test(raw);
            const absolute = path.isAbsolute(raw);
            let canonicalArgument: string | undefined;
            if (absolute || explicitTraversal) canonicalArgument = await canonicalizePotentialPath(path.resolve(canonicalCwd, raw));
            else if (/[\\/]/.test(raw)) {
                try { canonicalArgument = await fs.realpath(path.resolve(canonicalCwd, raw)); } catch { /* not an existing path-shaped argument */ }
            }
            if (!canonicalArgument) continue;
            const argumentInsideGraph = !graphRoots.length || graphRoots.some(root => isPathInside(canonicalArgument as string, root));
            const argumentInsideNode = !nodeRoots.length || nodeRoots.some(root => isPathInside(canonicalArgument as string, root));
            if (!argumentInsideGraph || !argumentInsideNode) throw new Error(`Argumento de path fora das raízes permitidas: ${raw}`);
        }
    }
    if (tool.effect === 'network') {
        const urls = (tool.args || []).filter(arg => /^https?:\/\//i.test(arg));
        const hostsConfigured = Boolean(graph?.networkHosts?.length || node?.networkHosts?.length);
        if (!urls.length || !hostsConfigured) throw new Error(`Ferramenta de rede "${tool.id}" exige URL e networkHosts explícitos.`);
        for (const raw of urls) {
            const host = new URL(raw).hostname;
            if (!matchesEveryHostLayer(host, graph?.networkHosts, node?.networkHosts)) throw new Error(`Host de rede não permitido: ${host}`);
        }
    }
}

async function canonicalizePotentialPath(candidate: string): Promise<string> {
    let cursor = path.resolve(candidate);
    const missing: string[] = [];
    while (true) {
        try {
            const existing = await fs.realpath(cursor);
            return path.join(existing, ...missing.reverse());
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const parent = path.dirname(cursor);
            if (parent === cursor) return path.resolve(candidate);
            missing.push(path.basename(cursor));
            cursor = parent;
        }
    }
}

function matchesEveryConfiguredLayer(values: string[], ...layers: Array<string[] | undefined>): boolean {
    return layers.every(patterns => !patterns?.length || values.some(value => matchesAny(value, patterns)));
}

function matchesEveryHostLayer(host: string, ...layers: Array<string[] | undefined>): boolean {
    return layers.every(patterns => !patterns?.length || patterns.some(pattern => hostMatchesPattern(host, pattern)));
}

function isPathInside(candidate: string, root: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateEmbeddedNode(
    node: FlowStudioNode,
    nodePath: string,
    role: 'worker' | 'judge',
    error: IssueWriter,
    graph: FlowStudioGraph,
    profileById: Record<string, FlowStudioModelProfile>,
    runnerById: Map<string, FlowStudioRunnerDefinition>
): void {
    const allowed: FlowStudioNodeType[] = role === 'judge'
        ? ['agent', 'report', 'transform']
        : ['agent', 'report', 'action', 'command', 'context', 'memory_write', 'playbook', 'subgraph', 'transform'];
    if (!node.id?.trim() || !node.label?.trim()) error(`${role}.identity`, `O ${role} embutido precisa de id e label.`, nodePath);
    if (!allowed.includes(node.type)) error(`${role}.type`, `O ${role} embutido não aceita o tipo "${node.type}".`, `${nodePath}/type`);
    if (node.next) error(`${role}.next`, `O ${role} embutido não pode declarar next.`, `${nodePath}/next`);
    if ((node.type === 'agent' || node.type === 'report') && !node.prompt?.trim()) error(`${role}.prompt`, `O ${role} de IA precisa de prompt.`, `${nodePath}/prompt`);
    if (role === 'judge' && node.tools?.length) error('judge.tools', 'O juiz embutido não pode executar ferramentas; julgue somente o pacote anônimo recebido.', `${nodePath}/tools`);
    if (node.type === 'action' && !node.tools?.length) error(`${role}.tools`, `O ${role} Action precisa de ferramentas.`, `${nodePath}/tools`);
    if (node.condition?.trim()) validateExpression(node.condition, `${nodePath}/condition`, error);
    const binding = node.runner || node.provider;
    if (binding) validateRunnerBindingTree(binding, nodePath, profileById, runnerById, error);
    for (const tool of node.tools || []) {
        if (!tool.id?.trim() || !tool.command?.trim()) error(`${role}.tool.invalid`, `Ferramenta inválida no ${role} embutido.`, `${nodePath}/tools`);
        if (!['none', 'read'].includes(tool.effect || 'command') && !tool.idempotencyKey) error(`${role}.tool.idempotency`, `A ferramenta mutável "${tool.id}" exige idempotencyKey.`, `${nodePath}/tools`);
    }
    if (node.type === 'command') {
        const config = node.command;
        if (!config?.command?.trim()) error(`${role}.command`, `O ${role} Command precisa de executável.`, `${nodePath}/command`);
        if (!['none', 'read'].includes(config?.effect || 'command') && !config?.idempotencyKey) error(`${role}.command.idempotency`, `O ${role} Command mutável exige idempotencyKey.`, `${nodePath}/command/idempotencyKey`);
        if (!['none', 'read'].includes(config?.effect || 'command') && (config?.retries || 0) > 0) error(`${role}.command.retry`, `O ${role} Command mutável não pode repetir automaticamente.`, `${nodePath}/command/retries`);
    }
    if (node.type === 'context') {
        const config = node.context;
        if (!config || (!config.query?.trim() && !config.statePaths?.length && !config.filePaths?.length && !config.tags?.length)) error(`${role}.context.sources`, `O ${role} Context precisa de fontes.`, `${nodePath}/context`);
        for (const statePath of config?.statePaths || []) if (!isSafeStatePath(statePath)) error(`${role}.context.path`, `Path proibido no ${role} Context.`, `${nodePath}/context/statePaths`);
        if (config?.scopes?.includes('agent') && !config.scopeId?.trim()) error(`${role}.context.scope`, `O escopo agent exige scopeId.`, `${nodePath}/context/scopeId`);
    }
    if (node.type === 'memory_write') {
        const config = node.memoryWrite;
        if (!config?.candidatesFrom?.trim()) error(`${role}.memory`, `O ${role} Memory Write precisa de candidatesFrom.`, `${nodePath}/memoryWrite`);
        if (config?.candidatesFrom && !isSafeStatePath(config.candidatesFrom)) error(`${role}.memory.path`, `candidatesFrom proibido no ${role}.`, `${nodePath}/memoryWrite/candidatesFrom`);
        if (config?.scope === 'agent' && !config.scopeId?.trim()) error(`${role}.memory.scope`, `O escopo agent exige scopeId.`, `${nodePath}/memoryWrite/scopeId`);
    }
    if (node.type === 'playbook') {
        const config = node.playbook;
        if (!config?.playbookId?.trim()) error(`${role}.playbook`, `O ${role} Playbook precisa de playbookId.`, `${nodePath}/playbook`);
        if (!config?.inline && !config?.graphId && !config?.graphRef && !config?.idempotencyKey) error(`${role}.playbook.idempotency`, `O ${role} Playbook externo exige idempotencyKey.`, `${nodePath}/playbook/idempotencyKey`);
        for (const [source, target] of Object.entries(config?.input || {})) if (!isSafeStatePath(source) || !isSafeStatePath(target)) error(`${role}.playbook.input`, 'Mapeamento de entrada proibido.', `${nodePath}/playbook/input`);
        for (const [source, target] of Object.entries(config?.output || {})) if (!isSafeStatePath(source) || !isSafeStatePath(target)) error(`${role}.playbook.output`, 'Mapeamento de saída proibido.', `${nodePath}/playbook/output`);
    }
    if (node.type === 'subgraph' && !node.subgraph?.inline && !node.subgraph?.graphId && !node.subgraph?.graphRef) error(`${role}.subgraph`, `O ${role} Subgraph precisa de referência.`, `${nodePath}/subgraph`);
    for (const [source, target] of Object.entries(node.outputs || {})) if (!isSafeStatePath(source) || !isSafeStatePath(target)) error(`${role}.output`, 'Mapeamento de saída proibido.', `${nodePath}/outputs`);
    for (const target of configuredOutputPaths(node)) {
        if (!isSafeStatePath(target)) error(`${role}.output`, `Destino proibido "${target}".`, nodePath);
        if (graph.state?.strictWrites && !graph.state.namespaces?.[target.split('.')[0]]) error(`${role}.namespace`, `Namespace não declarado para "${target}".`, nodePath);
    }
}

function validateRunnerBindingTree(
    binding: FlowStudioRunnerBinding,
    nodePath: string,
    profileById: Record<string, FlowStudioModelProfile>,
    runnerById: Map<string, FlowStudioRunnerDefinition>,
    error: IssueWriter
): void {
    let flattened: FlowStudioRunnerBinding[];
    try { flattened = flattenRunnerBindings(binding); } catch (caught) {
        error('runner.fallback.invalid', caught instanceof Error ? caught.message : 'Fallback inválido.', `${nodePath}/runner/fallbacks`);
        return;
    }
    for (const [index, candidate] of flattened.entries()) {
        const pathValue = index ? `${nodePath}/runner/fallbacks/${index - 1}` : `${nodePath}/runner`;
        const profile = resolveModel(candidate, profileById);
        if (candidate.profileId && !profileById[candidate.profileId]) error('runner.profile.unknown', `Perfil "${candidate.profileId}" não existe.`, `${pathValue}/profileId`);
        if (candidate.modelId && !profile) error('runner.model.unknown', `Modelo "${candidate.modelId}" não existe no catálogo.`, `${pathValue}/modelId`);
        if (candidate.runnerId && !runnerById.has(candidate.runnerId)) error('runner.unknown', `Runner "${candidate.runnerId}" não existe no catálogo.`, `${pathValue}/runnerId`);
        const capabilities = new Set<FlowStudioRunnerCapability>([...(profile?.capabilities || []), ...(candidate.runnerId ? runnerById.get(candidate.runnerId)?.capabilities || [] : [])]);
        for (const capability of candidate.requiredCapabilities || []) if (!capabilities.has(capability)) error('runner.capability', `Capability "${capability}" indisponível.`, `${pathValue}/requiredCapabilities`);
    }
}

function validateExpression(expression: string, expressionPath: string, error: IssueWriter): void {
    try {
        assertSafeExpressionSource(expression);
        new vm.Script(`(${expression})`, { filename: 'flow-studio-validation' });
    } catch (caught) {
        error('expression.syntax', caught instanceof Error ? caught.message : 'Expressão inválida.', expressionPath);
    }
}

function validateJsonValue(value: unknown, schema: Record<string, unknown>, valuePath: string): string[] {
    const errors: string[] = [];
    const expected = schema.type;
    const actualType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value;
    const accepted = Array.isArray(expected) ? expected : expected === undefined ? [] : [expected];
    if (accepted.length && !accepted.includes(actualType) && !(actualType === 'integer' && accepted.includes('number'))) {
        return [`${valuePath} deveria ser ${accepted.join('|')}, recebeu ${actualType}`];
    }
    if (Array.isArray(schema.enum) && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) errors.push(`${valuePath} não pertence ao enum permitido`);
    if (isRecord(value)) {
        const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [];
        for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${valuePath}.${key} é obrigatório`);
        const properties = isRecord(schema.properties) ? schema.properties : {};
        for (const [key, childSchema] of Object.entries(properties)) {
            if (Object.prototype.hasOwnProperty.call(value, key) && isRecord(childSchema)) errors.push(...validateJsonValue(value[key], childSchema, `${valuePath}.${key}`));
        }
        if (schema.additionalProperties === false) {
            for (const key of Object.keys(value)) if (!Object.prototype.hasOwnProperty.call(properties, key)) errors.push(`${valuePath}.${key} não é permitido`);
        }
    }
    if (Array.isArray(value) && isRecord(schema.items)) {
        value.forEach((item, index) => errors.push(...validateJsonValue(item, schema.items as Record<string, unknown>, `${valuePath}[${index}]`)));
    }
    if (typeof value === 'string') {
        if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${valuePath} possui menos de ${schema.minLength} caracteres`);
        if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${valuePath} possui mais de ${schema.maxLength} caracteres`);
        if (typeof schema.pattern === 'string') {
            try { if (!new RegExp(schema.pattern).test(value)) errors.push(`${valuePath} não corresponde ao padrão exigido`); } catch { errors.push(`${valuePath} possui pattern inválido no schema`); }
        }
    }
    if (typeof value === 'number') {
        if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${valuePath} é menor que ${schema.minimum}`);
        if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${valuePath} é maior que ${schema.maximum}`);
    }
    return errors;
}

function normalizeUsage(input?: Partial<FlowStudioUsage>): FlowStudioUsage {
    return { inputTokens: input?.inputTokens || 0, outputTokens: input?.outputTokens || 0, costUsd: input?.costUsd || 0, durationMs: input?.durationMs || 0 };
}

function subtractUsage(total: FlowStudioUsage, previous?: Partial<FlowStudioUsage>): FlowStudioUsage {
    return {
        inputTokens: Math.max(0, total.inputTokens - (previous?.inputTokens || 0)),
        outputTokens: Math.max(0, total.outputTokens - (previous?.outputTokens || 0)),
        costUsd: Math.max(0, total.costUsd - (previous?.costUsd || 0)),
        durationMs: Math.max(0, total.durationMs - (previous?.durationMs || 0))
    };
}

function estimateCost(usage: FlowStudioUsage, model: FlowStudioModelProfile): number {
    return (usage.inputTokens / 1_000_000) * (model.costPerMTokPrompt || 0) + (usage.outputTokens / 1_000_000) * (model.costPerMTokOutput || 0);
}

function addUsage(target: FlowStudioUsage, input: Partial<FlowStudioUsage>): void {
    target.inputTokens += input.inputTokens || 0;
    target.outputTokens += input.outputTokens || 0;
    target.costUsd += input.costUsd || 0;
    target.durationMs += input.durationMs || 0;
}

function mergeEffectsInPlace(target: FlowStudioEffectRecord[], source: FlowStudioEffectRecord[]): void {
    const ids = new Set(target.map(effect => effect.id));
    for (const effect of source) if (!ids.has(effect.id)) target.push(effect);
}

async function withRetry<T>(task: () => Promise<T>, retries: number, delayMs: number, onRetry: (attempt: number) => void, signal?: AbortSignal, remainingMs?: () => number): Promise<T> {
    let attempt = 0;
    while (true) {
        try { return await task(); } catch (caught) {
            if (isAbortError(caught) || signal?.aborted) throw caught;
            if (attempt >= retries) throw caught;
            attempt += 1;
            onRetry(attempt);
            if (delayMs > 0) await abortableDelay(delayMs, remainingMs?.(), signal);
        }
    }
}

async function abortableDelay(delayMs: number, remainingMs?: number, signal?: AbortSignal): Promise<void> {
    const timeoutMs = remainingMs === undefined ? delayMs : Math.min(delayMs, remainingMs);
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            if (timeoutMs < delayMs) reject(new Error('Execução excedeu o limite de duração.'));
            else resolve();
        }, timeoutMs);
        const onAbort = (): void => {
            cleanup();
            reject(abortError());
        };
        const cleanup = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, signal?: AbortSignal): Promise<T> {
    if (!timeoutMs && !signal) return promise;
    return new Promise<T>((resolve, reject) => {
        const timer = timeoutMs ? setTimeout(() => reject(new Error(`Timeout após ${timeoutMs}ms.`)), timeoutMs) : undefined;
        const onAbort = (): void => reject(abortError());
        signal?.addEventListener('abort', onAbort, { once: true });
        const cleanup = (): void => {
            if (timer) clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        };
        promise.then(value => {
            cleanup();
            resolve(value);
        }, error => {
            cleanup();
            reject(error);
        });
    });
}

async function withAbortableTimeout<T>(factory: (signal: AbortSignal) => Promise<T>, timeoutMs: number | undefined, parentSignal?: AbortSignal): Promise<T> {
    const controller = linkedAbortController(parentSignal);
    let timeoutFired = false;
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        let abortReason: Error | undefined;
        let abortGraceTimer: ReturnType<typeof setTimeout> | undefined;
        const timer = timeoutMs ? setTimeout(() => {
            timeoutFired = true;
            controller.abort();
        }, timeoutMs) : undefined;
        const cleanup = (): void => {
            if (timer) clearTimeout(timer);
            if (abortGraceTimer) clearTimeout(abortGraceTimer);
            controller.signal.removeEventListener('abort', onAbort);
            unlinkAbortController(controller);
        };
        const finish = (callback: () => void): void => {
            if (settled) return;
            settled = true;
            cleanup();
            callback();
        };
        const onAbort = (): void => {
            abortReason = timeoutFired ? new Error(`Timeout após ${timeoutMs}ms.`) : abortError();
            // Give a well-behaved adapter time to observe AbortSignal and settle so
            // no sibling callback can mutate receipts after the run is terminal.
            abortGraceTimer = setTimeout(() => finish(() => reject(abortReason as Error)), Math.min(100, timeoutMs || 100));
        };
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) {
            abortReason = timeoutFired ? new Error(`Timeout após ${timeoutMs}ms.`) : abortError();
            finish(() => reject(abortReason as Error));
            return;
        }
        let task: Promise<T>;
        try {
            task = factory(controller.signal);
        } catch (error) {
            finish(() => reject(error));
            return;
        }
        task.then(value => finish(() => abortReason ? reject(abortReason) : resolve(value)), error => finish(() => reject(abortReason || error)));
    });
}

function deepMerge(...items: FlowStudioContext[]): FlowStudioContext {
    const result: FlowStudioContext = {};
    for (const item of items) {
        for (const [key, value] of Object.entries(item || {})) {
            if (isPoisonKey(key)) continue;
            result[key] = isRecord(value) && isRecord(result[key]) ? deepMerge(result[key] as FlowStudioContext, value as FlowStudioContext) : clone(value);
        }
    }
    return result;
}

function clone<T>(value: T): T {
    if (value === undefined || value === null) return value;
    return JSON.parse(JSON.stringify(value)) as T;
}

function serializedSize(value: unknown): number {
    try {
        const serialized = JSON.stringify(value);
        return Buffer.byteLength(serialized === undefined ? 'null' : serialized, 'utf8');
    } catch (caught) {
        throw new Error(`Valor não serializável no runtime: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
}

function assertSerializedLimit(value: unknown, limit: number, label: string): void {
    const bytes = serializedSize(value);
    if (bytes > limit) throw new Error(`${label} excedeu ${limit} bytes (${bytes}).`);
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

function pathParts(pathValue: string): string[] {
    const parts = pathValue.split('.').map(item => item.trim()).filter(Boolean);
    if (parts.some(isPoisonKey)) throw new Error(`Caminho de estado proibido: ${pathValue}`);
    return parts;
}

function isPoisonKey(value: string): boolean { return value === '__proto__' || value === 'prototype' || value === 'constructor'; }

function isSafeStatePath(pathValue: string): boolean {
    const parts = pathValue.split('.').map(item => item.trim()).filter(Boolean);
    return parts.length > 0 && parts[0].toLocaleLowerCase() !== '_flowstudio' && !parts.some(isPoisonKey);
}

function hasReservedRoot(value: Record<string, unknown>): boolean {
    return Object.keys(value).some(key => key.toLocaleLowerCase() === '_flowstudio');
}

function assertNoReservedRoot(value: unknown, source: string): void {
    if (isRecord(value) && hasReservedRoot(value)) throw new Error(`${source} tentou sobrescrever o namespace interno _flowStudio.`);
}

function getPath(source: unknown, pathValue: string): unknown {
    let cursor: unknown = source;
    for (const part of pathParts(pathValue)) {
        if (!isRecord(cursor) || !Object.prototype.hasOwnProperty.call(cursor, part)) return undefined;
        cursor = cursor[part];
    }
    return cursor;
}

function hasPath(source: unknown, pathValue: string): boolean { return getPath(source, pathValue) !== undefined; }

function setPath(target: FlowStudioContext, pathValue: string, value: unknown): void {
    const parts = pathParts(pathValue);
    if (!parts.length) return;
    let cursor = target;
    for (const part of parts.slice(0, -1)) {
        if (!isRecord(cursor[part])) cursor[part] = {};
        cursor = cursor[part] as FlowStudioContext;
    }
    cursor[parts[parts.length - 1]] = clone(value);
}

function withoutInternalPlaybookState(context: FlowStudioContext): FlowStudioContext {
    const next = clone(context);
    if (!isRecord(next._flowStudio)) return next;
    delete (next._flowStudio as FlowStudioContext).playbook;
    delete (next._flowStudio as FlowStudioContext).playbookResult;
    if (!Object.keys(next._flowStudio as FlowStudioContext).length) delete next._flowStudio;
    return next;
}

function safeSerialize(value: unknown): string { try { return typeof value === 'string' ? value : JSON.stringify(value); } catch { return String(value); } }

function digest(value: unknown): string { return createHash('sha256').update(safeSerialize(value)).digest('hex'); }

function randomHex(): string { return randomBytes(16).toString('hex'); }

function normalizeProviderModelRef(providerId: string | undefined, modelId: string | undefined): string {
    const provider = providerId?.trim() || '';
    const model = modelId?.trim() || '';
    if (!model) return provider;
    if (!provider || model.startsWith(`${provider}/`)) return model;
    return `${provider}/${model}`;
}

function abortError(): Error { const error = new Error('Execução cancelada.'); error.name = 'AbortError'; return error; }

function isAbortError(error: unknown): boolean { return error instanceof Error && error.name === 'AbortError'; }

const defaultProviderAdapter: FlowStudioProviderAdapter = async args => {
    const providerRef = normalizeProviderModelRef(args.runner.providerId, args.model?.modelId || args.runner.modelId);
    const text = args.prompt.slice(0, 500);
    return {
        summary: `Runner ${providerRef || 'default'} simulou o nó ${args.node.id}; configure um adapter para execução real.`,
        output: {
            result: text,
            [args.node.id]: text,
            provider: args.runner.providerId,
            model: providerRef,
            reasoningEffort: args.runner.reasoningEffort || args.model?.reasonDefault || 'medium'
        },
        usage: { inputTokens: Math.ceil(args.prompt.length / 4), outputTokens: Math.ceil(text.length / 4) }
    };
};

const defaultToolAdapter: FlowStudioToolAdapter = async args => {
    const message = `${args.tool.name || args.tool.id} simulada; configure --tool-exec para execução real.`;
    return {
        output: { result: message, tool: { id: args.tool.id, command: args.tool.command, simulated: true } },
        artifacts: [{ id: randomHex(), nodeId: args.nodeId, kind: 'log', name: `${args.nodeId}.log`, payload: { message, at: new Date().toISOString() } }]
    };
};

const unavailableRunnerAdapter: FlowStudioRunnerAdapter = async args => {
    throw new Error(`Nenhum adapter real foi configurado para ${normalizeProviderModelRef(args.runner.providerId, args.runner.modelId)}. Configure um runner ou use simulationMode explicitamente.`);
};

const unavailableToolAdapter: FlowStudioToolAdapter = async args => {
    throw new Error(`Nenhum adapter real foi configurado para a ferramenta "${args.tool.id}". Configure --tool-exec ou use simulationMode explicitamente.`);
};
