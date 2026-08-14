import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import {
    FLOW_STUDIO_DEFAULT_MODEL_PROFILES,
    createFlowStudioTemplate,
    validateFlowStudioGraph,
    type FlowStudioGraph,
    type FlowStudioGateConfig,
    type FlowStudioGateKind,
    type FlowStudioMemoryScope,
    type FlowStudioModelProfile,
    type FlowStudioNode,
    type FlowStudioNodeType,
    type FlowStudioReasoningEffort
} from '@cybervinci/flow-shared';

const NODE_TYPES: FlowStudioNodeType[] = [
    'input', 'context', 'agent', 'playbook', 'action', 'command', 'memory_write',
    'router', 'fork', 'dynamic_parallel', 'tournament', 'join', 'gate', 'wait',
    'subgraph', 'loop', 'transform', 'report', 'end'
];
const NODE_GROUPS: Array<{ label: string; types: FlowStudioNodeType[] }> = [
    { label: 'Entrada e contexto', types: ['input', 'context'] },
    { label: 'Agentes e execucao', types: ['agent', 'playbook', 'action', 'command', 'memory_write', 'report'] },
    { label: 'Decisoes e paralelismo', types: ['router', 'fork', 'dynamic_parallel', 'tournament', 'join', 'gate'] },
    { label: 'Controle e composicao', types: ['wait', 'subgraph', 'loop', 'transform', 'end'] }
];
const NODE_DESCRIPTIONS: Record<FlowStudioNodeType, string> = {
    input: 'inicia e normaliza a requisicao',
    context: 'carrega memoria, estado e arquivos com limites',
    agent: 'executa um agente com provider e modelo proprios',
    playbook: 'chama um playbook ou grafo reutilizavel',
    action: 'usa uma ou mais ferramentas declaradas',
    command: 'executa um programa sem shell, com permissao explicita',
    memory_write: 'grava somente candidatos de memoria aprovados',
    router: 'escolhe a proxima rota por condicao',
    fork: 'abre branches estaticas em paralelo',
    dynamic_parallel: 'aplica um worker a uma colecao limitada',
    tournament: 'compara candidatos e seleciona vencedores',
    join: 'sincroniza branches paralelas',
    gate: 'exige decisao humana, de IA ou politica',
    wait: 'aguarda tempo, data ou evento',
    subgraph: 'executa outro GraphSpec',
    loop: 'repete um trecho com limite obrigatorio',
    transform: 'transforma o estado com expressao deterministica',
    report: 'produz uma sintese final com IA',
    end: 'encerra o fluxo'
};
const MEMORY_SCOPES: FlowStudioMemoryScope[] = ['ide', 'workspace', 'project', 'workflow', 'run', 'agent'];
const REASONING: FlowStudioReasoningEffort[] = ['none', 'low', 'medium', 'high', 'xhigh'];

export interface FlowStudioTuiHostOptions {
    input?: string;
    provider?: string;
    model?: string;
    profile?: string;
    reasoning?: FlowStudioReasoningEffort;
    host?: string;
    port?: number;
    workspace?: string;
    token?: string;
    watch?: boolean;
    simulate?: boolean;
    'max-steps'?: number;
    'provider-exec'?: string | string[];
    'tool-exec'?: string | string[];
    'playbook-exec'?: string | string[];
    'memory-exec'?: string;
    'memory-approval'?: string | string[];
    'author-exec'?: string;
    'allow-graph-tools'?: boolean;
    'allow-graph-runners'?: boolean;
    'allow-command'?: string | string[];
    'allow-runner-host'?: string | string[];
    'provider-host'?: 'flow' | 'cybervinci' | 'opencode';
}

export async function runFlowStudioTui(fileArg?: string, hostOptions: FlowStudioTuiHostOptions = {}): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
        throw new Error('A TUI exige um terminal interativo. Use "flow serve <arquivo>" para abrir o editor visual.');
    }
    const preferred = path.resolve('flow.graph.json');
    const legacy = path.resolve('flow-studio.graph.json');
    const target = path.resolve(fileArg || (!existsSync(preferred) && existsSync(legacy) ? legacy : preferred));
    const graph = await loadOrCreate(target);
    const app = new FlowStudioTui(graph, target, hostOptions);
    await app.run();
}

class FlowStudioTui {
    private selected = 0;
    private dirty = false;
    private notice = 'Setas navegam. Pressione ? para ajuda.';
    private done?: () => void;
    private queue = Promise.resolve();

    constructor(private graph: FlowStudioGraph, private readonly file: string, private readonly hostOptions: FlowStudioTuiHostOptions) {}

    async run(): Promise<void> {
        emitKeypressEvents(process.stdin);
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        const onKey = (text: string, key: { name?: string; ctrl?: boolean; shift?: boolean }): void => {
            this.queue = this.queue.then(() => this.handle(text, key)).catch(error => {
                this.notice = error instanceof Error ? error.message : String(error);
                this.render();
            });
        };
        process.stdin.on('keypress', onKey);
        this.render();
        await new Promise<void>(resolve => { this.done = resolve; });
        process.stdin.off('keypress', onKey);
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdout.write('\x1b[2J\x1b[H');
    }

    private async handle(text: string, key: { name?: string; ctrl?: boolean; shift?: boolean }): Promise<void> {
        if ((key.ctrl && key.name === 'c') || key.name === 'q') return this.quit();
        if (key.name === 'up' || key.name === 'k') this.selected = Math.max(0, this.selected - 1);
        else if (key.name === 'down' || key.name === 'j') this.selected = Math.min(Math.max(0, this.graph.nodes.length - 1), this.selected + 1);
        else if (key.name === 'a') await this.addNode();
        else if (key.name === 'e' || key.name === 'return') await this.editNode();
        else if (key.name === 'c') await this.connectNode();
        else if (key.name === 'd' || key.name === 'delete') await this.deleteNode();
        else if (key.name === 'm') await this.chooseModel();
        else if (key.name === 'p') await this.manageProfiles();
        else if (key.name === 'v') this.validate();
        else if (key.name === 's') await this.save();
        else if (key.name === 'r') await this.runGraph();
        else if (key.name === 'o') await this.openVisual();
        else if (text === '?') this.notice = '↑↓ selecionar · A adicionar · Enter/E editar · C conectar · M modelo · P providers · R executar · D remover · V validar · S salvar · O abrir visual · Q sair';
        this.render();
    }

    private render(): void {
        const width = Math.max(76, process.stdout.columns || 100);
        const height = Math.max(20, process.stdout.rows || 28);
        const leftWidth = Math.min(48, Math.floor(width * 0.46));
        const current = this.graph.nodes[this.selected];
        const outgoing = current ? this.graph.edges.filter(edge => edge.from === current.id).map(edge => edge.to) : [];
        const validation = validateFlowStudioGraph(this.graph);
        const title = ` FLOW STUDIO · ${this.graph.name}${this.dirty ? ' *' : ''} `;
        const lines: string[] = [];
        lines.push(`\x1b[1;36m${title.padEnd(width, '─')}\x1b[0m`);
        lines.push(two(`Fluxo  ${validation.valid ? '\x1b[32mVALIDO\x1b[0m' : `\x1b[31m${validation.errors.length} ERRO(S)\x1b[0m`}`, current ? `Bloco ${this.selected + 1}/${this.graph.nodes.length}` : 'Sem blocos', leftWidth, width));
        lines.push(two('────────────────────────────────────────', '────────────────────────────────────────', leftWidth, width));
        const visible = this.graph.nodes.slice(Math.max(0, this.selected - Math.floor((height - 10) / 2)), Math.max(0, this.selected - Math.floor((height - 10) / 2)) + height - 10);
        const inspector = current ? this.describeNode(current, outgoing) : ['A para adicionar o primeiro bloco.'];
        for (let index = 0; index < Math.max(visible.length, inspector.length, height - 10); index += 1) {
            const node = visible[index];
            const absolute = node ? this.graph.nodes.indexOf(node) : -1;
            const marker = absolute === this.selected ? '\x1b[46;30m › \x1b[0m' : '   ';
            const start = node?.id === this.graph.start ? '●' : ' ';
            const left = node ? `${marker}${start} ${node.type.padEnd(9)} ${node.label}` : '';
            lines.push(two(left, inspector[index] || '', leftWidth, width));
        }
        lines.push(`\x1b[2m${'─'.repeat(width)}\x1b[0m`);
        lines.push(clip(this.notice, width));
        lines.push('\x1b[2m↑↓ navegar  A adicionar  Enter editar  C conectar  M modelo  P providers  R executar  V validar  S salvar  ? ajuda  Q sair\x1b[0m');
        process.stdout.write(`\x1b[2J\x1b[H${lines.slice(0, height).join('\n')}`);
    }

    private describeNode(node: FlowStudioNode, outgoing: string[]): string[] {
        const lines = [
            `\x1b[1m${node.label}\x1b[0m`,
            `id      ${node.id}`,
            `tipo    ${node.type}`,
            `inicio  ${node.id === this.graph.start ? 'sim' : 'nao'}`,
            `segue   ${node.next || outgoing.join(', ') || '—'}`
        ];
        if (node.type === 'agent' || node.type === 'report') {
            lines.push(`perfil  ${node.provider?.profileId || 'manual'}`);
            lines.push(`modelo  ${node.provider?.providerId || '—'}/${node.provider?.modelId || '—'}`);
            lines.push(`esforco ${node.provider?.reasoningEffort || 'medium'}`);
            lines.push(`RAG     ${node.rag?.filePath || (node.rag?.markdown ? 'markdown inline' : '—')}`);
            lines.push(`tools   ${node.tools?.length || 0}`);
        }
        if (node.type === 'gate') lines.push(`gate    ${node.gate?.kind || 'human'}`);
        if (node.type === 'join') lines.push(`join    ${node.join?.strategy || 'all'}`);
        if (node.type === 'context') {
            lines.push(`fontes  ${[
                node.context?.query ? 'busca' : '',
                node.context?.statePaths?.length ? `${node.context.statePaths.length} estado` : '',
                node.context?.filePaths?.length ? `${node.context.filePaths.length} arquivo(s)` : ''
            ].filter(Boolean).join(' · ') || '—'}`);
            lines.push(`escopos ${(node.context?.scopes || []).join(', ') || 'padrao'}`);
            lines.push(`limites ${node.context?.maxItems || '—'} itens · ${node.context?.maxBytes || '—'} bytes`);
        }
        if (node.type === 'command') {
            lines.push(`programa ${node.command?.command || '—'}`);
            lines.push(`efeito  ${node.command?.effect || 'command'}`);
            lines.push(`timeout ${node.command?.timeoutMs || '—'} ms`);
        }
        if (node.type === 'memory_write') {
            lines.push(`origem  ${node.memoryWrite?.candidatesFrom || '—'}`);
            lines.push(`escopo  ${node.memoryWrite?.scope || '—'} · approved-only`);
            lines.push(`vazio   ${node.memoryWrite?.onEmpty || 'skip'}`);
        }
        if (node.type === 'playbook') {
            lines.push(`playbook ${node.playbook?.playbookId || '—'}`);
            lines.push(`fonte    ${node.playbook?.graphRef || node.playbook?.graphId || (node.playbook?.inline ? 'inline' : 'host externo')}`);
            lines.push(`isolado  ${node.playbook?.isolated ? 'sim' : 'nao'}`);
        }
        if (node.type === 'dynamic_parallel') {
            lines.push(`itens   ${node.dynamicParallel?.itemsFrom || '—'}`);
            lines.push(`worker  ${node.dynamicParallel?.worker?.type || '—'} · ${node.dynamicParallel?.concurrency || 1} simultaneo(s)`);
            lines.push(`limite  ${node.dynamicParallel?.maxItems || '—'} itens`);
        }
        if (node.type === 'tournament') {
            lines.push(`candid. ${node.tournament?.candidatesFrom || '—'}`);
            lines.push(`formato ${node.tournament?.strategy || 'single_round'}`);
            lines.push(`juiz    ${node.tournament?.judge?.type || '—'} · ${node.tournament?.maxComparisons || '—'} comparacoes`);
        }
        return lines;
    }

    private async addNode(): Promise<void> {
        const type = await this.chooseNodeType();
        if (!type) return;
        const id = sanitizeId(await this.ask('Id', `${type}-${this.graph.nodes.length + 1}`));
        if (!id || this.graph.nodes.some(node => node.id === id)) throw new Error('Id vazio ou duplicado.');
        const label = await this.ask('Nome', humanize(type));
        const node = defaultNode(type, id, label, this.graph.nodes.length);
        this.graph.nodes.push(node);
        if (!this.graph.start) this.graph.start = id;
        this.selected = this.graph.nodes.length - 1;
        this.changed(`Bloco ${label} adicionado.`);
    }

    private async chooseNodeType(): Promise<FlowStudioNodeType | undefined> {
        const groupLabel = await this.choose('Categoria', NODE_GROUPS.map(group => group.label));
        const group = NODE_GROUPS.find(candidate => candidate.label === groupLabel);
        if (!group) return undefined;
        const options = group.types.map(type => `${type} · ${NODE_DESCRIPTIONS[type]}`);
        const selection = await this.choose('Tipo de bloco', options);
        const type = selection?.split(' · ', 1)[0] as FlowStudioNodeType | undefined;
        return type && NODE_TYPES.includes(type) ? type : undefined;
    }

    private async editNode(): Promise<void> {
        const node = this.graph.nodes[this.selected];
        if (!node) return;
        node.label = await this.ask('Nome', node.label);
        node.description = empty(await this.ask('Descricao', node.description || ''));
        if (node.type === 'agent' || node.type === 'report') await this.editAgentConfig(node);
        await this.editTypeConfig(node);
        if (await this.confirm('Definir como inicio?', node.id === this.graph.start)) this.graph.start = node.id;
        this.changed(`Bloco ${node.label} atualizado.`);
    }

    private async connectNode(): Promise<void> {
        const node = this.graph.nodes[this.selected];
        if (!node) return;
        const candidates = this.graph.nodes.filter(item => item.id !== node.id);
        const target = await this.choose('Conectar a', candidates.map(item => `${item.id} · ${item.label}`));
        if (!target) return;
        const targetId = target.split(' · ', 1)[0];
        const mode = await this.choose('Modo da conexao', ['Adicionar rota', 'Substituir rotas'], 'Adicionar rota');
        if (!mode) return;
        const label = empty(await this.ask('Rotulo (opcional)', ''));
        const guard = empty(await this.ask('Condicao/guard (opcional)', ''));
        if (mode === 'Substituir rotas') this.graph.edges = this.graph.edges.filter(edge => edge.from !== node.id);
        if (!this.graph.edges.some(edge => edge.from === node.id && edge.to === targetId && edge.guard === guard)) {
            this.graph.edges.push({ id: `${node.id}->${targetId}-${this.graph.edges.length + 1}`, from: node.id, to: targetId, label, guard, priority: this.graph.edges.filter(edge => edge.from === node.id).length });
        }
        const outgoing = this.graph.edges.filter(edge => edge.from === node.id);
        node.next = outgoing.length === 1 && !outgoing[0].guard ? targetId : undefined;
        this.changed(`${node.id} → ${targetId}`);
    }

    private async editTypeConfig(node: FlowStudioNode): Promise<void> {
        const chooseNode = async (label: string, current?: string, filter?: (candidate: FlowStudioNode) => boolean): Promise<string | undefined> => {
            const candidates = this.graph.nodes.filter(candidate => candidate.id !== node.id && (!filter || filter(candidate)));
            const options = candidates.map(candidate => `${candidate.id} · ${candidate.label}`);
            const initial = current ? options.find(option => option.startsWith(`${current} · `)) : undefined;
            return (await this.choose(label, options, initial))?.split(' · ', 1)[0];
        };
        if (node.type === 'context') {
            const config = node.context || {};
            const query = empty(await this.ask('Busca textual na memoria local (opcional)', config.query || ''));
            const statePaths = splitComma(await this.ask('Caminhos de estado (separados por virgula)', (config.statePaths || []).join(', ')));
            const filePaths = splitComma(await this.ask('Arquivos relativos ao workspace', (config.filePaths || []).join(', ')));
            const tags = splitComma(await this.ask('Tags de memoria', (config.tags || []).join(', ')));
            if (!query && !statePaths.length && !filePaths.length && !tags.length) throw new Error('Context precisa de busca, estado, arquivo ou tag.');
            const scopes = parseMemoryScopes(await this.ask(`Escopos (${MEMORY_SCOPES.join(', ')})`, (config.scopes || ['workspace', 'project', 'run']).join(', ')));
            const scopeId = scopes.includes('agent')
                ? await this.ask('Id do agente para o escopo agent', config.scopeId || node.id)
                : undefined;
            node.context = {
                query,
                scopes,
                scopeId,
                statePaths,
                filePaths,
                tags,
                maxItems: positiveInteger(await this.ask('Maximo de itens', String(config.maxItems || 20)), 20),
                maxBytes: Math.max(1024, positiveInteger(await this.ask('Maximo de bytes', String(config.maxBytes || 65_536)), 65_536)),
                outputPath: empty(await this.ask('Destino no estado', config.outputPath || 'contextPack')),
                required: await this.confirm('Falhar se o contexto nao estiver disponivel?', config.required || false)
            };
        } else if (node.type === 'command') {
            const config = node.command || { command: 'node', effect: 'read' as const };
            const command = await this.ask('Executavel (sem shell)', config.command || 'node');
            const args = parseStringList(await this.ask('Argumentos (JSON array ou separados por virgula)', JSON.stringify(config.args || ['--version'])));
            const effect = await this.choose('Tipo de efeito', ['none', 'read', 'write', 'command', 'network', 'message', 'deploy', 'custom'] as const, config.effect || 'read') || 'read';
            const permission = `tool:${effect === 'none' ? 'read' : effect}`;
            const retries = effect === 'none' || effect === 'read'
                ? nonNegativeInteger(await this.ask('Tentativas extras em falha', String(config.retries || 0)), 0)
                : 0;
            const idempotencyKey = effect === 'none' || effect === 'read'
                ? empty(await this.ask('Chave de idempotencia (opcional)', config.idempotencyKey || ''))
                : await this.ask('Chave de idempotencia (obrigatoria)', config.idempotencyKey || `${node.id}:{{flow.request}}`);
            node.command = {
                command,
                args,
                cwd: empty(await this.ask('Diretorio relativo ao workspace', config.cwd || '.')),
                timeoutMs: positiveInteger(await this.ask('Timeout em ms', String(config.timeoutMs || 30_000)), 30_000),
                retries,
                retryDelayMs: retries ? nonNegativeInteger(await this.ask('Espera entre tentativas em ms', String(config.retryDelayMs || 500)), 500) : undefined,
                effect,
                idempotencyKey,
                requiredPermissions: splitComma(await this.ask('Permissoes exigidas', (config.requiredPermissions || [permission]).join(', ')))
            };
            const allow = new Set([...(node.permissions?.allow || []), ...(node.command.requiredPermissions || [])]);
            node.permissions = { ...(node.permissions || {}), allow: [...allow], commandPatterns: [command] };
        } else if (node.type === 'memory_write') {
            const config = node.memoryWrite || { scope: 'project' as const, candidatesFrom: 'flow.memoryCandidates' };
            const scope = await this.choose('Escopo de destino', MEMORY_SCOPES, config.scope) || config.scope;
            const scopeId = scope === 'agent'
                ? await this.ask('Id do agente dono da memoria', config.scopeId || node.id)
                : undefined;
            node.memoryWrite = {
                scope,
                scopeId,
                candidatesFrom: await this.ask('Caminho dos candidatos aprovaveis', config.candidatesFrom || 'flow.memoryCandidates'),
                candidateIds: splitComma(await this.ask('Ids permitidos (vazio aceita todos os aprovados)', (config.candidateIds || []).join(', '))),
                policy: 'approved-only',
                onEmpty: await this.choose('Se nao houver aprovado', ['skip', 'fail'] as const, config.onEmpty || 'skip') || 'skip',
                storeId: empty(await this.ask('Id do repositorio de memoria (opcional)', config.storeId || '')),
                kind: await this.choose('Tipo padrao da memoria', ['fact', 'decision', 'preference', 'instruction', 'summary'] as const, config.kind || 'fact'),
                outputPath: empty(await this.ask('Destino dos recibos no estado', config.outputPath || 'memoryWrites')),
                idempotencyKey: empty(await this.ask('Prefixo de idempotencia (opcional)', config.idempotencyKey || `${node.id}:{{flow.request}}`))
            };
        } else if (node.type === 'playbook') {
            const config = node.playbook || { playbookId: 'meu-playbook' };
            const sourceOptions = ['Host externo', 'GraphSpec por arquivo', 'Subgrafo pelo id', ...(config.inline ? ['Manter GraphSpec inline'] : [])];
            const initialSource = config.inline ? 'Manter GraphSpec inline' : config.graphRef ? 'GraphSpec por arquivo' : config.graphId ? 'Subgrafo pelo id' : 'Host externo';
            const source = await this.choose('Origem do playbook', sourceOptions, initialSource) || initialSource;
            const graphRef = source === 'GraphSpec por arquivo' ? await this.ask('Arquivo GraphSpec', config.graphRef || 'playbook.graph.json') : undefined;
            const graphId = source === 'Subgrafo pelo id' ? await this.ask('Id em graph.subgraphs', config.graphId || 'playbook') : undefined;
            node.playbook = {
                playbookId: await this.ask('Id estavel do playbook', config.playbookId || 'meu-playbook'),
                graphId,
                graphRef,
                inline: source === 'Manter GraphSpec inline' ? config.inline : undefined,
                input: parseKeyValuePairs(await this.ask('Entradas origem=destino', formatKeyValuePairs(config.input))),
                parameters: parseJsonObject(await this.ask('Parametros JSON', JSON.stringify(config.parameters || {}))),
                output: parseKeyValuePairs(await this.ask('Saidas origem=destino', formatKeyValuePairs(config.output))),
                isolated: await this.confirm('Executar com estado isolado?', config.isolated || false),
                idempotencyKey: source === 'Host externo'
                    ? await this.ask('Chave de idempotencia (obrigatoria)', config.idempotencyKey || `${node.id}:{{flow.request}}`)
                    : empty(await this.ask('Chave de idempotencia (opcional)', config.idempotencyKey || ''))
            };
        } else if (node.type === 'action') {
            const tool = node.tools?.[0] || { id: `${node.id}-tool`, name: 'Ferramenta', command: '', effect: 'read' as const };
            tool.name = await this.ask('Nome da ferramenta', tool.name);
            tool.command = await this.ask('Comando logico', tool.command);
            tool.args = splitComma(await this.ask('Argumentos separados por virgula', (tool.args || []).join(', ')));
            tool.effect = await this.choose('Tipo de efeito', ['none', 'read', 'write', 'command', 'network', 'message', 'deploy', 'custom'] as const, tool.effect || 'read') || tool.effect;
            tool.idempotencyKey = empty(await this.ask('Chave de idempotencia', tool.idempotencyKey || `${node.id}:{{flow.request}}`));
            tool.requiredPermissions = [`tool:${tool.effect === 'none' ? 'read' : tool.effect}`];
            node.tools = [tool, ...(node.tools || []).slice(1)];
        } else if (node.type === 'router' || node.type === 'transform') {
            node.condition = await this.ask(node.type === 'router' ? 'Expressao booleana' : 'Expressao que retorna objeto', node.condition || '');
        } else if (node.type === 'fork') {
            const branches = splitComma(await this.ask('Ids iniciais das branches', (node.fork?.branches || []).join(', ')));
            const join = await chooseNode('Join de destino', node.fork?.join, candidate => candidate.type === 'join');
            node.fork = { branches, join: join || node.fork?.join || '', maxConcurrency: Math.max(1, Number(await this.ask('Concorrencia maxima', String(node.fork?.maxConcurrency || 2))) || 1), continueOnError: await this.confirm('Continuar se uma branch falhar?', node.fork?.continueOnError || false) };
        } else if (node.type === 'dynamic_parallel') {
            const config = node.dynamicParallel || {
                itemsFrom: 'context.flow?.items || []',
                itemVariable: 'item',
                worker: embeddedDefault('agent', `${node.id}-worker`, 'Worker'),
                concurrency: 4,
                maxItems: 50,
                failurePolicy: 'best_effort' as const,
                joinStrategy: 'collect' as const,
                outputPath: 'parallel.results'
            };
            const failurePolicy = await this.choose('Politica de falha', ['fail_fast', 'best_effort', 'threshold'] as const, config.failurePolicy || 'best_effort') || 'best_effort';
            node.dynamicParallel = {
                itemsFrom: await this.ask('Expressao que retorna a lista', config.itemsFrom),
                itemVariable: await this.ask('Caminho da variavel de cada item', config.itemVariable || 'item'),
                worker: await this.editEmbeddedNode(config.worker, 'worker'),
                concurrency: positiveInteger(await this.ask('Maximo simultaneo', String(config.concurrency || 4)), 4),
                maxItems: positiveInteger(await this.ask('Limite absoluto de itens', String(config.maxItems || 50)), 50),
                failurePolicy,
                failureThreshold: failurePolicy === 'threshold'
                    ? nonNegativeNumber(await this.ask('Limite de falhas (0-1 = proporcao; >=1 = quantidade)', String(config.failureThreshold ?? 0.2)), 0.2)
                    : undefined,
                joinStrategy: await this.choose('Como reunir resultados', ['collect', 'best_effort', 'require_all'] as const, config.joinStrategy || 'collect') || 'collect',
                outputPath: await this.ask('Destino no estado', config.outputPath || 'parallel.results')
            };
        } else if (node.type === 'tournament') {
            const config = node.tournament || {
                candidatesFrom: 'context.flow?.candidates || []',
                judge: embeddedDefault('agent', `${node.id}-judge`, 'Juiz'),
                strategy: 'single_round' as const,
                criteria: ['qualidade', 'correcao', 'custo'],
                winnerCount: 1,
                maxComparisons: 16,
                tieBreaker: 'judge_again' as const,
                maxTieRounds: 2,
                outputPath: 'tournament.result'
            };
            const strategy = await this.choose('Formato do torneio', ['single_round', 'bracket', 'round_robin'] as const, config.strategy || 'single_round') || 'single_round';
            const tieBreaker = await this.choose('Desempate', ['judge_again', 'score_total', 'first_candidate'] as const, config.tieBreaker || 'judge_again') || 'judge_again';
            node.tournament = {
                candidatesFrom: await this.ask('Expressao que retorna os candidatos', config.candidatesFrom),
                judge: await this.editEmbeddedNode(config.judge, 'judge'),
                strategy,
                criteria: splitComma(await this.ask('Criterios objetivos', (config.criteria || []).join(', '))),
                winnerCount: positiveInteger(await this.ask('Quantidade de vencedores', String(config.winnerCount || 1)), 1),
                maxComparisons: positiveInteger(await this.ask('Limite absoluto de comparacoes', String(config.maxComparisons || 16)), 16),
                tieBreaker,
                maxTieRounds: tieBreaker === 'judge_again'
                    ? positiveInteger(await this.ask('Maximo de rodadas de desempate', String(config.maxTieRounds || 2)), 2)
                    : undefined,
                outputPath: await this.ask('Destino no estado', config.outputPath || 'tournament.result')
            };
        } else if (node.type === 'join') {
            const strategy = await this.choose('Estrategia', ['all', 'any', 'quorum', 'majority'] as const, node.join?.strategy || 'all') || 'all';
            node.join = { strategy, quorum: strategy === 'quorum' ? Math.max(1, Number(await this.ask('Quorum', String(node.join?.quorum || 1))) || 1) : undefined, cancelRemaining: await this.confirm('Cancelar branches restantes?', node.join?.cancelRemaining || false) };
        } else if (node.type === 'gate') {
            node.gate = await this.editGateConfig(node.gate || { kind: 'human' }, 0);
        } else if (node.type === 'wait') {
            const kind = await this.choose('Tipo de espera', ['duration', 'until', 'event'] as const, node.wait?.kind || 'event') || 'event';
            node.wait = kind === 'duration'
                ? { kind, durationMs: Math.max(1, Number(await this.ask('Duracao em ms', String(node.wait?.durationMs || 1000))) || 1) }
                : kind === 'until'
                    ? { kind, until: await this.ask('Data/hora ISO', node.wait?.until || new Date().toISOString()) }
                    : { kind, eventName: await this.ask('Nome do evento', node.wait?.eventName || 'continue'), correlationKey: empty(await this.ask('Chave de correlacao', node.wait?.correlationKey || '')), timeoutMs: numberOrUndefined(await this.ask('Timeout ms (opcional)', String(node.wait?.timeoutMs || ''))), onTimeout: await this.choose('Ao expirar', ['continue', 'fail'] as const, node.wait?.onTimeout || 'fail') || 'fail' };
        } else if (node.type === 'subgraph') {
            node.subgraph = { ...(node.subgraph || {}), graphId: empty(await this.ask('Id embutido (opcional)', node.subgraph?.graphId || '')), graphRef: empty(await this.ask('Arquivo GraphSpec (opcional)', node.subgraph?.graphRef || '')), isolated: await this.confirm('Estado isolado?', node.subgraph?.isolated || false) };
        } else if (node.type === 'loop') {
            const bodyStart = await chooseNode('Inicio do corpo', node.loop?.bodyStart);
            node.loop = { bodyStart: bodyStart || node.loop?.bodyStart || '', condition: await this.ask('Enquanto', node.loop?.condition || 'false'), maxIterations: Math.max(1, Number(await this.ask('Maximo de iteracoes', String(node.loop?.maxIterations || 3))) || 1), breakWhen: empty(await this.ask('Parar quando (opcional)', node.loop?.breakWhen || '')) };
        }
    }

    private async editGateConfig(current: FlowStudioGateConfig, depth: number): Promise<FlowStudioGateConfig> {
        const kinds: FlowStudioGateKind[] = depth >= 3
            ? ['human', 'deterministic', 'ai', 'policy']
            : ['human', 'deterministic', 'ai', 'policy', 'composite'];
        const initial: FlowStudioGateKind = kinds.includes(current.kind) ? current.kind : 'human';
        const kind = await this.choose(depth ? `Tipo do criterio ${depth}` : 'Tipo de gate', kinds, initial) || initial;
        const gate: FlowStudioGateConfig = {
            kind,
            prompt: empty(await this.ask(depth ? 'Instrucao do criterio' : 'Pergunta/instrucao', current.prompt || '')),
            requireEvidence: await this.confirm('Exigir evidencia para aprovar?', current.requireEvidence || false),
            timeoutMs: current.timeoutMs,
            onTimeout: current.onTimeout
        };
        if (kind === 'deterministic') gate.expression = await this.ask('Expressao booleana', current.expression || 'true');
        if (kind === 'policy') {
            gate.rules = [{
                id: current.rules?.[0]?.id || `policy-${depth + 1}`,
                expression: await this.ask('Regra bloqueadora', current.rules?.[0]?.expression || 'true'),
                severity: 'blocker',
                message: await this.ask('Mensagem da politica', current.rules?.[0]?.message || 'Politica nao atendida')
            }];
        }
        if (kind === 'ai') {
            const profile = await this.choose('Perfil revisor', this.profiles().map(item => item.id), current.reviewer?.profileId);
            const selected = this.profiles().find(item => item.id === profile);
            gate.reviewer = selected
                ? { providerId: selected.providerId, modelId: selected.modelId, profileId: selected.id, runnerId: selected.runnerId, reasoningEffort: selected.reasonDefault || 'high' }
                : current.reviewer;
        }
        if (kind === 'composite') {
            gate.combine = await this.choose('Como combinar os criterios', ['all', 'any', 'majority'] as const, current.combine || 'all') || 'all';
            const childCount = Math.min(8, positiveInteger(await this.ask('Quantidade de criterios (1-8)', String(current.children?.length || 2)), current.children?.length || 2));
            gate.children = [];
            for (let index = 0; index < childCount; index += 1) {
                process.stdout.write(`\nCriterio ${index + 1} de ${childCount}\n`);
                gate.children.push(await this.editGateConfig(current.children?.[index] || { kind: 'deterministic', expression: 'true' }, depth + 1));
            }
        }
        return gate;
    }

    private async editEmbeddedNode(current: FlowStudioNode, role: 'worker' | 'judge'): Promise<FlowStudioNode> {
        const allowed: FlowStudioNodeType[] = role === 'judge'
            ? ['agent', 'report', 'transform']
            : ['agent', 'report', 'action', 'command', 'context', 'memory_write', 'playbook', 'subgraph', 'transform'];
        const options = allowed.map(type => `${type} · ${NODE_DESCRIPTIONS[type]}`);
        const initial = options.find(option => option.startsWith(`${current.type} · `));
        const selection = await this.choose(role === 'judge' ? 'Tipo do juiz embutido' : 'Tipo do worker embutido', options, initial) || initial || options[0];
        const type = selection.split(' · ', 1)[0] as FlowStudioNodeType;
        const embedded = current.type === type ? current : embeddedDefault(type, `${current.id || role}-${type}`, role === 'judge' ? 'Juiz' : 'Worker');
        embedded.label = await this.ask(role === 'judge' ? 'Nome do juiz' : 'Nome do worker', embedded.label);
        embedded.description = empty(await this.ask('Descricao do bloco embutido', embedded.description || ''));
        if (embedded.type === 'agent' || embedded.type === 'report') await this.editAgentConfig(embedded, role);
        await this.editTypeConfig(embedded);
        delete embedded.next;
        delete embedded.position;
        return embedded;
    }

    private async editAgentConfig(node: FlowStudioNode, role?: 'worker' | 'judge'): Promise<void> {
        const defaultPrompt = role === 'judge'
            ? 'Compare apenas os candidatos fornecidos usando os criterios. Responda JSON com winnerIds, scores, reason e evidence.'
            : role === 'worker'
                ? 'Processe {{item}} e devolva um resultado estruturado.'
                : '';
        node.prompt = await this.ask(role === 'judge' ? 'Instrucao do juiz' : 'Prompt', node.prompt || defaultPrompt);
        node.rag = { ...(node.rag || {}), filePath: empty(await this.ask('Arquivo RAG Markdown', node.rag?.filePath || '')) };
        if (await this.confirm('Escolher provider/modelo para este agente?', Boolean(node.provider?.profileId || node.provider?.modelId))) {
            await this.assignModel(node);
        }
        if (role === 'worker' && node.type === 'agent') await this.editEmbeddedWorkerTools(node);
        if (role === 'judge') delete node.tools;
    }

    private async editEmbeddedWorkerTools(node: FlowStudioNode): Promise<void> {
        const current = node.tools || [];
        const count = Math.min(16, nonNegativeInteger(await this.ask('Quantidade de ferramentas do worker (0-16)', String(current.length)), current.length));
        const tools: NonNullable<FlowStudioNode['tools']> = [];
        for (let index = 0; index < count; index += 1) {
            const previous = current[index] || { id: `${node.id}-tool-${index + 1}`, name: `Ferramenta ${index + 1}`, command: '', effect: 'read' as const };
            const id = sanitizeId(await this.ask(`Ferramenta ${index + 1} · id`, previous.id));
            const name = await this.ask(`Ferramenta ${index + 1} · nome`, previous.name || id);
            const command = await this.ask(`Ferramenta ${index + 1} · comando logico`, previous.command || id);
            const effect = await this.choose('Tipo de efeito', ['none', 'read', 'write', 'command', 'network', 'message', 'deploy', 'custom'] as const, previous.effect || 'read') || 'read';
            const mutating = effect !== 'none' && effect !== 'read';
            tools.push({
                id,
                name,
                command,
                args: parseStringList(await this.ask('Argumentos (JSON array ou separados por virgula)', JSON.stringify(previous.args || []))),
                effect,
                idempotencyKey: mutating
                    ? await this.ask('Chave de idempotencia (obrigatoria)', previous.idempotencyKey || `${node.id}:${id}:{{flow.request}}`)
                    : empty(await this.ask('Chave de idempotencia (opcional)', previous.idempotencyKey || '')),
                requiredPermissions: splitComma(await this.ask('Permissoes exigidas', (previous.requiredPermissions || [`tool:${effect === 'none' ? 'read' : effect}`]).join(', ')))
            });
        }
        node.tools = tools;
    }

    private async deleteNode(): Promise<void> {
        const node = this.graph.nodes[this.selected];
        if (!node || !await this.confirm(`Remover ${node.label}?`, false)) return;
        this.graph.nodes = this.graph.nodes.filter(item => item.id !== node.id);
        this.graph.edges = this.graph.edges.filter(edge => edge.from !== node.id && edge.to !== node.id);
        for (const item of this.graph.nodes) if (item.next === node.id) item.next = undefined;
        if (this.graph.start === node.id) this.graph.start = this.graph.nodes[0]?.id || '';
        this.selected = Math.min(this.selected, Math.max(0, this.graph.nodes.length - 1));
        this.changed(`Bloco ${node.label} removido.`);
    }

    private async chooseModel(): Promise<void> {
        const node = this.graph.nodes[this.selected];
        if (!node || (node.type !== 'agent' && node.type !== 'report')) throw new Error('Selecione um Agente ou Relatorio.');
        await this.assignModel(node);
        this.changed(`${node.label} usa ${node.provider?.providerId}/${node.provider?.modelId || 'modelo padrao'}.`);
    }

    private async assignModel(node: FlowStudioNode): Promise<void> {
        const profiles = this.profiles();
        const selected = await this.choose('Assinatura de modelo', profiles.map(profile => `${profile.id} · ${profile.name} · ${profile.providerId}/${profile.modelId}`));
        if (!selected) return;
        const profile = profiles.find(item => item.id === selected.split(' · ', 1)[0]);
        if (!profile) return;
        const effort = await this.choose('Reasoning effort', REASONING, profile.reasonDefault || 'medium');
        node.provider = { providerId: profile.providerId, modelId: profile.modelId, profileId: profile.id, reasoningEffort: effort || profile.reasonDefault || 'medium' };
    }

    private async manageProfiles(): Promise<void> {
        const action = await this.choose('Providers e modelos', ['Adicionar assinatura', 'Listar assinaturas']);
        if (action === 'Listar assinaturas') {
            this.notice = this.profiles().map(item => `${item.id}=${item.providerId}/${item.modelId}`).join(' · ');
            return;
        }
        if (action !== 'Adicionar assinatura') return;
        const id = sanitizeId(await this.ask('Id da assinatura', 'meu-modelo'));
        const providerId = await this.ask('Provider', 'opencode');
        const modelId = await this.ask('Modelo', '');
        if (!id || !providerId || !modelId) throw new Error('Id, provider e modelo sao obrigatorios.');
        const profile: FlowStudioModelProfile = {
            id,
            name: await this.ask('Nome amigavel', id),
            providerId,
            modelId,
            reasonDefault: await this.choose('Reasoning padrao', REASONING, 'medium') || 'medium',
            command: empty(await this.ask('Comando do runner (opcional)', ''))
        };
        this.graph.modelProfiles = [...(this.graph.modelProfiles || []).filter(item => item.id !== id), profile];
        this.changed(`Assinatura ${profile.name} salva.`);
    }

    private validate(): void {
        const result = validateFlowStudioGraph(this.graph);
        this.notice = result.valid ? `Valido · ${result.warnings.length} aviso(s).` : result.errors.slice(0, 3).map(item => item.message).join(' · ');
    }

    private async save(): Promise<void> {
        const validation = validateFlowStudioGraph(this.graph);
        if (!validation.valid && !await this.confirm(`Ha ${validation.errors.length} erro(s). Salvar mesmo assim?`, false)) return;
        await atomicWrite(this.file, this.graph);
        this.dirty = false;
        this.notice = `Salvo em ${this.file}`;
    }

    private async runGraph(): Promise<void> {
        if (this.dirty && !await this.confirm('Salvar antes de executar?', true)) return;
        if (this.dirty) await this.save();
        process.stdin.setRawMode?.(false);
        process.stdout.write('\x1b[2J\x1b[H');
        const cliEntry = process.argv[1];
        const executable = cliEntry && cliEntry.endsWith('.js') ? process.execPath : process.argv0;
        const args = cliEntry && cliEntry.endsWith('.js') ? [cliEntry, 'run', this.file, '--watch'] : ['run', this.file, '--watch'];
        args.push(...hostCliArgs(this.hostOptions, 'run'));
        const code = await new Promise<number>((resolve, reject) => {
            const child = spawn(executable, args, { cwd: path.dirname(this.file), shell: false, stdio: 'inherit', windowsHide: true });
            child.once('error', reject);
            child.once('exit', value => resolve(value ?? 1));
        });
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        this.notice = code === 0 ? 'Execucao concluida.' : `Execucao terminou com codigo ${code}.`;
    }

    private async openVisual(): Promise<void> {
        if (this.dirty && await this.confirm('Salvar antes de abrir o Studio Web?', true)) await this.save();
        const port = Math.max(1, Number(await this.ask('Porta local', String(this.hostOptions.port || 4200))) || 4200);
        const cliEntry = process.argv[1];
        const executable = cliEntry && cliEntry.endsWith('.js') ? process.execPath : process.argv0;
        const args = cliEntry && cliEntry.endsWith('.js')
            ? [cliEntry, 'serve', this.file, '--workspace', this.hostOptions.workspace || path.dirname(this.file), '--port', String(port)]
            : ['serve', this.file, '--workspace', this.hostOptions.workspace || path.dirname(this.file), '--port', String(port)];
        args.push(...hostCliArgs(this.hostOptions, 'serve'));
        const child = spawn(executable, args, { cwd: path.dirname(this.file), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        const studioUrl = await new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('O Studio Web nao iniciou em 15 segundos.')), 15_000);
            let output = '';
            child.once('error', error => { clearTimeout(timeout); reject(error); });
            child.once('exit', code => { if (code) { clearTimeout(timeout); reject(new Error(`Studio Web encerrou com codigo ${code}.`)); } });
            child.stdout?.on('data', chunk => {
                output += String(chunk);
                const match = output.match(/https?:\/\/[^\s]+/);
                if (match) { clearTimeout(timeout); resolve(match[0]); }
            });
        });
        child.unref();
        child.stdout?.destroy();
        child.stderr?.destroy();
        openExternal(studioUrl);
        this.notice = `Studio Web aberto: ${studioUrl}`;
    }

    private async quit(): Promise<void> {
        if (this.dirty && !await this.confirm('Sair sem salvar?', false)) return;
        this.done?.();
    }

    private changed(message: string): void { this.dirty = true; this.notice = message; }

    private profiles(): FlowStudioModelProfile[] {
        const map = new Map<string, FlowStudioModelProfile>();
        for (const profile of Object.values(FLOW_STUDIO_DEFAULT_MODEL_PROFILES)) map.set(profile.id, profile);
        for (const profile of this.graph.modelProfiles || []) map.set(profile.id, profile);
        return [...map.values()];
    }

    private async ask(label: string, initial = ''): Promise<string> {
        process.stdin.setRawMode?.(false);
        process.stdout.write('\x1b[2J\x1b[H');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
            const answer = await rl.question(`${label}${initial ? ` [${initial}]` : ''}: `);
            return answer.trim() || initial;
        } finally {
            rl.close();
            process.stdin.setRawMode?.(true);
            process.stdin.resume();
        }
    }

    private async choose<T extends string>(label: string, values: readonly T[], initial?: T): Promise<T | undefined> {
        process.stdin.setRawMode?.(false);
        process.stdout.write('\x1b[2J\x1b[H');
        values.forEach((value, index) => process.stdout.write(`${index + 1}. ${value}${value === initial ? '  ← atual' : ''}\n`));
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
            const raw = await rl.question(`${label} (numero, vazio cancela): `);
            if (!raw.trim()) return undefined;
            const index = Number(raw) - 1;
            return values[index];
        } finally {
            rl.close();
            process.stdin.setRawMode?.(true);
            process.stdin.resume();
        }
    }

    private async confirm(label: string, initial: boolean): Promise<boolean> {
        const answer = (await this.ask(`${label} ${initial ? '(S/n)' : '(s/N)'}`, '')).toLowerCase();
        return answer ? ['s', 'sim', 'y', 'yes'].includes(answer) : initial;
    }
}

async function loadOrCreate(file: string): Promise<FlowStudioGraph> {
    try { return JSON.parse(await fs.readFile(file, 'utf-8')) as FlowStudioGraph; }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return createFlowStudioTemplate('Novo fluxo');
    }
}

async function atomicWrite(file: string, graph: FlowStudioGraph): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(graph, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    await fs.rename(temporary, file);
}

function defaultNode(type: FlowStudioNodeType, id: string, label: string, index: number): FlowStudioNode {
    const node: FlowStudioNode = { id, type, label, position: { x: 100 + index * 220, y: 120 } };
    if (type === 'agent' || type === 'report') { node.prompt = ''; node.provider = { runnerId: 'cybervinci', providerId: 'cybervinci', reasoningEffort: 'medium', fallbacks: [{ runnerId: 'opencode', providerId: 'opencode', reasoningEffort: 'medium' }] }; node.rag = {}; }
    if (type === 'context') node.context = { statePaths: ['flow.request'], scopes: ['workspace', 'project', 'run'], maxItems: 20, maxBytes: 65_536, outputPath: 'contextPack' };
    if (type === 'command') {
        node.command = { command: 'node', args: ['--version'], cwd: '.', timeoutMs: 30_000, retries: 0, effect: 'read', requiredPermissions: ['tool:read'] };
        node.permissions = { allow: ['tool:read'], commandPatterns: ['node'] };
    }
    if (type === 'memory_write') node.memoryWrite = { scope: 'project', candidatesFrom: 'flow.memoryCandidates', policy: 'approved-only', onEmpty: 'skip', kind: 'fact', outputPath: 'memoryWrites', idempotencyKey: `${id}:{{flow.request}}` };
    if (type === 'playbook') node.playbook = { playbookId: 'meu-playbook', isolated: true, idempotencyKey: `${id}:{{flow.request}}` };
    if (type === 'action') node.tools = [{ id: `${id}-tool`, name: 'Ferramenta', command: '', effect: 'read', requiredPermissions: ['tool:read'] }];
    if (type === 'router') node.condition = 'Boolean(context.flow?.result)';
    if (type === 'fork') node.fork = { branches: [], join: '', maxConcurrency: 2 };
    if (type === 'dynamic_parallel') node.dynamicParallel = {
        itemsFrom: 'context.flow?.items || []', itemVariable: 'item', worker: embeddedDefault('agent', `${id}-worker`, 'Worker'),
        concurrency: 4, maxItems: 50, failurePolicy: 'best_effort', joinStrategy: 'collect', outputPath: 'parallel.results'
    };
    if (type === 'tournament') node.tournament = {
        candidatesFrom: 'context.flow?.candidates || []', judge: embeddedDefault('agent', `${id}-judge`, 'Juiz'), strategy: 'single_round',
        criteria: ['qualidade', 'correcao', 'custo'], winnerCount: 1, maxComparisons: 16, tieBreaker: 'judge_again', maxTieRounds: 2, outputPath: 'tournament.result'
    };
    if (type === 'join') node.join = { strategy: 'all' };
    if (type === 'gate') node.gate = { kind: 'human', prompt: 'Deseja continuar?' };
    if (type === 'wait') node.wait = { kind: 'event', eventName: 'continue' };
    if (type === 'subgraph') node.subgraph = { graphId: '' };
    if (type === 'loop') node.loop = { bodyStart: '', condition: 'false', maxIterations: 3 };
    if (type === 'transform') node.condition = '({ result: context.flow?.result })';
    return node;
}

function embeddedDefault(type: FlowStudioNodeType, id: string, label: string): FlowStudioNode {
    const node = defaultNode(type, id, label, 0);
    delete node.position;
    delete node.next;
    if ((type === 'agent' || type === 'report') && !node.prompt) {
        node.prompt = label === 'Juiz'
            ? 'Compare os candidatos usando os criterios e responda JSON com winnerIds, scores, reason e evidence.'
            : 'Processe {{item}} e devolva um resultado estruturado.';
    }
    return node;
}

function two(left: string, right: string, leftWidth: number, total: number): string {
    return `${padAnsi(left, leftWidth)} │ ${clip(right, Math.max(1, total - leftWidth - 3))}`;
}

function padAnsi(value: string, width: number): string {
    const visible = value.replace(/\x1b\[[0-9;]*m/g, '');
    return `${clip(value, width)}${' '.repeat(Math.max(0, width - visible.length))}`;
}

function clip(value: string, width: number): string {
    const visible = value.replace(/\x1b\[[0-9;]*m/g, '');
    if (visible.length <= width) return value;
    return `${visible.slice(0, Math.max(0, width - 1))}…`;
}

function sanitizeId(value: string): string { return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, ''); }
function humanize(value: string): string { const text = value.replace(/_/g, ' '); return text.charAt(0).toUpperCase() + text.slice(1); }
function empty(value: string): string | undefined { return value.trim() || undefined; }
function splitComma(value: string): string[] { return value.split(',').map(item => item.trim()).filter(Boolean); }
function numberOrUndefined(value: string): number | undefined { const parsed = Number(value); return value.trim() && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined; }

function positiveInteger(value: string, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value: string, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseMemoryScopes(value: string): FlowStudioMemoryScope[] {
    const scopes = splitComma(value);
    const invalid = scopes.filter(scope => !MEMORY_SCOPES.includes(scope as FlowStudioMemoryScope));
    if (invalid.length) throw new Error(`Escopo(s) invalido(s): ${invalid.join(', ')}.`);
    return scopes as FlowStudioMemoryScope[];
}

function parseStringList(value: string): string[] {
    const source = value.trim();
    if (!source) return [];
    if (!source.startsWith('[')) return splitComma(source);
    const parsed = JSON.parse(source) as unknown;
    if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) throw new Error('Os argumentos devem ser um array JSON de strings.');
    return parsed;
}

function parseJsonObject(value: string): Record<string, unknown> {
    const source = value.trim();
    if (!source) return {};
    const parsed = JSON.parse(source) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Os parametros devem ser um objeto JSON.');
    return parsed as Record<string, unknown>;
}

function parseKeyValuePairs(value: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const pair of splitComma(value)) {
        const separator = pair.indexOf('=');
        if (separator < 1 || separator === pair.length - 1) throw new Error(`Mapeamento invalido: "${pair}". Use origem=destino.`);
        result[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
    }
    return result;
}

function formatKeyValuePairs(value: Record<string, string> | undefined): string {
    return Object.entries(value || {}).map(([source, target]) => `${source}=${target}`).join(', ');
}

function hostCliArgs(options: FlowStudioTuiHostOptions, mode: 'run' | 'serve'): string[] {
    const args: string[] = [];
    const append = (key: string, value: string | number | undefined): void => {
        if (value !== undefined && String(value).trim()) args.push(key, String(value));
    };
    const appendMany = (key: string, value: string | string[] | undefined): void => {
        for (const item of Array.isArray(value) ? value : value ? [value] : []) append(key, item);
    };
    append('--provider', options.provider);
    append('--model', options.model);
    append('--reasoning', options.reasoning);
    append('--max-steps', options['max-steps']);
    appendMany('--provider-exec', options['provider-exec']);
    appendMany('--tool-exec', options['tool-exec']);
    appendMany('--playbook-exec', options['playbook-exec']);
    append('--memory-exec', options['memory-exec']);
    appendMany('--memory-approval', options['memory-approval']);
    appendMany('--allow-command', options['allow-command']);
    appendMany('--allow-runner-host', options['allow-runner-host']);
    if (options['allow-graph-tools']) args.push('--allow-graph-tools');
    if (options['allow-graph-runners']) args.push('--allow-graph-runners');
    if (options.simulate) args.push('--simulate');
    if (mode === 'run') {
        append('--input', options.input);
    } else {
        append('--host', options.host);
        append('--token', options.token);
        append('--author-exec', options['author-exec']);
        append('--provider-host', options['provider-host']);
    }
    return args;
}

function openExternal(target: string): void {
    if (process.platform === 'win32') {
        const opener = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'param($target) Start-Process -FilePath $target', target], { shell: false, windowsHide: true, detached: true, stdio: 'ignore' });
        opener.unref();
        return;
    }
    const opener = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { shell: false, detached: true, stdio: 'ignore' });
    opener.unref();
}
