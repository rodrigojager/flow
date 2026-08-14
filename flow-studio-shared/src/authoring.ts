import { FLOW_STUDIO_SCHEMA_VERSION } from './types';
import Ajv2020 from 'ajv/dist/2020';
import type {
    FlowStudioAuthorAdapter,
    FlowStudioAuthorRequest,
    FlowStudioAuthorResult,
    FlowStudioGraph,
    FlowStudioNodeType
} from './types';
import { validateFlowStudioGraph } from './engine';

const AUTHOR_NODE_TYPES: FlowStudioNodeType[] = [
    'input', 'context', 'agent', 'playbook', 'action', 'command', 'memory_write',
    'router', 'fork', 'dynamic_parallel', 'tournament', 'join', 'gate',
    'wait', 'subgraph', 'loop', 'transform', 'report', 'end'
];

export const FLOW_STUDIO_GRAPH_SCHEMA: Record<string, unknown> = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://cybervinci.local/schemas/flow-studio-v2.json',
    title: 'Flow Studio GraphSpec v2',
    type: 'object',
    additionalProperties: false,
    required: ['version', 'id', 'name', 'start', 'nodes', 'edges'],
    properties: {
        version: { const: FLOW_STUDIO_SCHEMA_VERSION },
        id: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        start: { type: 'string', minLength: 1 },
        tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        metadata: { type: 'object' },
        budget: { $ref: '#/$defs/budget' },
        permissions: { $ref: '#/$defs/permissions' },
        state: {
            type: 'object',
            additionalProperties: false,
            properties: {
                strictWrites: { type: 'boolean' },
                initial: { type: 'object' },
                namespaces: {
                    type: 'object',
                    additionalProperties: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            description: { type: 'string' },
                            schema: { type: 'object' },
                            initial: { type: 'object' },
                            reducer: { $ref: '#/$defs/reducer' }
                        }
                    }
                }
            }
        },
        modelProfiles: { type: 'array', items: { $ref: '#/$defs/modelProfile' } },
        runners: { type: 'array', items: { $ref: '#/$defs/runner' } },
        subgraphs: { type: 'object', additionalProperties: { $ref: '#' } },
        nodes: { type: 'array', minItems: 1, items: { $ref: '#/$defs/node' } },
        edges: { type: 'array', items: { $ref: '#/$defs/edge' } }
    },
    $defs: {
        budget: {
            type: 'object', additionalProperties: false,
            properties: {
                maxSteps: { type: 'integer', minimum: 1 }, maxDurationMs: { type: 'integer', minimum: 1 },
                maxCostUsd: { type: 'number', minimum: 0 }, maxInputTokens: { type: 'integer', minimum: 1 },
                maxOutputTokens: { type: 'integer', minimum: 1 }, maxParallelism: { type: 'integer', minimum: 1 }
            }
        },
        permissions: {
            type: 'object', additionalProperties: false,
            properties: {
                allow: { type: 'array', items: { type: 'string' } }, deny: { type: 'array', items: { type: 'string' } },
                requireApproval: { type: 'array', items: { type: 'string' } }, fileRoots: { type: 'array', items: { type: 'string' } },
                networkHosts: { type: 'array', items: { type: 'string' } }, commandPatterns: { type: 'array', items: { type: 'string' } }
            }
        },
        reducer: {
            type: 'object', additionalProperties: false, required: ['kind'],
            properties: { kind: { enum: ['replace', 'merge', 'append', 'sum', 'min', 'max', 'first', 'last', 'custom'] }, expression: { type: 'string' } }
        },
        runnerBinding: {
            type: 'object', additionalProperties: false, required: ['providerId'],
            properties: {
                runnerId: { type: 'string' }, providerId: { type: 'string' }, modelId: { type: 'string' }, profileId: { type: 'string' },
                reasoningEffort: { enum: ['none', 'low', 'medium', 'high', 'xhigh'] }, serviceTier: { enum: ['default', 'fast', 'flex'] },
                timeoutMs: { type: 'integer', minimum: 1 }, sessionId: { type: 'string' }, command: { type: 'string' },
                requiredCapabilities: { type: 'array', items: { type: 'string' } },
                fallbacks: { type: 'array', items: { $ref: '#/$defs/runnerBinding' } }
            }
        },
        modelProfile: {
            type: 'object', additionalProperties: false, required: ['id', 'name', 'providerId', 'modelId'],
            properties: {
                id: { type: 'string' }, name: { type: 'string' }, providerId: { type: 'string' }, modelId: { type: 'string' }, runnerId: { type: 'string' },
                description: { type: 'string' }, command: { type: 'string' }, contextWindow: { type: 'integer', minimum: 1 }, maxOutputTokens: { type: 'integer', minimum: 1 },
                costPerMTokPrompt: { type: 'number', minimum: 0 }, costPerMTokOutput: { type: 'number', minimum: 0 }, tags: { type: 'array', items: { type: 'string' } },
                capabilities: { type: 'array', items: { type: 'string' } }, reasonDefault: { enum: ['none', 'low', 'medium', 'high', 'xhigh'] }, serviceTierDefault: { enum: ['default', 'fast', 'flex'] }
            }
        },
        runner: {
            type: 'object', additionalProperties: false, required: ['id', 'name', 'kind', 'capabilities'],
            properties: {
                id: { type: 'string' }, name: { type: 'string' }, kind: { enum: ['flow', 'llm', 'codex', 'cybervinci', 'opencode', 'command', 'http', 'mcp', 'worker'] },
                providerId: { type: 'string' }, command: { type: 'string' }, endpoint: { type: 'string' }, capabilities: { type: 'array', items: { type: 'string' } },
                models: { type: 'array', items: { type: 'string' } }, metadata: { type: 'object' }
            }
        },
        gateRule: {
            type: 'object', additionalProperties: false, required: ['id', 'expression'],
            properties: { id: { type: 'string' }, expression: { type: 'string' }, message: { type: 'string' }, severity: { enum: ['info', 'warning', 'blocker'] } }
        },
        gateConfig: {
            type: 'object', additionalProperties: false, required: ['kind'],
            properties: {
                kind: { enum: ['human', 'deterministic', 'ai', 'policy', 'composite'] }, prompt: { type: 'string' }, expression: { type: 'string' },
                rules: { type: 'array', items: { $ref: '#/$defs/gateRule' } }, children: { type: 'array', items: { $ref: '#/$defs/gateConfig' } },
                combine: { enum: ['all', 'any', 'majority'] }, reviewer: { $ref: '#/$defs/runnerBinding' }, requireEvidence: { type: 'boolean' },
                timeoutMs: { type: 'integer', minimum: 1 }, onTimeout: { enum: ['continue', 'wait', 'fail'] }
            }
        },
        subgraphConfig: {
            type: 'object', additionalProperties: false,
            properties: {
                graphId: { type: 'string' }, graphRef: { type: 'string' }, inline: { $ref: '#' },
                input: { type: 'object', additionalProperties: { type: 'string' } }, output: { type: 'object', additionalProperties: { type: 'string' } }, isolated: { type: 'boolean' }
            }
        },
        contextConfig: {
            type: 'object', additionalProperties: false,
            description: 'Pacote de contexto limitado, carregado por adapter a partir de memoria, estado e arquivos. Declare ao menos uma fonte.',
            properties: {
                query: { type: 'string' }, scopes: { type: 'array', items: { enum: ['ide', 'workspace', 'project', 'workflow', 'run', 'agent'] }, uniqueItems: true },
                statePaths: { type: 'array', items: { type: 'string' }, uniqueItems: true }, filePaths: { type: 'array', items: { type: 'string' }, uniqueItems: true },
                tags: { type: 'array', items: { type: 'string' }, uniqueItems: true }, maxItems: { type: 'integer', minimum: 1, maximum: 1000 }, maxBytes: { type: 'integer', minimum: 1024, maximum: 4194304 },
                outputPath: { type: 'string' }, required: { type: 'boolean' }, scopeId: { type: 'string' }
            }
        },
        commandConfig: {
            type: 'object', additionalProperties: false, required: ['command'],
            description: 'Execucao direta de um executavel com args separados, nunca uma linha interpretada por shell. Efeitos mutaveis exigem idempotencia e zero retry automatico.',
            properties: {
                command: { type: 'string', minLength: 1 }, args: { type: 'array', items: { type: 'string' } }, cwd: { type: 'string' },
                timeoutMs: { type: 'integer', minimum: 1 }, retries: { type: 'integer', minimum: 0 }, retryDelayMs: { type: 'integer', minimum: 0 },
                effect: { enum: ['none', 'read', 'write', 'command', 'network', 'message', 'deploy', 'custom'] }, idempotencyKey: { type: 'string' },
                requiredPermissions: { type: 'array', items: { type: 'string' } }
            }
        },
        memoryWriteConfig: {
            type: 'object', additionalProperties: false, required: ['scope', 'candidatesFrom'],
            description: 'Persistencia auditavel de candidatos de memoria. O status e editorial; candidate ou approved so pode ser gravado com receipt humano ligado ao digest e ao destino exato.',
            properties: {
                scope: { enum: ['ide', 'workspace', 'project', 'workflow', 'run', 'agent'] }, candidatesFrom: { type: 'string', minLength: 1 },
                candidateIds: { type: 'array', items: { type: 'string' }, uniqueItems: true }, policy: { const: 'approved-only' }, onEmpty: { enum: ['skip', 'fail'] },
                storeId: { type: 'string' }, kind: { enum: ['fact', 'decision', 'preference', 'instruction', 'summary'] }, outputPath: { type: 'string' }, idempotencyKey: { type: 'string' }, scopeId: { type: 'string' }
            }
        },
        playbookConfig: {
            type: 'object', additionalProperties: false, required: ['playbookId'],
            description: 'Invocacao tipada de playbook externo ou GraphSpec reutilizavel, com mapeamentos explicitos de entrada e saida.',
            properties: {
                playbookId: { type: 'string', minLength: 1 }, graphId: { type: 'string' }, graphRef: { type: 'string' }, inline: { $ref: '#' },
                input: { type: 'object', additionalProperties: { type: 'string' } }, parameters: { type: 'object' }, output: { type: 'object', additionalProperties: { type: 'string' } },
                isolated: { type: 'boolean' }, idempotencyKey: { type: 'string' }
            }
        },
        dynamicParallelConfig: {
            type: 'object', additionalProperties: false, required: ['itemsFrom', 'worker', 'maxItems'],
            description: 'Fan-out dinamico e limitado: avalia uma colecao, injeta cada item no worker embutido e agrega resultados em ordem deterministica.',
            properties: {
                itemsFrom: { type: 'string', minLength: 1 }, itemVariable: { type: 'string' }, worker: { $ref: '#/$defs/node' },
                concurrency: { type: 'integer', minimum: 1 }, maxItems: { type: 'integer', minimum: 1 }, failurePolicy: { enum: ['fail_fast', 'best_effort', 'threshold'] },
                failureThreshold: { type: 'number', minimum: 0 }, joinStrategy: { enum: ['collect', 'best_effort', 'require_all'] }, outputPath: { type: 'string' }
            }
        },
        tournamentConfig: {
            type: 'object', additionalProperties: false, required: ['candidatesFrom', 'judge', 'criteria', 'winnerCount', 'maxComparisons'],
            description: 'Selecao competitiva limitada. O juiz embutido compara apenas candidatos anonimizados e devolve winnerIds validos e scores estruturados.',
            properties: {
                candidatesFrom: { type: 'string', minLength: 1 }, judge: { $ref: '#/$defs/node' }, strategy: { enum: ['single_round', 'bracket', 'round_robin'] },
                criteria: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, uniqueItems: true }, winnerCount: { type: 'integer', minimum: 1 },
                maxComparisons: { type: 'integer', minimum: 1 }, tieBreaker: { enum: ['judge_again', 'score_total', 'first_candidate'] }, maxTieRounds: { type: 'integer', minimum: 1 },
                outputPath: { type: 'string' }, blind: { type: 'boolean' }, identityFields: { type: 'array', items: { type: 'string' }, uniqueItems: true }
            }
        },
        tool: {
            type: 'object', additionalProperties: false, required: ['id', 'name', 'command'],
            properties: {
                id: { type: 'string' }, name: { type: 'string' }, command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } },
                cwd: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1 }, retries: { type: 'integer', minimum: 0 },
                retryDelayMs: { type: 'integer', minimum: 0 }, effect: { enum: ['none', 'read', 'write', 'command', 'network', 'message', 'deploy', 'custom'] },
                idempotencyKey: { type: 'string' }, requiredPermissions: { type: 'array', items: { type: 'string' } }
            }
        },
        node: {
            type: 'object', additionalProperties: false, required: ['id', 'type', 'label'],
            properties: {
                id: { type: 'string', minLength: 1 }, type: { enum: AUTHOR_NODE_TYPES }, label: { type: 'string', minLength: 1 },
                description: { type: 'string' }, prompt: { type: 'string' }, condition: { type: 'string' }, next: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' } }, outputs: { type: 'object', additionalProperties: { type: 'string' } },
                provider: { $ref: '#/$defs/runnerBinding' }, runner: { $ref: '#/$defs/runnerBinding' }, tools: { type: 'array', items: { $ref: '#/$defs/tool' } },
                retries: { type: 'integer', minimum: 0 }, retryDelayMs: { type: 'integer', minimum: 0 }, timeoutMs: { type: 'integer', minimum: 1 },
                continueOnError: { type: 'boolean' }, toolExecMode: { enum: ['first', 'all'] }, budget: { $ref: '#/$defs/budget' }, permissions: { $ref: '#/$defs/permissions' },
                rag: { type: 'object', additionalProperties: false, properties: { markdown: { type: 'string' }, filePath: { type: 'string' }, maxBytes: { type: 'integer', minimum: 1 } } },
                loop: { type: 'object', additionalProperties: false, required: ['bodyStart', 'condition', 'maxIterations'], properties: { bodyStart: { type: 'string' }, condition: { type: 'string' }, maxIterations: { type: 'integer', minimum: 1 }, breakWhen: { type: 'string' } } },
                fork: { type: 'object', additionalProperties: false, required: ['branches', 'join'], properties: { branches: { type: 'array', minItems: 1, items: { type: 'string' } }, join: { type: 'string' }, maxConcurrency: { type: 'integer', minimum: 1 }, continueOnError: { type: 'boolean' } } },
                join: { type: 'object', additionalProperties: false, required: ['strategy'], properties: { strategy: { enum: ['all', 'any', 'quorum', 'majority'] }, quorum: { type: 'integer', minimum: 1 }, cancelRemaining: { type: 'boolean' }, reducer: { type: 'string' } } },
                gate: { $ref: '#/$defs/gateConfig' },
                gatePrompt: { type: 'string' }, gateDecisions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'label', 'decision'], properties: { id: { type: 'string' }, label: { type: 'string' }, toNodeId: { type: 'string' }, decision: { enum: ['continue', 'wait', 'fail'] }, note: { type: 'string' } } } },
                wait: { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { enum: ['duration', 'until', 'event'] }, durationMs: { type: 'integer', minimum: 1 }, until: { type: 'string' }, eventName: { type: 'string' }, correlationKey: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1 }, onTimeout: { enum: ['continue', 'fail'] } } },
                subgraph: { $ref: '#/$defs/subgraphConfig' }, context: { $ref: '#/$defs/contextConfig' }, command: { $ref: '#/$defs/commandConfig' },
                memoryWrite: { $ref: '#/$defs/memoryWriteConfig' }, playbook: { $ref: '#/$defs/playbookConfig' }, dynamicParallel: { $ref: '#/$defs/dynamicParallelConfig' },
                tournament: { $ref: '#/$defs/tournamentConfig' }, metadata: { type: 'object' },
                position: { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } }
            }
        },
        edge: {
            type: 'object', additionalProperties: false, required: ['from', 'to'],
            properties: { id: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, guard: { type: 'string' }, outcome: { enum: ['forward', 'back'] }, priority: { type: 'number' }, label: { type: 'string' }, metadata: { type: 'object' } }
        }
    }
};

const validateAuthorGraphSchema = new Ajv2020({ allErrors: true, strict: false }).compile(FLOW_STUDIO_GRAPH_SCHEMA);

/** Uses the same complete GraphSpec contract for manual/API validation and AI authoring. */
export function validateFlowStudioGraphSchema(value: unknown): Array<{ path: string; message: string }> {
    if (validateAuthorGraphSchema(value)) return [];
    return (validateAuthorGraphSchema.errors || []).map(error => ({
        path: error.instancePath || '/',
        message: error.message || 'valor inválido'
    }));
}

export function createFlowStudioAuthorPrompt(request: FlowStudioAuthorRequest): string {
    const catalog = {
        runners: request.availableRunners || [],
        models: request.availableModels || [],
        tools: request.availableTools || [],
        playbooks: request.availablePlaybooks || []
    };
    const mode = request.currentGraph ? 'Revise o grafo existente' : 'Crie um grafo novo';
    return [
        'Você é o arquiteto do CyberVinci Flow Studio.',
        `${mode} como GraphSpec flow-studio/v2 completo, executável e simples de entender.`,
        [
            'Escolha o menor conjunto de blocos que expresse a intenção:',
            '- Input inicia a requisição; Context carrega memória/estado/arquivos; Agent raciocina; Report sintetiza; End encerra.',
            '- Router decide por expressão/guards; Transform altera estado de modo determinístico; Gate controla aprovação/política; Wait suspende por tempo/evento.',
            '- Action usa ferramentas declaradas; Command executa um programa local sem shell; Memory Write persiste memória aprovada; Playbook reutiliza uma capacidade externa ou outro GraphSpec.',
            '- Fork+Join modela branches estáticas; Dynamic Parallel processa uma coleção; Tournament compara alternativas; Loop repete com limite; Subgraph compõe grafos.'
        ].join('\n'),
        [
            'Contratos obrigatórios dos blocos especializados:',
            '- Context: declare query, statePaths, filePaths ou tags; selecione os menores scopes; sempre limite maxItems e maxBytes; use required=true apenas se a ausência impedir o fluxo.',
            '- Command: separe command e args; nunca use shell, operadores encadeados ou segredos inline; restrinja cwd, commandPatterns e requiredPermissions. Efeito mutável exige idempotencyKey e retries=0.',
            '- Memory Write: candidatesFrom deve apontar para FlowStudioMemoryCandidate; policy é approved-only; escolha scope mínimo, onEmpty explícito e idempotência estável. O runtime só persiste a revisão com receipt humano ligado ao digest do conteúdo; nunca trate status textual como autorização.',
            '- Playbook: use playbookId estável; escolha exatamente uma implementação (graphId, graphRef, inline ou host externo); mapeie input/output. Host externo exige idempotencyKey.',
            '- Dynamic Parallel: itemsFrom deve retornar array; declare worker embutido, itemVariable, concurrency e maxItems; escolha failurePolicy, failureThreshold quando aplicável, joinStrategy e outputPath.',
            '- Tournament: candidatesFrom deve retornar ao menos dois itens; declare judge embutido, critérios objetivos, strategy, winnerCount e maxComparisons. O juiz deve devolver JSON com winnerIds permitidos, scores, reason e evidence; defina desempate limitado.'
        ].join('\n'),
        [
            'Limites, segurança e estado:',
            '- Todo Loop tem maxIterations; todo fan-out tem maxItems/concurrency; todo torneio tem maxComparisons; todo efeito e chamada externa tem timeout.',
            '- Efeitos mutáveis (write, command, network, message, deploy, custom) declaram effect, idempotencyKey e requiredPermissions e não recebem retry automático após resultado ambíguo.',
            '- Permissões do grafo e do nó formam interseção: o nó nunca amplia a política global. Use allowlists mínimas para comandos, diretórios e hosts.',
            '- Crie budget global de passos, duração, custo, tokens e paralelismo; adicione budgets de nó onde o risco justificar.',
            '- Use caminhos de estado simples e seguros, outputs explícitos, namespaces e reducers quando branches puderem escrever juntas. Evite estado oculto e ciclos sem limite.'
        ].join('\n'),
        'Cada Agent, Report e juiz/worker de IA deve escolher provider, model/profile e reasoningEffort por nó conforme inteligência necessária, custo e latência. Anexe RAG por markdown/filePath quando houver instrução persistente e exponha apenas as ferramentas necessárias.',
        'Nunca invente runners, modelos, perfis, ferramentas ou playbooks quando um catálogo foi fornecido. Se faltar uma capacidade, registre a necessidade em assumptions em vez de fabricar um id. Não execute, publique nem aprove efeitos: apenas proponha o grafo revisável.',
        'Garanta ids únicos, start existente, arestas alcançáveis e configuração compatível com o schema. Prefira labels curtos e descrições úteis; complexidade deve ficar dentro do bloco contextual, não espalhada em um painel excessivo.',
        'Responda apenas JSON no formato {"graph": GraphSpec, "summary": string, "assumptions": string[]}.',
        `Pedido do usuário:\n${request.instruction.trim()}`,
        request.constraints?.length ? `Restrições:\n- ${request.constraints.join('\n- ')}` : '',
        `Catálogo disponível:\n${JSON.stringify(catalog, null, 2)}`,
        request.currentGraph ? `Grafo atual:\n${JSON.stringify(request.currentGraph, null, 2)}` : ''
    ].filter(Boolean).join('\n\n');
}

export async function authorFlowStudioGraph(request: FlowStudioAuthorRequest, adapter: FlowStudioAuthorAdapter, signal?: AbortSignal): Promise<FlowStudioAuthorResult> {
    if (!request.instruction?.trim()) throw new Error('A instrução de autoria é obrigatória.');
    const raw = await adapter({ request, systemPrompt: createFlowStudioAuthorPrompt(request), schema: FLOW_STUDIO_GRAPH_SCHEMA, signal });
    const parsed = parseAuthorPayload(raw);
    const graph = (parsed.graph || parsed) as FlowStudioGraph;
    if (!validateAuthorGraphSchema(graph)) {
        const details = (validateAuthorGraphSchema.errors || []).map(error => `${error.instancePath || '/'} ${error.message || 'inválido'}`).join('; ');
        throw new Error(`O agente produziu JSON fora do GraphSpec: ${details}`);
    }
    const validation = validateFlowStudioGraph(graph);
    if (!validation.valid) {
        throw new Error(`O agente produziu um grafo inválido: ${validation.errors.map(issue => `${issue.path}: ${issue.message}`).join('; ')}`);
    }
    return {
        graph,
        summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
        assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions.filter((item): item is string => typeof item === 'string') : undefined,
        validation,
        raw
    };
}

function parseAuthorPayload(raw: unknown): Record<string, unknown> {
    if (isRecord(raw)) return raw;
    if (typeof raw !== 'string') throw new Error('O adapter de autoria não retornou JSON.');
    const source = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(source) as unknown;
    if (!isRecord(parsed)) throw new Error('A resposta de autoria deve ser um objeto JSON.');
    return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
