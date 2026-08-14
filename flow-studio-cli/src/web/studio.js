(function () {
    'use strict';

    const React = window.React;
    const ReactDOM = window.ReactDOM;
    const RF = window.ReactFlow;
    if (!React || !ReactDOM || !RF) {
        document.getElementById('app').innerHTML = '<main class="boot-error"><h1>Flow Studio não iniciou</h1><p>Os assets locais do editor não foram carregados.</p></main>';
        return;
    }

    const h = React.createElement;
    const {
        ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position,
        addEdge, useNodesState, useEdgesState, MarkerType
    } = RF;

    const NODE_CATALOG = [
        { type: 'input', label: 'Entrada', group: 'Fluxo', icon: '→', help: 'Recebe a requisição e prepara o estado.' },
        { type: 'end', label: 'Fim', group: 'Fluxo', icon: '■', help: 'Finaliza a execução de forma explícita.' },
        { type: 'agent', label: 'Agente', group: 'IA', icon: '✦', help: 'Executa um prompt com modelo, RAG e ferramentas próprios.' },
        { type: 'report', label: 'Relatório', group: 'IA', icon: '▤', help: 'Produz uma saída ou artefato final por IA.' },
        { type: 'context', label: 'Contexto', group: 'Contexto e memória', icon: '◎', help: 'Reúne memórias, arquivos e estado em um pacote rastreável.' },
        { type: 'memory_write', label: 'Gravar memória', group: 'Contexto e memória', icon: '◉', help: 'Persiste somente candidatos de memória aprovados.' },
        { type: 'action', label: 'Ação', group: 'Ações', icon: '⚡', help: 'Executa ferramentas com permissões e idempotência.' },
        { type: 'command', label: 'Comando', group: 'Ações', icon: '❯_', help: 'Executa um programa autorizado sem passar por um shell.' },
        { type: 'playbook', label: 'Playbook', group: 'Orquestração', icon: '▣', help: 'Chama uma automação reutilizável do host ou um subgrafo.' },
        { type: 'dynamic_parallel', label: 'Paralelo dinâmico', group: 'Orquestração', icon: '⫾', help: 'Aplica um worker a cada item com concorrência limitada.' },
        { type: 'tournament', label: 'Torneio', group: 'Orquestração', icon: '♛', help: 'Compara alternativas com um juiz e critérios explícitos.' },
        { type: 'router', label: 'Condição', group: 'Lógica', icon: '◇', help: 'Escolhe uma rota usando uma expressão.' },
        { type: 'fork', label: 'Paralelo', group: 'Lógica', icon: '⑂', help: 'Abre branches concorrentes e aponta para um Join.' },
        { type: 'join', label: 'Junção', group: 'Lógica', icon: '⑃', help: 'Consolida all, any, quorum ou maioria.' },
        { type: 'loop', label: 'Repetição', group: 'Lógica', icon: '↻', help: 'Repete uma região com limite obrigatório.' },
        { type: 'transform', label: 'Transformar', group: 'Lógica', icon: 'ƒ', help: 'Transforma o estado sem chamar um modelo.' },
        { type: 'gate', label: 'Gate', group: 'Controle', icon: '✓', help: 'Aprovação humana, política, IA ou composição.' },
        { type: 'wait', label: 'Aguardar', group: 'Controle', icon: '◷', help: 'Suspende até tempo, data ou evento.' },
        { type: 'subgraph', label: 'Subfluxo', group: 'Controle', icon: '▦', help: 'Reutiliza outro grafo com entradas e saídas mapeadas.' }
    ];
    const NODE_BY_TYPE = Object.fromEntries(NODE_CATALOG.map(item => [item.type, item]));
    const REASONING = ['none', 'low', 'medium', 'high', 'xhigh'];
    const TIERS = ['default', 'fast', 'flex'];
    const EFFECTS = ['none', 'read', 'write', 'command', 'network', 'message', 'deploy', 'custom'];
    const JOIN_STRATEGIES = ['all', 'any', 'quorum', 'majority'];
    const GATE_KINDS = ['human', 'deterministic', 'ai', 'policy', 'composite'];
    const MEMORY_SCOPES = [
        { value: 'ide', label: 'IDE' }, { value: 'workspace', label: 'Área de trabalho' },
        { value: 'project', label: 'Projeto' }, { value: 'workflow', label: 'Fluxo' },
        { value: 'run', label: 'Execução' }, { value: 'agent', label: 'Agente' }
    ];
    const EMBEDDED_WORKER_TYPES = [
        { value: 'agent', label: 'Agente' }, { value: 'report', label: 'Relatório' },
        { value: 'transform', label: 'Transformar' }, { value: 'command', label: 'Comando' },
        { value: 'action', label: 'Ação' }, { value: 'context', label: 'Contexto' },
        { value: 'memory_write', label: 'Gravar memória' }, { value: 'playbook', label: 'Playbook' },
        { value: 'subgraph', label: 'Subfluxo' }
    ];
    const EMBEDDED_JUDGE_TYPES = [
        { value: 'agent', label: 'Agente' }, { value: 'report', label: 'Relatório' }, { value: 'transform', label: 'Transformar' }
    ];
    const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'waiting']);
    const params = new URLSearchParams(window.location.search);
    const sessionToken = params.get('token') || '';

    const emptyGraph = () => ({
        version: 'flow-studio/v2',
        id: `flow-${Date.now()}`,
        name: 'Novo fluxo',
        description: '',
        start: '',
        nodes: [],
        edges: [],
        modelProfiles: [],
        runners: [],
        state: { strictWrites: false, namespaces: { flow: { reducer: { kind: 'merge' } } } },
        budget: { maxSteps: 500, maxDurationMs: 1800000, maxCostUsd: 10, maxParallelism: 4 },
        permissions: { allow: ['runner:invoke', 'tool:read', 'memory:read'], requireApproval: ['tool:command', 'tool:write', 'tool:network', 'memory:write', 'playbook:run'] }
    });

    const clone = value => JSON.parse(JSON.stringify(value));
    const uid = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const catalogFor = type => NODE_BY_TYPE[type] || { label: type, icon: '•', help: '' };
    const parseLines = value => String(value || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
    const mapToText = value => Object.entries(value || {}).map(([from, to]) => `${from} → ${to}`).join('\n');
    const textToMap = value => {
        const result = {};
        for (const line of parseLines(value)) {
            const parts = line.split(/\s*(?:→|=>|=)\s*/, 2);
            if (parts[0] && parts[1]) result[parts[0]] = parts[1];
        }
        return result;
    };
    const valuesToText = value => Object.entries(value || {}).map(([key, item]) => `${key} = ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n');
    const textToValues = value => {
        const result = {};
        for (const line of parseLines(value)) {
            const parts = line.split(/\s*=\s*/, 2);
            if (!parts[0] || parts[1] === undefined) continue;
            try { result[parts[0]] = JSON.parse(parts[1]); } catch { result[parts[0]] = parts[1]; }
        }
        return result;
    };
    const normalizeSearch = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
    const MEMORY_SCOPE_IDS = new Set(MEMORY_SCOPES.map(scope => scope.value));
    const isMemoryCandidate = value => Boolean(value && typeof value === 'object' && !Array.isArray(value)
        && typeof value.id === 'string' && value.id.trim()
        && ['candidate', 'approved', 'rejected', 'written', 'failed'].includes(value.status)
        && (typeof value.revision === 'string' || (typeof value.revision === 'number' && Number.isFinite(value.revision)))
        && Object.prototype.hasOwnProperty.call(value, 'value')
        && (value.scope === undefined || MEMORY_SCOPE_IDS.has(value.scope)));
    const collectMemoryCandidates = (...roots) => {
        const found = [];
        const seenObjects = new Set();
        const seenCandidates = new Set();
        let visited = 0;
        const visit = (value, path, depth) => {
            if (depth > 10 || visited >= 4000 || !value || typeof value !== 'object') return;
            visited += 1;
            if (seenObjects.has(value)) return;
            seenObjects.add(value);
            if (isMemoryCandidate(value)) {
                const identity = `${value.id}\u0000${String(value.revision)}\u0000${value.scope || ''}\u0000${JSON.stringify(value.value)}`;
                if (!seenCandidates.has(identity)) {
                    seenCandidates.add(identity);
                    found.push({ candidate: value, path });
                }
                return;
            }
            if (Array.isArray(value)) {
                value.slice(0, 500).forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
                return;
            }
            Object.entries(value).slice(0, 500).forEach(([key, item]) => visit(item, path ? `${path}.${key}` : key, depth + 1));
        };
        roots.forEach((root, index) => visit(root, index === 0 ? 'checkpoint.context' : 'run.context', 0));
        return found;
    };
    const memoryCandidateSummary = candidate => {
        if (typeof candidate.value === 'string') return candidate.value.slice(0, 240);
        if (candidate.key && candidate.value && typeof candidate.value === 'object' && candidate.value[candidate.key] !== undefined) return String(candidate.value[candidate.key]).slice(0, 240);
        try {
            const serialized = JSON.stringify(candidate.value);
            if (typeof serialized !== 'string') return String(candidate.value).slice(0, 240);
            return serialized.length > 240 ? `${serialized.slice(0, 237)}…` : serialized;
        } catch { return String(candidate.value).slice(0, 240); }
    };
    const profileOptionLabel = profile => {
        const name = profile.name || profile.id;
        const provider = profile.providerId || '';
        const model = profile.modelId || '';
        const comparable = value => normalizeSearch(value).replace(/[^a-z0-9]/g, '');
        const nameAlreadyIdentifiesProvider = provider && comparable(name).includes(comparable(provider));
        const displayModel = provider && model.toLocaleLowerCase('pt-BR').startsWith(`${provider.toLocaleLowerCase('pt-BR')}/`) ? model.slice(provider.length + 1) : model;
        const binding = nameAlreadyIdentifiesProvider ? displayModel : [provider, displayModel].filter(Boolean).join('/');
        return binding ? `${name} · ${binding}` : name;
    };
    const profileBindingLabel = profile => {
        const provider = profile.providerId || '';
        const model = profile.modelId || '';
        const comparable = value => normalizeSearch(value).replace(/[^a-z0-9]/g, '');
        const displayModel = provider && model.toLocaleLowerCase('pt-BR').startsWith(`${provider.toLocaleLowerCase('pt-BR')}/`) ? model.slice(provider.length + 1) : model;
        return provider && comparable(profile.name || profile.id).includes(comparable(provider))
            ? (displayModel || provider)
            : [provider, displayModel].filter(Boolean).join(' · ');
    };
    const findAvailableNodePosition = (nodes, preferred) => {
        const base = preferred || { x: 160, y: 100 };
        const snapped = { x: Math.round(base.x / 16) * 16, y: Math.round(base.y / 16) * 16 };
        const occupied = (position) => nodes.some(node => {
            const current = node.position || { x: 100, y: 100 };
            return Math.abs(current.x - position.x) < 224 && Math.abs(current.y - position.y) < 112;
        });
        for (let index = 0; index < 400; index += 1) {
            const column = index % 4;
            const row = Math.floor(index / 4);
            const candidate = { x: snapped.x + column * 240, y: snapped.y + row * 128 };
            if (!occupied(candidate)) return candidate;
        }
        return { x: snapped.x, y: snapped.y + nodes.length * 128 };
    };
    const normalizeNodePositions = graph => {
        const placed = [];
        const nodes = (graph.nodes || []).map((node, index) => {
            const valid = Number.isFinite(node.position?.x) && Number.isFinite(node.position?.y);
            const preferred = valid ? node.position : { x: 160 + (index % 4) * 240, y: 100 + Math.floor(index / 4) * 128 };
            const overlaps = placed.some(item => Math.abs(item.position.x - preferred.x) < 224 && Math.abs(item.position.y - preferred.y) < 112);
            const position = overlaps ? findAvailableNodePosition(placed, preferred) : preferred;
            const positioned = { ...node, position };
            placed.push(positioned);
            return positioned;
        });
        return { ...graph, nodes };
    };
    const errorMessage = payload => payload?.error || payload?.message || (payload?.errors ? payload.errors.map(item => item.message).join('; ') : 'Falha inesperada.');

    async function api(path, options) {
        const headers = { 'Content-Type': 'application/json', 'X-Flow-Studio-Token': sessionToken, ...(options?.headers || {}) };
        const response = await fetch(path, { ...options, headers });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(errorMessage(payload));
            error.payload = payload;
            error.status = response.status;
            throw error;
        }
        return payload;
    }

    function defaultNode(type, position) {
        const meta = catalogFor(type);
        const node = { id: uid(type), type, label: meta.label, position: position || { x: 160, y: 120 } };
        if (type === 'agent' || type === 'report') {
            node.prompt = '';
            node.provider = { runnerId: 'cybervinci', providerId: 'cybervinci', reasoningEffort: type === 'agent' ? 'high' : 'medium', serviceTier: 'default', fallbacks: [{ runnerId: 'opencode', providerId: 'opencode', reasoningEffort: type === 'agent' ? 'high' : 'medium' }] };
            node.rag = {};
        }
        if (type === 'action') node.tools = [{ id: uid('tool'), name: 'Nova ferramenta', command: '', args: [], effect: 'read', idempotencyKey: `${node.id}:{{flow.request}}`, requiredPermissions: ['tool:read'] }];
        if (type === 'router') node.condition = 'Boolean(context.flow?.result)';
        if (type === 'fork') node.fork = { branches: [], join: '', maxConcurrency: 2, continueOnError: false };
        if (type === 'join') node.join = { strategy: 'all', cancelRemaining: false };
        if (type === 'gate') node.gate = { kind: 'human', prompt: 'Deseja continuar?', requireEvidence: false };
        if (type === 'wait') node.wait = { kind: 'event', eventName: 'continue' };
        if (type === 'subgraph') node.subgraph = { graphId: '', input: {}, output: {}, isolated: false };
        if (type === 'loop') node.loop = { bodyStart: '', condition: 'false', maxIterations: 3 };
        if (type === 'transform') node.condition = '({ result: context.flow?.result })';
        if (type === 'context') node.context = { query: 'Contexto relevante para a solicitação atual', scopes: ['workspace', 'project'], maxItems: 20, maxBytes: 131072, outputPath: 'context.pack', required: false };
        if (type === 'command') node.command = { command: 'node', args: ['--version'], timeoutMs: 30000, effect: 'read', requiredPermissions: ['tool:read'] };
        if (type === 'memory_write') node.memoryWrite = { scope: 'workflow', candidatesFrom: 'flow.memoryCandidates', policy: 'approved-only', onEmpty: 'skip', outputPath: 'memory.writes', idempotencyKey: `${node.id}:{{flow.request}}` };
        if (type === 'playbook') node.playbook = { playbookId: 'my-playbook', input: {}, parameters: {}, output: {}, isolated: false, idempotencyKey: `${node.id}:{{flow.request}}` };
        if (type === 'dynamic_parallel') node.dynamicParallel = { itemsFrom: 'context.flow?.items || []', itemVariable: 'item', worker: defaultEmbeddedNode('transform', 'worker'), concurrency: 4, maxItems: 50, failurePolicy: 'fail_fast', joinStrategy: 'collect', outputPath: 'parallel.results' };
        if (type === 'tournament') node.tournament = { candidatesFrom: 'context.flow?.candidates || []', judge: defaultEmbeddedNode('agent', 'judge'), strategy: 'single_round', criteria: ['Qualidade', 'Precisão'], winnerCount: 1, maxComparisons: 32, tieBreaker: 'judge_again', maxTieRounds: 2, outputPath: 'tournament.result' };
        return node;
    }

    function defaultEmbeddedNode(type, role) {
        const id = `${role}-${type}`;
        const node = { id, type, label: role === 'judge' ? 'Juiz' : 'Worker' };
        if (type === 'agent' || type === 'report') {
            node.prompt = role === 'judge'
                ? 'Avalie os candidatos somente pelos critérios informados e retorne JSON com winnerIds e scores.'
                : 'Processe {{item}} e devolva um resultado claro e estruturado.';
            node.provider = { runnerId: 'cybervinci', providerId: 'cybervinci', reasoningEffort: role === 'judge' ? 'high' : 'medium', serviceTier: 'default', fallbacks: [{ runnerId: 'opencode', providerId: 'opencode', reasoningEffort: role === 'judge' ? 'high' : 'medium' }] };
            node.rag = {};
        }
        if (type === 'transform') node.condition = role === 'judge'
            ? '({ winnerIds: [context.tournament.candidates[0].id] })'
            : '({ result: context.item })';
        if (type === 'command') node.command = { command: 'node', args: ['--version'], effect: 'read', timeoutMs: 30000, requiredPermissions: ['tool:read'] };
        if (type === 'action') node.tools = [{ id: `${id}-tool`, name: 'Ferramenta', command: 'tool-id', args: [], effect: 'read', requiredPermissions: ['tool:read'] }];
        if (type === 'context') node.context = { query: 'Contexto relevante para este item', scopes: ['workspace', 'project'], outputPath: 'context.pack' };
        if (type === 'memory_write') node.memoryWrite = { scope: 'workflow', candidatesFrom: 'flow.memoryCandidates', policy: 'approved-only', onEmpty: 'skip', outputPath: 'memory.writes', idempotencyKey: `${id}:{{flow.request}}` };
        if (type === 'playbook') node.playbook = { playbookId: 'my-playbook', input: {}, output: {}, idempotencyKey: `${id}:{{flow.request}}` };
        if (type === 'subgraph') node.subgraph = { graphId: 'subflow', input: {}, output: {}, isolated: false };
        return node;
    }

    function nodeSummary(node) {
        if (node.type === 'context') return `${node.context?.scopes?.length || 0} escopos · ${node.context?.outputPath || 'context.pack'}`;
        if (node.type === 'command') return `${node.command?.command || 'Configure o executável'} · ${node.command?.effect || 'command'}`;
        if (node.type === 'memory_write') return `${node.memoryWrite?.scope || 'workflow'} · somente aprovadas`;
        if (node.type === 'playbook') return node.playbook?.playbookId || 'Configure o playbook';
        if (node.type === 'dynamic_parallel') return `${node.dynamicParallel?.concurrency || 1} em paralelo · ${node.dynamicParallel?.worker?.label || 'worker'}`;
        if (node.type === 'tournament') return `${node.tournament?.strategy || 'single_round'} · ${node.tournament?.winnerCount || 1} vencedor(es)`;
        return node.provider?.modelId || node.provider?.profileId || node.provider?.providerId || '';
    }

    function StudioNode(props) {
        const node = props.data.node;
        const meta = catalogFor(node.type);
        const summary = nodeSummary(node);
        return h('article', { className: `node-card node-card--${node.type} ${props.selected ? 'is-selected' : ''}`, 'aria-label': `${meta.label}: ${node.label}` },
            h(Handle, { type: 'target', position: Position.Left, className: 'node-handle' }),
            h('header', null, h('span', { className: 'node-card__icon', 'aria-hidden': true }, meta.icon), h('span', { className: 'node-card__type' }, meta.label)),
            h('strong', null, node.label),
            node.description ? h('p', null, node.description) : null,
            summary ? h('span', { className: 'node-card__meta' }, summary) : null,
            h(Handle, { type: 'source', position: Position.Right, className: 'node-handle' })
        );
    }
    const nodeTypes = { studio: StudioNode };

    const toRfNode = node => ({ id: node.id, type: 'studio', position: node.position || { x: 100, y: 100 }, data: { node } });
    const toRfEdge = edge => ({
        id: edge.id || `${edge.from}->${edge.to}`,
        source: edge.from,
        target: edge.to,
        label: edge.label || '',
        data: { edge },
        markerEnd: { type: MarkerType.ArrowClosed },
        className: edge.outcome === 'back' ? 'edge-back' : ''
    });

    function Field(props) {
        return h('label', { className: `field ${props.wide ? 'field--wide' : ''}` },
            h('span', null, props.label),
            props.help ? h('small', null, props.help) : null,
            props.children
        );
    }
    function ChoiceGroup(props) {
        return h('fieldset', { className: `choice-field ${props.wide ? 'field--wide' : ''}` },
            h('legend', null, props.label),
            props.help ? h('small', null, props.help) : null,
            props.children
        );
    }
    const Text = props => h('input', { type: props.type || 'text', value: props.value ?? '', onChange: event => props.onChange(event.target.value), placeholder: props.placeholder, min: props.min, step: props.step, disabled: props.disabled, 'aria-label': props.ariaLabel || props.placeholder || undefined });
    const Area = props => h('textarea', { value: props.value ?? '', onChange: event => props.onChange(event.target.value), placeholder: props.placeholder, rows: props.rows || 4, 'aria-label': props.ariaLabel || props.placeholder || undefined });
    const Select = props => h('select', { value: props.value ?? '', onChange: event => props.onChange(event.target.value), disabled: props.disabled },
        props.empty !== undefined ? h('option', { value: '' }, props.empty) : null,
        props.options.map(option => typeof option === 'string' ? h('option', { key: option, value: option }, option) : h('option', { key: option.value, value: option.value }, option.label))
    );
    const Check = props => h('label', { className: 'check' }, h('input', { type: 'checkbox', checked: Boolean(props.value), onChange: event => props.onChange(event.target.checked) }), h('span', null, props.label));
    const IconButton = props => h('button', { type: 'button', className: `icon-button ${props.className || ''} ${props.active ? 'is-active' : ''} ${props.danger ? 'is-danger' : ''}`, onClick: props.onClick, title: props.title, 'aria-label': props.title, disabled: props.disabled }, props.icon);

    function ModalDialog({ children, close, labelledBy, className = '', initialFocusSelector, restoreFocusSelector = '[aria-label="Mais opções"]' }) {
        const dialogRef = React.useRef(null);
        const closeRef = React.useRef(close);
        const restoreFocusRef = React.useRef(null);
        closeRef.current = close;
        React.useEffect(() => {
            restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            const frame = requestAnimationFrame(() => {
                const target = (initialFocusSelector && dialogRef.current?.querySelector(initialFocusSelector))
                    || dialogRef.current?.querySelector('[data-autofocus], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])');
                target?.focus();
            });
            return () => {
                cancelAnimationFrame(frame);
                const previous = restoreFocusRef.current;
                const previousIsFocusable = previous?.isConnected
                    && previous !== document.body
                    && previous !== document.documentElement
                    && previous.matches('button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])');
                const target = previousIsFocusable ? previous : document.querySelector(restoreFocusSelector);
                if (target) requestAnimationFrame(() => target.focus());
            };
        }, []);
        const onKeyDown = event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeRef.current();
                return;
            }
            if (event.key !== 'Tab') return;
            const focusable = [...(dialogRef.current?.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])') || [])]
                .filter(element => element.getAttribute('aria-hidden') !== 'true' && element.getClientRects().length > 0);
            if (!focusable.length) {
                event.preventDefault();
                dialogRef.current?.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        return h('div', { className: 'modal-backdrop', role: 'presentation', onMouseDown: event => { if (event.target === event.currentTarget) closeRef.current(); } },
            h('section', { ref: dialogRef, className: `modal ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelledBy, tabIndex: -1, onKeyDown }, children));
    }

    function App() {
        const [graphPath, setGraphPath] = React.useState(params.get('path') || '');
        const [graph, setGraph] = React.useState(emptyGraph());
        const [nodes, setNodes, onNodesChange] = useNodesState([]);
        const [edges, setEdges, onEdgesChange] = useEdgesState([]);
        const [selectedNodeId, setSelectedNodeId] = React.useState('');
        const [selectedEdgeId, setSelectedEdgeId] = React.useState('');
        const [drawer, setDrawer] = React.useState('palette');
        const [paletteSearch, setPaletteSearch] = React.useState('');
        const [contextMenu, setContextMenu] = React.useState(null);
        const [dirty, setDirty] = React.useState(false);
        const [notice, setNotice] = React.useState({ text: 'Iniciando…', tone: 'neutral' });
        const [validation, setValidation] = React.useState(null);
        const [profiles, setProfiles] = React.useState([]);
        const [profileDraft, setProfileDraft] = React.useState({ id: '', name: '', providerId: '', modelId: '', runnerId: '', command: '', reasonDefault: 'medium', serviceTierDefault: 'default', tags: '', capabilities: '', description: '', contextWindow: '', maxOutputTokens: '', costPerMTokPrompt: '', costPerMTokOutput: '' });
        const [runInput, setRunInput] = React.useState('{\n  "prompt": "Descreva o trabalho"\n}');
        const [activeRun, setActiveRun] = React.useState(null);
        const [runHistory, setRunHistory] = React.useState([]);
        const [runComparison, setRunComparison] = React.useState(null);
        const [runTab, setRunTab] = React.useState('timeline');
        const [waitSignal, setWaitSignal] = React.useState({ eventName: '', correlationKey: '' });
        const [gateEvidence, setGateEvidence] = React.useState('');
        const [authorOpen, setAuthorOpen] = React.useState(false);
        const [authorInstruction, setAuthorInstruction] = React.useState('');
        const [authorProfileId, setAuthorProfileId] = React.useState('');
        const [authorPreview, setAuthorPreview] = React.useState(null);
        const [providerCatalogOpen, setProviderCatalogOpen] = React.useState(false);
        const [graphSpecOpen, setGraphSpecOpen] = React.useState(false);
        const [graphSpecDraft, setGraphSpecDraft] = React.useState('');
        const [busy, setBusy] = React.useState(false);
        const [history, setHistory] = React.useState([]);
        const [future, setFuture] = React.useState([]);
        const [advancedJson, setAdvancedJson] = React.useState('');
        const graphRef = React.useRef(graph);
        const flowInstanceRef = React.useRef(null);
        const inspectorRef = React.useRef(null);
        graphRef.current = graph;

        const selectedNode = graph.nodes.find(node => node.id === selectedNodeId);
        const selectedEdge = graph.edges.find(edge => (edge.id || `${edge.from}->${edge.to}`) === selectedEdgeId);

        const syncCanvas = React.useCallback(next => {
            setNodes(next.nodes.map(toRfNode));
            setEdges(next.edges.map(toRfEdge));
        }, [setNodes, setEdges]);

        const replaceGraph = React.useCallback((next, remember) => {
            const normalized = normalizeNodePositions(clone(next));
            if (remember) {
                setHistory(items => [...items.slice(-49), clone(graphRef.current)]);
                setFuture([]);
            }
            setGraph(normalized);
            graphRef.current = normalized;
            syncCanvas(normalized);
            setDirty(Boolean(remember));
        }, [syncCanvas]);

        const changeGraph = React.useCallback(transform => {
            replaceGraph(transform(clone(graphRef.current)), true);
        }, [replaceGraph]);

        const patchNode = React.useCallback((id, patch) => changeGraph(current => ({ ...current, nodes: current.nodes.map(node => node.id === id ? { ...node, ...patch } : node) })), [changeGraph]);
        const patchEdge = React.useCallback((id, patch) => changeGraph(current => ({ ...current, edges: current.edges.map(edge => (edge.id || `${edge.from}->${edge.to}`) === id ? { ...edge, ...patch } : edge) })), [changeGraph]);

        const loadProfiles = React.useCallback(async () => {
            const payload = await api('/api/profiles');
            setProfiles(payload.profiles || []);
            if (!authorProfileId && payload.profiles?.[0]) setAuthorProfileId(payload.profiles[0].id);
        }, [authorProfileId]);

        const loadRunHistory = React.useCallback(async () => {
            const payload = await api('/api/runs?limit=30');
            setRunHistory(payload.runs || []);
        }, []);

        const loadGraph = React.useCallback(async () => {
            setBusy(true);
            try {
                const payload = await api(graphPath ? `/api/graph?path=${encodeURIComponent(graphPath)}` : '/api/graph');
                replaceGraph(payload.graph, false);
                setGraphPath(payload.file || graphPath);
                setSelectedNodeId('');
                setSelectedEdgeId('');
                setNotice({ text: 'Fluxo carregado', tone: 'success' });
                setDirty(false);
                await loadProfiles();
            } catch (error) {
                setNotice({ text: error.message, tone: 'error' });
            } finally { setBusy(false); }
        }, [graphPath, replaceGraph, loadProfiles]);

        React.useEffect(() => { void loadGraph(); }, []);
        React.useEffect(() => {
            const onMessage = event => {
                if (event.source !== window.parent) return;
                if (event.data?.type !== 'flow-studio-theme') return;
                document.documentElement.dataset.theme = event.data.theme || 'dark';
                for (const [key, value] of Object.entries(event.data.tokens || {})) document.documentElement.style.setProperty(key, value);
            };
            window.addEventListener('message', onMessage);
            document.documentElement.dataset.theme = params.get('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
            return () => window.removeEventListener('message', onMessage);
        }, []);

        React.useEffect(() => {
            if (!selectedNode) { setAdvancedJson(''); return; }
            setAdvancedJson(JSON.stringify(selectedNode, null, 2));
        }, [selectedNodeId, selectedNode && JSON.stringify(selectedNode)]);

        React.useEffect(() => {
            if (drawer !== 'inspector' || (!selectedNodeId && !selectedEdgeId)) return undefined;
            const frame = requestAnimationFrame(() => inspectorRef.current?.focus());
            return () => cancelAnimationFrame(frame);
        }, [drawer, selectedNodeId, selectedEdgeId]);

        React.useEffect(() => {
            if (!activeRun?.id || TERMINAL.has(activeRun.status)) return undefined;
            let stopped = false;
            const poll = async () => {
                while (!stopped) {
                    try {
                        const payload = await api(`/api/runs/${activeRun.id}`);
                        if (stopped) return;
                        setActiveRun(payload.run);
                        if (TERMINAL.has(payload.run.status)) {
                            setNotice({ text: payload.run.status === 'completed' ? 'Execução concluída' : payload.run.status === 'waiting' ? 'Fluxo aguardando uma decisão' : `Execução: ${payload.run.status}`, tone: payload.run.status === 'completed' ? 'success' : payload.run.status === 'waiting' ? 'warning' : 'error' });
                            void loadRunHistory();
                            return;
                        }
                    } catch (error) { setNotice({ text: error.message, tone: 'error' }); return; }
                    await new Promise(resolve => setTimeout(resolve, 350));
                }
            };
            void poll();
            return () => { stopped = true; };
        }, [activeRun?.id, activeRun?.status, loadRunHistory]);

        const saveGraph = async () => {
            setBusy(true);
            try {
                const payload = await api('/api/graph', { method: 'POST', body: JSON.stringify({ path: graphPath, graph }) });
                setValidation(payload.validation);
                setDirty(false);
                setNotice({ text: 'Salvo', tone: 'success' });
            } catch (error) { setNotice({ text: error.message, tone: 'error' }); }
            finally { setBusy(false); }
        };

        const validate = async () => {
            setBusy(true);
            try {
                const payload = await api('/api/validate', { method: 'POST', body: JSON.stringify({ graph }) });
                setValidation(payload);
                setNotice({ text: payload.warnings?.length ? `Válido com ${payload.warnings.length} aviso(s)` : 'Fluxo válido', tone: payload.warnings?.length ? 'warning' : 'success' });
                setDrawer('validation');
            } catch (error) {
                setNotice({ text: error.message, tone: 'error' });
                setDrawer('validation');
                if (error.payload?.errors) setValidation(error.payload);
            } finally { setBusy(false); }
        };

        const run = async () => {
            let input;
            try { input = JSON.parse(runInput || '{}'); } catch { setNotice({ text: 'A entrada precisa ser JSON válido.', tone: 'error' }); return; }
            setBusy(true);
            setDrawer('run');
            try {
                const payload = await api('/api/runs', { method: 'POST', body: JSON.stringify({ graph, input }) });
                setActiveRun(payload.run);
                setRunComparison(null);
                await loadRunHistory();
                setNotice({ text: 'Execução iniciada', tone: 'neutral' });
            } catch (error) { setNotice({ text: error.message, tone: 'error' }); }
            finally { setBusy(false); }
        };

        const cancelRun = async () => {
            if (!activeRun?.id) return;
            await api(`/api/runs/${activeRun.id}/cancel`, { method: 'POST', body: '{}' });
            setNotice({ text: 'Cancelamento solicitado', tone: 'warning' });
        };

        const resumeRun = async body => {
            if (!activeRun?.id) return;
            setBusy(true);
            try {
                const payload = await api(`/api/runs/${activeRun.id}/resume`, { method: 'POST', body: JSON.stringify(body) });
                setActiveRun(payload.run);
                setNotice({ text: 'Execução retomada', tone: 'neutral' });
            } catch (error) { setNotice({ text: error.message, tone: 'error' }); }
            finally { setBusy(false); }
        };

        const replayRun = async checkpointId => {
            if (!activeRun?.id) return;
            const payload = await api(`/api/runs/${activeRun.id}/replay`, { method: 'POST', body: JSON.stringify({ checkpointId }) });
            setActiveRun(payload.run);
            setNotice({ text: 'Replay criado sem repetir efeitos confirmados', tone: 'neutral' });
        };

        const openRun = async runId => {
            const payload = await api(`/api/runs/${runId}`);
            setActiveRun(payload.run);
            setRunComparison(null);
            setRunTab('timeline');
        };

        const compareRun = async otherRunId => {
            if (!activeRun?.id || !otherRunId || activeRun.id === otherRunId) return;
            const payload = await api(`/api/runs/compare?left=${encodeURIComponent(otherRunId)}&right=${encodeURIComponent(activeRun.id)}`);
            setRunComparison(payload.comparison);
            setRunTab('result');
        };

        const addNodeAt = (type, position) => {
            const node = defaultNode(type, findAvailableNodePosition(graphRef.current.nodes, position));
            changeGraph(current => ({ ...current, start: current.start || node.id, nodes: [...current.nodes, node] }));
            setSelectedNodeId(node.id);
            setSelectedEdgeId('');
            setDrawer('inspector');
        };

        const removeNode = id => {
            changeGraph(current => ({ ...current, start: current.start === id ? '' : current.start, nodes: current.nodes.filter(node => node.id !== id), edges: current.edges.filter(edge => edge.from !== id && edge.to !== id) }));
            setSelectedNodeId('');
        };
        const duplicateNode = id => {
            const source = graph.nodes.find(node => node.id === id);
            if (!source) return;
            const copy = { ...clone(source), id: uid(source.type), label: `${source.label} (cópia)`, position: findAvailableNodePosition(graphRef.current.nodes, { x: (source.position?.x || 0) + 240, y: source.position?.y || 0 }) };
            changeGraph(current => ({ ...current, nodes: [...current.nodes, copy] }));
            setSelectedNodeId(copy.id);
        };
        const removeEdge = id => { changeGraph(current => ({ ...current, edges: current.edges.filter(edge => (edge.id || `${edge.from}->${edge.to}`) !== id) })); setSelectedEdgeId(''); };

        const undo = () => {
            if (!history.length) return;
            const previous = history[history.length - 1];
            setHistory(history.slice(0, -1));
            setFuture(items => [clone(graphRef.current), ...items].slice(0, 50));
            replaceGraph(previous, false);
            setDirty(true);
        };
        const redo = () => {
            if (!future.length) return;
            const next = future[0];
            setFuture(future.slice(1));
            setHistory(items => [...items, clone(graphRef.current)].slice(-50));
            replaceGraph(next, false);
            setDirty(true);
        };

        React.useEffect(() => {
            const handler = event => {
                const tag = event.target?.tagName?.toLowerCase();
                if (['input', 'textarea', 'select'].includes(tag) || event.target?.isContentEditable) return;
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void saveGraph(); }
                else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void run(); }
                else if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'v') { event.preventDefault(); void validate(); }
                else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
                else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
                else if (event.key === 'Delete' || event.key === 'Backspace') { if (selectedNodeId) removeNode(selectedNodeId); else if (selectedEdgeId) removeEdge(selectedEdgeId); }
                else if (event.key === 'Escape') { setContextMenu(null); setAuthorOpen(false); }
            };
            window.addEventListener('keydown', handler);
            return () => window.removeEventListener('keydown', handler);
        }, [history, future, selectedNodeId, selectedEdgeId, graph, runInput]);

        const onConnect = connection => {
            const edge = { id: uid('edge'), from: connection.source, to: connection.target, priority: graph.edges.filter(item => item.from === connection.source).length };
            changeGraph(current => ({ ...current, edges: [...current.edges, edge] }));
        };
        const onNodeDragStop = (_event, rfNode) => {
            const current = graphRef.current.nodes.find(node => node.id === rfNode.id)?.position;
            if (current?.x === rfNode.position.x && current?.y === rfNode.position.y) return;
            patchNode(rfNode.id, { position: rfNode.position });
        };
        const onPaneContextMenu = event => {
            event.preventDefault();
            const flowPosition = flowInstanceRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) || { x: 160, y: 120 };
            setContextMenu({ kind: 'canvas', x: event.clientX, y: event.clientY, flowPosition });
        };
        const onNodeContextMenu = (event, rfNode) => { event.preventDefault(); setContextMenu({ kind: 'node', id: rfNode.id, x: event.clientX, y: event.clientY }); };
        const onEdgeContextMenu = (event, rfEdge) => { event.preventDefault(); setContextMenu({ kind: 'edge', id: rfEdge.id, x: event.clientX, y: event.clientY }); };

        const createWithAi = async () => {
            if (!authorInstruction.trim()) return;
            setBusy(true);
            try {
                const payload = await api('/api/author', { method: 'POST', body: JSON.stringify({ instruction: authorInstruction, profileId: authorProfileId, currentGraph: graph }) });
                setAuthorPreview(payload);
            } catch (error) { setNotice({ text: error.message, tone: 'error' }); }
            finally { setBusy(false); }
        };

        const openGraphSpecEditor = () => {
            setGraphSpecDraft(JSON.stringify(graphRef.current, null, 2));
            setGraphSpecOpen(true);
        };
        const applyGraphSpec = () => {
            try {
                const parsed = JSON.parse(graphSpecDraft);
                if (parsed.version !== 'flow-studio/v2' || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) throw new Error('Use um GraphSpec flow-studio/v2 com nodes e edges.');
                replaceGraph(parsed, true);
                setGraphSpecOpen(false);
                setNotice({ text: 'GraphSpec aplicado; valide antes de executar.', tone: 'warning' });
            } catch (error) { setNotice({ text: error.message, tone: 'error' }); }
        };
        const saveAndOpenGraphSpecInIde = async () => {
            try {
                const parsed = JSON.parse(graphSpecDraft);
                const payload = await api('/api/graph', { method: 'POST', body: JSON.stringify({ path: graphPath, graph: parsed }) });
                replaceGraph(parsed, false);
                setGraphPath(payload.file || graphPath);
                setGraphSpecOpen(false);
                setDirty(false);
                window.parent.postMessage({ type: 'flow-studio-open-graphspec' }, '*');
                setNotice({ text: 'GraphSpec salvo e aberto no editor da IDE', tone: 'success' });
            } catch (error) { setNotice({ text: error.message, tone: 'error' }); }
        };

        const saveProfiles = async nextProfiles => {
            const payload = await api('/api/profiles', { method: 'POST', body: JSON.stringify({ profiles: nextProfiles }) });
            setProfiles(nextProfiles);
            setNotice({ text: `${payload.count} perfil(is) salvo(s)`, tone: 'success' });
        };
        const upsertProfile = async () => {
            if (!profileDraft.id || !profileDraft.providerId || !profileDraft.modelId) { setNotice({ text: 'Perfil, provider e modelo são obrigatórios.', tone: 'error' }); return; }
            const normalized = {
                ...profileDraft,
                name: profileDraft.name || profileDraft.id,
                runnerId: profileDraft.runnerId || undefined,
                tags: profileDraft.tags.split(',').map(item => item.trim()).filter(Boolean),
                capabilities: profileDraft.capabilities.split(',').map(item => item.trim()).filter(Boolean),
                command: profileDraft.command || undefined,
                contextWindow: profileDraft.contextWindow ? Number(profileDraft.contextWindow) : undefined,
                maxOutputTokens: profileDraft.maxOutputTokens ? Number(profileDraft.maxOutputTokens) : undefined,
                costPerMTokPrompt: profileDraft.costPerMTokPrompt ? Number(profileDraft.costPerMTokPrompt) : undefined,
                costPerMTokOutput: profileDraft.costPerMTokOutput ? Number(profileDraft.costPerMTokOutput) : undefined
            };
            await saveProfiles([...profiles.filter(item => item.id !== normalized.id), normalized]);
            setProfileDraft({ id: '', name: '', providerId: '', modelId: '', runnerId: '', command: '', reasonDefault: 'medium', serviceTierDefault: 'default', tags: '', capabilities: '', description: '', contextWindow: '', maxOutputTokens: '', costPerMTokPrompt: '', costPerMTokOutput: '' });
        };
        const useCatalogModel = async (providerId, modelId) => {
            const payload = await api('/api/providers/profile', { method: 'POST', body: JSON.stringify({ providerId, modelId }) });
            const profile = payload.profile;
            await saveProfiles([...profiles.filter(item => item.id !== profile.id), profile]);
            setAuthorProfileId(profile.id);
            setNotice({ text: `${profile.name} disponível para todos os agentes.`, tone: 'success' });
            return profile;
        };

        const nodeInspector = selectedNode && h(NodeInspector, {
            node: selectedNode,
            graph,
            profiles,
            patch: patch => patchNode(selectedNode.id, patch),
            remove: () => removeNode(selectedNode.id),
            setStart: () => changeGraph(current => ({ ...current, start: selectedNode.id })),
            advancedJson,
            setAdvancedJson,
            applyAdvanced: () => {
                try {
                    const parsed = JSON.parse(advancedJson);
                    if (parsed.id !== selectedNode.id) throw new Error('O id não pode mudar pelo editor avançado.');
                    patchNode(selectedNode.id, parsed);
                } catch (error) { setNotice({ text: error.message, tone: 'error' }); }
            }
        });

        const edgeInspector = selectedEdge && h('section', { className: 'inspector-section' },
            h('div', { className: 'inspector-heading' }, h('div', null, h('small', null, 'Conexão'), h('h2', null, `${selectedEdge.from} → ${selectedEdge.to}`)), IconButton({ icon: '×', title: 'Fechar', onClick: () => { setSelectedEdgeId(''); setDrawer(''); } })),
            h(Field, { label: 'Rótulo' }, h(Text, { value: selectedEdge.label, onChange: value => patchEdge(selectedEdgeId, { label: value || undefined }) })),
            h(Field, { label: 'Condição da rota', help: 'Opcional. Ex.: condition === true' }, h(Area, { value: selectedEdge.guard, onChange: value => patchEdge(selectedEdgeId, { guard: value || undefined }), rows: 3 })),
            h('div', { className: 'field-grid' },
                h(Field, { label: 'Prioridade' }, h(Text, { type: 'number', value: selectedEdge.priority ?? 0, onChange: value => patchEdge(selectedEdgeId, { priority: Number(value) || 0 }) })),
                h(Field, { label: 'Direção' }, h(Select, { value: selectedEdge.outcome || 'forward', options: ['forward', 'back'], onChange: value => patchEdge(selectedEdgeId, { outcome: value }) }))
            ),
            h('button', { className: 'button button--danger button--wide', onClick: () => removeEdge(selectedEdgeId) }, 'Remover conexão')
        );

        const groups = [...new Set(NODE_CATALOG.map(item => item.group))];
        const normalizedPaletteSearch = normalizeSearch(paletteSearch);
        const visibleCatalog = NODE_CATALOG.filter(item => normalizeSearch(`${item.label} ${item.help} ${item.group}`).includes(normalizedPaletteSearch));
        const palette = h('section', { className: 'drawer drawer--left', 'aria-label': 'Paleta de nós' },
            h('div', { className: 'drawer__heading' }, h('div', null, h('small', null, 'Adicionar'), h('h2', null, 'Blocos do fluxo')), IconButton({ icon: '×', title: 'Fechar paleta', onClick: () => setDrawer('') })),
            h(Text, { value: paletteSearch, onChange: setPaletteSearch, placeholder: 'Buscar bloco…', ariaLabel: 'Buscar bloco' }),
            h('div', { className: 'palette-list' }, visibleCatalog.length ? groups.map(group => {
                const items = visibleCatalog.filter(item => item.group === group);
                return items.length ? h(
                    'section',
                    { key: group },
                    h('h3', null, group),
                    items.map(item => h(
                        'button',
                        { key: item.type, className: `palette-item palette-item--${item.type}`, onClick: () => addNodeAt(item.type) },
                        h('span', { 'aria-hidden': true }, item.icon),
                        h('span', null, h('strong', null, item.label), h('small', null, item.help))
                    ))
                ) : null;
            }) : h('div', { className: 'empty-state palette-empty', role: 'status' },
                h('span', { 'aria-hidden': true }, '⌕'),
                h('strong', null, 'Nenhum bloco encontrado'),
                h('p', null, `Não encontramos “${paletteSearch}”. Tente outro termo.`),
                h('button', { className: 'button button--ghost button--small', onClick: () => setPaletteSearch('') }, 'Limpar busca')
            ))
        );

        const runDrawer = h(RunDrawer, { run: activeRun, runs: runHistory, comparison: runComparison, graph, input: runInput, setInput: setRunInput, tab: runTab, setTab: setRunTab, onRun: run, onCancel: cancelRun, onReplay: replayRun, onResume: resumeRun, onOpenRun: openRun, onCompare: compareRun, onRefresh: loadRunHistory, waitSignal, setWaitSignal, gateEvidence, setGateEvidence, close: () => setDrawer(''), busy });
        const profilesDrawer = h(ProfilesDrawer, { profiles, draft: profileDraft, setDraft: setProfileDraft, save: upsertProfile, remove: id => saveProfiles(profiles.filter(item => item.id !== id)), openCatalog: () => setProviderCatalogOpen(true), close: () => setDrawer('') });
        const validationDrawer = h(ValidationDrawer, { validation, close: () => setDrawer(''), onValidate: validate });

        return h('div', { className: 'studio-shell', onContextMenu: event => { if (!event.defaultPrevented) event.preventDefault(); } },
            h('header', { className: 'topbar' },
                h('div', { className: 'brand' }, h('span', { className: 'brand__mark', 'aria-hidden': true }, '◆'), h('div', null, h('strong', null, graph.name || 'Flow Studio'), h('small', null, dirty ? 'Alterações não salvas' : 'Salvo'))),
                h('div', { className: `notice notice--${notice.tone}`, role: 'status', 'aria-live': 'polite' }, busy ? h('span', { className: 'spinner', 'aria-hidden': true }) : null, notice.text),
                h('nav', { className: 'topbar__actions', 'aria-label': 'Ações do fluxo' },
                    IconButton({ icon: '↶', title: 'Desfazer (Ctrl+Z)', onClick: undo, disabled: !history.length }),
                    IconButton({ icon: '↷', title: 'Refazer (Ctrl+Y)', onClick: redo, disabled: !future.length }),
                    h('button', { className: 'button button--ghost topbar-action--author', onClick: () => { setAuthorOpen(true); setAuthorPreview(null); } }, '✦ Criar com IA'),
                    h('button', { className: 'button button--ghost topbar-action--models', onClick: () => setProviderCatalogOpen(true) }, '◈ Modelos'),
                    h('button', { className: 'button button--ghost topbar-action--save', onClick: saveGraph, disabled: busy }, 'Salvar'),
                    h('button', { className: 'button button--primary topbar-action--run', onClick: run, disabled: busy }, 'Executar'),
                    IconButton({ className: 'topbar-action--more', icon: '•••', title: 'Mais opções', onClick: () => setContextMenu({ kind: 'more', x: window.innerWidth - 230, y: 54 }) })
                )
            ),
            h('main', { className: 'workspace' },
                h('div', { className: 'canvas-toolbar', role: 'toolbar', 'aria-label': 'Ferramentas do canvas' },
                    IconButton({ icon: '+', title: 'Abrir paleta', active: drawer === 'palette', onClick: () => setDrawer(drawer === 'palette' ? '' : 'palette') }),
                    IconButton({ icon: '◎', title: 'Execução e histórico', active: drawer === 'run', onClick: () => { const opening = drawer !== 'run'; setDrawer(opening ? 'run' : ''); if (opening) void loadRunHistory(); } }),
                    IconButton({ icon: '✓', title: 'Validação', active: drawer === 'validation', onClick: () => setDrawer(drawer === 'validation' ? '' : 'validation') })
                ),
                drawer === 'palette' ? palette : null,
                h('section', { className: 'canvas', 'aria-label': 'Canvas do fluxo' },
                    h(ReactFlowProvider, null,
                        h(ReactFlow, {
                            nodes, edges, nodeTypes, onNodesChange, onEdgesChange, onConnect, onNodeDragStop,
                            onInit: instance => { flowInstanceRef.current = instance; },
                            onNodeClick: (_event, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(''); setDrawer('inspector'); },
                            onEdgeClick: (_event, edge) => { setSelectedEdgeId(edge.id); setSelectedNodeId(''); setDrawer('inspector'); },
                            onPaneClick: () => { setSelectedNodeId(''); setSelectedEdgeId(''); setContextMenu(null); if (drawer === 'inspector') setDrawer(''); },
                            onPaneContextMenu, onNodeContextMenu, onEdgeContextMenu,
                            fitView: true, minZoom: 0.2, maxZoom: 2, snapToGrid: true, snapGrid: [16, 16],
                            deleteKeyCode: null, multiSelectionKeyCode: 'Shift', selectionKeyCode: 'Shift',
                            proOptions: { hideAttribution: true }
                        }, h(Background, { gap: 24, size: 1 }), h(Controls, { showInteractive: false }), h(MiniMap, { pannable: true, zoomable: true, nodeColor: node => `var(--node-${node.data.node.type}, var(--accent))` })))
                ),
                drawer === 'inspector' && (nodeInspector || edgeInspector) ? h('aside', { ref: inspectorRef, className: 'drawer drawer--right', 'aria-label': 'Inspector', tabIndex: -1 }, nodeInspector || edgeInspector) : null,
                drawer === 'run' ? runDrawer : null,
                drawer === 'profiles' ? profilesDrawer : null,
                drawer === 'validation' ? validationDrawer : null
            ),
            contextMenu ? h(ContextMenu, { menu: contextMenu, close: () => setContextMenu(null), add: type => addNodeAt(type, contextMenu.flowPosition), openPalette: () => { setPaletteSearch(''); setDrawer('palette'); }, duplicate: () => duplicateNode(contextMenu.id), removeNode: () => removeNode(contextMenu.id), setStart: () => changeGraph(current => ({ ...current, start: contextMenu.id })), removeEdge: () => removeEdge(contextMenu.id), load: loadGraph, save: saveGraph, author: () => { setAuthorOpen(true); setAuthorPreview(null); }, validate, graphSpec: openGraphSpecEditor, profiles: () => setDrawer('profiles'), run: () => setDrawer('run') }) : null,
            authorOpen ? h(AuthorDialog, { instruction: authorInstruction, setInstruction: setAuthorInstruction, profiles, profileId: authorProfileId, setProfileId: setAuthorProfileId, preview: authorPreview, generate: createWithAi, apply: () => { replaceGraph(authorPreview.graph, true); setAuthorOpen(false); setNotice({ text: 'Proposta da IA aplicada; revise e salve.', tone: 'warning' }); }, close: () => setAuthorOpen(false), busy }) : null,
            providerCatalogOpen ? h(ProviderCatalogDialog, { profiles, useModel: useCatalogModel, close: () => setProviderCatalogOpen(false) }) : null,
            graphSpecOpen ? h(ModalDialog, { close: () => setGraphSpecOpen(false), labelledBy: 'graphspec-title', className: 'modal--graphspec', initialFocusSelector: '.graphspec-editor' }, h('div', { className: 'drawer__heading' }, h('div', null, h('small', null, 'Modo avançado'), h('h2', { id: 'graphspec-title' }, 'GraphSpec completo')), IconButton({ icon: '×', title: 'Fechar GraphSpec', onClick: () => setGraphSpecOpen(false) })), h('p', { className: 'muted' }, 'A interface visual e este documento editam a mesma fonte de verdade. Na IDE, você também pode abrir o arquivo no editor Monaco completo.'), h('textarea', { className: 'graphspec-editor', value: graphSpecDraft, onChange: event => setGraphSpecDraft(event.target.value), spellCheck: false, 'aria-label': 'GraphSpec JSON completo' }), h('div', { className: 'modal-actions' }, h('button', { className: 'button button--ghost', onClick: () => setGraphSpecOpen(false) }, 'Cancelar'), h('button', { className: 'button button--ghost', onClick: saveAndOpenGraphSpecInIde }, 'Salvar e abrir na IDE'), h('button', { className: 'button button--primary', onClick: applyGraphSpec }, 'Aplicar GraphSpec'))) : null
        );
    }

    function NodeInspector({ node, graph, profiles, patch, remove, setStart, advancedJson, setAdvancedJson, applyAdvanced }) {
        const meta = catalogFor(node.type);
        const nodeOptions = graph.nodes.filter(item => item.id !== node.id).map(item => ({ value: item.id, label: item.label }));
        const profileOptions = profiles.map(item => ({ value: item.id, label: profileOptionLabel(item) }));
        const setProfile = id => {
            const profile = profiles.find(item => item.id === id);
            if (!profile) return patch({ provider: { ...(node.provider || {}), profileId: undefined, modelId: undefined } });
            patch({ provider: { ...(node.provider || {}), providerId: profile.providerId, modelId: profile.modelId, profileId: profile.id, reasoningEffort: node.provider?.reasoningEffort || profile.reasonDefault || 'medium' } });
        };
        return h(React.Fragment, null,
            h('div', { className: 'inspector-heading' }, h('div', null, h('small', null, `${meta.icon} ${meta.label}`), h('h2', null, node.label)), IconButton({ icon: '×', title: 'Fechar inspector', onClick: () => document.querySelector('.react-flow__pane')?.click() })),
            h('section', { className: 'inspector-section' },
                h(Field, { label: 'Nome', wide: true }, h(Text, { value: node.label, onChange: value => patch({ label: value }) })),
                h(Field, { label: 'Descrição', wide: true }, h(Area, { value: node.description, onChange: value => patch({ description: value || undefined }), rows: 2, placeholder: 'O que este bloco faz?' }))
            ),
            (node.type === 'agent' || node.type === 'report') ? h('section', { className: 'inspector-section' },
                h('h3', null, 'Instrução'),
                h(Field, { label: 'Prompt', help: 'Use {{flow.campo}} para inserir estado.', wide: true }, h(Area, { value: node.prompt, onChange: value => patch({ prompt: value }), rows: 8, placeholder: 'Descreva o resultado esperado…' })),
                h('h3', null, 'Modelo deste agente'),
                h(Field, { label: 'Assinatura / perfil', wide: true }, h(Select, { value: node.provider?.profileId || '', empty: 'Escolher manualmente', options: profileOptions, onChange: setProfile })),
                h('div', { className: 'field-grid' },
                    h(Field, { label: 'Provider' }, h(Text, { value: node.provider?.providerId, onChange: value => patch({ provider: { ...(node.provider || {}), providerId: value } }) })),
                    h(Field, { label: 'Modelo' }, h(Text, { value: node.provider?.modelId, onChange: value => patch({ provider: { ...(node.provider || {}), modelId: value } }) })),
                    h(Field, { label: 'Raciocínio' }, h(Select, { value: node.provider?.reasoningEffort || 'medium', options: REASONING, onChange: value => patch({ provider: { ...(node.provider || {}), reasoningEffort: value } }) })),
                    h(Field, { label: 'Prioridade' }, h(Select, { value: node.provider?.serviceTier || 'default', options: TIERS, onChange: value => patch({ provider: { ...(node.provider || {}), serviceTier: value } }) }))
                ),
                h('details', { className: 'details' }, h('summary', null, 'Contexto e RAG'),
                    h(Field, { label: 'Markdown inicial', wide: true }, h(Area, { value: node.rag?.markdown, onChange: value => patch({ rag: { ...(node.rag || {}), markdown: value || undefined } }), rows: 5, placeholder: 'Identidade, regras e contexto estável do agente.' })),
                    h(Field, { label: 'Arquivo Markdown', help: 'Precisa estar em uma raiz autorizada.', wide: true }, h(Text, { value: node.rag?.filePath, onChange: value => patch({ rag: { ...(node.rag || {}), filePath: value || undefined } }), placeholder: 'agents/reviewer.md' }))
                )
            ) : null,
            node.type === 'agent' ? h(ToolEditor, { node, patch }) : null,
            h(TypeInspector, { node, graph, profiles, patch, nodeOptions }),
            node.type !== 'end' && node.type !== 'fork' && node.type !== 'router' ? h('section', { className: 'inspector-section' }, h(Field, { label: 'Próximo bloco', wide: true }, h(Select, { value: node.next || '', empty: 'Usar conexão do canvas', options: nodeOptions, onChange: value => patch({ next: value || undefined }) }))) : null,
            h('section', { className: 'inspector-section' },
                h('h3', null, 'Saídas para o estado'),
                h(Field, { label: 'Uma por linha: saída → namespace.campo', wide: true }, h(Area, { value: mapToText(node.outputs), onChange: value => patch({ outputs: textToMap(value) }), rows: 4, placeholder: 'result → flow.result' })),
                h('details', { className: 'details' }, h('summary', null, 'Avançado · JSON deste bloco'), h(Area, { value: advancedJson, onChange: setAdvancedJson, rows: 14 }), h('button', { className: 'button button--ghost button--wide', onClick: applyAdvanced }, 'Aplicar JSON')),
                h('div', { className: 'danger-zone' }, h('button', { className: 'button button--ghost', onClick: setStart }, graph.start === node.id ? 'É o início' : 'Definir como início'), h('button', { className: 'button button--danger', onClick: remove }, 'Remover bloco'))
            )
        );
    }

    function TypeInspector({ node, graph, profiles, patch, nodeOptions }) {
        if (node.type === 'action') return h(ToolEditor, { node, patch });
        if (node.type === 'context') return h(ContextEditor, { node, patch });
        if (node.type === 'command') return h(CommandEditor, { node, patch });
        if (node.type === 'memory_write') return h(MemoryWriteEditor, { node, patch });
        if (node.type === 'playbook') return h(PlaybookEditor, { node, patch });
        if (node.type === 'dynamic_parallel') return h(DynamicParallelEditor, { node, profiles, patch });
        if (node.type === 'tournament') return h(TournamentEditor, { node, profiles, patch });
        if (node.type === 'router') return h('section', { className: 'inspector-section' }, h('h3', null, 'Condição'), h(Field, { label: 'Expressão booleana', wide: true }, h(Area, { value: node.condition, onChange: value => patch({ condition: value }), rows: 4 })));
        if (node.type === 'fork') return h('section', { className: 'inspector-section' }, h('h3', null, 'Branches'),
            h(Field, { label: 'Inícios das branches', help: 'Selecione blocos independentes.', wide: true }, h('div', { className: 'choice-list' }, graph.nodes.filter(item => item.id !== node.id && item.type !== 'join').map(item => h(Check, { key: item.id, label: item.label, value: node.fork?.branches?.includes(item.id), onChange: checked => patch({ fork: { ...(node.fork || {}), branches: checked ? [...(node.fork?.branches || []), item.id] : (node.fork?.branches || []).filter(id => id !== item.id) } }) })))),
            h(Field, { label: 'Join de destino', wide: true }, h(Select, { value: node.fork?.join || '', empty: 'Selecione um Join', options: graph.nodes.filter(item => item.type === 'join').map(item => ({ value: item.id, label: item.label })), onChange: value => patch({ fork: { ...(node.fork || {}), join: value } }) })),
            h('div', { className: 'field-grid' }, h(Field, { label: 'Concorrência' }, h(Text, { type: 'number', min: 1, value: node.fork?.maxConcurrency || 2, onChange: value => patch({ fork: { ...(node.fork || {}), maxConcurrency: Math.max(1, Number(value) || 1) } }) })), h(Check, { label: 'Continuar se uma branch falhar', value: node.fork?.continueOnError, onChange: value => patch({ fork: { ...(node.fork || {}), continueOnError: value } }) }))
        );
        if (node.type === 'join') return h('section', { className: 'inspector-section' }, h('h3', null, 'Consolidação'), h(Field, { label: 'Estratégia', wide: true }, h(Select, { value: node.join?.strategy || 'all', options: JOIN_STRATEGIES, onChange: value => patch({ join: { ...(node.join || {}), strategy: value } }) })), node.join?.strategy === 'quorum' ? h(Field, { label: 'Quorum' }, h(Text, { type: 'number', min: 1, value: node.join?.quorum || 1, onChange: value => patch({ join: { ...(node.join || {}), quorum: Math.max(1, Number(value) || 1) } }) })) : null, h(Check, { label: 'Cancelar branches restantes', value: node.join?.cancelRemaining, onChange: value => patch({ join: { ...(node.join || {}), cancelRemaining: value } }) }));
        if (node.type === 'gate') return h(GateEditor, { node, patch, nodeOptions, profiles });
        if (node.type === 'wait') return h(WaitEditor, { node, patch });
        if (node.type === 'subgraph') return h('section', { className: 'inspector-section' }, h('h3', null, 'Subfluxo'), h(Field, { label: 'Id do subgrafo embutido' }, h(Text, { value: node.subgraph?.graphId, onChange: value => patch({ subgraph: { ...(node.subgraph || {}), graphId: value || undefined } }) })), h(Field, { label: 'Ou arquivo de grafo' }, h(Text, { value: node.subgraph?.graphRef, onChange: value => patch({ subgraph: { ...(node.subgraph || {}), graphRef: value || undefined } }) })), h(Field, { label: 'Entradas: estado → campo do subfluxo' }, h(Area, { value: mapToText(node.subgraph?.input), onChange: value => patch({ subgraph: { ...(node.subgraph || {}), input: textToMap(value) } }) })), h(Field, { label: 'Saídas: campo → estado' }, h(Area, { value: mapToText(node.subgraph?.output), onChange: value => patch({ subgraph: { ...(node.subgraph || {}), output: textToMap(value) } }) })), h(Check, { label: 'Estado isolado', value: node.subgraph?.isolated, onChange: value => patch({ subgraph: { ...(node.subgraph || {}), isolated: value } }) }));
        if (node.type === 'loop') return h('section', { className: 'inspector-section' }, h('h3', null, 'Repetição segura'), h(Field, { label: 'Início do corpo' }, h(Select, { value: node.loop?.bodyStart || '', empty: 'Selecione', options: nodeOptions, onChange: value => patch({ loop: { ...(node.loop || {}), bodyStart: value } }) })), h(Field, { label: 'Enquanto' }, h(Area, { value: node.loop?.condition, onChange: value => patch({ loop: { ...(node.loop || {}), condition: value } }), rows: 3 })), h(Field, { label: 'Máximo de iterações' }, h(Text, { type: 'number', min: 1, value: node.loop?.maxIterations || 1, onChange: value => patch({ loop: { ...(node.loop || {}), maxIterations: Math.max(1, Number(value) || 1) } }) })), h(Field, { label: 'Parar quando (opcional)' }, h(Area, { value: node.loop?.breakWhen, onChange: value => patch({ loop: { ...(node.loop || {}), breakWhen: value || undefined } }), rows: 2 })));
        if (node.type === 'transform') return h('section', { className: 'inspector-section' }, h('h3', null, 'Transformação'), h(Field, { label: 'Expressão que retorna objeto', wide: true }, h(Area, { value: node.condition, onChange: value => patch({ condition: value }), rows: 5 })));
        return null;
    }

    function WaitEditor({ node, patch }) {
        const wait = node.wait || { kind: 'event', eventName: 'continue' };
        const update = change => patch({ wait: { ...wait, ...change } });
        const setKind = kind => patch({ wait: kind === 'duration'
            ? { kind, durationMs: wait.durationMs || 1000 }
            : kind === 'until'
                ? { kind, until: wait.until || new Date(Date.now() + 3600000).toISOString() }
                : { kind, eventName: wait.eventName || 'continue', correlationKey: wait.correlationKey, timeoutMs: wait.timeoutMs, onTimeout: wait.timeoutMs ? wait.onTimeout || 'fail' : undefined }
        });
        const setTimeoutMs = value => {
            const timeoutMs = value ? Math.max(1, Number(value) || 1) : undefined;
            update({ timeoutMs, onTimeout: timeoutMs ? wait.onTimeout || 'fail' : undefined });
        };
        return h('section', { className: 'inspector-section' },
            h('h3', null, 'Espera durável'),
            h(Field, { label: 'Tipo', wide: true }, h(Select, { value: wait.kind, options: ['duration', 'until', 'event'], onChange: setKind })),
            wait.kind === 'duration' ? h(Field, { label: 'Duração em ms' }, h(Text, { type: 'number', min: 1, value: wait.durationMs || 1000, onChange: value => update({ durationMs: Number(value) || 1 }) })) : null,
            wait.kind === 'until' ? h(Field, { label: 'Data/hora ISO' }, h(Text, { value: wait.until, onChange: value => update({ until: value }) })) : null,
            wait.kind === 'event' ? h(React.Fragment, null,
                h(Field, { label: 'Nome do evento' }, h(Text, { value: wait.eventName, onChange: value => update({ eventName: value }) })),
                h(Field, { label: 'Chave de correlação', help: 'Opcional. Use para distinguir instâncias do mesmo evento.' }, h(Text, { value: wait.correlationKey, onChange: value => update({ correlationKey: value || undefined }) })),
                h(Field, { label: 'Timeout opcional (ms)', help: 'Sem valor, o fluxo aguarda o evento sem prazo.' }, h(Text, { type: 'number', min: 1, value: wait.timeoutMs || '', placeholder: 'Sem timeout', onChange: setTimeoutMs })),
                wait.timeoutMs ? h(Field, { label: 'Ao expirar' }, h(Select, { value: wait.onTimeout || 'fail', options: [{ value: 'fail', label: 'Falhar o fluxo' }, { value: 'continue', label: 'Continuar o fluxo' }], onChange: value => update({ onTimeout: value }) })) : null
            ) : null
        );
    }

    function ContextEditor({ node, patch }) {
        const config = node.context || {};
        const update = change => patch({ context: { ...config, ...change } });
        const scopes = config.scopes || [];
        return h('section', { className: 'inspector-section' },
            h('h3', null, 'Contexto necessário'),
            h(Field, { label: 'O que buscar?', help: 'Descreva o contexto de que a próxima etapa precisa.', wide: true }, h(Area, { value: config.query, onChange: value => update({ query: value || undefined }), rows: 3, placeholder: 'Decisões recentes, convenções do projeto…' })),
            h(ChoiceGroup, { label: 'Onde buscar', wide: true }, h('div', { className: 'choice-list choice-list--compact' }, MEMORY_SCOPES.map(scope => h(Check, { key: scope.value, label: scope.label, value: scopes.includes(scope.value), onChange: checked => update({ scopes: checked ? [...scopes, scope.value] : scopes.filter(item => item !== scope.value) }) })))),
            scopes.includes('agent') ? h(Field, { label: 'ID do agente', help: 'Identifica de forma estável qual agente é dono deste contexto.', wide: true }, h(Text, { value: config.scopeId, onChange: value => update({ scopeId: value || undefined }), placeholder: node.id })) : null,
            h(Field, { label: 'Salvar pacote em', help: 'Caminho do estado que receberá resumo, memórias, arquivos e proveniência.' }, h(Text, { value: config.outputPath || 'context.pack', onChange: value => update({ outputPath: value || undefined }), placeholder: 'context.pack' })),
            h('details', { className: 'details' }, h('summary', null, 'Fontes específicas e limites'),
                h(Field, { label: 'Campos do estado (um por linha)' }, h(Area, { value: (config.statePaths || []).join('\n'), onChange: value => update({ statePaths: parseLines(value) }), rows: 3, placeholder: 'flow.request\nflow.constraints' })),
                h(Field, { label: 'Arquivos (um por linha)' }, h(Area, { value: (config.filePaths || []).join('\n'), onChange: value => update({ filePaths: parseLines(value) }), rows: 3, placeholder: 'AGENTS.md\ndocs/architecture.md' })),
                h(Field, { label: 'Tags de memória (uma por linha)' }, h(Area, { value: (config.tags || []).join('\n'), onChange: value => update({ tags: parseLines(value) }), rows: 3 })),
                h('div', { className: 'field-grid' },
                    h(Field, { label: 'Máximo de itens' }, h(Text, { type: 'number', min: 1, value: config.maxItems || 20, onChange: value => update({ maxItems: Math.max(1, Number(value) || 1) }) })),
                    h(Field, { label: 'Máximo de bytes' }, h(Text, { type: 'number', min: 1024, value: config.maxBytes || 131072, onChange: value => update({ maxBytes: Math.max(1024, Number(value) || 1024) }) }))
                ),
                h(Check, { label: 'Falhar se nenhuma fonte estiver disponível', value: config.required, onChange: value => update({ required: value }) })
            )
        );
    }

    function CommandEditor({ node, patch }) {
        const config = node.command || {};
        const update = change => patch({ command: { ...config, ...change } });
        const effect = config.effect || 'command';
        const mutating = effect !== 'none' && effect !== 'read';
        return h('section', { className: 'inspector-section' },
            h('h3', null, 'Programa autorizado'),
            h(Field, { label: 'Executável', help: 'Informe o programa diretamente; não use pipes ou sintaxe de shell.', wide: true }, h(Text, { value: config.command, onChange: value => update({ command: value }), placeholder: 'node, git, dotnet…' })),
            h(Field, { label: 'Argumentos (um por linha)', wide: true }, h(Area, { value: (config.args || []).join('\n'), onChange: value => update({ args: parseLines(value) }), rows: 4, placeholder: '--version' })),
            h('div', { className: 'field-grid' },
                h(Field, { label: 'Tipo de efeito' }, h(Select, { value: effect, options: EFFECTS, onChange: value => update({ effect: value, retries: value === 'none' || value === 'read' ? config.retries : 0, requiredPermissions: [`tool:${value === 'none' ? 'read' : value}`] }) })),
                h(Field, { label: 'Timeout ms' }, h(Text, { type: 'number', min: 1, value: config.timeoutMs || 30000, onChange: value => update({ timeoutMs: Math.max(1, Number(value) || 1) }) }))
            ),
            mutating ? h('div', { className: 'callout callout--warning' }, h('strong', null, 'Efeito protegido'), h('span', null, 'A permissão e a chave abaixo evitam execuções duplicadas em replay.')) : null,
            h(Field, { label: 'Chave de idempotência', help: mutating ? 'Obrigatória para comandos que alteram estado.' : 'Opcional para leitura; recomendada quando o resultado é externo.' }, h(Text, { value: config.idempotencyKey, onChange: value => update({ idempotencyKey: value || undefined }), placeholder: `${node.id}:{{flow.request}}` })),
            h('details', { className: 'details' }, h('summary', null, 'Pasta, permissões e tentativas'),
                h(Field, { label: 'Pasta de trabalho' }, h(Text, { value: config.cwd, onChange: value => update({ cwd: value || undefined }), placeholder: '.' })),
                h(Field, { label: 'Permissões exigidas (uma por linha)' }, h(Area, { value: (config.requiredPermissions || []).join('\n'), onChange: value => update({ requiredPermissions: parseLines(value) }), rows: 3, placeholder: `tool:${effect}` })),
                !mutating ? h('div', { className: 'field-grid' },
                    h(Field, { label: 'Novas tentativas' }, h(Text, { type: 'number', min: 0, value: config.retries || 0, onChange: value => update({ retries: Math.max(0, Number(value) || 0) }) })),
                    h(Field, { label: 'Intervalo ms' }, h(Text, { type: 'number', min: 0, value: config.retryDelayMs || 0, onChange: value => update({ retryDelayMs: Math.max(0, Number(value) || 0) }) }))
                ) : h('p', { className: 'muted' }, 'Comandos mutáveis não são repetidos automaticamente quando o resultado pode ser ambíguo.')
            )
        );
    }

    function MemoryWriteEditor({ node, patch }) {
        const config = node.memoryWrite || {};
        const update = change => patch({ memoryWrite: { ...config, ...change } });
        return h('section', { className: 'inspector-section' },
            h('h3', null, 'Memórias aprovadas'),
            h('div', { className: 'callout callout--success' }, h('strong', null, 'Autorização explícita'), h('span', null, 'O status é editorial. Somente um receipt humano ligado ao conteúdo e a este destino permite gravar candidatos em estado candidate ou approved.')),
            h(Field, { label: 'Candidatos no estado', help: 'Caminho do array de candidatos revisados.', wide: true }, h(Text, { value: config.candidatesFrom, onChange: value => update({ candidatesFrom: value }), placeholder: 'flow.memoryCandidates' })),
            h('div', { className: 'field-grid' },
                h(Field, { label: 'Escopo' }, h(Select, { value: config.scope || 'workflow', options: MEMORY_SCOPES, onChange: value => update({ scope: value, scopeId: value === 'agent' ? config.scopeId : undefined }) })),
                h(Field, { label: 'Se estiver vazio' }, h(Select, { value: config.onEmpty || 'skip', options: [{ value: 'skip', label: 'Continuar' }, { value: 'fail', label: 'Falhar' }], onChange: value => update({ onEmpty: value }) }))
            ),
            config.scope === 'agent' ? h(Field, { label: 'ID do agente', help: 'Este ID também vincula o receipt ao agente de destino.', wide: true }, h(Text, { value: config.scopeId, onChange: value => update({ scopeId: value || undefined }), placeholder: node.id })) : null,
            h(Field, { label: 'Salvar recibos em' }, h(Text, { value: config.outputPath || 'memory.writes', onChange: value => update({ outputPath: value || undefined }), placeholder: 'memory.writes' })),
            h(Field, { label: 'Chave de idempotência' }, h(Text, { value: config.idempotencyKey, onChange: value => update({ idempotencyKey: value || undefined }), placeholder: `${node.id}:{{flow.request}}` })),
            h('details', { className: 'details' }, h('summary', null, 'Filtrar e classificar'),
                h(Field, { label: 'IDs permitidos (um por linha)' }, h(Area, { value: (config.candidateIds || []).join('\n'), onChange: value => update({ candidateIds: parseLines(value) }), rows: 3 })),
                h('div', { className: 'field-grid' },
                    h(Field, { label: 'Armazenamento' }, h(Text, { value: config.storeId, onChange: value => update({ storeId: value || undefined }), placeholder: 'padrão' })),
                    h(Field, { label: 'Classificação' }, h(Select, { value: config.kind || '', empty: 'Preservar candidato', options: ['fact', 'decision', 'preference', 'instruction', 'summary'], onChange: value => update({ kind: value || undefined }) }))
                )
            )
        );
    }

    function PlaybookEditor({ node, patch }) {
        const config = node.playbook || {};
        const update = change => patch({ playbook: { ...config, ...change } });
        return h('section', { className: 'inspector-section' },
            h('h3', null, 'Automação reutilizável'),
            h(Field, { label: 'ID do playbook', help: 'Nome registrado pelo host, CLI ou plugin.', wide: true }, h(Text, { value: config.playbookId, onChange: value => update({ playbookId: value }), placeholder: 'review-and-fix' })),
            h(Field, { label: 'Parâmetros (um por linha: nome = valor)', wide: true }, h(Area, { value: valuesToText(config.parameters), onChange: value => update({ parameters: textToValues(value) }), rows: 4, placeholder: 'mode = strict\nmaxFindings = 20' })),
            h(Field, { label: 'Chave de idempotência', help: 'Obrigatória para playbooks externos.' }, h(Text, { value: config.idempotencyKey, onChange: value => update({ idempotencyKey: value || undefined }), placeholder: `${node.id}:{{flow.request}}` })),
            h('details', { className: 'details' }, h('summary', null, 'Subgrafo e mapeamentos'),
                h('div', { className: 'field-grid' },
                    h(Field, { label: 'Subgrafo embutido' }, h(Text, { value: config.graphId, onChange: value => update({ graphId: value || undefined }), placeholder: 'review-flow' })),
                    h(Field, { label: 'Arquivo de grafo' }, h(Text, { value: config.graphRef, onChange: value => update({ graphRef: value || undefined }), placeholder: 'flows/review.json' }))
                ),
                h(Field, { label: 'Entradas: estado → campo do playbook' }, h(Area, { value: mapToText(config.input), onChange: value => update({ input: textToMap(value) }), rows: 3, placeholder: 'flow.request → input.request' })),
                h(Field, { label: 'Saídas: campo do playbook → estado' }, h(Area, { value: mapToText(config.output), onChange: value => update({ output: textToMap(value) }), rows: 3, placeholder: 'result → flow.review' })),
                h(Check, { label: 'Executar com estado isolado', value: config.isolated, onChange: value => update({ isolated: value }) })
            )
        );
    }

    function DynamicParallelEditor({ node, profiles, patch }) {
        const config = node.dynamicParallel || {};
        const update = change => patch({ dynamicParallel: { ...config, ...change } });
        return h('section', { className: 'inspector-section' },
            h('h3', null, 'Itens e concorrência'),
            h(Field, { label: 'Lista de itens', help: 'Expressão que retorna um array.', wide: true }, h(Area, { value: config.itemsFrom, onChange: value => update({ itemsFrom: value }), rows: 3, placeholder: 'context.flow?.items || []' })),
            h('div', { className: 'field-grid' },
                h(Field, { label: 'Nome de cada item' }, h(Text, { value: config.itemVariable || 'item', onChange: value => update({ itemVariable: value || 'item' }), placeholder: 'item' })),
                h(Field, { label: 'Em paralelo' }, h(Text, { type: 'number', min: 1, value: config.concurrency || 4, onChange: value => update({ concurrency: Math.max(1, Number(value) || 1) }) }))
            ),
            h('div', { className: 'embedded-editor' }, h('div', { className: 'embedded-editor__heading' }, h('span', null, 'Worker por item'), h('small', null, config.worker?.label || 'Configure o worker')), h(EmbeddedNodeEditor, { node: config.worker || defaultEmbeddedNode('transform', 'worker'), role: 'worker', profiles, onChange: worker => update({ worker }) })),
            h(Field, { label: 'Salvar resultados em' }, h(Text, { value: config.outputPath || 'parallel.results', onChange: value => update({ outputPath: value || undefined }), placeholder: 'parallel.results' })),
            h('details', { className: 'details' }, h('summary', null, 'Limites e falhas'),
                h('div', { className: 'field-grid' },
                    h(Field, { label: 'Máximo de itens' }, h(Text, { type: 'number', min: 1, value: config.maxItems || 50, onChange: value => update({ maxItems: Math.max(1, Number(value) || 1) }) })),
                    h(Field, { label: 'Ao falhar' }, h(Select, { value: config.failurePolicy || 'fail_fast', options: [{ value: 'fail_fast', label: 'Parar imediatamente' }, { value: 'best_effort', label: 'Coletar o que funcionar' }, { value: 'threshold', label: 'Aceitar até um limite' }], onChange: value => update({ failurePolicy: value, failureThreshold: value === 'threshold' ? (config.failureThreshold ?? 1) : undefined }) }))
                ),
                config.failurePolicy === 'threshold' ? h(Field, { label: 'Falhas toleradas' }, h(Text, { type: 'number', min: 0, value: config.failureThreshold ?? 1, onChange: value => update({ failureThreshold: Math.max(0, Number(value) || 0) }) })) : null,
                h(Field, { label: 'Como consolidar' }, h(Select, { value: config.joinStrategy || 'collect', options: [{ value: 'collect', label: 'Coletar em ordem' }, { value: 'best_effort', label: 'Somente sucessos' }, { value: 'require_all', label: 'Exigir todos' }], onChange: value => update({ joinStrategy: value }) }))
            )
        );
    }

    function TournamentEditor({ node, profiles, patch }) {
        const config = node.tournament || {};
        const update = change => patch({ tournament: { ...config, ...change } });
        return h('section', { className: 'inspector-section' },
            h('h3', null, 'Candidatos e critérios'),
            h(Field, { label: 'Lista de candidatos', help: 'Expressão que retorna um array.', wide: true }, h(Area, { value: config.candidatesFrom, onChange: value => update({ candidatesFrom: value }), rows: 3, placeholder: 'context.flow?.candidates || []' })),
            h(Field, { label: 'Critérios (um por linha)', wide: true }, h(Area, { value: (config.criteria || []).join('\n'), onChange: value => update({ criteria: parseLines(value) }), rows: 4, placeholder: 'Precisão\nQualidade\nCusto' })),
            h('div', { className: 'field-grid' },
                h(Field, { label: 'Formato' }, h(Select, { value: config.strategy || 'single_round', options: [{ value: 'single_round', label: 'Rodada única' }, { value: 'bracket', label: 'Eliminatória' }, { value: 'round_robin', label: 'Todos contra todos' }], onChange: value => update({ strategy: value }) })),
                h(Field, { label: 'Quantidade de vencedores' }, h(Text, { type: 'number', min: 1, value: config.winnerCount || 1, onChange: value => update({ winnerCount: Math.max(1, Number(value) || 1) }) }))
            ),
            h('div', { className: 'embedded-editor' }, h('div', { className: 'embedded-editor__heading' }, h('span', null, 'Juiz'), h('small', null, config.judge?.provider?.modelId || config.judge?.provider?.providerId || 'Regra local')), h(EmbeddedNodeEditor, { node: config.judge || defaultEmbeddedNode('agent', 'judge'), role: 'judge', profiles, onChange: judge => update({ judge }) })),
            h(Field, { label: 'Salvar resultado em' }, h(Text, { value: config.outputPath || 'tournament.result', onChange: value => update({ outputPath: value || undefined }), placeholder: 'tournament.result' })),
            h('details', { className: 'details' }, h('summary', null, 'Limites e desempate'),
                h('div', { className: 'field-grid' },
                    h(Field, { label: 'Máximo de comparações' }, h(Text, { type: 'number', min: 1, value: config.maxComparisons || 32, onChange: value => update({ maxComparisons: Math.max(1, Number(value) || 1) }) })),
                    h(Field, { label: 'Desempate' }, h(Select, { value: config.tieBreaker || 'judge_again', options: [{ value: 'judge_again', label: 'Julgar novamente' }, { value: 'score_total', label: 'Maior pontuação' }, { value: 'first_candidate', label: 'Ordem original' }], onChange: value => update({ tieBreaker: value }) }))
                ),
                config.tieBreaker === 'judge_again' ? h(Field, { label: 'Máximo de rodadas extras' }, h(Text, { type: 'number', min: 1, value: config.maxTieRounds || 2, onChange: value => update({ maxTieRounds: Math.max(1, Number(value) || 1) }) })) : null
            )
        );
    }

    function EmbeddedNodeEditor({ node, role, profiles, onChange }) {
        const patch = change => onChange({ ...node, ...change });
        const types = role === 'judge' ? EMBEDDED_JUDGE_TYPES : EMBEDDED_WORKER_TYPES;
        const tool = node.tools?.[0] || { id: `${node.id}-tool`, name: 'Ferramenta', command: 'tool-id', args: [], effect: 'read', requiredPermissions: ['tool:read'] };
        const updateTool = change => patch({ tools: [{ ...tool, ...change }] });
        return h('div', { className: 'embedded-editor__body' },
            h('div', { className: 'field-grid' },
                h(Field, { label: 'Tipo' }, h(Select, { value: node.type, options: types, onChange: value => onChange(defaultEmbeddedNode(value, role)) })),
                h(Field, { label: 'Nome' }, h(Text, { value: node.label, onChange: value => patch({ label: value }) }))
            ),
            node.type === 'agent' || node.type === 'report' ? h(React.Fragment, null,
                h(Field, { label: role === 'judge' ? 'Instrução de julgamento' : 'Instrução do worker', wide: true }, h(Area, { value: node.prompt, onChange: value => patch({ prompt: value }), rows: 5 })),
                h(EmbeddedProviderFields, { node, profiles, patch }),
                h('details', { className: 'details' }, h('summary', null, 'RAG do agente'), h(Field, { label: 'Markdown inicial' }, h(Area, { value: node.rag?.markdown, onChange: value => patch({ rag: { ...(node.rag || {}), markdown: value || undefined } }), rows: 4 })), h(Field, { label: 'Arquivo Markdown' }, h(Text, { value: node.rag?.filePath, onChange: value => patch({ rag: { ...(node.rag || {}), filePath: value || undefined } }), placeholder: 'agents/worker.md' })))
            ) : null,
            role === 'worker' && node.type === 'agent' ? h(ToolEditor, { node, patch, embedded: true }) : null,
            role === 'judge' && node.type === 'agent' ? h('div', { className: 'callout' }, h('strong', null, 'Julgamento isolado'), h('span', null, 'O juiz não recebe ferramentas; ele compara somente os candidatos e critérios apresentados.')) : null,
            node.type === 'transform' ? h(Field, { label: role === 'judge' ? 'Expressão que escolhe winnerIds' : 'Expressão que retorna o resultado', wide: true }, h(Area, { value: node.condition, onChange: value => patch({ condition: value }), rows: 4 })) : null,
            node.type === 'command' ? h(React.Fragment, null,
                h(Field, { label: 'Executável' }, h(Text, { value: node.command?.command, onChange: value => patch({ command: { ...(node.command || {}), command: value } }) })),
                h(Field, { label: 'Argumentos (um por linha)' }, h(Area, { value: (node.command?.args || []).join('\n'), onChange: value => patch({ command: { ...(node.command || {}), args: parseLines(value) } }), rows: 3 }))
            ) : null,
            node.type === 'action' ? h(React.Fragment, null,
                h(Field, { label: 'Ferramenta' }, h(Text, { value: tool.command, onChange: value => updateTool({ command: value }) })),
                h(Field, { label: 'Argumentos (um por linha)' }, h(Area, { value: (tool.args || []).join('\n'), onChange: value => updateTool({ args: parseLines(value) }), rows: 3 }))
            ) : null,
            node.type === 'context' ? h(Field, { label: 'O que buscar?' }, h(Area, { value: node.context?.query, onChange: value => patch({ context: { ...(node.context || {}), query: value } }), rows: 3 })) : null,
            node.type === 'memory_write' ? h(React.Fragment, null,
                h(Field, { label: 'Candidatos no estado' }, h(Text, { value: node.memoryWrite?.candidatesFrom, onChange: value => patch({ memoryWrite: { ...(node.memoryWrite || {}), candidatesFrom: value } }) })),
                h(Field, { label: 'Escopo' }, h(Select, { value: node.memoryWrite?.scope || 'workflow', options: MEMORY_SCOPES, onChange: value => patch({ memoryWrite: { ...(node.memoryWrite || {}), scope: value } }) }))
            ) : null,
            node.type === 'playbook' ? h(React.Fragment, null,
                h(Field, { label: 'ID do playbook' }, h(Text, { value: node.playbook?.playbookId, onChange: value => patch({ playbook: { ...(node.playbook || {}), playbookId: value } }) })),
                h(Field, { label: 'Chave de idempotência' }, h(Text, { value: node.playbook?.idempotencyKey, onChange: value => patch({ playbook: { ...(node.playbook || {}), idempotencyKey: value || undefined } }) }))
            ) : null,
            node.type === 'subgraph' ? h('div', { className: 'field-grid' },
                h(Field, { label: 'ID do subgrafo' }, h(Text, { value: node.subgraph?.graphId, onChange: value => patch({ subgraph: { ...(node.subgraph || {}), graphId: value || undefined } }) })),
                h(Field, { label: 'Arquivo do grafo' }, h(Text, { value: node.subgraph?.graphRef, onChange: value => patch({ subgraph: { ...(node.subgraph || {}), graphRef: value || undefined } }) }))
            ) : null
        );
    }

    function EmbeddedProviderFields({ node, profiles, patch }) {
        const profileOptions = profiles.map(item => ({ value: item.id, label: profileOptionLabel(item) }));
        const setProfile = id => {
            const profile = profiles.find(item => item.id === id);
            patch({ provider: profile ? { ...(node.provider || {}), providerId: profile.providerId, modelId: profile.modelId, profileId: profile.id, runnerId: profile.runnerId, reasoningEffort: node.provider?.reasoningEffort || profile.reasonDefault || 'medium', serviceTier: profile.serviceTierDefault || 'default' } : { ...(node.provider || {}), profileId: undefined, modelId: undefined } });
        };
        return h(React.Fragment, null,
            h(Field, { label: 'Assinatura / perfil' }, h(Select, { value: node.provider?.profileId || '', empty: 'Escolher manualmente', options: profileOptions, onChange: setProfile })),
            h('div', { className: 'field-grid' },
                h(Field, { label: 'Provider' }, h(Text, { value: node.provider?.providerId, onChange: value => patch({ provider: { ...(node.provider || {}), providerId: value } }) })),
                h(Field, { label: 'Modelo' }, h(Text, { value: node.provider?.modelId, onChange: value => patch({ provider: { ...(node.provider || {}), modelId: value || undefined } }) })),
                h(Field, { label: 'Raciocínio' }, h(Select, { value: node.provider?.reasoningEffort || 'medium', options: REASONING, onChange: value => patch({ provider: { ...(node.provider || {}), reasoningEffort: value } }) })),
                h(Field, { label: 'Prioridade' }, h(Select, { value: node.provider?.serviceTier || 'default', options: TIERS, onChange: value => patch({ provider: { ...(node.provider || {}), serviceTier: value } }) }))
            )
        );
    }

    function ToolEditor({ node, patch, embedded = false }) {
        const tools = node.tools || [];
        const update = (index, change) => patch({ tools: tools.map((tool, current) => current === index ? { ...tool, ...change } : tool) });
        return h(embedded ? 'div' : 'section', { className: embedded ? 'embedded-tools' : 'inspector-section' }, h('div', { className: 'section-heading' }, h('h3', null, node.type === 'agent' ? 'Ferramentas disponíveis ao agente' : 'Ferramentas executadas'), h('button', { className: 'button button--ghost button--small', onClick: () => patch({ tools: [...tools, { id: uid('tool'), name: 'Ferramenta', command: '', args: [], effect: 'read', idempotencyKey: `${node.id}:{{flow.request}}`, requiredPermissions: ['tool:read'] }] }) }, '+ Adicionar')),
            node.type === 'agent' ? h('p', { className: 'muted' }, 'O runner recebe esta lista e decide quando chamar cada ferramenta. Use um bloco Action quando a execução for obrigatória.') : null,
            tools.map((tool, index) => h('details', { className: 'tool-card', open: index === 0, key: tool.id }, h('summary', null, tool.name || tool.id),
                h(Field, { label: 'Nome' }, h(Text, { value: tool.name, onChange: value => update(index, { name: value }) })),
                h(Field, { label: 'Executável lógico' }, h(Text, { value: tool.command, onChange: value => update(index, { command: value }), placeholder: 'tool-id ou comando autorizado' })),
                h(Field, { label: 'Argumentos (um por linha)' }, h(Area, { value: (tool.args || []).join('\n'), onChange: value => update(index, { args: parseLines(value) }), rows: 3 })),
                h('div', { className: 'field-grid' }, h(Field, { label: 'Efeito' }, h(Select, { value: tool.effect || 'read', options: EFFECTS, onChange: value => update(index, { effect: value, requiredPermissions: [`tool:${value === 'none' ? 'read' : value}`] }) })), h(Field, { label: 'Timeout ms' }, h(Text, { type: 'number', value: tool.timeoutMs || '', onChange: value => update(index, { timeoutMs: value ? Number(value) : undefined }) }))),
                h(Field, { label: 'Chave de idempotência', help: 'Impede repetir o efeito em replay.' }, h(Text, { value: tool.idempotencyKey, onChange: value => update(index, { idempotencyKey: value }) })),
                h('button', { className: 'button button--danger button--small', onClick: () => patch({ tools: tools.filter((_, current) => current !== index) }) }, 'Remover ferramenta')
            ))
        );
    }

    function GateEditor({ node, patch, nodeOptions, profiles }) {
        const gate = node.gate || { kind: 'human' };
        const decisions = node.gateDecisions || [];
        const setDecision = (index, change) => patch({ gateDecisions: decisions.map((item, current) => current === index ? { ...item, ...change } : item) });
        const rules = gate.rules || [];
        const children = gate.children || [];
        const reviewerProfile = gate.reviewer?.profileId || '';
        const setReviewerProfile = id => {
            const profile = profiles.find(item => item.id === id);
            patch({ gate: { ...gate, reviewer: profile ? { providerId: profile.providerId, modelId: profile.modelId, profileId: profile.id, runnerId: profile.runnerId, reasoningEffort: profile.reasonDefault || 'high', serviceTier: profile.serviceTierDefault || 'default' } : { runnerId: 'cybervinci', providerId: 'cybervinci', reasoningEffort: 'high', fallbacks: [{ runnerId: 'opencode', providerId: 'opencode', reasoningEffort: 'high' }] } } });
        };
        const updateRule = (index, change) => patch({ gate: { ...gate, rules: rules.map((item, current) => current === index ? { ...item, ...change } : item) } });
        const updateChild = (index, change) => patch({ gate: { ...gate, children: children.map((item, current) => current === index ? { ...item, ...change } : item) } });
        return h('section', { className: 'inspector-section' }, h('h3', null, 'Critério de aprovação'), h(Field, { label: 'Tipo', wide: true }, h(Select, { value: gate.kind, options: GATE_KINDS, onChange: value => patch({ gate: { ...gate, kind: value } }) })), h(Field, { label: 'Pergunta / instrução', wide: true }, h(Area, { value: gate.prompt, onChange: value => patch({ gate: { ...gate, prompt: value } }), rows: 3 })), gate.kind === 'deterministic' ? h(Field, { label: 'Expressão booleana', help: 'Aprova quando a expressão for verdadeira.', wide: true }, h(Area, { value: gate.expression, onChange: value => patch({ gate: { ...gate, expression: value } }), rows: 3 })) : null,
            gate.kind === 'ai' ? h(React.Fragment, null,
                h(Field, { label: 'Perfil revisor', wide: true }, h(Select, { value: reviewerProfile, empty: 'Configurar manualmente', options: profiles.map(item => ({ value: item.id, label: `${item.name || item.id} · ${item.modelId}` })), onChange: setReviewerProfile })),
                h('div', { className: 'field-grid' }, h(Field, { label: 'Provider' }, h(Text, { value: gate.reviewer?.providerId, onChange: value => patch({ gate: { ...gate, reviewer: { ...(gate.reviewer || {}), providerId: value } } }) })), h(Field, { label: 'Modelo' }, h(Text, { value: gate.reviewer?.modelId, onChange: value => patch({ gate: { ...gate, reviewer: { ...(gate.reviewer || {}), modelId: value || undefined } } }) })), h(Field, { label: 'Raciocínio' }, h(Select, { value: gate.reviewer?.reasoningEffort || 'high', options: REASONING, onChange: value => patch({ gate: { ...gate, reviewer: { ...(gate.reviewer || { runnerId: 'cybervinci', providerId: 'cybervinci' }), reasoningEffort: value } } }) })))
            ) : null,
            gate.kind === 'policy' ? h(React.Fragment, null,
                h('div', { className: 'section-heading' }, h('h3', null, 'Regras de política'), h('button', { className: 'button button--ghost button--small', onClick: () => patch({ gate: { ...gate, rules: [...rules, { id: uid('rule'), expression: 'true', severity: 'blocker', message: 'Critério obrigatório' }] } }) }, '+ Regra')),
                rules.map((rule, index) => h('details', { className: 'tool-card', open: index === 0, key: rule.id }, h('summary', null, rule.message || rule.id), h(Field, { label: 'Id' }, h(Text, { value: rule.id, onChange: value => updateRule(index, { id: value }) })), h(Field, { label: 'Expressão' }, h(Area, { value: rule.expression, onChange: value => updateRule(index, { expression: value }), rows: 3 })), h(Field, { label: 'Mensagem' }, h(Text, { value: rule.message, onChange: value => updateRule(index, { message: value }) })), h(Field, { label: 'Severidade' }, h(Select, { value: rule.severity || 'blocker', options: ['info', 'warning', 'blocker'], onChange: value => updateRule(index, { severity: value }) })), h('button', { className: 'button button--danger button--small', onClick: () => patch({ gate: { ...gate, rules: rules.filter((_, current) => current !== index) } }) }, 'Remover regra')))
            ) : null,
            gate.kind === 'composite' ? h(React.Fragment, null,
                h(Field, { label: 'Combinação', wide: true }, h(Select, { value: gate.combine || 'all', options: ['all', 'any', 'majority'], onChange: value => patch({ gate: { ...gate, combine: value } }) })),
                h('div', { className: 'section-heading' }, h('h3', null, 'Critérios internos'), h('button', { className: 'button button--ghost button--small', onClick: () => patch({ gate: { ...gate, children: [...children, { kind: 'deterministic', prompt: 'Novo critério', expression: 'true' }] } }) }, '+ Critério')),
                children.map((child, index) => h('details', { className: 'tool-card', open: index === 0, key: `${child.kind}-${index}` },
                    h('summary', null, child.prompt || `Critério ${index + 1}`),
                    h(Field, { label: 'Tipo' }, h(Select, { value: child.kind, options: ['human', 'deterministic', 'ai', 'policy'], onChange: value => updateChild(index, { kind: value }) })),
                    h(Field, { label: 'Instrução' }, h(Area, { value: child.prompt, onChange: value => updateChild(index, { prompt: value }), rows: 2 })),
                    child.kind === 'deterministic' ? h(Field, { label: 'Expressão' }, h(Area, { value: child.expression, onChange: value => updateChild(index, { expression: value }), rows: 2 })) : null,
                    child.kind === 'ai' ? h(Field, { label: 'Perfil revisor' }, h(Select, { value: child.reviewer?.profileId || '', empty: 'Selecione', options: profiles.map(item => ({ value: item.id, label: item.name || item.id })), onChange: value => { const profile = profiles.find(item => item.id === value); updateChild(index, { reviewer: profile ? { providerId: profile.providerId, modelId: profile.modelId, profileId: profile.id, runnerId: profile.runnerId, reasoningEffort: profile.reasonDefault || 'high' } : undefined }); } })) : null,
                    child.kind === 'policy' ? h(Field, { label: 'Regra bloqueadora', help: 'Uma expressão simples; múltiplas regras podem ser editadas no JSON avançado.' }, h(Area, { value: child.rules?.[0]?.expression, onChange: value => updateChild(index, { rules: [{ id: child.rules?.[0]?.id || uid('rule'), expression: value, severity: 'blocker', message: child.rules?.[0]?.message || 'Política interna' }] }), rows: 2 })) : null,
                    h('button', { className: 'button button--danger button--small', onClick: () => patch({ gate: { ...gate, children: children.filter((_, current) => current !== index) } }) }, 'Remover critério')
                ))
            ) : null,
            h(Check, { label: 'Exigir evidência para aprovar', value: gate.requireEvidence, onChange: value => patch({ gate: { ...gate, requireEvidence: value } }) }),
            h('details', { className: 'details' }, h('summary', null, 'Timeout e comportamento'), h('div', { className: 'field-grid' }, h(Field, { label: 'Timeout ms' }, h(Text, { type: 'number', min: 1, value: gate.timeoutMs || '', onChange: value => patch({ gate: { ...gate, timeoutMs: value ? Number(value) : undefined } }) })), h(Field, { label: 'Ao expirar' }, h(Select, { value: gate.onTimeout || 'fail', options: ['continue', 'wait', 'fail'], onChange: value => patch({ gate: { ...gate, onTimeout: value } }) })))),
            gate.kind === 'human' ? h(React.Fragment, null, h('div', { className: 'section-heading' }, h('h3', null, 'Decisões'), h('button', { className: 'button button--ghost button--small', onClick: () => patch({ gateDecisions: [...decisions, { id: uid('decision'), label: 'Continuar', decision: 'continue' }] }) }, '+ Decisão')), decisions.map((decision, index) => h('div', { className: 'decision-row', key: decision.id }, h(Text, { value: decision.label, onChange: value => setDecision(index, { label: value }) }), h(Select, { value: decision.decision || '', empty: 'Escolha uma ação', options: ['continue', 'wait', 'fail'], onChange: value => setDecision(index, { decision: value }) }), h(Select, { value: decision.toNodeId || '', empty: 'Sem destino', options: nodeOptions, onChange: value => setDecision(index, { toNodeId: value || undefined }) }), IconButton({ icon: '×', title: 'Remover decisão', danger: true, onClick: () => patch({ gateDecisions: decisions.filter((_, current) => current !== index) }) })))) : null
        );
    }

    function RunDrawer({ run, runs, comparison, graph, input, setInput, tab, setTab, onRun, onCancel, onReplay, onResume, onOpenRun, onCompare, onRefresh, waitSignal, setWaitSignal, gateEvidence, setGateEvidence, close, busy }) {
        const result = run?.result;
        const waiting = result?.waiting;
        const runGraph = run?.graph || graph;
        const waitingNode = waiting ? runGraph.nodes.find(node => node.id === waiting.nodeId) : undefined;
        const interaction = waiting?.detail?.interaction && typeof waiting.detail.interaction === 'object' ? waiting.detail.interaction : undefined;
        const interactionType = interaction?.type || waiting?.kind;
        const requiresEvidence = interaction?.requireEvidence === true || (!interaction && waitingNode?.gate?.requireEvidence === true);
        const interactionLabel = interaction?.label || waitingNode?.label || waiting?.nodeId;
        const interactionDecisions = Array.isArray(interaction?.decisions) && interaction.decisions.length
            ? interaction.decisions
            : waitingNode?.gateDecisions || [{ id: 'continue', label: 'Continuar', decision: 'continue' }, { id: 'fail', label: 'Falhar', decision: 'fail' }];
        const waitingCheckpoint = waiting ? (run?.checkpoints || result?.checkpoints || []).find(checkpoint => checkpoint.id === waiting.checkpointId) : undefined;
        const waitKind = interaction?.kind || waiting?.detail?.wait?.kind || waitingCheckpoint?.metadata?.wait?.kind;
        const isEventWait = interactionType === 'wait' && waitKind === 'event';
        const isTemporalWait = interactionType === 'wait' && (waitKind === 'duration' || waitKind === 'until');
        const temporalDueAt = interaction?.dueAt || waiting?.detail?.dueAt || waitingCheckpoint?.metadata?.dueAt || interaction?.until;
        const memoryCandidates = React.useMemo(
            () => collectMemoryCandidates(waitingCheckpoint, result?.finalContext),
            [waiting?.checkpointId, waitingCheckpoint, result?.finalContext]
        );
        const memoryWriteTargets = React.useMemo(() => {
            if (Array.isArray(interaction?.memoryWriteTargets)) {
                return interaction.memoryWriteTargets.filter(target => target && MEMORY_SCOPE_IDS.has(target.scope));
            }
            return (runGraph.nodes || [])
                .filter(node => node.type === 'memory_write' && MEMORY_SCOPE_IDS.has(node.memoryWrite?.scope))
                .map(node => ({
                    nodeId: node.id,
                    label: node.label,
                    scope: node.memoryWrite.scope,
                    scopeId: node.memoryWrite.scopeId,
                    storeId: node.memoryWrite.storeId
                }));
        }, [runGraph, waiting?.checkpointId]);
        const [memoryReviews, setMemoryReviews] = React.useState({});
        const [memoryApprovalBusy, setMemoryApprovalBusy] = React.useState(false);
        const [memoryApprovalError, setMemoryApprovalError] = React.useState('');
        const [clockNow, setClockNow] = React.useState(Date.now());
        React.useEffect(() => {
            setMemoryReviews({});
            setMemoryApprovalError('');
            if (isEventWait) {
                setWaitSignal({ eventName: interaction?.eventName || '', correlationKey: interaction?.correlationKey || '' });
            }
        }, [waiting?.checkpointId]);
        React.useEffect(() => {
            if (!isTemporalWait && !(isEventWait && temporalDueAt)) return undefined;
            setClockNow(Date.now());
            const timer = setInterval(() => setClockNow(Date.now()), 1000);
            return () => clearInterval(timer);
        }, [waiting?.checkpointId, isEventWait, isTemporalWait, temporalDueAt]);
        const tabsRef = React.useRef(null);
        const tabItems = [
            { id: 'timeline', label: 'Linha do tempo' },
            { id: 'result', label: 'Resultado' },
            { id: 'checkpoints', label: 'Checkpoints' },
            { id: 'effects', label: 'Efeitos' },
            { id: 'history', label: 'Histórico' }
        ];
        const selectTab = item => {
            setTab(item.id);
            if (item.id === 'history') void onRefresh();
        };
        const onTabKeyDown = event => {
            const current = tabItems.findIndex(item => item.id === tab);
            let next = current;
            if (event.key === 'ArrowRight') next = (current + 1) % tabItems.length;
            else if (event.key === 'ArrowLeft') next = (current - 1 + tabItems.length) % tabItems.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = tabItems.length - 1;
            else return;
            event.preventDefault();
            selectTab(tabItems[next]);
            tabsRef.current?.querySelector(`#run-tab-${tabItems[next].id}`)?.focus();
        };
        const panelProps = id => ({ id: `run-panel-${id}`, className: 'tab-panel', role: 'tabpanel', 'aria-labelledby': `run-tab-${id}`, tabIndex: 0 });
        const memoryReviewKey = item => `${item.candidate.id}\u0000${String(item.candidate.revision)}\u0000${item.path}`;
        const eligibleTargets = item => memoryWriteTargets.filter(target => !item.candidate.scope || target.scope === item.candidate.scope);
        const suggestedMemoryTarget = item => eligibleTargets(item).length === 1 ? eligibleTargets(item)[0].nodeId : '';
        const updateMemoryReview = (item, change) => {
            const key = memoryReviewKey(item);
            setMemoryReviews(current => ({ ...current, [key]: { ...(current[key] || {}), ...change } }));
            setMemoryApprovalError('');
        };
        const selectedMemoryCandidates = memoryCandidates.filter(item => memoryReviews[memoryReviewKey(item)]?.approved);
        const selectedMemoryTargetMissing = selectedMemoryCandidates.some(item => !(memoryReviews[memoryReviewKey(item)]?.targetId || suggestedMemoryTarget(item)));
        const resolveMemoryApprovals = async evidence => Promise.all(selectedMemoryCandidates.map(async item => {
            const candidate = item.candidate;
            const targetId = memoryReviews[memoryReviewKey(item)]?.targetId || suggestedMemoryTarget(item);
            const target = memoryWriteTargets.find(itemTarget => itemTarget.nodeId === targetId);
            if (!target) throw new Error(`Escolha um bloco Memory Write de destino para a memória “${candidate.id}”.`);
            const scope = target.scope;
            if (!['candidate', 'approved'].includes(candidate.status)) throw new Error(`A memória “${candidate.id}” não pode ser autorizada no estado “${candidate.status}”.`);
            const payload = await api('/api/memory/candidate-digest', { method: 'POST', body: JSON.stringify({ candidate, scope }) });
            const candidateDigest = payload.candidateDigest;
            if (typeof candidateDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(candidateDigest)) {
                throw new Error('O servidor não devolveu um candidateDigest SHA-256 válido. Nenhuma memória foi autorizada.');
            }
            return {
                id: candidate.id,
                revision: candidate.revision,
                scope,
                scopeId: target.scopeId,
                storeId: target.storeId,
                graphId: interaction?.graphId || runGraph.id,
                nodeId: target.nodeId,
                candidateDigest: candidateDigest.toLocaleLowerCase(),
                approvedAt: new Date().toISOString(),
                approvedBy: 'flow-studio-web',
                evidence
            };
        }));
        const decideGate = async decision => {
            setMemoryApprovalError('');
            const evidence = gateEvidence.trim() ? [{ id: uid('evidence'), nodeId: interaction?.nodeId || waiting.nodeId, kind: 'evidence', name: 'Evidência de aprovação', payload: gateEvidence.trim(), createdAt: new Date().toISOString() }] : undefined;
            let memoryApprovals = [];
            if (decision.decision === 'continue' && selectedMemoryCandidates.length) {
                setMemoryApprovalBusy(true);
                try { memoryApprovals = await resolveMemoryApprovals(evidence); }
                catch (error) {
                    setMemoryApprovalError(error.message || 'Não foi possível validar os candidatos de memória.');
                    setMemoryApprovalBusy(false);
                    return;
                }
            }
            try {
                await onResume({ gate: { decisionId: decision.id, action: decision.decision, evidence, memoryApprovals } });
                setGateEvidence('');
            } finally { setMemoryApprovalBusy(false); }
        };
        const dueTimestamp = typeof temporalDueAt === 'string' ? Date.parse(temporalDueAt) : Number.NaN;
        const remainingMs = Number.isFinite(dueTimestamp) ? Math.max(0, dueTimestamp - clockNow) : undefined;
        const remainingLabel = remainingMs === undefined
            ? 'O prazo não pôde ser determinado.'
            : remainingMs <= 0
                ? isEventWait
                    ? interaction?.onTimeout === 'continue'
                        ? 'Prazo expirado. Verifique para continuar pela política de timeout.'
                        : 'Prazo expirado. Verifique para aplicar a falha configurada.'
                    : 'Prazo alcançado. O fluxo já pode continuar.'
                : `Faltam ${remainingMs >= 3600000 ? `${Math.floor(remainingMs / 3600000)}h ` : ''}${remainingMs >= 60000 ? `${Math.floor((remainingMs % 3600000) / 60000)}min ` : ''}${Math.max(1, Math.ceil((remainingMs % 60000) / 1000))}s.`;
        const renderWaitControls = () => isEventWait ? h('div', null,
            interaction?.eventName ? h('p', { className: 'muted' }, `Evento esperado: ${interaction.eventName}${interaction.correlationKey ? ` · Correlação: ${interaction.correlationKey}` : ''}`) : null,
            Number.isFinite(dueTimestamp) ? h('div', { className: 'wait-deadline' },
                h('p', { className: 'muted' }, `Prazo do evento: ${new Date(dueTimestamp).toLocaleString()} · Ao expirar: ${interaction?.onTimeout === 'continue' ? 'continuar' : 'falhar'}`),
                h('strong', { 'aria-live': 'polite' }, remainingLabel)
            ) : null,
            h('div', { className: 'field-grid' }, h(Field, { label: 'Evento' }, h(Text, { value: waitSignal.eventName, onChange: value => setWaitSignal({ ...waitSignal, eventName: value }) })), h(Field, { label: 'Correlação' }, h(Text, { value: waitSignal.correlationKey, onChange: value => setWaitSignal({ ...waitSignal, correlationKey: value }) }))),
            h('button', { className: 'button button--primary', disabled: busy, onClick: () => onResume({ signal: waitSignal }) }, remainingMs === 0 ? 'Verificar expiração' : 'Enviar sinal')
        ) : h('div', { className: 'wait-timer' },
            h('p', null, waitKind === 'until' ? 'Este fluxo continua a partir do horário programado.' : 'Este fluxo continua depois da duração configurada.'),
            Number.isFinite(dueTimestamp) ? h('p', { className: 'muted' }, `Horário de liberação: ${new Date(dueTimestamp).toLocaleString()}`) : null,
            h('strong', { 'aria-live': 'polite' }, remainingLabel),
            h('button', { className: 'button button--primary', disabled: busy || (remainingMs !== undefined && remainingMs > 0), onClick: () => onResume({ signal: {} }) }, remainingMs === 0 ? 'Continuar fluxo' : 'Verificar prazo')
        );
        return h('section', { className: `run-drawer ${waiting ? 'run-drawer--waiting' : ''}`, 'aria-label': 'Execução' },
            h('div', { className: 'drawer__heading' }, h('div', null, h('small', null, 'Observabilidade'), h('h2', null, run ? `Run ${run.id.slice(0, 8)} · ${run.status}` : 'Executar fluxo')), h('div', { className: 'row' }, run?.status === 'running' ? h('button', { className: 'button button--danger button--small', onClick: onCancel }, 'Cancelar') : null, IconButton({ icon: '×', title: 'Fechar execução', onClick: close }))),
            !run ? h('div', { className: 'run-empty' }, h(Field, { label: 'Entrada JSON', wide: true }, h(Area, { value: input, onChange: setInput, rows: 8 })), h('button', { className: 'button button--primary button--wide', onClick: onRun, disabled: busy }, 'Iniciar execução'), runs.length ? h('details', { className: 'details' }, h('summary', null, `Histórico · ${runs.length} execuções`), h(RunHistoryList, { runs, currentId: '', onOpenRun })) : null) : h(React.Fragment, null,
                waiting ? h('div', { className: 'inbox-card' }, h('strong', null, isEventWait ? 'Sinal necessário' : isTemporalWait ? 'Espera temporal' : interactionType === 'permission' ? 'Autorização necessária' : 'Decisão necessária'), h('p', null, interactionLabel),
                    interaction?.pendingHumanPath ? h('p', { className: 'muted' }, `Critério humano: ${interaction.pendingHumanPath}`) : null,
                    interaction?.permission ? h('p', { className: 'muted' }, `Permissão: ${interaction.permission}${interaction.toolId ? ` · Ferramenta: ${interaction.toolId}` : ''}`) : null,
                    interactionType !== 'wait' ? h('div', null,
                    memoryCandidates.length ? h(MemoryApprovalReview, { items: memoryCandidates, reviews: memoryReviews, targets: memoryWriteTargets, eligibleTargets, suggestedTarget: suggestedMemoryTarget, update: updateMemoryReview, error: memoryApprovalError }) : null,
                    requiresEvidence ? h(Field, { label: 'Evidência obrigatória', wide: true }, h(Area, { value: gateEvidence, onChange: setGateEvidence, rows: 3, placeholder: 'Explique a verificação realizada ou informe a evidência observada.' })) : null,
                    h('div', { className: 'decision-buttons' }, interactionDecisions.map(decision => h('button', { key: decision.id, className: `button ${decision.decision === 'fail' ? 'button--danger' : 'button--primary'}`, disabled: !decision.decision || memoryApprovalBusy || (decision.decision === 'continue' && (selectedMemoryTargetMissing || (requiresEvidence && !gateEvidence.trim()))), title: decision.decision ? undefined : 'A decisão não possui uma ação válida.', onClick: () => void decideGate(decision) }, memoryApprovalBusy && decision.decision === 'continue' ? 'Validando memórias…' : decision.label)))) : renderWaitControls()) : null,
                h('div', { ref: tabsRef, className: 'tabs', role: 'tablist', 'aria-label': 'Detalhes da execução', onKeyDown: onTabKeyDown }, tabItems.map(item => h('button', { id: `run-tab-${item.id}`, key: item.id, role: 'tab', 'aria-selected': tab === item.id, 'aria-controls': `run-panel-${item.id}`, tabIndex: tab === item.id ? 0 : -1, className: tab === item.id ? 'is-active' : '', onClick: () => selectTab(item) }, item.label))),
                tab === 'timeline' ? h('div', panelProps('timeline'), h('ol', { className: 'timeline' }, (run.events || []).slice().reverse().map((event, index) => h('li', { key: `${event.at}-${event.step}-${index}`, className: `event event--${event.kind.replaceAll('.', '-')}` }, h('time', null, new Date(event.at).toLocaleTimeString()), h('div', null, h('strong', null, event.kind), h('p', null, event.message)))))) : null,
                tab === 'result' ? h('div', panelProps('result'),
                    runs.filter(item => item.id !== run.id).length ? h(Field, { label: 'Comparar com', help: 'Mostra custo, tokens, caminho e estado alterado.' }, h(Select, { value: '', empty: 'Escolha outra execução', options: runs.filter(item => item.id !== run.id).map(item => ({ value: item.id, label: `${item.id.slice(0, 8)} · ${item.status} · ${new Date(item.createdAt).toLocaleString()}` })), onChange: onCompare })) : null,
                    comparison ? h('article', { className: 'comparison-card' }, h('div', { className: 'section-heading' }, h('strong', null, 'Diferenças entre execuções'), h('small', null, `${comparison.left.runId.slice(0, 8)} → ${comparison.right.runId.slice(0, 8)}`)), h('div', { className: 'comparison-grid' }, Object.entries(comparison.delta || {}).map(([key, value]) => h('span', { key }, h('small', null, key), h('strong', null, `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(key === 'costUsd' ? 4 : 0)}`))), h('span', null, h('small', null, 'Campos de estado alterados'), h('strong', null, comparison.changedContextKeys?.length || 0))), comparison.visited?.onlyLeft?.length || comparison.visited?.onlyRight?.length ? h('p', { className: 'muted' }, `Caminho diferente: só antes [${(comparison.visited.onlyLeft || []).join(', ') || '—'}] · só agora [${(comparison.visited.onlyRight || []).join(', ') || '—'}]`) : null) : null,
                    h('pre', { className: 'code-view' }, JSON.stringify(result || run, null, 2))
                ) : null,
                tab === 'checkpoints' ? h('div', panelProps('checkpoints'), h('div', { className: 'card-list' }, (run.checkpoints || []).slice().reverse().map(checkpoint => { const replayable = checkpoint.metadata?.replayable !== false; return h('article', { className: 'data-card', key: checkpoint.id }, h('strong', null, checkpoint.reason), h('span', null, checkpoint.nodeId), h('small', null, new Date(checkpoint.createdAt).toLocaleString()), h('code', null, checkpoint.id.slice(0, 12)), h('button', { className: 'button button--ghost button--small', disabled: !replayable, title: replayable ? 'Criar uma nova run a partir deste snapshot' : checkpoint.metadata?.replayBlockedReason, onClick: () => onReplay(checkpoint.id) }, replayable ? 'Replay daqui' : 'Snapshot interno')); }))) : null,
                tab === 'effects' ? h('div', panelProps('effects'), h('div', { className: 'card-list' }, (run.effects || []).map(effect => h('article', { className: `data-card data-card--${effect.status}`, key: effect.id }, h('strong', null, effect.toolId || effect.kind), h('span', null, effect.status), h('small', null, effect.idempotencyKey))))) : null,
                tab === 'history' ? h('div', panelProps('history'), h(RunHistoryList, { runs, currentId: run.id, onOpenRun })) : null,
                run.status !== 'running' && !waiting ? h('div', { className: 'run-footer' }, h('button', { className: 'button button--ghost', onClick: onReplay }, 'Criar replay a partir do último checkpoint'), h('button', { className: 'button button--primary', onClick: onRun }, 'Nova execução')) : null
            )
        );
    }

    function MemoryApprovalReview({ items, reviews, targets, eligibleTargets, suggestedTarget, update, error }) {
        return h('section', { className: 'memory-review', 'aria-labelledby': 'memory-review-title' },
            h('div', { className: 'section-heading' },
                h('div', null, h('h3', { id: 'memory-review-title' }, 'Memórias propostas'), h('small', null, 'Aprovação explícita e vinculada ao conteúdo')),
                h('span', { className: 'status' }, `${items.length} candidato(s)`)
            ),
            h('p', { className: 'muted' }, 'Nada é autorizado automaticamente. Marque somente revisões que podem ser gravadas; o servidor valida o conteúdo e gera um digest antes de continuar.'),
            h('div', { className: 'memory-review__list' }, items.map(item => {
                const candidate = item.candidate;
                const key = `${candidate.id}\u0000${String(candidate.revision)}\u0000${item.path}`;
                const review = reviews[key] || {};
                const targetId = review.targetId || suggestedTarget(item);
                const target = targets.find(itemTarget => itemTarget.nodeId === targetId);
                const eligible = ['candidate', 'approved'].includes(candidate.status);
                const statusLabel = candidate.status === 'candidate' ? 'Aguardando aprovação' : candidate.status === 'approved' ? 'Pré-aprovado' : candidate.status === 'rejected' ? 'Rejeitado' : candidate.status === 'written' ? 'Já gravado' : 'Falhou';
                const displayName = candidate.key && candidate.key !== candidate.id ? candidate.key : candidate.id;
                const identity = candidate.key && candidate.key !== candidate.id
                    ? `ID ${candidate.id} · Revisão ${candidate.revision} · ${statusLabel}`
                    : `Revisão ${candidate.revision} · ${statusLabel}`;
                return h('article', { className: `memory-candidate ${review.approved ? 'is-selected' : ''}`, key },
                    h('div', { className: 'memory-candidate__heading' },
                        h('label', { className: 'memory-candidate__choice' },
                            h('input', { type: 'checkbox', checked: Boolean(review.approved), disabled: !eligible || !target, onChange: event => update(item, { approved: event.target.checked, targetId }) }),
                            h('span', null, h('strong', null, displayName), h('small', null, identity))
                        ),
                        candidate.kind ? h('span', { className: 'status' }, candidate.kind) : null
                    ),
                    h('p', { className: 'memory-candidate__summary' }, memoryCandidateSummary(candidate)),
                    h('div', { className: 'memory-candidate__meta' },
                        h(Field, { label: 'Destino de gravação' }, h(Select, {
                            value: targetId,
                            empty: 'Escolha um Memory Write',
                            options: eligibleTargets(item).map(destination => ({ value: destination.nodeId, label: `${destination.label} · ${destination.scope}${destination.scopeId ? `:${destination.scopeId}` : ''}${destination.storeId ? ` · ${destination.storeId}` : ''}` })),
                            onChange: value => update(item, { targetId: value, approved: value ? review.approved : false })
                        })),
                        h('span', null, h('small', null, 'Origem no checkpoint'), h('code', null, item.path))
                    ),
                    !eligible ? h('p', { className: 'memory-candidate__notice' }, `Este item não pode ser autorizado neste Gate porque está com status “${statusLabel}”.`) : !target ? h('p', { className: 'memory-candidate__notice' }, 'Selecione o bloco Memory Write e o destino exato antes de marcar este candidato.') : null
                );
            })),
            error ? h('div', { className: 'callout callout--error', role: 'alert' }, h('strong', null, 'Aprovação não enviada'), h('span', null, error)) : null,
            h('p', { className: 'memory-review__footnote' }, 'Itens não marcados seguem sem autorização de gravação.')
        );
    }

    function RunHistoryList({ runs, currentId, onOpenRun }) {
        return h('div', { className: 'run-history' }, runs.length ? runs.map(item => h('button', { key: item.id, className: `run-history__item ${item.id === currentId ? 'is-current' : ''}`, disabled: item.id === currentId, onClick: () => onOpenRun(item.id) }, h('span', null, h('strong', null, item.id.slice(0, 8)), h('small', null, new Date(item.createdAt).toLocaleString())), h('span', { className: `status status--${item.status}` }, item.status), h('small', null, item.result ? `${item.result.visited?.length || 0} etapas · $${Number(item.result.usage?.costUsd || 0).toFixed(4)}` : 'sem resultado'))) : h('div', { className: 'empty-state' }, h('strong', null, 'Nenhuma execução ainda')));
    }

    function ProviderCatalogDialog({ profiles, useModel, close }) {
        const [catalog, setCatalog] = React.useState(null);
        const [providerSearch, setProviderSearch] = React.useState('');
        const [modelSearch, setModelSearch] = React.useState('');
        const [selectedProviderId, setSelectedProviderId] = React.useState('');
        const [loading, setLoading] = React.useState(true);
        const [error, setError] = React.useState('');
        const [usingModel, setUsingModel] = React.useState('');
        const [auth, setAuth] = React.useState(null);
        const [authBusy, setAuthBusy] = React.useState(false);
        const installed = new Set(profiles.map(profile => profile.id));

        const loadCatalog = async (force = false) => {
            setLoading(true);
            setError('');
            try {
                const payload = await api(force ? '/api/providers?refresh=1' : '/api/providers');
                setCatalog(payload);
                setSelectedProviderId(current => payload.providers?.some(provider => provider.id === current)
                    ? current
                    : payload.providers?.find(provider => provider.connected)?.id || payload.providers?.[0]?.id || '');
            } catch (loadError) {
                setError(loadError.message);
            } finally {
                setLoading(false);
            }
        };
        React.useEffect(() => { void loadCatalog(); }, []);

        const normalizedProviderSearch = normalizeSearch(providerSearch);
        const visibleProviders = (catalog?.providers || []).filter(provider => normalizeSearch(`${provider.name} ${provider.id}`).includes(normalizedProviderSearch));
        const selectedProvider = visibleProviders.find(provider => provider.id === selectedProviderId) || visibleProviders[0];
        const normalizedModelSearch = normalizeSearch(modelSearch);
        const matchingModels = (selectedProvider?.models || []).filter(model => normalizeSearch(`${model.name} ${model.reference} ${model.family || ''}`).includes(normalizedModelSearch));
        const visibleModels = matchingModels.slice(0, 200);
        const compactNumber = value => value >= 1000000 ? `${(value / 1000000).toFixed(value % 1000000 ? 1 : 0)}M` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
        const price = value => value === undefined ? '—' : value === 0 ? 'grátis' : `$${Number(value).toFixed(value < 1 ? 2 : 1)}`;
        const providerInitials = provider => provider.name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
        const authMethodsFor = provider => provider.authMethods?.length ? provider.authMethods : [{ type: 'api', label: 'Inserir API key' }];
        const beginConnect = provider => {
            const methods = authMethodsFor(provider);
            setAuth({ provider, methods, methodIndex: methods.length === 1 ? 0 : null, inputs: {}, key: '', code: '', stage: methods.length === 1 ? 'form' : 'choose', authorization: null, error: '' });
        };
        const updateAuth = patch => setAuth(current => ({ ...current, ...patch }));
        const activeMethod = auth && auth.methodIndex !== null ? auth.methods[auth.methodIndex] : null;
        const visibleAuthPrompts = (activeMethod?.prompts || []).filter(prompt => {
            if (!prompt.when) return true;
            const matches = auth.inputs[prompt.when.key] === prompt.when.value;
            return prompt.when.op === 'eq' ? matches : !matches;
        });
        const chooseMethod = index => updateAuth({ methodIndex: index, stage: 'form', inputs: {}, key: '', error: '' });
        const completeAuth = async () => {
            await loadCatalog();
            setAuth(null);
        };
        const submitAuth = async () => {
            if (!activeMethod) return;
            if (visibleAuthPrompts.some(prompt => !prompt.optional && !String(auth.inputs[prompt.key] || '').trim())) return updateAuth({ error: 'Preencha os campos obrigatórios.' });
            if (activeMethod.type === 'api' && !auth.key.trim()) return updateAuth({ error: 'Informe a API key.' });
            setAuthBusy(true);
            updateAuth({ error: '' });
            try {
                if (activeMethod.type === 'api') {
                    await api(`/api/providers/${encodeURIComponent(auth.provider.id)}/api-key`, { method: 'POST', body: JSON.stringify({ key: auth.key, metadata: auth.inputs }) });
                    await completeAuth();
                    return;
                }
                const hostMethod = activeMethod.method ?? auth.methodIndex;
                const payload = await api(`/api/providers/${encodeURIComponent(auth.provider.id)}/oauth/authorize`, { method: 'POST', body: JSON.stringify({ method: hostMethod, inputs: auth.inputs }) });
                const authorization = payload.authorization || {};
                if (authorization.url) window.open(authorization.url, '_blank', 'noopener,noreferrer');
                if (authorization.method === 'code') {
                    updateAuth({ stage: 'code', authorization });
                    return;
                }
                updateAuth({ stage: 'waiting', authorization });
                await api(`/api/providers/${encodeURIComponent(auth.provider.id)}/oauth/callback`, { method: 'POST', body: JSON.stringify({ method: hostMethod }) });
                await completeAuth();
            } catch (authError) {
                updateAuth({ error: authError.message, stage: auth?.stage === 'waiting' ? 'form' : auth.stage });
            } finally {
                setAuthBusy(false);
            }
        };
        const submitCode = async () => {
            if (!auth.code.trim()) return updateAuth({ error: 'Cole o código de autorização.' });
            setAuthBusy(true);
            updateAuth({ error: '' });
            try {
                await api(`/api/providers/${encodeURIComponent(auth.provider.id)}/oauth/callback`, { method: 'POST', body: JSON.stringify({ method: activeMethod?.method ?? auth.methodIndex, code: auth.code }) });
                await completeAuth();
            } catch (authError) {
                updateAuth({ error: authError.message });
            } finally {
                setAuthBusy(false);
            }
        };
        const disconnect = async provider => {
            if (!window.confirm(`Desconectar ${provider.name}? Credenciais fornecidas por variáveis de ambiente continuarão disponíveis.`)) return;
            setLoading(true);
            try {
                await api(`/api/providers/${encodeURIComponent(provider.id)}/auth`, { method: 'DELETE' });
                await loadCatalog();
            } catch (disconnectError) {
                setError(disconnectError.message);
            } finally {
                setLoading(false);
            }
        };
        const addModel = async model => {
            setUsingModel(model.reference);
            setError('');
            try {
                await useModel(selectedProvider.id, model.id);
            } catch (useError) {
                setError(useError.message);
            } finally {
                setUsingModel('');
            }
        };

        const authSheet = auth ? h('div', { className: 'provider-auth-overlay' },
            h('section', { className: 'provider-auth-sheet', 'aria-label': `Conectar ${auth.provider.name}` },
                h('div', { className: 'provider-auth-heading' },
                    h('div', null, h('small', null, 'Conexão segura'), h('h3', null, auth.provider.name)),
                    IconButton({ icon: '×', title: 'Fechar conexão', onClick: () => setAuth(null), disabled: authBusy })
                ),
                auth.stage === 'choose' ? h('div', { className: 'auth-method-list' },
                    h('p', { className: 'muted' }, 'Escolha como deseja conectar esta conta.'),
                    auth.methods.map((method, index) => h('button', { key: `${method.type}-${index}`, className: 'auth-method-card', onClick: () => chooseMethod(index) },
                        h('span', { 'aria-hidden': true }, method.type === 'oauth' ? '↗' : '⌁'),
                        h('span', null, h('strong', null, method.label), h('small', null, method.type === 'oauth' ? 'Login pelo navegador' : method.source === 'flow' ? 'Cofre standalone do Flow' : 'Cofre do host externo'))
                    ))
                ) : auth.stage === 'waiting' ? h('div', { className: 'provider-auth-waiting' },
                    h('span', { className: 'spinner provider-auth-spinner', 'aria-hidden': true }),
                    h('strong', null, 'Aguardando autorização no navegador'),
                    h('p', null, auth.authorization?.instructions || 'Conclua o login na janela que foi aberta.')
                ) : auth.stage === 'code' ? h(React.Fragment, null,
                    auth.authorization?.instructions ? h('div', { className: 'callout' }, auth.authorization.instructions) : null,
                    h(Field, { label: 'Código de autorização', wide: true }, h(Text, { value: auth.code, onChange: value => updateAuth({ code: value }), placeholder: 'Cole o código retornado' })),
                    auth.error ? h('div', { className: 'callout callout--error' }, auth.error) : null,
                    h('div', { className: 'modal-actions' }, h('button', { className: 'button button--ghost', onClick: () => updateAuth({ stage: 'form' }), disabled: authBusy }, 'Voltar'), h('button', { className: 'button button--primary', onClick: submitCode, disabled: authBusy }, authBusy ? 'Validando…' : 'Concluir login'))
                ) : h(React.Fragment, null,
                    h('p', { className: 'muted' }, activeMethod?.type === 'oauth' ? 'O navegador será aberto para autenticação. O Flow recebe apenas o estado da conexão.' : 'A chave é criptografada no cofre standalone do Flow e não entra no GraphSpec.'),
                    visibleAuthPrompts.map(prompt => h(Field, { key: prompt.key, label: prompt.message, wide: true }, prompt.type === 'select'
                        ? h(Select, { value: auth.inputs[prompt.key] || '', empty: 'Selecione', options: prompt.options || [], onChange: value => updateAuth({ inputs: { ...auth.inputs, [prompt.key]: value } }) })
                        : h(Text, { value: auth.inputs[prompt.key] || '', onChange: value => updateAuth({ inputs: { ...auth.inputs, [prompt.key]: value } }), placeholder: prompt.placeholder || '' })
                    )),
                    activeMethod?.type === 'api' ? h(Field, { label: 'API key', wide: true }, h('input', { type: 'password', value: auth.key, onChange: event => updateAuth({ key: event.target.value }), placeholder: 'Cole sua chave', autoComplete: 'off', 'data-autofocus': true })) : null,
                    auth.error ? h('div', { className: 'callout callout--error' }, auth.error) : null,
                    h('div', { className: 'modal-actions' }, auth.methods.length > 1 ? h('button', { className: 'button button--ghost', onClick: () => updateAuth({ stage: 'choose', methodIndex: null }), disabled: authBusy }, 'Voltar') : null, h('button', { className: 'button button--primary', onClick: submitAuth, disabled: authBusy }, authBusy ? 'Conectando…' : activeMethod?.type === 'oauth' ? 'Abrir login' : 'Salvar e conectar'))
                )
            )
        ) : null;

        return h(ModalDialog, { close: auth ? () => setAuth(null) : close, labelledBy: 'provider-catalog-title', className: 'modal--providers', initialFocusSelector: '.provider-search' },
            h('div', { className: 'drawer__heading provider-catalog-heading' },
                h('div', null, h('small', null, catalog ? `Catálogo ${catalog.source}` : 'Catálogo unificado'), h('h2', { id: 'provider-catalog-title' }, 'Providers e modelos')),
                h('div', { className: 'row' }, h('button', { className: 'button button--ghost button--small', onClick: () => loadCatalog(true), disabled: loading }, loading ? 'Atualizando…' : '↻ Atualizar'), IconButton({ icon: '×', title: 'Fechar catálogo', onClick: close }))
            ),
            h('div', { className: 'provider-catalog-summary' },
                h('div', null, h('strong', null, catalog?.providers?.length || '—'), h('span', null, 'providers')),
                h('div', null, h('strong', null, catalog?.providers?.reduce((sum, provider) => sum + provider.models.length, 0) || '—'), h('span', null, 'modelos')),
                h('div', null, h('strong', null, catalog?.connected?.length || 0), h('span', null, 'conectados')),
                h('p', null, 'O Flow mantém catálogo e cofre próprios. CyberVinci/OpenCode, quando instalados, entram apenas como fontes e logins opcionais em paralelo.')
            ),
            error ? h('div', { className: 'callout callout--error provider-catalog-error', role: 'alert' }, h('strong', null, 'Não foi possível concluir'), h('span', null, error)) : null,
            loading && !catalog ? h('div', { className: 'provider-catalog-loading' }, h('span', { className: 'spinner', 'aria-hidden': true }), h('span', null, 'Carregando catálogo standalone do Flow…')) : h('div', { className: 'provider-explorer' },
                h('aside', { className: 'provider-pane' },
                    h('input', { className: 'provider-search', value: providerSearch, onChange: event => setProviderSearch(event.target.value), placeholder: 'Buscar provider…', 'aria-label': 'Buscar provider' }),
                    h('div', { className: 'provider-list' }, visibleProviders.map(provider => h('button', { key: provider.id, className: `provider-list-item ${selectedProvider?.id === provider.id ? 'is-selected' : ''}`, onClick: () => { setSelectedProviderId(provider.id); setModelSearch(''); } },
                        h('span', { className: 'provider-avatar', 'aria-hidden': true }, providerInitials(provider)),
                        h('span', null, h('strong', null, provider.name), h('small', null, `${provider.models.length} modelos · ${provider.id}`)),
                        h('i', { className: provider.connected ? 'is-connected' : '', title: provider.connected ? 'Conectado' : 'Não conectado' })
                    )))
                ),
                h('section', { className: 'model-pane' }, selectedProvider ? h(React.Fragment, null,
                    h('header', { className: 'selected-provider-heading' },
                        h('div', null, h('span', { className: 'provider-avatar provider-avatar--large', 'aria-hidden': true }, providerInitials(selectedProvider)), h('span', null, h('strong', null, selectedProvider.name), h('small', null, selectedProvider.connected ? '● Conectado e pronto' : '○ Conecte para executar modelos'))),
                        selectedProvider.connected
                            ? h('button', { className: 'button button--ghost button--small', onClick: () => disconnect(selectedProvider) }, 'Desconectar')
                            : h('button', { className: 'button button--primary button--small', onClick: () => beginConnect(selectedProvider) }, 'Conectar')
                    ),
                    h('div', { className: 'model-search-row' },
                        h('input', { value: modelSearch, onChange: event => setModelSearch(event.target.value), placeholder: `Buscar entre ${selectedProvider.models.length} modelos…`, 'aria-label': 'Buscar modelo' }),
                        h('span', null, `${visibleModels.length}${matchingModels.length > visibleModels.length ? ` de ${matchingModels.length}` : ''}`)
                    ),
                    h('div', { className: 'model-grid' }, visibleModels.length ? visibleModels.map(model => {
                        const isInstalled = installed.has(model.reference);
                        const isDefault = selectedProvider.defaultModel === model.reference;
                        return h('article', { key: model.reference, className: `model-card ${isInstalled ? 'is-installed' : ''}` },
                            h('header', null, h('div', null, h('strong', null, model.name), h('code', null, model.id)), h('div', { className: 'model-badges' }, isDefault ? h('span', null, 'padrão') : null, model.status && model.status !== 'active' ? h('span', { className: 'is-warning' }, model.status) : null)),
                            h('div', { className: 'model-metrics' },
                                h('span', null, h('small', null, 'Contexto'), h('strong', null, model.contextWindow ? compactNumber(model.contextWindow) : '—')),
                                h('span', null, h('small', null, 'Entrada / 1M'), h('strong', null, price(model.costPerMTokPrompt))),
                                h('span', null, h('small', null, 'Saída / 1M'), h('strong', null, price(model.costPerMTokOutput)))
                            ),
                            h('div', { className: 'model-capabilities' }, model.capabilities.slice(0, 5).map(capability => h('span', { key: capability }, capability))),
                            h('button', { className: `button ${isInstalled ? 'button--ghost' : 'button--primary'} button--wide`, disabled: isInstalled || !selectedProvider.connected || usingModel === model.reference, onClick: () => addModel(model) }, isInstalled ? '✓ Adicionado' : !selectedProvider.connected ? 'Conecte primeiro' : usingModel === model.reference ? 'Adicionando…' : 'Usar no Flow')
                        );
                    }) : h('div', { className: 'empty-state model-empty' }, h('span', null, '⌕'), h('strong', null, 'Nenhum modelo encontrado')))
                ) : h('div', { className: 'empty-state' }, h('strong', null, 'Selecione um provider')))
            ),
            authSheet
        );
    }

    function ProfilesDrawer({ profiles, draft, setDraft, save, remove, openCatalog, close }) {
        const field = key => value => setDraft({ ...draft, [key]: value });
        const edit = profile => setDraft({
            ...profile,
            runnerId: profile.runnerId || '',
            tags: (profile.tags || []).join(', '),
            capabilities: (profile.capabilities || []).join(', '),
            contextWindow: profile.contextWindow || '',
            maxOutputTokens: profile.maxOutputTokens || '',
            costPerMTokPrompt: profile.costPerMTokPrompt ?? '',
            costPerMTokOutput: profile.costPerMTokOutput ?? '',
            serviceTierDefault: profile.serviceTierDefault || 'default'
        });
        return h('section', { className: 'drawer drawer--right drawer--wide', 'aria-label': 'Providers e modelos' },
            h('div', { className: 'drawer__heading' }, h('div', null, h('small', null, 'Runners'), h('h2', null, 'Providers e modelos')), IconButton({ icon: '×', title: 'Fechar providers', onClick: close })),
            h('p', { className: 'muted' }, 'Crie assinaturas reutilizáveis. Cada agente pode escolher uma diferente conforme inteligência, custo e esforço.'),
            h('button', { className: 'button button--primary button--wide provider-catalog-cta', onClick: openCatalog }, '◈ Explorar catálogo de modelos'),
            h('div', { className: 'preset-row' },
                h('button', { className: 'button button--ghost button--small', onClick: () => setDraft({ id: 'codex-default', name: 'Codex · assinatura atual', providerId: 'codex', modelId: 'default', runnerId: 'codex', command: '', reasonDefault: 'high', serviceTierDefault: 'default', tags: 'subscription, coding', capabilities: 'text, reasoning, tools, files, structured-output, sessions, subagents', description: 'Usa o login e o modelo padrão já configurados no Codex CLI.', contextWindow: '', maxOutputTokens: '', costPerMTokPrompt: '', costPerMTokOutput: '' }) }, '+ Codex atual'),
                h('button', { className: 'button button--ghost button--small', onClick: () => setDraft({ id: 'cybervinci-default', name: 'CyberVinci · configuração atual', providerId: 'cybervinci', modelId: 'default', runnerId: 'cybervinci', command: '', reasonDefault: 'high', serviceTierDefault: 'default', tags: 'local, coding, tools', capabilities: 'text, reasoning, tools, files, structured-output, sessions, subagents', description: 'Usa o login, o modelo padrão e as sessões do CyberVinci CLI.', contextWindow: '', maxOutputTokens: '', costPerMTokPrompt: '', costPerMTokOutput: '' }) }, '+ CyberVinci atual'),
                h('button', { className: 'button button--ghost button--small', onClick: () => setDraft({ id: 'opencode-default', name: 'OpenCode · configuração atual', providerId: 'opencode', modelId: 'default', runnerId: 'opencode', command: '', reasonDefault: 'medium', serviceTierDefault: 'default', tags: 'local, flexible', capabilities: 'text, reasoning, tools, files, structured-output, sessions, subagents', description: 'Usa provider e modelo padrão já configurados no OpenCode.', contextWindow: '', maxOutputTokens: '', costPerMTokPrompt: '', costPerMTokOutput: '' }) }, '+ OpenCode atual')
            ),
            h('div', { className: 'profile-list' }, profiles.map(profile => h('article', { className: 'profile-card', key: profile.id },
                h('div', null, h('strong', null, profile.name || profile.id), h('span', null, profileBindingLabel(profile)), h('small', null, (profile.tags || []).join(' · '))),
                h('div', { className: 'row' }, h('button', { className: 'button button--ghost button--small', onClick: () => edit(profile) }, 'Editar'), h('button', { type: 'button', className: 'button button--danger button--small', title: 'Excluir este perfil', onClick: () => { if (window.confirm(`Excluir o perfil “${profile.name || profile.id}”?`)) remove(profile.id); } }, 'Excluir'))
            ))),
            h('section', { className: 'inspector-section profile-form' },
                h('h3', null, draft.id ? 'Editar assinatura' : 'Nova assinatura'),
                h('div', { className: 'field-grid' },
                    h(Field, { label: 'Id' }, h(Text, { value: draft.id, onChange: field('id'), placeholder: 'minha-assinatura' })),
                    h(Field, { label: 'Nome amigável' }, h(Text, { value: draft.name, onChange: field('name'), placeholder: 'Codex Pro' })),
                    h(Field, { label: 'Provider' }, h(Text, { value: draft.providerId, onChange: field('providerId'), placeholder: 'codex' })),
                    h(Field, { label: 'Modelo' }, h(Text, { value: draft.modelId, onChange: field('modelId'), placeholder: 'gpt-5.5-codex' })),
                    h(Field, { label: 'Raciocínio padrão' }, h(Select, { value: draft.reasonDefault || 'medium', options: REASONING, onChange: field('reasonDefault') })),
                    h(Field, { label: 'Prioridade padrão' }, h(Select, { value: draft.serviceTierDefault || 'default', options: TIERS, onChange: field('serviceTierDefault') })),
                    h(Field, { label: 'Runner (opcional)' }, h(Text, { value: draft.runnerId, onChange: field('runnerId'), placeholder: 'codex' })),
                    h(Field, { label: 'Tags' }, h(Text, { value: draft.tags, onChange: field('tags'), placeholder: 'econômico, coding' }))
                ),
                h(Field, { label: 'Comando do runner', help: 'Executável local configurado por você; recebe JSON em stdin.', wide: true }, h(Text, { value: draft.command, onChange: field('command'), placeholder: 'node adapters/codex-runner.js' })),
                h(Field, { label: 'Descrição', wide: true }, h(Area, { value: draft.description, onChange: field('description'), rows: 3 })),
                h('details', { className: 'details' }, h('summary', null, 'Custos, limites e capabilities'),
                    h('div', { className: 'field-grid' },
                        h(Field, { label: 'Context window' }, h(Text, { type: 'number', min: 1, value: draft.contextWindow, onChange: field('contextWindow') })),
                        h(Field, { label: 'Máximo de saída' }, h(Text, { type: 'number', min: 1, value: draft.maxOutputTokens, onChange: field('maxOutputTokens') })),
                        h(Field, { label: 'US$ / 1M entrada' }, h(Text, { type: 'number', min: 0, step: '0.01', value: draft.costPerMTokPrompt, onChange: field('costPerMTokPrompt') })),
                        h(Field, { label: 'US$ / 1M saída' }, h(Text, { type: 'number', min: 0, step: '0.01', value: draft.costPerMTokOutput, onChange: field('costPerMTokOutput') }))
                    ),
                    h(Field, { label: 'Capabilities (separadas por vírgula)', wide: true }, h(Text, { value: draft.capabilities, onChange: field('capabilities'), placeholder: 'text, reasoning, tools, files' }))
                ),
                h('button', { className: 'button button--primary button--wide', onClick: save }, 'Salvar assinatura')
            )
        );
    }

    function ValidationDrawer({ validation, close, onValidate }) {
        const issues = [...(validation?.errors || []), ...(validation?.warnings || [])];
        return h('section', { className: 'drawer drawer--right', 'aria-label': 'Validação' }, h('div', { className: 'drawer__heading' }, h('div', null, h('small', null, 'GraphSpec v2'), h('h2', null, validation?.valid ? 'Fluxo válido' : 'Revisar fluxo')), IconButton({ icon: '×', title: 'Fechar validação', onClick: close })), h('button', { className: 'button button--primary button--wide', onClick: onValidate }, 'Validar agora'), validation ? h('div', { className: 'issue-list' }, issues.length ? issues.map((issue, index) => h('article', { className: `issue issue--${issue.kind}`, key: `${issue.path}-${index}` }, h('strong', null, issue.message), h('code', null, issue.path), issue.hint ? h('p', null, issue.hint) : null)) : h('div', { className: 'empty-state' }, h('span', null, '✓'), h('strong', null, 'Nenhum problema encontrado'))) : h('p', { className: 'muted' }, 'Execute a validação para ver problemas estruturais, permissões, custos e rotas.'));
    }

    function ContextMenu({ menu, close, add, openPalette, duplicate, removeNode, setStart, removeEdge, load, save, author, validate, graphSpec, profiles, run }) {
        const quickTypes = ['agent', 'router', 'action', 'context', 'gate', 'end'];
        const quickAdd = quickTypes.map(type => NODE_BY_TYPE[type]).map(item => ({ label: `${item.icon} ${item.label}`, action: () => add(item.type) }));
        const actions = menu.kind === 'node' ? [{ label: 'Duplicar', action: duplicate }, { label: 'Definir como início', action: setStart }, { label: 'Remover', action: removeNode, danger: true }] : menu.kind === 'edge' ? [{ label: 'Remover conexão', action: removeEdge, danger: true }] : menu.kind === 'canvas' ? [...quickAdd, { label: '… Mais blocos', action: openPalette }] : [{ label: 'Criar com IA', action: author }, { label: 'Carregar', action: load }, { label: 'Salvar', action: save }, { label: 'Validar', action: validate }, { label: 'Editar GraphSpec completo', action: graphSpec }, { label: 'Execução', action: run }, { label: 'Providers e modelos', action: profiles }];
        const menuRef = React.useRef(null);
        React.useEffect(() => { menuRef.current?.querySelector('button')?.focus(); }, []);
        const onKeyDown = event => {
            const buttons = [...menuRef.current.querySelectorAll('button')];
            const index = buttons.indexOf(document.activeElement);
            if (event.key === 'Escape') { event.preventDefault(); close(); return; }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            const direction = event.key === 'ArrowDown' ? 1 : -1;
            buttons[(index + direction + buttons.length) % buttons.length]?.focus();
        };
        return h('div', { ref: menuRef, className: 'context-menu', role: 'menu', 'aria-label': 'Menu contextual', style: { left: Math.max(8, Math.min(menu.x, window.innerWidth - 250)), top: Math.max(8, Math.min(menu.y, window.innerHeight - Math.min(actions.length * 42, 560) - 16)) }, onKeyDown }, actions.map((item, index) => h('button', { key: index, role: 'menuitem', className: item.danger ? 'is-danger' : '', onClick: () => { item.action(); close(); } }, item.label)));
    }

    function AuthorDialog({ instruction, setInstruction, profiles, profileId, setProfileId, preview, generate, apply, close, busy }) {
        const editor = h(
            React.Fragment,
            null,
            h('p', { className: 'muted' }, 'Descreva o resultado. O agente escolhe blocos, providers, condicionais, gates, limites e ferramentas; nada é aplicado sem sua revisão.'),
            h(Field, { label: 'O que o fluxo deve fazer?', wide: true },
                h(Area, { value: instruction, onChange: setInstruction, rows: 10, placeholder: 'Crie um fluxo que…' })
            ),
            h(Field, { label: 'Modelo autor', wide: true },
                h(Select, {
                    value: profileId,
                    empty: 'Selecione um perfil configurado',
                    options: profiles.map(item => ({ value: item.id, label: profileOptionLabel(item) })),
                    onChange: setProfileId
                })
            ),
            h('button', { className: 'button button--primary button--wide', onClick: generate, disabled: busy || !instruction.trim() }, busy ? 'Gerando…' : 'Gerar proposta')
        );
        const proposal = preview ? h(
            React.Fragment,
            null,
            h('div', { className: 'author-summary' },
                h('strong', null, preview.summary || 'Proposta gerada'),
                preview.assumptions?.length ? h('ul', null, preview.assumptions.map((item, index) => h('li', { key: index }, item))) : null
            ),
            h('div', { className: 'proposal-stats' },
                h('span', null, `${preview.graph.nodes.length} blocos`),
                h('span', null, `${preview.graph.edges.length} conexões`),
                h('span', null, `${preview.validation.warnings.length} avisos`)
            ),
            h('pre', { className: 'code-view code-view--proposal' }, JSON.stringify(preview.graph, null, 2)),
            h('div', { className: 'modal-actions' },
                h('button', { className: 'button button--ghost', onClick: close }, 'Descartar'),
                h('button', { className: 'button button--primary', onClick: apply }, 'Aplicar para revisão')
            )
        ) : null;
        return h(ModalDialog, { close, labelledBy: 'author-title', initialFocusSelector: preview ? '.modal-actions .button--primary' : 'textarea' },
            h('div', { className: 'drawer__heading' },
                h('div', null, h('small', null, 'Graph Engineering'), h('h2', { id: 'author-title' }, 'Criar ou revisar com IA')),
                IconButton({ icon: '×', title: 'Fechar autoria', onClick: close })
            ),
            preview ? proposal : editor
        );
    }

    ReactDOM.createRoot(document.getElementById('app')).render(h(App));
})();
