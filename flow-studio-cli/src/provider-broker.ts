import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { FlowStandaloneProviderService, type FlowStandaloneProviderOptions } from './standalone-provider';

export type FlowProviderHostKind = 'cybervinci' | 'opencode';
export type FlowProviderSource = 'flow' | FlowProviderHostKind;

export interface FlowProviderAuthPrompt {
    type: 'text' | 'select';
    key: string;
    message: string;
    placeholder?: string;
    optional?: boolean;
    options?: Array<{ label: string; value: string; hint?: string }>;
    when?: { key: string; op: 'eq' | 'neq'; value: string };
}

export interface FlowProviderAuthMethod {
    type: 'oauth' | 'api';
    label: string;
    prompts?: FlowProviderAuthPrompt[];
    method?: number;
    source?: FlowProviderSource;
}

export interface FlowProviderCatalogModel {
    id: string;
    reference: string;
    name: string;
    family?: string;
    status?: string;
    releaseDate?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    costPerMTokPrompt?: number;
    costPerMTokOutput?: number;
    capabilities: string[];
    variants: string[];
    api?: string;
    npm?: string;
}

export interface FlowProviderCatalogEntry {
    id: string;
    name: string;
    connected: boolean;
    defaultModel?: string;
    env: string[];
    api?: string;
    npm?: string;
    sources?: FlowProviderSource[];
    connectedSources?: FlowProviderSource[];
    authMethods: FlowProviderAuthMethod[];
    models: FlowProviderCatalogModel[];
}

export interface FlowProviderCatalog {
    source: FlowProviderSource;
    sources?: FlowProviderSource[];
    connected: string[];
    providers: FlowProviderCatalogEntry[];
}

export interface FlowCatalogModelProfile {
    id: string;
    name: string;
    providerId: string;
    modelId: string;
    runnerId: FlowProviderSource;
    description: string;
    contextWindow?: number;
    maxOutputTokens?: number;
    costPerMTokPrompt?: number;
    costPerMTokOutput?: number;
    tags: string[];
    capabilities: Array<'text' | 'reasoning' | 'tools' | 'vision' | 'files' | 'structured-output' | 'streaming' | 'sessions' | 'subagents'>;
    reasonDefault: 'none' | 'medium' | 'high';
    serviceTierDefault: 'default';
}

interface ProviderHostLaunch {
    kind: FlowProviderHostKind;
    executable: string;
    prefix: string[];
}

interface FlowProviderBrokerOptions {
    workspaceRoot: string;
    preferredHost?: FlowProviderSource;
    baseUrl?: string;
    launch?: ProviderHostLaunch;
    standalone?: FlowStandaloneProviderOptions;
}

const PROVIDER_ID = /^[a-zA-Z0-9._-]+$/;
const API_KEY_MAX_LENGTH = 64 * 1024;
const STARTUP_TIMEOUT_MS = 20_000;

export class FlowProviderBroker {
    private child?: ChildProcess;
    private activeUrl?: string;
    private starting?: Promise<string>;
    private stderr = '';
    private readonly launch?: ProviderHostLaunch;
    private readonly standalone: FlowStandaloneProviderService;
    private readonly explicitBaseUrl: boolean;

    constructor(private readonly options: FlowProviderBrokerOptions) {
        this.launch = options.launch || findProviderHost(options.preferredHost === 'flow' ? undefined : options.preferredHost);
        this.standalone = new FlowStandaloneProviderService(options.standalone);
        this.explicitBaseUrl = Boolean(options.baseUrl);
        if (options.baseUrl) {
            const parsed = new URL(options.baseUrl);
            if (!isLoopback(parsed.hostname)) throw new Error('O servidor de providers precisa estar em loopback.');
            this.activeUrl = parsed.origin;
        }
    }

    get source(): FlowProviderSource {
        return this.options.preferredHost || (this.explicitBaseUrl ? this.launch?.kind || 'cybervinci' : 'flow');
    }

    get available(): boolean {
        return true;
    }

    async catalog(forceRefresh = false): Promise<FlowProviderCatalog> {
        if (this.explicitBaseUrl) return this.hostCatalog();
        if (this.options.preferredHost === 'flow') return this.standalone.catalog(forceRefresh);
        if (this.options.preferredHost === 'cybervinci' || this.options.preferredHost === 'opencode') return this.hostCatalog();
        const [standalone, hosted] = await Promise.all([
            this.standalone.catalog(forceRefresh),
            this.launch || this.activeUrl ? this.hostCatalog().catch(() => undefined) : Promise.resolve(undefined)
        ]);
        return hosted ? mergeProviderCatalogs(standalone, hosted) : standalone;
    }

    async setApiKey(providerId: string, key: string, metadata?: Record<string, string>): Promise<void> {
        assertProviderId(providerId);
        if (!key.trim()) throw new Error('A API key é obrigatória.');
        if (key.length > API_KEY_MAX_LENGTH) throw new Error('A API key excede o limite permitido.');
        if (!this.explicitBaseUrl && this.options.preferredHost !== 'cybervinci' && this.options.preferredHost !== 'opencode') {
            await this.standalone.setApiKey(providerId, key, metadata);
            return;
        }
        await this.request('PUT', `/auth/${encodeURIComponent(providerId)}`, {
            type: 'api',
            key,
            ...(metadata && Object.keys(metadata).length ? { metadata } : {})
        }, false);
    }

    async disconnect(providerId: string): Promise<void> {
        assertProviderId(providerId);
        if (!this.explicitBaseUrl && this.options.preferredHost !== 'cybervinci' && this.options.preferredHost !== 'opencode') {
            await this.standalone.disconnect(providerId);
            if (this.launch || this.activeUrl) await this.request('DELETE', `/auth/${encodeURIComponent(providerId)}`, undefined, false).catch(() => undefined);
            return;
        }
        await this.request('DELETE', `/auth/${encodeURIComponent(providerId)}`, undefined, false);
    }

    async authorize(providerId: string, method: number, inputs?: Record<string, string>): Promise<Record<string, unknown> | undefined> {
        assertProviderId(providerId);
        if (!Number.isInteger(method) || method < 0) throw new Error('Método OAuth inválido.');
        const result = await this.request('POST', `/provider/${encodeURIComponent(providerId)}/oauth/authorize`, {
            method,
            ...(inputs && Object.keys(inputs).length ? { inputs } : {})
        });
        return isRecord(result) ? result : undefined;
    }

    async callback(providerId: string, method: number, code?: string): Promise<void> {
        assertProviderId(providerId);
        if (!Number.isInteger(method) || method < 0) throw new Error('Método OAuth inválido.');
        await this.request('POST', `/provider/${encodeURIComponent(providerId)}/oauth/callback`, {
            method,
            ...(code?.trim() ? { code: code.trim() } : {})
        }, false);
    }

    private async hostCatalog(): Promise<FlowProviderCatalog> {
        if (!this.launch && !this.activeUrl) throw new Error('CyberVinci/OpenCode CLI não foi encontrado no PATH. Use --source flow para o catálogo standalone.');
        const [providers, auth] = await Promise.all([
            this.request('GET', '/provider'),
            this.request('GET', '/provider/auth')
        ]);
        const source = this.launch?.kind || (this.options.preferredHost === 'opencode' ? 'opencode' : 'cybervinci');
        return normalizeProviderCatalog(providers, auth, source);
    }

    async stop(): Promise<void> {
        const child = this.child;
        this.child = undefined;
        this.starting = undefined;
        if (!child || child.exitCode !== null || !child.pid) return;
        child.kill('SIGTERM');
        await Promise.race([
            new Promise<void>(resolve => child.once('exit', () => resolve())),
            new Promise<void>(resolve => setTimeout(resolve, 2_000))
        ]);
        if (child.exitCode === null && process.platform === 'win32') {
            const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
                shell: false,
                windowsHide: true,
                stdio: 'ignore'
            });
            killer.unref();
        } else if (child.exitCode === null) child.kill('SIGKILL');
    }

    stopSync(): void {
        const child = this.child;
        this.child = undefined;
        if (!child || child.exitCode !== null || !child.pid) return;
        if (process.platform === 'win32') {
            const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
                shell: false,
                windowsHide: true,
                stdio: 'ignore'
            });
            killer.unref();
            return;
        }
        child.kill('SIGTERM');
    }

    private async request(method: string, route: string, body?: unknown, parseJson = true): Promise<unknown> {
        const baseUrl = await this.start();
        const target = new URL(route, baseUrl);
        if (route.startsWith('/provider')) target.searchParams.set('directory', path.resolve(this.options.workspaceRoot));
        const response = await fetch(target, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            redirect: 'manual'
        });
        const text = await response.text();
        if (!response.ok) {
            const parsed = parseJsonValue(text);
            const message = isRecord(parsed) && isRecord(parsed.data) && typeof parsed.data.message === 'string'
                ? parsed.data.message
                : isRecord(parsed) && typeof parsed.message === 'string'
                    ? parsed.message
                    : text.slice(0, 500);
            throw new Error(`CyberVinci/OpenCode respondeu ${response.status}${message ? `: ${message}` : ''}.`);
        }
        if (!parseJson || !text.trim()) return undefined;
        return parseJsonValue(text);
    }

    private async start(): Promise<string> {
        if (this.activeUrl) return this.activeUrl;
        if (this.starting) return this.starting;
        if (!this.launch) throw new Error('CyberVinci/OpenCode CLI não foi encontrado no PATH.');
        this.starting = this.startHost();
        try {
            return await this.starting;
        } finally {
            this.starting = undefined;
        }
    }

    private async startHost(): Promise<string> {
        const port = await reservePort();
        const baseUrl = `http://127.0.0.1:${port}`;
        const environment = { ...process.env };
        delete environment.CYBERVINCI_SERVER_PASSWORD;
        delete environment.CYBERVINCI_SERVER_USERNAME;
        delete environment.OPENCODE_SERVER_PASSWORD;
        delete environment.OPENCODE_SERVER_USERNAME;
        const child = spawn(this.launch!.executable, [
            ...this.launch!.prefix,
            'serve', '--hostname', '127.0.0.1', '--port', String(port)
        ], {
            cwd: path.resolve(this.options.workspaceRoot),
            env: environment,
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        if (!child.pid) throw new Error('Não foi possível iniciar o catálogo do CyberVinci/OpenCode.');
        this.child = child;
        child.stderr?.on('data', chunk => { this.stderr = `${this.stderr}${String(chunk)}`.slice(-16_384); });
        child.once('exit', () => {
            if (this.child === child) {
                this.child = undefined;
                this.activeUrl = undefined;
            }
        });
        const deadline = Date.now() + STARTUP_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (child.exitCode !== null) throw new Error(`CyberVinci/OpenCode encerrou durante a inicialização. ${this.stderr}`.trim());
            try {
                const target = new URL('/provider', baseUrl);
                target.searchParams.set('directory', path.resolve(this.options.workspaceRoot));
                const response = await fetch(target, { signal: AbortSignal.timeout(1_000) });
                if (response.ok) {
                    this.activeUrl = baseUrl;
                    return baseUrl;
                }
            } catch { /* servidor ainda inicializando */ }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        await this.stop();
        throw new Error(`O catálogo do CyberVinci/OpenCode não respondeu. ${this.stderr}`.trim());
    }
}

export function findProviderHost(preferred?: FlowProviderHostKind): ProviderHostLaunch | undefined {
    const kinds = preferred ? [preferred] : ['cybervinci', 'opencode'] as const;
    const pathEntries = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
    for (const kind of kinds) {
        for (const entry of pathEntries) {
            if (kind === 'opencode') {
                const packaged = path.join(entry, 'node_modules', 'opencode-ai', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
                if (existsSync(packaged)) return { kind, executable: packaged, prefix: [] };
            }
            const direct = path.join(entry, process.platform === 'win32' ? `${kind}.exe` : kind);
            if (existsSync(direct)) return { kind, executable: direct, prefix: [] };
        }
    }
    return undefined;
}

export async function runProviderHostCommand(args: string[], preferred?: FlowProviderHostKind, stdio: StdioOptions = 'inherit'): Promise<number> {
    const launch = findProviderHost(preferred);
    if (!launch) throw new Error('CyberVinci/OpenCode CLI não foi encontrado no PATH.');
    const child = spawn(launch.executable, [...launch.prefix, ...args], {
        cwd: process.cwd(),
        env: process.env,
        shell: false,
        windowsHide: false,
        stdio
    });
    return new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => resolve(code ?? 1));
    });
}

export function normalizeProviderCatalog(rawCatalog: unknown, rawAuth: unknown, source: FlowProviderHostKind): FlowProviderCatalog {
    const catalog = isRecord(rawCatalog) ? rawCatalog : {};
    const auth = isRecord(rawAuth) ? rawAuth : {};
    const connected = Array.isArray(catalog.connected)
        ? catalog.connected.filter((item): item is string => typeof item === 'string')
        : [];
    const connectedSet = new Set(connected);
    const defaults = isRecord(catalog.default) ? catalog.default : {};
    const providers = Array.isArray(catalog.all) ? catalog.all
        .map(provider => normalizeProvider(provider, auth, defaults, connectedSet))
        .filter((provider): provider is FlowProviderCatalogEntry => provider !== undefined)
        .sort((left, right) => Number(right.connected) - Number(left.connected) || left.name.localeCompare(right.name))
        : [];
    return {
        source,
        sources: [source],
        connected,
        providers: providers.map(provider => ({
            ...provider,
            sources: [source],
            connectedSources: provider.connected ? [source] : [],
            authMethods: provider.authMethods.map(method => ({ ...method, source }))
        }))
    };
}

export function mergeProviderCatalogs(standalone: FlowProviderCatalog, hosted: FlowProviderCatalog): FlowProviderCatalog {
    const entries = new Map<string, FlowProviderCatalogEntry>();
    for (const provider of standalone.providers) entries.set(provider.id, provider);
    for (const provider of hosted.providers) {
        const current = entries.get(provider.id);
        if (!current) {
            entries.set(provider.id, provider);
            continue;
        }
        const models = new Map(current.models.map(model => [model.reference, model]));
        for (const model of provider.models) models.set(model.reference, { ...models.get(model.reference), ...model });
        entries.set(provider.id, {
            ...current,
            connected: current.connected || provider.connected,
            defaultModel: provider.defaultModel || current.defaultModel,
            env: [...new Set([...current.env, ...provider.env])],
            sources: [...new Set([...(current.sources || ['flow']), ...(provider.sources || [hosted.source])])],
            connectedSources: [...new Set([...(current.connectedSources || (current.connected ? ['flow'] : [])), ...(provider.connectedSources || (provider.connected ? [hosted.source] : []))])],
            authMethods: [...current.authMethods, ...provider.authMethods.filter(method => method.type === 'oauth')],
            models: [...models.values()].sort((left, right) => statusRank(left.status) - statusRank(right.status) || left.name.localeCompare(right.name))
        });
    }
    const providers = [...entries.values()].sort((left, right) => Number(right.connected) - Number(left.connected) || left.name.localeCompare(right.name));
    const sources = [...new Set([...(standalone.sources || [standalone.source]), ...(hosted.sources || [hosted.source])])];
    return { source: 'flow', sources, connected: providers.filter(provider => provider.connected).map(provider => provider.id), providers };
}

export function catalogModelProfile(source: FlowProviderSource, provider: FlowProviderCatalogEntry, model: FlowProviderCatalogModel): FlowCatalogModelProfile {
    const capabilities = model.capabilities.filter((item): item is FlowCatalogModelProfile['capabilities'][number] => [
        'text', 'reasoning', 'tools', 'vision', 'files', 'structured-output', 'streaming', 'sessions', 'subagents'
    ].includes(item));
    return {
        id: model.reference,
        name: `${provider.name} · ${model.name}`,
        providerId: provider.id,
        modelId: model.reference,
        runnerId: source,
        description: `${model.name}${model.family ? ` (${model.family})` : ''}, descoberto pelo catálogo ${source}.`,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        costPerMTokPrompt: model.costPerMTokPrompt,
        costPerMTokOutput: model.costPerMTokOutput,
        tags: [...new Set([source, model.status, model.family].filter((item): item is string => Boolean(item)))],
        capabilities,
        reasonDefault: capabilities.includes('reasoning') ? (model.variants.includes('high') || model.variants.includes('xhigh') ? 'high' : 'medium') : 'none',
        serviceTierDefault: 'default'
    };
}

function normalizeProvider(provider: unknown, auth: Record<string, unknown>, defaults: Record<string, unknown>, connected: Set<string>): FlowProviderCatalogEntry | undefined {
    if (!isRecord(provider) || typeof provider.id !== 'string' || !PROVIDER_ID.test(provider.id)) return undefined;
    const id = provider.id;
    const models = modelValues(provider.models)
        .map(model => normalizeModel(id, model))
        .filter((model): model is FlowProviderCatalogModel => model !== undefined)
        .sort((left, right) => statusRank(left.status) - statusRank(right.status) || left.name.localeCompare(right.name));
    return {
        id,
        name: typeof provider.name === 'string' && provider.name.trim() ? provider.name : id,
        connected: connected.has(id),
        defaultModel: typeof defaults[id] === 'string' ? `${id}/${defaults[id]}` : undefined,
        env: Array.isArray(provider.env) ? provider.env.filter((item): item is string => typeof item === 'string') : [],
        authMethods: normalizeAuthMethods(auth[id]),
        models
    };
}

function normalizeModel(providerId: string, model: unknown): FlowProviderCatalogModel | undefined {
    if (!isRecord(model) || typeof model.id !== 'string' || !model.id.trim()) return undefined;
    const capabilities = isRecord(model.capabilities) ? model.capabilities : {};
    const input = isRecord(capabilities.input) ? capabilities.input : {};
    const limit = isRecord(model.limit) ? model.limit : {};
    const cost = isRecord(model.cost) ? model.cost : {};
    return {
        id: model.id,
        reference: `${providerId}/${model.id}`,
        name: typeof model.name === 'string' && model.name.trim() ? model.name : model.id,
        family: typeof model.family === 'string' ? model.family : undefined,
        status: typeof model.status === 'string' ? model.status : undefined,
        releaseDate: typeof model.release_date === 'string' ? model.release_date : undefined,
        contextWindow: positiveNumber(limit.context),
        maxOutputTokens: positiveNumber(limit.output),
        costPerMTokPrompt: nonNegativeNumber(cost.input),
        costPerMTokOutput: nonNegativeNumber(cost.output),
        capabilities: [...new Set([
            'text', 'structured-output', 'streaming', 'sessions', 'subagents',
            capabilities.reasoning === true ? 'reasoning' : undefined,
            capabilities.toolcall === true ? 'tools' : undefined,
            input.image === true ? 'vision' : undefined,
            capabilities.attachment === true || input.pdf === true ? 'files' : undefined
        ].filter((item): item is string => Boolean(item)))],
        variants: isRecord(model.variants) ? Object.keys(model.variants) : []
    };
}

function normalizeAuthMethods(value: unknown): FlowProviderAuthMethod[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((method, index): FlowProviderAuthMethod[] => {
        if (!isRecord(method) || (method.type !== 'oauth' && method.type !== 'api') || typeof method.label !== 'string') return [];
        const prompts = Array.isArray(method.prompts) ? method.prompts.map(normalizeAuthPrompt).filter((prompt): prompt is FlowProviderAuthPrompt => prompt !== undefined) : undefined;
        return [{ type: method.type, label: method.label, method: index, ...(prompts?.length ? { prompts } : {}) }];
    });
}

function normalizeAuthPrompt(value: unknown): FlowProviderAuthPrompt | undefined {
    if (!isRecord(value) || (value.type !== 'text' && value.type !== 'select') || typeof value.key !== 'string' || typeof value.message !== 'string') return undefined;
    const when: FlowProviderAuthPrompt['when'] = isRecord(value.when) && typeof value.when.key === 'string' && (value.when.op === 'eq' || value.when.op === 'neq') && typeof value.when.value === 'string'
        ? { key: value.when.key, op: value.when.op as 'eq' | 'neq', value: value.when.value }
        : undefined;
    const options = value.type === 'select' && Array.isArray(value.options) ? value.options.map(option => isRecord(option) && typeof option.label === 'string' && typeof option.value === 'string'
        ? { label: option.label, value: option.value, ...(typeof option.hint === 'string' ? { hint: option.hint } : {}) }
        : undefined).filter((option): option is { label: string; value: string; hint?: string } => option !== undefined) : undefined;
    return {
        type: value.type,
        key: value.key,
        message: value.message,
        ...(typeof value.placeholder === 'string' ? { placeholder: value.placeholder } : {}),
        ...(value.optional === true ? { optional: true } : {}),
        ...(options?.length ? { options } : {}),
        ...(when ? { when } : {})
    };
}

function modelValues(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    return isRecord(value) ? Object.values(value) : [];
}

function statusRank(value: string | undefined): number {
    if (value === 'active') return 0;
    if (!value) return 1;
    if (value === 'deprecated') return 3;
    return 2;
}

function positiveNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function assertProviderId(value: string): void {
    if (!PROVIDER_ID.test(value)) throw new Error(`Provider inválido: ${value}`);
}

function parseJsonValue(value: string): unknown {
    try { return JSON.parse(value) as unknown; } catch { return value; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isLoopback(hostname: string): boolean {
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
}

async function reservePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            server.close(error => error ? reject(error) : resolve(port));
        });
    });
}
