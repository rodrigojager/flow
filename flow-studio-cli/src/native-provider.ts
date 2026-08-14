import type { FlowStudioProviderAdapter, FlowStudioRunnerOutput } from '@cybervinci/flow-shared';
import { FlowStandaloneProviderService, type FlowStandaloneCredential, type FlowStandaloneProtocol } from './standalone-provider';

const DEFAULT_ENDPOINTS: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    google: 'https://generativelanguage.googleapis.com/v1beta',
    groq: 'https://api.groq.com/openai/v1',
    xai: 'https://api.x.ai/v1',
    mistral: 'https://api.mistral.ai/v1',
    deepinfra: 'https://api.deepinfra.com/v1/openai',
    cerebras: 'https://api.cerebras.ai/v1',
    togetherai: 'https://api.together.xyz/v1',
    perplexity: 'https://api.perplexity.ai',
    openrouter: 'https://openrouter.ai/api/v1',
    opencode: 'https://opencode.ai/zen/v1',
    'opencode-go': 'https://opencode.ai/zen/go/v1'
};

export function createStandaloneProviderAdapter(service = new FlowStandaloneProviderService()): FlowStudioProviderAdapter {
    return async args => {
        const providerId = args.runner.providerId;
        if (!providerId || providerId === 'flow') throw new Error('O runner standalone precisa de um providerId específico. Selecione um modelo no catálogo do Flow.');
        const requested = args.model?.modelId || args.runner.modelId;
        const modelId = stripProviderPrefix(providerId, requested);
        if (!modelId || modelId === 'default') throw new Error(`Selecione um modelo específico de ${providerId}.`);
        const prompt = runnerPrompt(args.prompt, args.input, Object.keys(args.node.outputs || {}), args.node.tools || []);
        const timeoutMs = args.runner.timeoutMs || args.node.timeoutMs || 10 * 60_000;
        const signal = combineSignals(args.signal, AbortSignal.timeout(timeoutMs));
        const result = await runStandaloneProviderText(service, providerId, modelId, prompt, args.runner.reasoningEffort, args.model?.maxOutputTokens, signal);
        return normalizeRunnerOutput(result.text, result.usage, args.node.id);
    };
}

export interface FlowStandaloneTextResult {
    text: string;
    usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

export async function runStandaloneProviderText(
    service: FlowStandaloneProviderService,
    providerId: string,
    modelId: string,
    prompt: string,
    reasoning?: string,
    maxOutput?: number,
    signal: AbortSignal = AbortSignal.timeout(10 * 60_000)
): Promise<FlowStandaloneTextResult> {
    const provider = await service.provider(providerId);
    if (!provider) throw new Error(`Provider "${providerId}" não existe no catálogo standalone do Flow.`);
    const models = isRecord(provider.models) ? provider.models : {};
    const model = isRecord(models[modelId]) ? models[modelId] : undefined;
    const credential = await service.credential(providerId);
    const env = Array.isArray(provider.env) ? provider.env : [];
    if (!credential && env.length > 0) throw new Error(`Provider "${providerId}" não está conectado. Use "flow providers login ${providerId}" ou o botão Modelos.`);
    const modelProvider = model && isRecord(model.provider) ? model.provider : {};
    const packageName = stringValue(modelProvider.npm) || stringValue(provider.npm);
    const baseURL = credential?.baseURL || stringValue(modelProvider.api) || stringValue(provider.api) || DEFAULT_ENDPOINTS[providerId];
    if (!baseURL) throw new Error(`O provider "${providerId}" exige uma Base URL no modo standalone. Reconecte-o e informe o endpoint, ou use CyberVinci/OpenCode como host opcional.`);
    const protocol = credential?.protocol && credential.protocol !== 'auto' ? credential.protocol : inferProtocol(packageName, providerId);
    return protocol === 'anthropic'
        ? callAnthropic(baseURL, credential, modelId, prompt, maxOutput, signal)
        : protocol === 'google'
            ? callGoogle(baseURL, credential, modelId, prompt, signal)
            : providerId === 'openai' && packageName === '@ai-sdk/openai'
                ? callOpenAIResponses(baseURL, credential, modelId, prompt, reasoning, signal)
                : callOpenAICompatible(baseURL, credential, modelId, prompt, reasoning, signal);
}

async function callOpenAICompatible(baseURL: string, credential: FlowStandaloneCredential | undefined, model: string, prompt: string, reasoning: string | undefined, signal: AbortSignal): Promise<FlowStandaloneTextResult> {
    const endpoint = appendEndpoint(baseURL, 'chat/completions');
    const response = await providerFetch(endpoint, credential, {
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        ...(reasoning && reasoning !== 'none' ? { reasoning_effort: reasoning } : {})
    }, signal);
    const choice = Array.isArray(response.choices) && isRecord(response.choices[0]) ? response.choices[0] : undefined;
    const message = choice && isRecord(choice.message) ? choice.message : undefined;
    const text = message ? contentText(message.content) : '';
    if (!text) throw new Error('O provider retornou uma resposta sem conteúdo textual.');
    return { text, usage: normalizeUsage(response.usage) };
}

async function callOpenAIResponses(baseURL: string, credential: FlowStandaloneCredential | undefined, model: string, prompt: string, reasoning: string | undefined, signal: AbortSignal): Promise<FlowStandaloneTextResult> {
    const endpoint = appendEndpoint(baseURL, 'responses');
    const response = await providerFetch(endpoint, credential, {
        model,
        input: prompt,
        ...(reasoning && reasoning !== 'none' ? { reasoning: { effort: reasoning } } : {})
    }, signal);
    const direct = stringValue(response.output_text);
    const output = Array.isArray(response.output) ? response.output : [];
    const text = direct || output.flatMap(item => isRecord(item) && Array.isArray(item.content) ? item.content : [])
        .map(item => isRecord(item) ? stringValue(item.text) : undefined).filter(Boolean).join('\n');
    if (!text) throw new Error('A API Responses retornou uma resposta sem conteúdo textual.');
    return { text, usage: normalizeUsage(response.usage) };
}

async function callAnthropic(baseURL: string, credential: FlowStandaloneCredential | undefined, model: string, prompt: string, maxOutput: number | undefined, signal: AbortSignal): Promise<FlowStandaloneTextResult> {
    const endpoint = appendEndpoint(baseURL, 'messages');
    const headers = {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(credential?.apiKey ? { 'x-api-key': credential.apiKey } : {}),
        ...(credential?.headers || {})
    };
    const response = await rawJsonFetch(endpoint, headers, {
        model,
        max_tokens: Math.max(1, Math.min(maxOutput || 8192, 65_536)),
        messages: [{ role: 'user', content: prompt }]
    }, signal);
    const text = Array.isArray(response.content) ? response.content.map(item => isRecord(item) ? stringValue(item.text) : undefined).filter(Boolean).join('\n') : '';
    if (!text) throw new Error('A API Anthropic retornou uma resposta sem conteúdo textual.');
    return { text, usage: normalizeUsage(response.usage) };
}

async function callGoogle(baseURL: string, credential: FlowStandaloneCredential | undefined, model: string, prompt: string, signal: AbortSignal): Promise<FlowStandaloneTextResult> {
    const normalizedModel = model.replace(/^models\//, '');
    const endpoint = appendEndpoint(baseURL, `models/${encodeURIComponent(normalizedModel)}:generateContent`);
    const headers = {
        'Content-Type': 'application/json',
        ...(credential?.apiKey ? { 'x-goog-api-key': credential.apiKey } : {}),
        ...(credential?.headers || {})
    };
    const response = await rawJsonFetch(endpoint, headers, { contents: [{ role: 'user', parts: [{ text: prompt }] }] }, signal);
    const candidates = Array.isArray(response.candidates) ? response.candidates : [];
    const text = candidates.flatMap(candidate => isRecord(candidate) && isRecord(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [])
        .map(part => isRecord(part) ? stringValue(part.text) : undefined).filter(Boolean).join('\n');
    if (!text) throw new Error('A API Google retornou uma resposta sem conteúdo textual.');
    return { text, usage: normalizeUsage(response.usageMetadata) };
}

async function providerFetch(endpoint: URL, credential: FlowStandaloneCredential | undefined, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    const headers = {
        'Content-Type': 'application/json',
        ...(credential?.apiKey ? { Authorization: `Bearer ${credential.apiKey}` } : {}),
        ...(credential?.headers || {})
    };
    return rawJsonFetch(endpoint, headers, body, signal);
}

async function rawJsonFetch(endpoint: URL, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
    validateEndpoint(endpoint);
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: 'manual' });
    const text = await response.text();
    if (response.status >= 300 && response.status < 400) throw new Error(`O provider tentou redirecionar a credencial para ${response.headers.get('location') || 'outro endpoint'}; redirects foram bloqueados.`);
    const parsed = parseJson(text);
    if (!response.ok) {
        const record = isRecord(parsed) ? parsed : {};
        const detail = isRecord(record.error) ? stringValue(record.error.message) : stringValue(record.message);
        throw new Error(`Provider respondeu ${response.status}${detail ? `: ${detail}` : ''}.`);
    }
    if (!isRecord(parsed)) throw new Error('O provider retornou JSON inválido.');
    return parsed;
}

function runnerPrompt(prompt: string, input: Record<string, unknown>, expected: string[], tools: Array<{ id: string; name: string; effect?: string; args?: string[] }>): string {
    const toolContract = tools.map(tool => ({ id: tool.id, name: tool.name, effect: tool.effect, args: tool.args || [] }));
    return [
        prompt,
        '',
        'Responda ao Flow com um objeto JSON e nenhum texto fora dele.',
        `Formato: {"output":{${expected.map(key => `"${key}":null`).join(',')}},"summary":"resumo","toolCalls":[{"toolId":"id-declarado","args":[]}]}.`,
        toolContract.length ? `Ferramentas lógicas disponíveis (não execute diretamente; solicite em toolCalls): ${JSON.stringify(toolContract)}` : 'Não solicite ferramentas.',
        `Contexto de entrada: ${JSON.stringify(input)}`
    ].join('\n');
}

function normalizeRunnerOutput(text: string, usage: FlowStandaloneTextResult['usage'], nodeId: string): FlowStudioRunnerOutput {
    const parsed = parseStructuredText(text);
    if (isRecord(parsed) && (isRecord(parsed.output) || Array.isArray(parsed.toolCalls) || typeof parsed.summary === 'string')) {
        return {
            output: isRecord(parsed.output) ? parsed.output : {},
            summary: stringValue(parsed.summary),
            usage,
            toolCalls: Array.isArray(parsed.toolCalls) ? parsed.toolCalls.filter(isRecord).map(call => ({
                toolId: stringValue(call.toolId) || '',
                args: Array.isArray(call.args) ? call.args.filter((item): item is string => typeof item === 'string') : undefined,
                idempotencyKey: stringValue(call.idempotencyKey)
            })).filter(call => call.toolId) : undefined
        };
    }
    const result = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    return { output: { result, [nodeId]: result }, summary: result.slice(0, 500), usage };
}

function inferProtocol(packageName: string | undefined, providerId: string): FlowStandaloneProtocol {
    if (packageName?.includes('anthropic') || providerId === 'anthropic') return 'anthropic';
    if ((packageName === '@ai-sdk/google' || providerId === 'google')) return 'google';
    return 'openai';
}

function appendEndpoint(baseURL: string, route: string): URL {
    const base = new URL(baseURL.endsWith('/') ? baseURL : `${baseURL}/`);
    const normalizedRoute = route.replace(/^\/+/, '');
    if (base.pathname.endsWith(`/${normalizedRoute}`) || base.pathname === `/${normalizedRoute}`) return base;
    base.pathname = `${base.pathname.replace(/\/$/, '')}/${normalizedRoute}`.replace(/\/+/g, '/');
    return base;
}

function validateEndpoint(endpoint: URL): void {
    if (endpoint.protocol === 'https:') return;
    if (endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(endpoint.hostname)) return;
    throw new Error('O endpoint do provider precisa usar HTTPS ou HTTP em loopback.');
}

function stripProviderPrefix(providerId: string, value: string | undefined): string | undefined {
    if (!value) return undefined;
    return value.startsWith(`${providerId}/`) ? value.slice(providerId.length + 1) : value;
}

function contentText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    return value.map(item => isRecord(item) ? stringValue(item.text) : undefined).filter(Boolean).join('\n');
}

function normalizeUsage(value: unknown): FlowStandaloneTextResult['usage'] {
    if (!isRecord(value)) return undefined;
    return {
        inputTokens: numberValue(value.input_tokens) ?? numberValue(value.prompt_tokens) ?? numberValue(value.promptTokenCount),
        outputTokens: numberValue(value.output_tokens) ?? numberValue(value.completion_tokens) ?? numberValue(value.candidatesTokenCount)
    };
}

function parseStructuredText(value: string): unknown {
    const trimmed = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const direct = parseJson(trimmed);
    if (typeof direct !== 'string') return direct;
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    return start >= 0 && end > start ? parseJson(trimmed.slice(start, end + 1)) : trimmed;
}

function parseJson(value: string): unknown {
    try { return JSON.parse(value) as unknown; } catch { return value; }
}

function combineSignals(...values: Array<AbortSignal | undefined>): AbortSignal {
    const signals = values.filter((value): value is AbortSignal => value !== undefined);
    return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
