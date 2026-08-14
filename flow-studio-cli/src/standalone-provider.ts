import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type {
    FlowProviderAuthMethod,
    FlowProviderCatalog,
    FlowProviderCatalogEntry,
    FlowProviderCatalogModel
} from './provider-broker';

export type FlowStandaloneProtocol = 'auto' | 'openai' | 'anthropic' | 'google';

export interface FlowStandaloneCredential {
    providerId: string;
    apiKey: string;
    baseURL?: string;
    headers?: Record<string, string>;
    protocol?: FlowStandaloneProtocol;
    source: 'store' | 'environment';
}

interface StoredCredentialPayload {
    apiKey: string;
    baseURL?: string;
    headers?: Record<string, string>;
    protocol?: FlowStandaloneProtocol;
}

interface EncryptedCredential {
    iv: string;
    tag: string;
    ciphertext: string;
}

interface CredentialDocument {
    version: 1;
    entries: Record<string, EncryptedCredential>;
}

interface CatalogSnapshot {
    schema: 'flow-provider-catalog/v1';
    source: string;
    generatedAt: string;
    providers: Record<string, unknown>;
}

export interface FlowStandaloneProviderOptions {
    configRoot?: string;
    catalogUrl?: string;
    snapshotPath?: string;
    fetcher?: typeof fetch;
    catalogTtlMs?: number;
}

const PROVIDER_ID = /^[a-zA-Z0-9._-]+$/;
const API_KEY_MAX_LENGTH = 64 * 1024;
const CATALOG_TIMEOUT_MS = 15_000;
const DEFAULT_CATALOG_TTL_MS = 6 * 60 * 60_000;
const DEFAULT_CATALOG_URL = 'https://models.dev/api.json';

export class FlowStandaloneProviderService {
    private readonly configRoot: string;
    private readonly catalogUrl: string;
    private readonly snapshotPath: string;
    private readonly fetcher: typeof fetch;
    private readonly catalogTtlMs: number;
    private catalogPromise?: Promise<CatalogSnapshot>;

    constructor(options: FlowStandaloneProviderOptions = {}) {
        this.configRoot = path.resolve(options.configRoot || defaultFlowConfigRoot());
        this.catalogUrl = options.catalogUrl || process.env.FLOW_MODELS_URL || DEFAULT_CATALOG_URL;
        this.snapshotPath = path.resolve(options.snapshotPath || path.join(__dirname, '..', 'src', 'provider-catalog.snapshot.json.gz'));
        this.fetcher = options.fetcher || fetch;
        this.catalogTtlMs = options.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS;
    }

    async catalog(forceRefresh = false): Promise<FlowProviderCatalog> {
        const snapshot = await this.loadCatalog(forceRefresh);
        const credentials = await this.readCredentialDocument();
        return normalizeStandaloneCatalog(snapshot.providers, new Set(Object.keys(credentials.entries)));
    }

    async setApiKey(providerId: string, apiKey: string, metadata: Record<string, string> = {}): Promise<void> {
        assertProviderId(providerId);
        if (!apiKey.trim()) throw new Error('A API key é obrigatória.');
        if (apiKey.length > API_KEY_MAX_LENGTH) throw new Error('A API key excede o limite permitido.');
        const payload = normalizeCredentialPayload(apiKey, metadata);
        const [key, document] = await Promise.all([this.loadMasterKey(), this.readCredentialDocument()]);
        document.entries[providerId] = encryptCredential(key, payload);
        await this.writeCredentialDocument(document);
    }

    async disconnect(providerId: string): Promise<void> {
        assertProviderId(providerId);
        const document = await this.readCredentialDocument();
        if (!(providerId in document.entries)) return;
        delete document.entries[providerId];
        await this.writeCredentialDocument(document);
    }

    async credential(providerId: string): Promise<FlowStandaloneCredential | undefined> {
        assertProviderId(providerId);
        const document = await this.readCredentialDocument();
        const stored = document.entries[providerId];
        if (stored) {
            const key = await this.loadMasterKey();
            return { providerId, ...decryptCredential(key, stored), source: 'store' };
        }
        const snapshot = await this.loadCatalog(false);
        const provider = isRecord(snapshot.providers[providerId]) ? snapshot.providers[providerId] : undefined;
        const env = provider && Array.isArray(provider.env) ? provider.env.filter((item): item is string => typeof item === 'string') : [];
        for (const name of env) {
            const apiKey = process.env[name];
            if (apiKey?.trim()) return { providerId, apiKey, source: 'environment' };
        }
        return undefined;
    }

    async provider(providerId: string): Promise<Record<string, unknown> | undefined> {
        const snapshot = await this.loadCatalog(false);
        const provider = snapshot.providers[providerId];
        return isRecord(provider) ? provider : undefined;
    }

    private async loadCatalog(forceRefresh: boolean): Promise<CatalogSnapshot> {
        if (!forceRefresh && this.catalogPromise) return this.catalogPromise;
        const pending = this.resolveCatalog(forceRefresh);
        this.catalogPromise = pending;
        try {
            return await pending;
        } catch (error) {
            if (this.catalogPromise === pending) this.catalogPromise = undefined;
            throw error;
        }
    }

    private async resolveCatalog(forceRefresh: boolean): Promise<CatalogSnapshot> {
        const cachePath = path.join(this.configRoot, 'catalog.json.gz');
        const cached = await readCatalogFile(cachePath);
        const cacheStat = await fs.stat(cachePath).catch(() => undefined);
        const fresh = cacheStat && Date.now() - cacheStat.mtimeMs < this.catalogTtlMs;
        if (!forceRefresh && cached && fresh) return cached;
        try {
            const response = await this.fetcher(this.catalogUrl, {
                headers: { 'User-Agent': 'flow-cli/provider-catalog' },
                redirect: 'error',
                signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS)
            });
            if (!response.ok) throw new Error(`O catálogo respondeu ${response.status}.`);
            const providers = await response.json();
            if (!isRecord(providers) || Object.keys(providers).length < 1) throw new Error('O catálogo remoto é inválido ou está vazio.');
            const snapshot: CatalogSnapshot = {
                schema: 'flow-provider-catalog/v1',
                source: this.catalogUrl,
                generatedAt: new Date().toISOString(),
                providers
            };
            await writeGzipJson(cachePath, snapshot);
            return snapshot;
        } catch {
            if (cached) return cached;
            const bundled = await readCatalogFile(this.snapshotPath);
            if (bundled) return bundled;
            throw new Error('O catálogo standalone do Flow não pôde ser carregado do cache, da rede ou do snapshot incluído.');
        }
    }

    private async loadMasterKey(): Promise<Buffer> {
        const keyPath = path.join(this.configRoot, 'credentials.key');
        const existing = await fs.readFile(keyPath).catch(() => undefined);
        if (existing) {
            const key = Buffer.from(existing.toString('utf8').trim(), 'base64');
            if (key.length !== 32) throw new Error('A chave mestra do cofre Flow é inválida.');
            return key;
        }
        const key = randomBytes(32);
        await fs.mkdir(this.configRoot, { recursive: true, mode: 0o700 });
        await writePrivateFile(keyPath, `${key.toString('base64')}\n`);
        return key;
    }

    private async readCredentialDocument(): Promise<CredentialDocument> {
        const file = path.join(this.configRoot, 'credentials.json');
        const raw = await fs.readFile(file, 'utf8').catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
        });
        if (!raw) return { version: 1, entries: {} };
        const parsed = JSON.parse(raw) as unknown;
        if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.entries)) throw new Error('O cofre de providers do Flow está corrompido.');
        return { version: 1, entries: parsed.entries as Record<string, EncryptedCredential> };
    }

    private async writeCredentialDocument(document: CredentialDocument): Promise<void> {
        const file = path.join(this.configRoot, 'credentials.json');
        await fs.mkdir(this.configRoot, { recursive: true, mode: 0o700 });
        await writePrivateFile(file, `${JSON.stringify(document, null, 2)}\n`);
    }
}

export function normalizeStandaloneCatalog(raw: unknown, configured: Set<string>): FlowProviderCatalog {
    const providers = isRecord(raw) ? Object.values(raw)
        .map(value => normalizeStandaloneProvider(value, configured))
        .filter((value): value is FlowProviderCatalogEntry => value !== undefined)
        .sort((left, right) => Number(right.connected) - Number(left.connected) || left.name.localeCompare(right.name)) : [];
    const connected = providers.filter(provider => provider.connected).map(provider => provider.id);
    return { source: 'flow', sources: ['flow'], connected, providers };
}

function normalizeStandaloneProvider(value: unknown, configured: Set<string>): FlowProviderCatalogEntry | undefined {
    if (!isRecord(value) || typeof value.id !== 'string' || !PROVIDER_ID.test(value.id)) return undefined;
    const id = value.id;
    const env = Array.isArray(value.env) ? value.env.filter((item): item is string => typeof item === 'string') : [];
    const connected = configured.has(id) || env.some(name => Boolean(process.env[name]?.trim())) || (env.length === 0 && isLocalEndpoint(value.api));
    const models = isRecord(value.models) ? Object.values(value.models)
        .map(model => normalizeStandaloneModel(id, value, model))
        .filter((model): model is FlowProviderCatalogModel => model !== undefined)
        .sort((left, right) => statusRank(left.status) - statusRank(right.status) || left.name.localeCompare(right.name)) : [];
    const prompts = [{
        type: 'text' as const,
        key: 'baseURL',
        message: 'Base URL personalizada (opcional)',
        placeholder: typeof value.api === 'string' ? value.api : 'Use o endpoint padrão do provider',
        optional: true
    }, {
        type: 'text' as const,
        key: 'headers',
        message: 'Headers adicionais em JSON (opcional)',
        placeholder: '{"X-Project":"meu-projeto"}',
        optional: true
    }, {
        type: 'select' as const,
        key: 'protocol',
        message: 'Protocolo HTTP (opcional)',
        optional: true,
        options: [
            { label: 'Detectar automaticamente', value: 'auto' },
            { label: 'OpenAI compatible', value: 'openai' },
            { label: 'Anthropic Messages', value: 'anthropic' },
            { label: 'Google generateContent', value: 'google' }
        ]
    }];
    const authMethods: FlowProviderAuthMethod[] = [{ type: 'api', label: 'API key no cofre do Flow', prompts }];
    return {
        id,
        name: typeof value.name === 'string' && value.name.trim() ? value.name : id,
        connected,
        connectedSources: connected ? ['flow'] : [],
        env,
        api: typeof value.api === 'string' ? value.api : undefined,
        npm: typeof value.npm === 'string' ? value.npm : undefined,
        sources: ['flow'],
        authMethods: authMethods.map(method => ({ ...method, source: 'flow' })),
        models
    };
}

function normalizeStandaloneModel(providerId: string, provider: Record<string, unknown>, value: unknown): FlowProviderCatalogModel | undefined {
    if (!isRecord(value) || typeof value.id !== 'string' || !value.id.trim()) return undefined;
    const limit = isRecord(value.limit) ? value.limit : {};
    const cost = isRecord(value.cost) ? value.cost : {};
    const modalities = isRecord(value.modalities) ? value.modalities : {};
    const input = Array.isArray(modalities.input) ? modalities.input : [];
    const reasoningOptions = Array.isArray(value.reasoning_options) ? value.reasoning_options : [];
    const effort = reasoningOptions.find(option => isRecord(option) && option.type === 'effort');
    const variants = effort && isRecord(effort) && Array.isArray(effort.values)
        ? effort.values.map(item => item === null ? 'none' : String(item))
        : value.reasoning === true ? ['low', 'medium', 'high'] : [];
    const modelProvider = isRecord(value.provider) ? value.provider : {};
    return {
        id: value.id,
        reference: `${providerId}/${value.id}`,
        name: typeof value.name === 'string' && value.name.trim() ? value.name : value.id,
        family: typeof value.family === 'string' ? value.family : undefined,
        status: typeof value.status === 'string' ? value.status : 'active',
        releaseDate: typeof value.release_date === 'string' ? value.release_date : undefined,
        contextWindow: positiveNumber(limit.context),
        maxOutputTokens: positiveNumber(limit.output),
        costPerMTokPrompt: nonNegativeNumber(cost.input),
        costPerMTokOutput: nonNegativeNumber(cost.output),
        api: typeof modelProvider.api === 'string' ? modelProvider.api : typeof provider.api === 'string' ? provider.api : undefined,
        npm: typeof modelProvider.npm === 'string' ? modelProvider.npm : typeof provider.npm === 'string' ? provider.npm : undefined,
        capabilities: [...new Set([
            'text', 'structured-output', 'streaming', 'sessions',
            value.reasoning === true ? 'reasoning' : undefined,
            value.tool_call === true ? 'tools' : undefined,
            input.includes('image') ? 'vision' : undefined,
            value.attachment === true || input.includes('pdf') ? 'files' : undefined
        ].filter((item): item is string => Boolean(item)))],
        variants: [...new Set(variants)]
    };
}

function normalizeCredentialPayload(apiKey: string, metadata: Record<string, string>): StoredCredentialPayload {
    const baseURL = metadata.baseURL?.trim() || undefined;
    if (baseURL) validateEndpoint(baseURL);
    const protocolValue = metadata.protocol?.trim().toLowerCase();
    const protocol: FlowStandaloneProtocol | undefined = protocolValue && ['auto', 'openai', 'anthropic', 'google'].includes(protocolValue)
        ? protocolValue as FlowStandaloneProtocol
        : undefined;
    let headers: Record<string, string> | undefined;
    if (metadata.headers?.trim()) {
        const parsed = JSON.parse(metadata.headers) as unknown;
        if (!isRecord(parsed) || Object.values(parsed).some(value => typeof value !== 'string')) throw new Error('Headers adicionais precisam ser um objeto JSON de strings.');
        headers = parsed as Record<string, string>;
    }
    return { apiKey: apiKey.trim(), ...(baseURL ? { baseURL } : {}), ...(headers ? { headers } : {}), ...(protocol ? { protocol } : {}) };
}

function encryptCredential(key: Buffer, value: StoredCredentialPayload): EncryptedCredential {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

function decryptCredential(key: Buffer, value: EncryptedCredential): StoredCredentialPayload {
    if (!value || typeof value.iv !== 'string' || typeof value.tag !== 'string' || typeof value.ciphertext !== 'string') throw new Error('Uma entrada do cofre Flow é inválida.');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8')) as StoredCredentialPayload;
}

async function readCatalogFile(file: string): Promise<CatalogSnapshot | undefined> {
    const compressed = await fs.readFile(file).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    });
    if (!compressed) return undefined;
    try {
        const parsed = JSON.parse(gunzipSync(compressed).toString('utf8')) as unknown;
        if (!isRecord(parsed) || parsed.schema !== 'flow-provider-catalog/v1' || !isRecord(parsed.providers)) return undefined;
        return parsed as unknown as CatalogSnapshot;
    } catch {
        return undefined;
    }
}

async function writeGzipJson(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, gzipSync(JSON.stringify(value), { level: 9 }), { mode: 0o600 });
    await fs.rename(temporary, file);
}

async function writePrivateFile(file: string, contents: string): Promise<void> {
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600).catch(() => undefined);
}

function defaultFlowConfigRoot(): string {
    if (process.env.FLOW_CONFIG_DIR?.trim()) return process.env.FLOW_CONFIG_DIR.trim();
    if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'flow');
    return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'flow');
}

function validateEndpoint(value: string): URL {
    const endpoint = new URL(value);
    if (endpoint.protocol === 'https:') return endpoint;
    if (endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(endpoint.hostname)) return endpoint;
    throw new Error('Base URL precisa usar HTTPS ou HTTP em loopback.');
}

function isLocalEndpoint(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    try {
        const endpoint = new URL(value);
        return endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(endpoint.hostname);
    } catch { return false; }
}

function assertProviderId(value: string): void {
    if (!PROVIDER_ID.test(value)) throw new Error(`Provider inválido: ${value}`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
