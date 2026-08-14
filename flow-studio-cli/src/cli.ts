import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import url from 'node:url';
import process from 'node:process';
import os from 'node:os';
import {
    createFlowStudioTemplate,
    validateFlowStudioGraph,
    runFlowStudioGraph,
    flowStudioMemoryCandidateDigest,
    FLOW_STUDIO_SCHEMA_VERSION,
    FlowStudioGraph,
    FLOW_STUDIO_DEFAULT_MODEL_PROFILES,
    FlowStudioValidationResult,
    FlowStudioProviderBinding,
    FlowStudioRunResult,
    FlowStudioReasoningEffort,
    FlowStudioModelProfile,
    FlowStudioGatePolicy,
    FlowStudioGateDecision,
    FlowStudioServiceTier,
    FlowStudioRunnerCapability,
    FlowStudioRunnerOutput,
    FlowStudioRunnerDefinition,
    FlowStudioPermissionSpec,
    authorFlowStudioGraph,
    type FlowStudioAuthorAdapter,
    type FlowStudioArtifact,
    type FlowStudioContext,
    type FlowStudioContextPack,
    type FlowStudioGateResult,
    type FlowStudioMemoryAdapter,
    type FlowStudioMemoryApproval,
    type FlowStudioMemoryCandidate,
    type FlowStudioMemoryScope,
    type FlowStudioMemoryWriteRecord,
    type FlowStudioPlaybookAdapter,
    type FlowStudioPlaybookRunResult,
    type FlowStudioPlaybookDefinition,
    type FlowStudioToolBinding,
    FLOW_STUDIO_GRAPH_SCHEMA
} from '@cybervinci/flow-shared';
import type { FlowStudioProviderAdapter, FlowStudioToolAdapter } from '@cybervinci/flow-shared';
import chalk from 'chalk';
import { FlowStudioFileRunStore, flowStudioProcessIdentityMatches, type FlowStudioRunRecord } from './run-store';
import { FlowStudioRunConflictError, FlowStudioRunManager, FlowStudioRunRequestError, type FlowStudioRunLaunchOptions } from './run-manager';
import { runFlowStudioTui } from './tui';
import {
    catalogModelProfile,
    FlowProviderBroker,
    findProviderHost,
    type FlowProviderSource,
    runProviderHostCommand
} from './provider-broker';
import { createStandaloneProviderAdapter, runStandaloneProviderText } from './native-provider';
import { FlowStandaloneProviderService } from './standalone-provider';

type CliArgValue = string | string[] | boolean | undefined;

interface ParsedArgs {
    _: string[];
    [key: string]: CliArgValue;
}

interface FlowStudioCliOptions {
    name?: string;
    file?: string;
    input?: string;
    provider?: string;
    model?: string;
    profile?: string;
    reasoning?: FlowStudioReasoningEffort;
    host?: string;
    port?: number;
    'max-steps'?: number;
    watch?: boolean;
    'provider-exec'?: string | string[];
    'tool-exec'?: string | string[];
    'playbook-exec'?: string | string[];
    'memory-exec'?: string;
    'memory-approval'?: string | string[];
    'allow-graph-tools'?: boolean;
    'allow-graph-runners'?: boolean;
    'allow-command'?: string | string[];
    'allow-runner-host'?: string | string[];
    'author-exec'?: string;
    token?: string;
    workspace?: string;
    simulate?: boolean;
    out?: string;
    json?: boolean;
    search?: string;
    method?: string;
    'provider-host'?: FlowProviderSource;
    'api-key-stdin'?: boolean;
    'api-key-env'?: string;
    'base-url'?: string;
    headers?: string;
    protocol?: string;
}

const DEFAULT_WEB_PORT = 4200;
const DEFAULT_SERVE_HOST = '127.0.0.1';
const MODEL_PROFILE_CATALOG_FILENAME = '.flow-studio.model-profiles.json';
const EXEC_MAX_BUFFER_BYTES = 1024 * 1024 * 4;
const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024;
const MEMORY_STORE_FILENAME = 'memory.json';
const MEMORY_ENTRY_MAX_BYTES = 512 * 1024;
const MEMORY_STORE_MAX_BYTES = 16 * 1024 * 1024;
const MEMORY_STORE_MAX_ENTRIES = 10_000;
const MEMORY_REVISIONS_PER_CANDIDATE = 20;
const MEMORY_LOCK_HEARTBEAT_MS = 1_000;
const MEMORY_MALFORMED_LOCK_STALE_MS = 15_000;
const MEMORY_SCOPES: readonly FlowStudioMemoryScope[] = ['ide', 'workspace', 'project', 'workflow', 'run', 'agent'];
const CHILD_ENV_ALLOWLIST = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec',
    'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'CODEX_HOME',
    'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'HOME', 'XDG_CONFIG_HOME',
    'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy'
] as const;

const childProcessEnvironment = (): NodeJS.ProcessEnv => Object.fromEntries(
    CHILD_ENV_ALLOWLIST
        .map(key => [key, process.env[key]])
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
);

const runShellCommand = async (
    command: string,
    input: string,
    options?: {
        args?: string[];
        cwd?: string;
        timeoutMs?: number;
        signal?: AbortSignal;
    }
): Promise<string> => {
    const commandTokens = splitCommandLine(command);
    if (!commandTokens.length) throw new Error('Comando vazio.');
    return runExecutable(commandTokens[0], [...commandTokens.slice(1), ...(options?.args || [])], input, options);
};

const runExecutable = async (
    executable: string,
    args: string[],
    input: string,
    options?: { cwd?: string; timeoutMs?: number; signal?: AbortSignal }
): Promise<string> => {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
            cwd: options?.cwd,
            env: childProcessEnvironment(),
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let size = 0;
        let failure: Error | undefined;
        const stop = (error: Error): void => {
            if (!failure) failure = error;
            if (child.exitCode === null) terminateProcessTree(child.pid);
        };
        const collect = (target: Buffer[]) => (chunk: Buffer | string): void => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > EXEC_MAX_BUFFER_BYTES) return stop(new Error(`Saída do comando excedeu ${EXEC_MAX_BUFFER_BYTES} bytes.`));
            target.push(buffer);
        };
        child.stdout.on('data', collect(stdout));
        child.stderr.on('data', collect(stderr));
        child.once('error', error => { failure = error; });
        const onAbort = (): void => stop(new Error('Comando cancelado.'));
        options?.signal?.addEventListener('abort', onAbort, { once: true });
        const timer = options?.timeoutMs ? setTimeout(() => stop(new Error(`Comando excedeu ${options.timeoutMs}ms.`)), options.timeoutMs) : undefined;
        child.once('close', code => {
            if (timer) clearTimeout(timer);
            options?.signal?.removeEventListener('abort', onAbort);
            if (failure) return reject(failure);
            if (code !== 0) return reject(new Error(Buffer.concat(stderr).toString('utf-8').trim() || `Comando terminou com código ${code}.`));
            resolve(Buffer.concat(stdout).toString('utf-8').trim());
        });
        child.stdin.on('error', error => stop(error));
        child.stdin.end(input);
    });
};

const terminateProcessTree = (pid: number | undefined): void => {
    if (!pid) return;
    if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
            env: childProcessEnvironment(), shell: false, windowsHide: true, stdio: 'ignore'
        });
        killer.unref();
        return;
    }
    try { process.kill(pid, 'SIGTERM'); } catch { /* process already exited */ }
};

const splitCommandLine = (source: string): string[] => {
    const result: string[] = [];
    let token = '';
    let quote: '"' | "'" | undefined;
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (quote) {
            if (char === quote) quote = undefined;
            else if (char === '\\' && source[index + 1] === quote) token += source[++index];
            else token += char;
        } else if (char === '"' || char === "'") quote = char;
        else if (/\s/.test(char)) {
            if (token) { result.push(token); token = ''; }
        } else token += char;
    }
    if (quote) throw new Error('Aspas não fechadas no comando.');
    if (token) result.push(token);
    return result;
};

interface NativeCliLaunch { executable: string; prefix: string[] }
type NativeCliKind = 'codex' | 'cybervinci' | 'opencode';

const findNativeCli = (kind: NativeCliKind): NativeCliLaunch | undefined => {
    const pathEntries = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
    for (const entry of pathEntries) {
        if (kind === 'codex') {
            const script = path.join(entry, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
            if (existsSync(script)) return { executable: process.execPath, prefix: [script] };
        } else if (kind === 'opencode') {
            const packaged = path.join(entry, 'node_modules', 'opencode-ai', 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
            if (existsSync(packaged)) return { executable: packaged, prefix: [] };
        }
        const direct = path.join(entry, process.platform === 'win32' ? `${kind}.exe` : kind);
        if (existsSync(direct)) return { executable: direct, prefix: [] };
    }
    return undefined;
};

const createNativeCliProviderAdapter = (kind: NativeCliKind, workspaceRoot: string): FlowStudioProviderAdapter | undefined => {
    const launch = findNativeCli(kind);
    if (!launch) return undefined;
    return async args => {
        const requestedModelId = args.model?.modelId || args.runner.modelId;
        const modelId = requestedModelId && requestedModelId !== 'default' ? requestedModelId : undefined;
        const reasoning = args.runner.reasoningEffort;
        const serviceTier = args.runner.serviceTier;
        const expected = Object.keys(args.node.outputs || {});
        const toolContract = (args.node.tools || []).map(tool => ({ id: tool.id, name: tool.name, effect: tool.effect, args: tool.args || [] }));
        const prompt = [
            args.prompt,
            '',
            'Responda ao Flow Studio com um objeto JSON e nenhum texto fora dele.',
            `Formato: {"output":{${expected.map(key => `"${key}":null`).join(',')}},"summary":"resumo","toolCalls":[{"toolId":"id-declarado","args":[]}]}.`,
            toolContract.length ? `Ferramentas lógicas disponíveis (não as execute diretamente; solicite-as em toolCalls): ${JSON.stringify(toolContract)}` : 'Não solicite ferramentas.',
            `Contexto de entrada: ${JSON.stringify(args.input)}`
        ].join('\n');
        let commandArgs: string[];
        let stdin = '';
        if (kind === 'codex') {
            commandArgs = [...launch.prefix, 'exec', '--json', '--color', 'never', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', workspaceRoot];
            if (modelId) commandArgs.push('-m', modelId);
            if (reasoning && reasoning !== 'none') commandArgs.push('-c', `model_reasoning_effort="${reasoning}"`);
            if (serviceTier && serviceTier !== 'default') {
                commandArgs.push('-c', `service_tier="${serviceTier}"`);
                if (serviceTier === 'fast') commandArgs.push('-c', 'features.fast_mode=true');
            }
            if (args.runner.sessionId) commandArgs.push('resume', args.runner.sessionId, '-');
            else commandArgs.push('-');
            stdin = prompt;
        } else {
            if (serviceTier && serviceTier !== 'default') throw new Error(`${kind === 'cybervinci' ? 'CyberVinci' : 'OpenCode'} CLI não expõe service tier. Use model/variant ou um runner HTTP/command que suporte "${serviceTier}".`);
            commandArgs = [...launch.prefix, 'run', '--format', 'json', '--pure', '--dir', workspaceRoot];
            if (modelId) commandArgs.push('--model', modelId);
            if (reasoning && reasoning !== 'none') commandArgs.push('--variant', reasoning);
            if (args.runner.sessionId) commandArgs.push('--session', args.runner.sessionId);
            commandArgs.push(prompt);
        }
        const raw = await runExecutable(launch.executable, commandArgs, stdin, { cwd: workspaceRoot, timeoutMs: args.runner.timeoutMs || args.node.timeoutMs || 10 * 60_000, signal: args.signal });
        return parseNativeCliOutput(raw, args.node.id);
    };
};

const createNativeCliAuthorAdapter = (kind: NativeCliKind, workspaceRoot: string, profile?: FlowStudioModelProfile): FlowStudioAuthorAdapter | undefined => {
    const launch = findNativeCli(kind);
    if (!launch) return undefined;
    return async args => {
        const prompt = `${args.systemPrompt}\n\nPedido estruturado:\n${JSON.stringify(args.request)}\n\nRetorne somente o objeto JSON GraphSpec solicitado.`;
        const modelId = profile?.modelId && profile.modelId !== 'default' ? profile.modelId : undefined;
        let commandArgs: string[];
        let stdin = '';
        if (kind === 'codex') {
            commandArgs = [...launch.prefix, 'exec', '--json', '--color', 'never', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', workspaceRoot];
            if (modelId) commandArgs.push('-m', modelId);
            if (profile?.reasonDefault && profile.reasonDefault !== 'none') commandArgs.push('-c', `model_reasoning_effort="${profile.reasonDefault}"`);
            commandArgs.push('-');
            stdin = prompt;
        } else {
            commandArgs = [...launch.prefix, 'run', '--format', 'json', '--pure', '--dir', workspaceRoot];
            if (modelId) commandArgs.push('--model', modelId);
            if (profile?.reasonDefault && profile.reasonDefault !== 'none') commandArgs.push('--variant', profile.reasonDefault);
            commandArgs.push(prompt);
        }
        const raw = await runExecutable(launch.executable, commandArgs, stdin, { cwd: workspaceRoot, timeoutMs: 10 * 60_000, signal: args.signal });
        return extractStructuredText(raw);
    };
};

const createStandaloneAuthorAdapter = (profile: FlowStudioModelProfile | undefined): FlowStudioAuthorAdapter | undefined => {
    if (!profile || profile.runnerId !== 'flow' || !profile.providerId || profile.providerId === 'flow' || !profile.modelId) return undefined;
    const service = new FlowStandaloneProviderService();
    const modelId = profile.modelId.startsWith(`${profile.providerId}/`) ? profile.modelId.slice(profile.providerId.length + 1) : profile.modelId;
    return async args => {
        const prompt = `${args.systemPrompt}\n\nPedido estruturado:\n${JSON.stringify(args.request)}\n\nRetorne somente o objeto JSON GraphSpec solicitado.`;
        const result = await runStandaloneProviderText(service, profile.providerId, modelId, prompt, profile.reasonDefault, profile.maxOutputTokens, args.signal || AbortSignal.timeout(10 * 60_000));
        return result.text;
    };
};

const createHttpProviderAdapter = (runner: FlowStudioRunnerDefinition, permissions: FlowStudioPermissionSpec | undefined, hostAllowedHosts: readonly string[]): FlowStudioProviderAdapter | undefined => {
    if (!runner.endpoint) return undefined;
    const endpoint = new URL(runner.endpoint);
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error(`Runner "${runner.id}" usa protocolo HTTP inválido.`);
    const allowedHosts = permissions?.networkHosts || [];
    if (!allowedHosts.some(pattern => pattern === '*' || pattern === endpoint.host || pattern === endpoint.hostname || (pattern.startsWith('*.') && endpoint.hostname.endsWith(pattern.slice(1))))) {
        throw new Error(`Runner "${runner.id}" exige que ${endpoint.host} esteja em permissions.networkHosts.`);
    }
    if (!hostAllowedHosts.some(pattern => pattern === endpoint.host || pattern === endpoint.hostname || (pattern.startsWith('*.') && endpoint.hostname.endsWith(pattern.slice(1))))) {
        throw new Error(`Runner "${runner.id}" exige que ${endpoint.host} esteja também em --allow-runner-host do host.`);
    }
    return async args => {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mode: 'flow-studio-runner', runnerId: runner.id, runId: args.runId, node: args.node,
                prompt: args.prompt, context: args.context, input: args.input, binding: args.runner, model: args.model
            }),
            signal: args.signal,
            redirect: 'manual'
        });
        const text = await response.text();
        if (response.status >= 300 && response.status < 400) {
            throw new Error(`Runner HTTP "${runner.id}" tentou redirecionar para ${response.headers.get('location') || 'destino não informado'}; redirects não são permitidos.`);
        }
        if (!response.ok) throw new Error(`Runner HTTP "${runner.id}" respondeu ${response.status}: ${text.slice(0, 500)}`);
        const parsed = parseAdapterOutput(text);
        if (isRecord(parsed) && (isRecord(parsed.output) || parsed.summary || parsed.sessionId || Array.isArray(parsed.toolCalls))) return parsed as unknown as FlowStudioRunnerOutput;
        return { output: isRecord(parsed) ? parsed : { result: parsed ?? text } };
    };
};

const nativeAuthorKindForProfile = (profile: FlowStudioModelProfile | undefined): NativeCliKind | undefined => {
    const values = [profile?.runnerId, profile?.providerId].filter((value): value is string => Boolean(value)).map(value => value.toLowerCase());
    if (values.some(value => value === 'codex' || value.startsWith('codex-') || value.includes('@openai/codex'))) return 'codex';
    if (values.some(value => value === 'cybervinci' || value.startsWith('cybervinci-') || value.includes('@cybervinci/'))) return 'cybervinci';
    if (values.some(value => value === 'opencode' || value.startsWith('opencode-') || value.includes('opencode'))) return 'opencode';
    return undefined;
};

const resolveAuthorAdapter = (
    workspaceRoot: string,
    profile: FlowStudioModelProfile | undefined,
    explicitCommand?: string
): FlowStudioAuthorAdapter | undefined => {
    if (explicitCommand?.trim()) return createCommandAuthorAdapter(explicitCommand, workspaceRoot);
    const standalone = createStandaloneAuthorAdapter(profile);
    if (standalone) return standalone;
    const preferred = nativeAuthorKindForProfile(profile);
    if (preferred) {
        const adapter = createNativeCliAuthorAdapter(preferred, workspaceRoot, profile);
        if (adapter) return adapter;
    }
    return createNativeCliAuthorAdapter('codex', workspaceRoot)
        || createNativeCliAuthorAdapter('cybervinci', workspaceRoot)
        || createNativeCliAuthorAdapter('opencode', workspaceRoot);
};

const parseNativeCliOutput = (raw: string, nodeId: string): FlowStudioRunnerOutput => {
    const extracted = extractStructuredText(raw);
    const parsed = typeof extracted === 'string' ? parseAdapterOutput(extracted) : extracted;
    const events = raw.split(/\r?\n/).map(line => { try { return JSON.parse(line) as unknown; } catch { return undefined; } }).filter(Boolean);
    const sessionId = findFirstString(events, ['thread_id', 'sessionID', 'sessionId', 'session_id']);
    const rawUsage = findFirstRecord([...events].reverse(), ['usage']);
    const usage = rawUsage ? {
        inputTokens: numberField(rawUsage, ['inputTokens', 'input_tokens']),
        outputTokens: numberField(rawUsage, ['outputTokens', 'output_tokens']),
        costUsd: numberField(rawUsage, ['costUsd', 'cost_usd'])
    } : undefined;
    if (isRecord(parsed) && (isRecord(parsed.output) || Array.isArray(parsed.toolCalls) || parsed.summary)) {
        return {
            output: isRecord(parsed.output) ? parsed.output : {},
            summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
            sessionId,
            usage,
            toolCalls: Array.isArray(parsed.toolCalls) ? parsed.toolCalls.filter(isRecord).map(call => ({
                toolId: String(call.toolId || ''),
                args: Array.isArray(call.args) ? call.args.filter((item): item is string => typeof item === 'string') : undefined,
                idempotencyKey: typeof call.idempotencyKey === 'string' ? call.idempotencyKey : undefined
            })).filter(call => call.toolId) : undefined
        };
    }
    const text = typeof extracted === 'string' ? extracted : JSON.stringify(extracted);
    return { output: { result: text, [nodeId]: text }, summary: text.slice(0, 500), sessionId, usage };
};

const extractStructuredText = (raw: string): unknown => {
    const events = raw.split(/\r?\n/).map(line => { try { return JSON.parse(line) as unknown; } catch { return undefined; } }).filter(Boolean);
    const candidates: string[] = [];
    const visit = (value: unknown, parentKey = ''): void => {
        if (typeof value === 'string' && ['text', 'content', 'message', 'output', 'result'].includes(parentKey)) candidates.push(value);
        else if (Array.isArray(value)) value.forEach(item => visit(item, parentKey));
        else if (isRecord(value)) for (const [key, item] of Object.entries(value)) visit(item, key);
    };
    events.forEach(event => visit(event));
    const text = candidates.reverse().find(candidate => candidate.trim()) || raw.trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try { return JSON.parse(cleaned) as unknown; } catch { return cleaned; }
};

const findFirstString = (value: unknown, keys: string[]): string | undefined => {
    if (Array.isArray(value)) for (const item of value) { const found = findFirstString(item, keys); if (found) return found; }
    else if (isRecord(value)) for (const [key, item] of Object.entries(value)) {
        if (keys.includes(key) && typeof item === 'string') return item;
        const found = findFirstString(item, keys);
        if (found) return found;
    }
    return undefined;
};

const findFirstRecord = (value: unknown, keys: string[]): Record<string, unknown> | undefined => {
    if (Array.isArray(value)) for (const item of value) { const found = findFirstRecord(item, keys); if (found) return found; }
    else if (isRecord(value)) for (const [key, item] of Object.entries(value)) {
        if (keys.includes(key) && isRecord(item)) return item;
        const found = findFirstRecord(item, keys);
        if (found) return found;
    }
    return undefined;
};

const numberField = (value: Record<string, unknown>, keys: string[]): number => {
    for (const key of keys) if (typeof value[key] === 'number' && Number.isFinite(value[key])) return value[key];
    return 0;
};

const readGraphFile = async (filePath: string): Promise<FlowStudioGraph> => {
    const resolved = path.resolve(filePath);
    const raw = await fs.readFile(resolved, 'utf-8');
    return JSON.parse(raw) as FlowStudioGraph;
};

const writeGraphFile = async (target: string, payload: FlowStudioGraph): Promise<void> => {
    const resolved = path.resolve(target);
    await atomicWriteJson(resolved, payload);
};

const atomicWriteJson = async (target: string, payload: unknown): Promise<void> => {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    await fs.rename(temporary, target);
};

interface WorkspaceMemoryEntry {
    candidateId: string;
    revision: string | number;
    scope: FlowStudioMemoryScope;
    ownerId: string;
    storeId?: string;
    kind?: FlowStudioMemoryCandidate['kind'];
    key?: string;
    value: unknown;
    tags?: string[];
    approvedAt?: string;
    approvedBy?: string;
    approvalEvidence?: FlowStudioArtifact[];
    approvalDigest: string;
    candidateDigest: string;
    graphId: string;
    nodeId: string;
    scopeId?: string;
    writtenAt: string;
    digest: string;
}

interface WorkspaceMemoryStore {
    version: string;
    updatedAt: string;
    entries: WorkspaceMemoryEntry[];
}

const memoryWriteQueues = new Map<string, Promise<void>>();

const sha256 = (value: unknown): string => createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');

const readWorkspaceMemoryStore = async (file: string): Promise<WorkspaceMemoryStore> => {
    try {
        const stat = await fs.stat(file);
        if (stat.size > MEMORY_STORE_MAX_BYTES) {
            throw new Error(`Store de memória excede o limite de ${MEMORY_STORE_MAX_BYTES} bytes: ${file}`);
        }
        const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as Partial<WorkspaceMemoryStore>;
        return {
            version: typeof parsed.version === 'string' ? parsed.version : FLOW_STUDIO_SCHEMA_VERSION,
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
            entries: Array.isArray(parsed.entries) ? parsed.entries.filter(isWorkspaceMemoryEntry) : []
        };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { version: FLOW_STUDIO_SCHEMA_VERSION, updatedAt: new Date(0).toISOString(), entries: [] };
        }
        throw error;
    }
};

const isWorkspaceMemoryEntry = (value: unknown): value is WorkspaceMemoryEntry => {
    if (!isRecord(value)) return false;
    return typeof value.candidateId === 'string'
        && (typeof value.revision === 'string' || typeof value.revision === 'number')
        && ['ide', 'workspace', 'project', 'workflow', 'run', 'agent'].includes(String(value.scope))
        && typeof value.ownerId === 'string'
        && typeof value.writtenAt === 'string'
        && typeof value.digest === 'string'
        && typeof value.approvalDigest === 'string'
        && typeof value.candidateDigest === 'string'
        && typeof value.graphId === 'string'
        && typeof value.nodeId === 'string'
        && Object.prototype.hasOwnProperty.call(value, 'value');
};

const serializeMemoryWrite = async <T>(file: string, operation: () => Promise<T>): Promise<T> => {
    const previous = memoryWriteQueues.get(file) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => current);
    memoryWriteQueues.set(file, queued);
    await previous.catch(() => undefined);
    try {
        return await withCrossProcessFileLock(file, operation);
    } finally {
        release();
        if (memoryWriteQueues.get(file) === queued) memoryWriteQueues.delete(file);
    }
};

const withCrossProcessFileLock = async <T>(file: string, operation: () => Promise<T>): Promise<T> => {
    const lockDirectory = `${file}.lock`;
    const ownerFile = path.join(lockDirectory, 'owner.json');
    const token = randomBytes(24).toString('hex');
    await fs.mkdir(path.dirname(lockDirectory), { recursive: true });
    const deadline = Date.now() + 30_000;
    let acquired = false;
    while (!acquired) {
        try {
            await fs.mkdir(lockDirectory, { mode: 0o700 });
            try {
                await fs.writeFile(ownerFile, JSON.stringify({
                    pid: process.pid,
                    token,
                    createdAt: new Date().toISOString(),
                    processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString()
                }), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
                acquired = true;
            } catch (error) {
                await fs.rm(lockDirectory, { recursive: true, force: true });
                throw error;
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            let breakLock = false;
            try {
                const owner = JSON.parse(await fs.readFile(ownerFile, 'utf-8')) as { pid?: unknown; token?: unknown; createdAt?: unknown; processStartedAt?: unknown };
                const wellFormed = typeof owner.pid === 'number' && typeof owner.token === 'string'
                    && typeof owner.createdAt === 'string' && typeof owner.processStartedAt === 'string'
                    && Number.isFinite(Date.parse(owner.processStartedAt));
                if (wellFormed) {
                    // Never steal a well-formed lock from a live process. A delayed event loop
                    // can starve the heartbeat, and breaking on mtime alone would permit two
                    // writers without fencing. PID + process start identity also prevents a
                    // recycled PID from making a dead lock permanent. Lookup failures remain
                    // fail-closed.
                    breakLock = await flowStudioProcessIdentityMatches(owner.pid as number, owner.processStartedAt) === false;
                } else {
                    const stat = await fs.stat(lockDirectory);
                    breakLock = Date.now() - stat.mtimeMs >= MEMORY_MALFORMED_LOCK_STALE_MS;
                }
            } catch {
                try {
                    const stat = await fs.stat(lockDirectory);
                    breakLock = Date.now() - stat.mtimeMs >= MEMORY_MALFORMED_LOCK_STALE_MS;
                } catch (statError) {
                    if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
                    throw statError;
                }
            }
            if (breakLock) {
                const quarantine = `${lockDirectory}.stale.${token}`;
                try {
                    await fs.rename(lockDirectory, quarantine);
                    await fs.rm(quarantine, { recursive: true, force: true });
                    continue;
                } catch (breakError) {
                    if ((breakError as NodeJS.ErrnoException).code === 'ENOENT') continue;
                }
            }
            if (Date.now() >= deadline) throw new Error(`Timeout aguardando lock de memória: ${lockDirectory}`);
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    }
    const heartbeat = setInterval(() => {
        const now = new Date();
        void fs.utimes(ownerFile, now, now).catch(() => undefined);
    }, MEMORY_LOCK_HEARTBEAT_MS);
    heartbeat.unref();
    try {
        return await operation();
    } finally {
        clearInterval(heartbeat);
        try {
            const owner = JSON.parse(await fs.readFile(ownerFile, 'utf-8')) as { token?: unknown };
            if (owner.token === token) await fs.rm(lockDirectory, { recursive: true, force: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
};

const ideMemoryDataRoot = (): string => {
    if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
    return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
};

const readContextValue = (context: FlowStudioContext, source: string): unknown => {
    const clean = source.replace(/^\$\.?/, '');
    if (!clean) return context;
    return clean.split('.').reduce<unknown>((current, segment) => {
        if (!isRecord(current) || ['__proto__', 'prototype', 'constructor'].includes(segment)) return undefined;
        return current[segment];
    }, context);
};

const readUtf8FileLimited = async (file: string, maxBytes: number): Promise<{ content: string; truncated: boolean }> => {
    const handle = await fs.open(file, 'r');
    try {
        const stat = await handle.stat();
        const length = Math.max(0, Math.min(stat.size, maxBytes));
        const buffer = Buffer.alloc(length);
        if (length) await handle.read(buffer, 0, length, 0);
        return { content: buffer.toString('utf-8'), truncated: stat.size > length };
    } finally {
        await handle.close();
    }
};

const trimContextPack = (source: FlowStudioContextPack, maxBytes: number): FlowStudioContextPack => {
    const pack: FlowStudioContextPack = JSON.parse(JSON.stringify(source)) as FlowStudioContextPack;
    const size = (): number => Buffer.byteLength(JSON.stringify(pack), 'utf-8');
    if (size() <= maxBytes) return pack;
    pack.truncated = true;
    for (let index = (pack.files?.length || 0) - 1; index >= 0 && size() > maxBytes; index -= 1) {
        const file = pack.files?.[index];
        if (!file?.content) continue;
        const keep = Math.max(0, Math.floor(Buffer.byteLength(file.content, 'utf-8') / 2));
        file.content = Buffer.from(file.content, 'utf-8').subarray(0, keep).toString('utf-8');
        file.truncated = true;
    }
    while ((pack.memories?.length || 0) > 0 && size() > maxBytes) pack.memories?.pop();
    while ((pack.files?.length || 0) > 0 && size() > maxBytes) pack.files?.pop();
    while ((pack.sections?.length || 0) > 0 && size() > maxBytes) pack.sections?.pop();
    if (size() > maxBytes) pack.signals = {};
    while ((pack.provenance?.length || 0) > 0 && size() > maxBytes) pack.provenance?.pop();
    if (size() > maxBytes) pack.summary = 'Contexto truncado pelo limite configurado.';
    if (size() > maxBytes) return { truncated: true };
    return pack;
};

const memoryOwnerId = (scope: FlowStudioMemoryScope, args: { workspaceRoot: string; graphId: string; runId: string; nodeId: string; scopeId?: string }): string => {
    const workspaceId = sha256(path.resolve(args.workspaceRoot).toLocaleLowerCase()).slice(0, 20);
    if (scope === 'ide') return 'ide';
    if (scope === 'workspace') return `workspace:${workspaceId}`;
    if (scope === 'project') return `project:${workspaceId}`;
    if (scope === 'workflow') return `workflow:${workspaceId}:${args.graphId}`;
    if (scope === 'run') return `run:${args.runId}`;
    return `agent:${args.graphId}:${args.scopeId || args.nodeId}`;
};

const createWorkspaceMemoryAdapter = (workspaceRoot: string): FlowStudioMemoryAdapter => {
    const workspaceStoreFile = path.join(workspaceRoot, '.flow-studio', MEMORY_STORE_FILENAME);
    const ideStoreFile = path.join(ideMemoryDataRoot(), 'CyberVinci', 'Flow Studio', MEMORY_STORE_FILENAME);
    return {
        loadContext: async args => {
            if (args.signal?.aborted) throw new Error('Carregamento de contexto cancelado.');
            const queryTokens = (args.config.query || '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
            const scopes = new Set<FlowStudioMemoryScope>(args.config.scopes?.length ? args.config.scopes : ['ide', 'workspace', 'project', 'workflow', 'run', 'agent']);
            const tags = new Set(args.config.tags || []);
            const maxItems = Math.min(1000, Math.max(1, args.config.maxItems || 50));
            const maxBytes = Math.min(4 * 1024 * 1024, Math.max(1024, args.config.maxBytes || 256 * 1024));
            const storeFiles = [...new Set([...scopes].map(scope => scope === 'ide' ? ideStoreFile : workspaceStoreFile))];
            const stores = await Promise.all(storeFiles.map(readWorkspaceMemoryStore));
            const memories = stores.flatMap(store => store.entries)
                .filter(entry => scopes.has(entry.scope))
                .filter(entry => entry.ownerId === memoryOwnerId(entry.scope, { workspaceRoot, graphId: args.graph.id, runId: args.runId, nodeId: args.node.id, scopeId: args.config.scopeId }))
                .filter(entry => !tags.size || [...tags].every(tag => entry.tags?.includes(tag)))
                .filter(entry => !queryTokens.length || queryTokens.every(token => JSON.stringify(entry).toLocaleLowerCase().includes(token)))
                .slice(-maxItems)
                .reverse();
            const signals = Object.fromEntries((args.config.statePaths || []).map(source => [source, readContextValue(args.context, source)]));
            const files: NonNullable<FlowStudioContextPack['files']> = [];
            const diagnostics: Array<{ path: string; error: string }> = [];
            for (const candidate of (args.config.filePaths || []).slice(0, maxItems)) {
                if (args.signal?.aborted) throw new Error('Carregamento de contexto cancelado.');
                try {
                    const resolved = await resolveWorkspaceFile(workspaceRoot, path.resolve(workspaceRoot, candidate));
                    const loaded = await readUtf8FileLimited(resolved, maxBytes);
                    files.push({ path: path.relative(workspaceRoot, resolved), content: loaded.content, digest: sha256(loaded.content), truncated: loaded.truncated });
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                    diagnostics.push({ path: candidate, error: 'Arquivo não encontrado.' });
                }
            }
            const pack = trimContextPack({
                summary: `${memories.length} memória(s), ${files.length} arquivo(s) e ${Object.keys(signals).length} sinal(is) carregados.`,
                memories,
                files,
                signals,
                sections: [
                    { title: 'Memória aprovada', content: memories, provenance: storeFiles.map(file => path.relative(workspaceRoot, file)).join(', ') },
                    { title: 'Estado do fluxo', content: signals, provenance: 'run.context' },
                    ...(diagnostics.length ? [{ title: 'Diagnósticos', content: diagnostics, provenance: 'context.files' }] : [])
                ],
                provenance: [
                    ...storeFiles.map(file => ({ kind: 'memory-store', ref: path.relative(workspaceRoot, file), digest: sha256(memories) })),
                    ...files.map(file => ({ kind: 'workspace-file', ref: file.path, digest: file.digest }))
                ]
            }, maxBytes);
            const artifact: FlowStudioArtifact = {
                id: `context-${args.node.id}-${sha256(pack).slice(0, 12)}`,
                nodeId: args.node.id,
                kind: 'json',
                name: `Context pack · ${args.node.label}`,
                payload: pack,
                mimeType: 'application/json',
                digest: sha256(pack),
                createdAt: new Date().toISOString()
            };
            return { pack, artifacts: [artifact] };
        },
        writeCandidate: async args => {
            if (args.signal?.aborted) throw new Error('Gravação de memória cancelada.');
            if (args.candidate.status !== 'approved') throw new Error(`Candidato "${args.candidate.id}" não está aprovado.`);
            const scope = args.config.scope;
            if (args.approval.candidateDigest !== flowStudioMemoryCandidateDigest(args.candidate, scope)) throw new Error(`Approval receipt inválido para o candidato "${args.candidate.id}".`);
            if (args.approval.graphId !== args.graph.id || args.approval.nodeId !== args.node.id
                || (args.approval.scopeId || '') !== (args.config.scopeId || '')
                || (args.approval.storeId || '') !== (args.config.storeId || '')) {
                throw new Error(`Approval receipt não corresponde ao destino exato do Memory Write "${args.node.id}".`);
            }
            if (!args.approval.approvedAt || !args.approval.approvedBy) throw new Error('Approval receipt sem proveniência confiável.');
            if (args.candidate.scope !== undefined && args.candidate.scope !== scope) throw new Error(`Escopo do candidato não corresponde ao escopo autorizado do nó: ${args.candidate.scope} != ${scope}.`);
            const ownerId = memoryOwnerId(scope, { workspaceRoot, graphId: args.graph.id, runId: args.runId, nodeId: args.node.id, scopeId: args.config.scopeId });
            const storeFile = scope === 'ide' ? ideStoreFile : workspaceStoreFile;
            const candidateDigest = sha256({ ...args.candidate, scope, ownerId, storeId: args.config.storeId });
            return serializeMemoryWrite(storeFile, async (): Promise<FlowStudioMemoryWriteRecord> => {
                const store = await readWorkspaceMemoryStore(storeFile);
                const existing = store.entries.find(entry => entry.candidateId === args.candidate.id
                    && String(entry.revision) === String(args.candidate.revision)
                    && entry.scope === scope
                    && entry.ownerId === ownerId
                    && entry.storeId === args.config.storeId);
                if (existing) {
                    if (existing.digest !== candidateDigest) throw new Error(`Conflito de revisão na memória "${args.candidate.id}".`);
                    return { candidateId: existing.candidateId, revision: existing.revision, scope: existing.scope, scopeId: existing.scopeId, storeId: existing.storeId, status: 'written', digest: existing.digest, writtenAt: existing.writtenAt };
                }
                const entry: WorkspaceMemoryEntry = {
                    candidateId: args.candidate.id,
                    revision: args.candidate.revision,
                    scope,
                    ownerId,
                    storeId: args.config.storeId,
                    kind: args.candidate.kind || args.config.kind,
                    key: args.candidate.key,
                    value: args.candidate.value,
                    tags: args.candidate.tags,
                    approvedAt: args.approval.approvedAt,
                    approvedBy: args.approval.approvedBy,
                    approvalEvidence: args.approval.evidence,
                    approvalDigest: sha256(args.approval),
                    candidateDigest: args.approval.candidateDigest,
                    graphId: args.approval.graphId,
                    nodeId: args.approval.nodeId,
                    scopeId: args.approval.scopeId,
                    writtenAt: new Date().toISOString(),
                    digest: candidateDigest
                };
                const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf-8');
                if (entryBytes > MEMORY_ENTRY_MAX_BYTES) {
                    throw new Error(`Candidato de memória excede o limite de ${MEMORY_ENTRY_MAX_BYTES} bytes (${entryBytes}).`);
                }
                const sameIdentity = (item: WorkspaceMemoryEntry): boolean => item.candidateId === entry.candidateId
                    && item.scope === entry.scope
                    && item.ownerId === entry.ownerId
                    && item.storeId === entry.storeId;
                const priorRevisions = store.entries.filter(sameIdentity);
                if (priorRevisions.length >= MEMORY_REVISIONS_PER_CANDIDATE) {
                    const remove = new Set(priorRevisions.slice(0, priorRevisions.length - MEMORY_REVISIONS_PER_CANDIDATE + 1));
                    store.entries = store.entries.filter(item => !remove.has(item));
                }
                store.entries.push(entry);
                if (store.entries.length > MEMORY_STORE_MAX_ENTRIES) {
                    store.entries = store.entries.slice(store.entries.length - MEMORY_STORE_MAX_ENTRIES);
                }
                store.updatedAt = entry.writtenAt;
                store.version = FLOW_STUDIO_SCHEMA_VERSION;
                while (store.entries.length > 1 && Buffer.byteLength(`${JSON.stringify(store, null, 2)}\n`, 'utf-8') > MEMORY_STORE_MAX_BYTES) {
                    store.entries.shift();
                }
                const storeBytes = Buffer.byteLength(`${JSON.stringify(store, null, 2)}\n`, 'utf-8');
                if (storeBytes > MEMORY_STORE_MAX_BYTES) {
                    throw new Error(`Store de memória excederia o limite de ${MEMORY_STORE_MAX_BYTES} bytes (${storeBytes}).`);
                }
                await atomicWriteJson(storeFile, store);
                return { candidateId: entry.candidateId, revision: entry.revision, scope: entry.scope, scopeId: entry.scopeId, storeId: entry.storeId, status: 'written', digest: entry.digest, writtenAt: entry.writtenAt };
            });
        }
    };
};

/**
 * Host bridge for CyberVinci Memory (or another trusted memory service).
 * The executable is configured by the host, never by the GraphSpec, and every
 * operation is a single JSON request/response over stdio.
 */
const createCommandMemoryAdapter = (command: string, workspaceRoot: string): FlowStudioMemoryAdapter => {
    const normalized = command.trim();
    if (!normalized) throw new Error('--memory-exec exige um comando não vazio.');
    const invoke = async (operation: 'loadContext' | 'writeCandidate', payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> => {
        const raw = await runShellCommand(normalized, JSON.stringify({
            mode: 'flow-studio-memory',
            operation,
            ...payload
        }), { cwd: workspaceRoot, signal });
        const parsed = parseAdapterOutput(raw);
        if (!parsed) throw new Error(`O adapter de memória retornou uma resposta inválida para ${operation}; era esperado JSON objeto.`);
        return parsed;
    };
    return {
        loadContext: async args => {
            const result = await invoke('loadContext', {
                nodeId: args.node.id,
                runId: args.runId,
                graph: { id: args.graph.id, version: args.graph.version, name: args.graph.name },
                config: args.config,
                context: args.context
            }, args.signal);
            if (!isRecord(result.pack)) throw new Error('O adapter de memória deve devolver { pack: objeto } em loadContext.');
            return {
                pack: result.pack as FlowStudioContextPack,
                artifacts: Array.isArray(result.artifacts) ? result.artifacts as FlowStudioArtifact[] : undefined
            };
        },
        writeCandidate: async args => {
            const result = await invoke('writeCandidate', {
                nodeId: args.node.id,
                runId: args.runId,
                graph: { id: args.graph.id, version: args.graph.version, name: args.graph.name },
                config: args.config,
                context: args.context,
                candidate: args.candidate,
                approval: args.approval
            }, args.signal);
            const record = isRecord(result.record) ? result.record : result;
            if (typeof record.candidateId !== 'string'
                || (typeof record.revision !== 'string' && typeof record.revision !== 'number')
                || !MEMORY_SCOPES.includes(record.scope as FlowStudioMemoryScope)
                || (record.status !== 'written' && record.status !== 'failed')) {
                throw new Error('O adapter de memória devolveu um recibo inválido em writeCandidate.');
            }
            if (record.candidateId !== args.candidate.id
                || String(record.revision) !== String(args.candidate.revision)
                || record.scope !== args.config.scope
                || String(record.scopeId || '') !== String(args.config.scopeId || '')
                || String(record.storeId || '') !== String(args.config.storeId || '')) {
                throw new Error('O adapter de memória devolveu um recibo que não corresponde ao candidato e destino solicitados.');
            }
            if (record.status === 'written' && (typeof record.digest !== 'string' || !record.digest.trim()
                || typeof record.writtenAt !== 'string' || !Number.isFinite(Date.parse(record.writtenAt)))) {
                throw new Error('O adapter de memória devolveu um recibo written sem digest/writtenAt válidos.');
            }
            return record as unknown as FlowStudioMemoryWriteRecord;
        }
    };
};

const parseFlowInput = async (raw: string | undefined): Promise<Record<string, unknown> | undefined> => {
    if (!raw || !raw.trim()) {
        return undefined;
    }
    const source = raw.trim();
    if (source.startsWith('@')) {
        const jsonPath = path.resolve(source.substring(1));
        const contents = await fs.readFile(jsonPath, 'utf-8');
        return JSON.parse(contents) as Record<string, unknown>;
    }
    return JSON.parse(source) as Record<string, unknown>;
};

const defaultGraphPath = (value?: string): string => {
    if (value?.trim()) return path.resolve(value.trim());
    const preferred = path.join(process.cwd(), 'flow.graph.json');
    const legacy = path.join(process.cwd(), 'flow-studio.graph.json');
    return !existsSync(preferred) && existsSync(legacy) ? legacy : preferred;
};

const parseProviderModel = (rawProvider: string | undefined, rawModel: string | undefined): FlowStudioProviderBinding => {
    const provider = (rawProvider ?? '').trim();
    const model = (rawModel ?? '').trim();

    const nativeRunner = (providerId: string): NativeCliKind | 'flow' => {
        if (providerId === 'codex' || providerId === 'cybervinci' || providerId === 'opencode') return providerId;
        return 'flow';
    };

    if (!rawProvider && !rawModel) {
        const runnerId = findNativeCli('cybervinci') ? 'cybervinci' : findNativeCli('opencode') ? 'opencode' : 'flow';
        return { runnerId, providerId: runnerId };
    }

    if (rawModel && rawModel.includes('/')) {
        const [providerId, ...modelTail] = rawModel.split('/');
        const normalizedProvider = (providerId || provider || 'opencode').trim();
        const runnerId = nativeRunner(normalizedProvider);
        const tail = modelTail.join('/');
        return {
            runnerId,
            providerId: normalizedProvider,
            modelId: runnerId === 'cybervinci' || runnerId === 'opencode'
                ? normalizedProvider === runnerId && tail === 'default' ? 'default' : rawModel
                : tail || rawModel
        };
    }

    if (rawProvider && rawProvider.includes('/')) {
        const [providerId, modelId] = provider.split('/', 2);
        const normalizedProvider = providerId || 'opencode';
        const runnerId = nativeRunner(normalizedProvider);
        return {
            runnerId,
            providerId: normalizedProvider,
            modelId: runnerId === 'cybervinci' || runnerId === 'opencode' ? rawProvider : modelId || rawModel
        };
    }

    const providerId = provider || 'opencode';
    return {
        runnerId: nativeRunner(providerId),
        providerId,
        modelId: model || undefined
    };
};

const normalizeProviderModelRef = (providerId: string | undefined, modelId: string | undefined): string => {
    const normalizedProvider = providerId?.trim() || '';
    const normalizedModel = modelId?.trim() || '';
    if (!normalizedModel) {
        return normalizedProvider;
    }
    if (!normalizedProvider || normalizedModel === normalizedProvider) {
        return normalizedModel;
    }
    if (normalizedModel.startsWith(`${normalizedProvider}/`)) {
        return normalizedModel;
    }
    return `${normalizedProvider}/${normalizedModel}`;
};

const parseReasoningEffort = (value: unknown): FlowStudioReasoningEffort | undefined => {
    return typeof value === 'string' && ['none', 'low', 'medium', 'high', 'xhigh'].includes(value)
        ? value as FlowStudioReasoningEffort
        : undefined;
};

const parseServiceTier = (value: unknown): FlowStudioServiceTier | undefined => {
    return typeof value === 'string' && ['default', 'fast', 'flex'].includes(value)
        ? value as FlowStudioServiceTier
        : undefined;
};

const parseProviderBinding = (raw: unknown): FlowStudioProviderBinding | undefined => {
    if (!raw) {
        return undefined;
    }
    if (typeof raw === 'string') {
        const parsed = parseProviderModel(raw, undefined);
        return parsed.modelId ? parsed : { ...parsed, modelId: undefined };
    }
    if (typeof raw !== 'object') {
        return undefined;
    }
    const candidate = raw as Record<string, unknown>;
    const providerId = typeof candidate.providerId === 'string' ? candidate.providerId.trim() : undefined;
    const modelId = typeof candidate.modelId === 'string' ? candidate.modelId.trim() : undefined;
    if (!providerId && !modelId) {
        return undefined;
    }
    return {
        providerId: providerId || 'opencode',
        modelId,
        reasoningEffort: parseReasoningEffort(candidate.reasoningEffort),
        serviceTier: parseServiceTier(candidate.serviceTier),
        timeoutMs: typeof candidate.timeoutMs === 'number' ? candidate.timeoutMs : undefined,
        command: typeof candidate.command === 'string' ? candidate.command : undefined
    };
};

const parseAdapterOutput = (raw: unknown): Record<string, unknown> | undefined => {
    if (typeof raw !== 'string') {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // not JSON
    }
    return undefined;
};

const parseAdapterBinding = (raw: string): { key: string; command: string } | undefined => {
    const separatorIndex = raw.indexOf('=');
    if (separatorIndex < 0) {
        return undefined;
    }
    const rawKey = raw.slice(0, separatorIndex).trim();
    const command = raw.slice(separatorIndex + 1).trim();
    if (!rawKey || !command) {
        return undefined;
    }

    const key = rawKey.includes('/') ? rawKey : rawKey.includes(':') ? rawKey.replace(':', '/') : rawKey;
    return { key, command };
};

const parseMemoryApprovalPayload = (value: unknown): FlowStudioMemoryApproval[] => {
    if (value === undefined || value === null) return [];
    const rows = Array.isArray(value) ? value : [value];
    return rows.map((row, index) => {
        if (!isRecord(row)
            || typeof row.id !== 'string' || !row.id.trim()
            || (typeof row.revision !== 'string' && typeof row.revision !== 'number')
            || !MEMORY_SCOPES.includes(row.scope as FlowStudioMemoryScope)
            || typeof row.graphId !== 'string' || !row.graphId.trim()
            || typeof row.nodeId !== 'string' || !row.nodeId.trim()
            || typeof row.candidateDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(row.candidateDigest)) {
            throw new HttpStatusError(400, `memoryApprovals[${index}] deve conter id, revision, scope, graphId, nodeId e candidateDigest SHA-256.`);
        }
        return {
            id: row.id,
            revision: row.revision,
            scope: row.scope as FlowStudioMemoryScope,
            graphId: row.graphId,
            nodeId: row.nodeId,
            scopeId: typeof row.scopeId === 'string' && row.scopeId.trim() ? row.scopeId.trim() : undefined,
            storeId: typeof row.storeId === 'string' && row.storeId.trim() ? row.storeId.trim() : undefined,
            candidateDigest: row.candidateDigest.toLocaleLowerCase(),
            approvedAt: typeof row.approvedAt === 'string' ? row.approvedAt : undefined,
            approvedBy: typeof row.approvedBy === 'string' ? row.approvedBy : undefined,
            evidence: Array.isArray(row.evidence) ? row.evidence as FlowStudioArtifact[] : undefined
        };
    });
};

const parseHumanGatePayload = (value: unknown): FlowStudioGateResult | undefined => {
    if (value === undefined || value === null) return undefined;
    if (!isRecord(value)) throw new HttpStatusError(400, 'gate deve ser um objeto de decisão humana.');
    const allowedKeys = new Set(['decisionId', 'action', 'toNodeId', 'message', 'evidence', 'memoryApprovals']);
    const unknownKey = Object.keys(value).find(key => !allowedKeys.has(key));
    if (unknownKey) throw new HttpStatusError(400, `Campo gate.${unknownKey} não é permitido em uma retomada humana.`);
    if (typeof value.decisionId !== 'string' || !value.decisionId.trim()) {
        throw new HttpStatusError(400, 'gate.decisionId deve identificar uma decisão declarada pelo fluxo.');
    }
    if (value.action !== undefined && !['continue', 'wait', 'fail'].includes(String(value.action))) {
        throw new HttpStatusError(400, 'gate.action deve ser continue, wait ou fail.');
    }
    if (value.toNodeId !== undefined && (typeof value.toNodeId !== 'string' || !value.toNodeId.trim())) {
        throw new HttpStatusError(400, 'gate.toNodeId deve ser uma string não vazia.');
    }
    if (value.message !== undefined && (typeof value.message !== 'string' || value.message.length > 10_000)) {
        throw new HttpStatusError(400, 'gate.message deve ser uma string de até 10000 caracteres.');
    }
    const artifactKinds = new Set(['text', 'json', 'log', 'tool-output', 'report', 'file', 'diff', 'evidence']);
    if (value.evidence !== undefined && (!Array.isArray(value.evidence) || value.evidence.length > 32 || value.evidence.some(item =>
        !isRecord(item)
        || typeof item.id !== 'string' || !item.id.trim()
        || typeof item.nodeId !== 'string' || !item.nodeId.trim()
        || typeof item.kind !== 'string' || !artifactKinds.has(item.kind)
        || typeof item.name !== 'string' || !item.name.trim()
        || !Object.prototype.hasOwnProperty.call(item, 'payload')))) {
        throw new HttpStatusError(400, 'gate.evidence deve conter no máximo 32 artefatos válidos.');
    }
    return {
        decisionId: value.decisionId.trim(),
        action: value.action as FlowStudioGateResult['action'],
        toNodeId: typeof value.toNodeId === 'string' ? value.toNodeId.trim() : undefined,
        message: typeof value.message === 'string' ? value.message : undefined,
        evidence: value.evidence as FlowStudioArtifact[] | undefined,
        memoryApprovals: parseMemoryApprovalPayload(value.memoryApprovals)
    };
};

const parseMemoryCandidateDigestRequest = (candidate: unknown, scope: unknown): { candidate: FlowStudioMemoryCandidate; scope: FlowStudioMemoryScope } => {
    const validStatuses = new Set(['candidate', 'approved', 'rejected', 'written', 'failed']);
    const validKinds = new Set(['fact', 'decision', 'preference', 'instruction', 'summary']);
    if (!isRecord(candidate)
        || typeof candidate.id !== 'string' || !candidate.id.trim()
        || (typeof candidate.revision !== 'string' && typeof candidate.revision !== 'number')
        || typeof candidate.status !== 'string' || !validStatuses.has(candidate.status)
        || !Object.prototype.hasOwnProperty.call(candidate, 'value')
        || !MEMORY_SCOPES.includes(scope as FlowStudioMemoryScope)
        || (candidate.scope !== undefined && candidate.scope !== scope)
        || (candidate.kind !== undefined && (typeof candidate.kind !== 'string' || !validKinds.has(candidate.kind)))
        || (candidate.tags !== undefined && (!Array.isArray(candidate.tags) || candidate.tags.some(tag => typeof tag !== 'string')))) {
        throw new HttpStatusError(400, 'candidate/scope inválidos para cálculo do digest de memória.');
    }
    return { candidate: candidate as unknown as FlowStudioMemoryCandidate, scope: scope as FlowStudioMemoryScope };
};

const readMemoryApprovalOptions = async (input: CliArgValue, workspaceRoot: string): Promise<FlowStudioMemoryApproval[]> => {
    const approvals: FlowStudioMemoryApproval[] = [];
    for (const raw of toStringArray(input)) {
        const source = raw.trim();
        if (!source) continue;
        const payload = source.startsWith('@')
            ? JSON.parse(await fs.readFile(await resolveWorkspaceFile(workspaceRoot, source.slice(1)), 'utf-8')) as unknown
            : JSON.parse(source) as unknown;
        approvals.push(...parseMemoryApprovalPayload(payload));
    }
    return approvals;
};

const hostToolCatalog = (input: CliArgValue): FlowStudioToolBinding[] => toStringArray(input)
    .map(parseAdapterBinding)
    .filter((binding): binding is { key: string; command: string } => Boolean(binding))
    .map(({ key }) => ({
        id: key,
        name: key,
        command: key,
        effect: 'custom',
        idempotencyKey: `${key}:{{flow.request}}`,
        requiredPermissions: ['tool:custom']
    }));

const hostPlaybookCatalog = (input: CliArgValue): FlowStudioPlaybookDefinition[] => toStringArray(input)
    .map(parseAdapterBinding)
    .filter((binding): binding is { key: string; command: string } => Boolean(binding))
    .map(({ key }) => ({ id: key, name: key, description: 'Playbook externo fornecido pelo host.' }));

const uniqueById = <T extends { id: string }>(...sources: Array<T[] | undefined>): T[] => {
    const result = new Map<string, T>();
    for (const source of sources) for (const item of source || []) result.set(item.id, item);
    return [...result.values()];
};

const normalizeModelProfile = (id: string, providerId: string, modelId: string): FlowStudioModelProfile => ({
    id,
    name: `${providerId} ${modelId}`,
    providerId,
    modelId,
    description: `Perfil criado via CLI para ${id}`,
    tags: ['cli', 'custom']
});

const parseProviderAdapterOverrides = (
    providerExecInput: CliArgValue,
    modelProfiles: Record<string, FlowStudioModelProfile>,
    workspaceRoot: string
): Record<string, FlowStudioProviderAdapter> => {
    const bindings = toStringArray(providerExecInput)
        .map(item => parseAdapterBinding(item))
        .filter((item): item is { key: string; command: string } => item !== undefined);
    const registry: Record<string, FlowStudioProviderAdapter> = {};
    for (const binding of bindings) {
        const adapter = createCommandProviderAdapter(binding.command, workspaceRoot);
        registry[binding.key] = adapter;
        const [providerId, modelId] = binding.key.split('/', 2);
        if (providerId) {
            registry[providerId] = registry[providerId] || adapter;
            if (modelId) {
                const profileId = `${providerId}/${modelId}`.trim();
                modelProfiles[profileId] = normalizeModelProfile(profileId, providerId, profileId);
            }
        }
    }
    return registry;
};

const registerGraphRunnerAdapters = (
    registry: Record<string, FlowStudioProviderAdapter>,
    graph: FlowStudioGraph,
    profiles: Record<string, FlowStudioModelProfile>,
    workspaceRoot: string,
    nativeEnabled = true,
    graphCommandsEnabled = false,
    hostCommandPatterns: readonly string[] = [],
    hostRunnerHosts: readonly string[] = []
): Record<string, FlowStudioProviderAdapter> => {
    if (nativeEnabled) {
        registry.flow = registry.flow || createStandaloneProviderAdapter();
        for (const kind of ['codex', 'cybervinci', 'opencode'] as const) {
            const native = createNativeCliProviderAdapter(kind, workspaceRoot);
            if (native && !registry[kind]) registry[kind] = native;
        }
    }
    for (const runner of graph.runners || []) {
        const adapter = nativeEnabled && (runner.kind === 'codex' || runner.kind === 'cybervinci' || runner.kind === 'opencode')
                ? createNativeCliProviderAdapter(runner.kind, workspaceRoot)
            : !graphCommandsEnabled
                ? undefined
                : runner.command?.trim()
                    ? createGraphCommandProviderAdapter(runner.command, workspaceRoot, graph.permissions, hostCommandPatterns)
                    : runner.kind === 'http' || runner.kind === 'worker' || runner.kind === 'llm'
                    ? createHttpProviderAdapter(runner, graph.permissions, hostRunnerHosts)
                : undefined;
        if (!adapter) continue;
        registry[runner.id] = adapter;
        if (runner.providerId && !registry[runner.providerId]) registry[runner.providerId] = adapter;
    }
    if (graphCommandsEnabled) for (const profile of Object.values(profiles)) {
        if (!profile.command?.trim()) continue;
        const adapter = createGraphCommandProviderAdapter(profile.command, workspaceRoot, graph.permissions, hostCommandPatterns);
        registry[profile.id] = registry[profile.id] || adapter;
        registry[profile.providerId] = registry[profile.providerId] || adapter;
        registry[profile.modelId] = registry[profile.modelId] || adapter;
    }
    for (const profile of Object.values(profiles)) {
        const adapter = (profile.runnerId && registry[profile.runnerId]) || registry[profile.providerId];
        if (!adapter) continue;
        registry[profile.id] = registry[profile.id] || adapter;
        registry[profile.modelId] = registry[profile.modelId] || adapter;
        registry[profile.providerId] = registry[profile.providerId] || adapter;
    }
    return registry;
};

const parseToolAdapterOverrides = (toolExecInput: CliArgValue, workspaceRoot: string): Record<string, FlowStudioToolAdapter> => {
    const bindings = toStringArray(toolExecInput)
        .map(item => parseAdapterBinding(item))
        .filter((item): item is { key: string; command: string } => item !== undefined);
    if (bindings.length === 0) {
        return {};
    }
    const registry: Record<string, FlowStudioToolAdapter> = {};
    for (const binding of bindings) {
        registry[binding.key] = createCommandToolAdapter(binding.command, workspaceRoot);
    }
    return registry;
};

const createCommandPlaybookAdapter = (command: string, workspaceRoot: string): FlowStudioPlaybookAdapter => {
    const normalized = command.trim();
    return async args => {
        const raw = await runShellCommand(normalized, JSON.stringify({
            mode: 'flow-studio-playbook',
            playbookId: args.config.playbookId,
            runId: args.runId,
            node: args.node,
            graph: { id: args.graph.id, version: args.graph.version, name: args.graph.name },
            parameters: args.config.parameters || {},
            context: args.context
        }), { cwd: workspaceRoot, timeoutMs: args.node.timeoutMs || 10 * 60_000, signal: args.signal });
        const parsed = parseAdapterOutput(raw);
        if (!parsed) return { ok: true, value: raw, output: { playbookOutput: raw } };
        const result: FlowStudioPlaybookRunResult = {
            ok: parsed.ok !== false,
            stop: parsed.stop === true,
            message: typeof parsed.message === 'string' ? parsed.message : undefined,
            value: parsed.value,
            output: isRecord(parsed.output) ? parsed.output : undefined,
            signals: isRecord(parsed.signals) ? parsed.signals : undefined,
            issues: Array.isArray(parsed.issues) ? parsed.issues.filter((item): item is string => typeof item === 'string') : undefined,
            diagnostics: Array.isArray(parsed.diagnostics) ? parsed.diagnostics : undefined,
            artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts as FlowStudioArtifact[] : undefined,
            usage: isRecord(parsed.usage) ? parsed.usage : undefined
        };
        if (!result.output && result.value !== undefined) result.output = { playbookOutput: result.value };
        return result;
    };
};

const parsePlaybookAdapterOverrides = (playbookExecInput: CliArgValue, workspaceRoot: string): Record<string, FlowStudioPlaybookAdapter> => {
    const registry: Record<string, FlowStudioPlaybookAdapter> = {};
    for (const binding of toStringArray(playbookExecInput).map(parseAdapterBinding)) {
        if (binding) registry[binding.key] = createCommandPlaybookAdapter(binding.command, workspaceRoot);
    }
    return registry;
};

const parseGatePolicy = (raw: unknown): FlowStudioGatePolicy | undefined => {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const candidate = raw as Record<string, unknown>;
    const defaultActionRaw = typeof candidate.defaultAction === 'string' ? candidate.defaultAction : undefined;
    const defaultAction = (
        defaultActionRaw === 'continue' || defaultActionRaw === 'wait' || defaultActionRaw === 'fail'
    ) ? defaultActionRaw : undefined;
    const defaultToNodeId = typeof candidate.defaultToNodeId === 'string' ? candidate.defaultToNodeId : undefined;
    const byNode: Record<string, { action?: FlowStudioGateDecision; toNodeId?: string }> = {};

    if (candidate.byNode && typeof candidate.byNode === 'object') {
        for (const [nodeId, rowUnknown] of Object.entries(candidate.byNode)) {
            if (!nodeId || !rowUnknown || typeof rowUnknown !== 'object') {
                continue;
            }
            const row = rowUnknown as Record<string, unknown>;
            const actionRaw = typeof row.action === 'string' ? row.action : undefined;
            const action = (
                actionRaw === 'continue' || actionRaw === 'wait' || actionRaw === 'fail'
            ) ? actionRaw : undefined;
            const toNodeId = typeof row.toNodeId === 'string' ? row.toNodeId : undefined;
            if (action || toNodeId) {
                byNode[nodeId] = { action, toNodeId };
            }
        }
    }

    return {
        defaultAction,
        defaultToNodeId,
        byNode: Object.keys(byNode).length > 0 ? byNode : undefined
    };
};

const parseModelProfilesFromBody = (raw: unknown): Record<string, FlowStudioModelProfile> => {
    return normalizeProfilePayload(raw);
};

const normalizeProfilePayload = (raw: unknown): Record<string, FlowStudioModelProfile> => {
    if (!raw) {
        return {};
    }
    if (Array.isArray(raw)) {
        const result: Record<string, FlowStudioModelProfile> = {};
        for (const item of raw) {
            if (!item || typeof item !== 'object') {
                continue;
            }
            const profile = item as FlowStudioModelProfile;
            if (!profile.id) {
                continue;
            }
            result[profile.id] = {
                id: profile.id,
                name: profile.name || profile.id,
                providerId: profile.providerId || 'opencode',
                modelId: profile.modelId || profile.id,
                runnerId: profile.runnerId,
                description: profile.description,
                command: profile.command,
                contextWindow: profile.contextWindow,
                maxOutputTokens: profile.maxOutputTokens,
                costPerMTokPrompt: profile.costPerMTokPrompt,
                costPerMTokOutput: profile.costPerMTokOutput,
                tags: profile.tags,
                capabilities: profile.capabilities,
                reasonDefault: profile.reasonDefault,
                serviceTierDefault: profile.serviceTierDefault
            };
        }
        return result;
    }
    if (typeof raw === 'object') {
        const result: Record<string, FlowStudioModelProfile> = {};
        for (const [id, value] of Object.entries(raw)) {
            if (!id || !value || typeof value !== 'object') {
                continue;
            }
            const candidate = value as Record<string, unknown>;
            result[id] = {
                id,
                providerId: typeof candidate.providerId === 'string' ? candidate.providerId : 'opencode',
                modelId: typeof candidate.modelId === 'string' ? candidate.modelId : id,
                runnerId: typeof candidate.runnerId === 'string' ? candidate.runnerId : undefined,
                name: typeof candidate.name === 'string' ? candidate.name : id,
                description: typeof candidate.description === 'string' ? candidate.description : undefined,
                tags: Array.isArray(candidate.tags) ? (candidate.tags as string[]) : undefined,
                capabilities: Array.isArray(candidate.capabilities) ? candidate.capabilities.filter((item): item is FlowStudioRunnerCapability => typeof item === 'string') as FlowStudioRunnerCapability[] : undefined,
                reasonDefault: parseReasoningEffort(candidate.reasonDefault),
                serviceTierDefault: parseServiceTier(candidate.serviceTierDefault)
            };
            if (typeof candidate.command === 'string' && candidate.command.trim()) {
                result[id].command = candidate.command;
            }
            if (typeof candidate.contextWindow === 'number' && Number.isFinite(candidate.contextWindow)) {
                result[id].contextWindow = candidate.contextWindow;
            }
            if (typeof candidate.maxOutputTokens === 'number' && Number.isFinite(candidate.maxOutputTokens)) {
                result[id].maxOutputTokens = candidate.maxOutputTokens;
            }
            if (typeof candidate.costPerMTokPrompt === 'number' && Number.isFinite(candidate.costPerMTokPrompt)) {
                result[id].costPerMTokPrompt = candidate.costPerMTokPrompt;
            }
            if (typeof candidate.costPerMTokOutput === 'number' && Number.isFinite(candidate.costPerMTokOutput)) {
                result[id].costPerMTokOutput = candidate.costPerMTokOutput;
            }
        }
        return result;
    }
    return {};
};

const resolveModelProfileCatalogPath = (graphPath: string): string => {
    const directory = path.dirname(path.resolve(graphPath));
    return path.join(directory, MODEL_PROFILE_CATALOG_FILENAME);
};

const readModelProfilesFromCatalog = async (graphPath: string): Promise<Record<string, FlowStudioModelProfile>> => {
    const catalogPath = resolveModelProfileCatalogPath(graphPath);
    try {
        const raw = await fs.readFile(catalogPath, 'utf-8');
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && 'profiles' in parsed) {
            return normalizeProfilePayload((parsed as { profiles?: unknown }).profiles);
        }
        return normalizeProfilePayload(parsed);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return {};
        }
        throw error;
    }
};

const writeModelProfilesToCatalog = async (
    graphPath: string,
    profiles: Record<string, FlowStudioModelProfile>
): Promise<string> => {
    const catalogPath = resolveModelProfileCatalogPath(graphPath);
    const payload = {
        version: FLOW_STUDIO_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        profiles: Object.values(profiles)
    };
    await atomicWriteJson(catalogPath, payload);
    return catalogPath;
};

const createCommandProviderAdapter = (command: string, workspaceRoot: string): FlowStudioProviderAdapter => {
    const normalized = command.trim();
    return async args => {
        const payload = {
            nodeId: args.node.id,
            runId: args.runId,
            prompt: args.prompt,
            model: args.model,
            provider: args.runner,
            context: args.context,
            tools: args.node.tools || [],
            permissions: args.node.permissions || args.graph.permissions
        };
        const providerRef = normalizeProviderModelRef(args.runner.providerId, args.model?.modelId ?? args.runner.modelId);
        const result = await runShellCommand(normalized, JSON.stringify(payload), {
            cwd: workspaceRoot,
            timeoutMs: args.runner.timeoutMs,
            signal: args.signal
        });
        const parsed = parseAdapterOutput(result);
        if (parsed && (isRecord(parsed.output) || Array.isArray(parsed.toolCalls) || parsed.summary || parsed.usage || parsed.artifacts)) {
            return {
                summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
                output: isRecord(parsed.output) ? parsed.output : {},
                artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts as never[] : undefined,
                usage: isRecord(parsed.usage) ? parsed.usage : undefined,
                sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
                toolCalls: Array.isArray(parsed.toolCalls) ? parsed.toolCalls.filter(isRecord).map(call => ({
                    toolId: String(call.toolId || ''),
                    args: Array.isArray(call.args) ? call.args.filter((item): item is string => typeof item === 'string') : undefined,
                    idempotencyKey: typeof call.idempotencyKey === 'string' ? call.idempotencyKey : undefined
                })).filter(call => call.toolId) : undefined
            };
        }
        const output = parsed ?? {
            [args.node.id]: result || String(args.prompt ?? ''),
            [`${args.node.id}.provider`]: args.runner.providerId || 'default',
            [`${args.node.id}.model`]: providerRef || args.runner.modelId || args.runner.providerId,
            [`${args.node.id}.reasoningEffort`]: args.runner.reasoningEffort ?? 'medium'
        };
        return {
            summary: `Provider command "${normalized}" executed for ${providerRef || 'default'}.`,
            output: {
                ...output,
                [`${args.node.id}.command`]: normalized
            }
        };
    };
};

const createGraphCommandProviderAdapter = (command: string, workspaceRoot: string, permissions: FlowStudioPermissionSpec | undefined, hostPatterns: readonly string[]): FlowStudioProviderAdapter => {
    const adapter = createCommandProviderAdapter(command, workspaceRoot);
    return async args => {
        const patterns = permissions?.commandPatterns || [];
        const commandLine = command.trim();
        if (!hostPatterns.length || !hostPatterns.some(pattern => pattern === commandLine || (pattern.endsWith('*') && commandLine.startsWith(pattern.slice(0, -1))))) {
            throw new Error(`Runner por comando fora da allowlist independente do host: ${commandLine}`);
        }
        if (!patterns.length || !patterns.some(pattern => pattern === '*' || pattern === commandLine || (pattern.endsWith('*') && commandLine.startsWith(pattern.slice(0, -1))))) {
            throw new Error(`Runner por comando fora da allowlist: ${commandLine}`);
        }
        const roots = permissions?.fileRoots || [];
        if (roots.length) {
            const canonicalWorkspace = await fs.realpath(workspaceRoot);
            const canonicalRoots = await Promise.all(roots.map(root => fs.realpath(path.resolve(workspaceRoot, root))));
            if (!canonicalRoots.some(root => path.relative(root, canonicalWorkspace) === '')) {
                throw new Error('Runner por comando exige que o workspace esteja dentro de permissions.fileRoots.');
            }
        }
        return adapter(args);
    };
};

const createCommandAuthorAdapter = (command: string, workspaceRoot: string): FlowStudioAuthorAdapter => {
    const normalized = command.trim();
    return async args => {
        const output = await runShellCommand(normalized, JSON.stringify({
            mode: 'flow-studio-authoring',
            prompt: args.systemPrompt,
            schema: args.schema,
            request: args.request
        }), { cwd: workspaceRoot, signal: args.signal });
        try {
            return JSON.parse(output) as unknown;
        } catch {
            return output;
        }
    };
};

const createCommandToolAdapter = (command: string, workspaceRoot: string): FlowStudioToolAdapter => {
    const normalized = command.trim();
    return async args => {
        const cwd = args.tool.cwd ? await resolveWorkspaceFile(workspaceRoot, args.tool.cwd) : workspaceRoot;
        const payload = {
            nodeId: args.nodeId,
            runId: args.runId,
            tool: args.tool,
            context: args.context
        };
        const result = await runShellCommand(normalized, JSON.stringify(payload), {
            args: args.tool.args,
            cwd,
            timeoutMs: args.tool.timeoutMs ?? args.node.timeoutMs,
            signal: args.signal
        });
        const output = parseAdapterOutput(result);
        return {
            output: {
                [args.nodeId]: output ? (typeof output.output === 'string' ? output.output : JSON.stringify(output)) : (result || 'ok'),
                [`${args.nodeId}.tool.command`]: normalized,
                ...(output ? { [`${args.nodeId}.commandOutput`]: JSON.stringify(output) } : {})
            }
        };
    };
};

const createGraphCommandToolAdapter = (workspaceRoot: string, hostPatterns: readonly string[]): FlowStudioToolAdapter => async args => {
    const normalized = args.tool.command.trim();
    if (!normalized) throw new Error(`Ferramenta "${args.tool.id}" não possui comando.`);
    const commandLine = [normalized, ...(args.tool.args || [])].join(' ').trim();
    if (!hostPatterns.some(pattern => pattern === commandLine || (pattern.endsWith('*') && commandLine.startsWith(pattern.slice(0, -1))))) {
        throw new Error(`Ferramenta "${args.tool.id}" tentou executar comando fora da allowlist do host: ${commandLine}`);
    }
    const cwd = args.tool.cwd ? await resolveWorkspaceFile(workspaceRoot, args.tool.cwd) : workspaceRoot;
    const result = await runShellCommand(normalized, JSON.stringify({
        nodeId: args.nodeId,
        runId: args.runId,
        tool: args.tool,
        context: args.context
    }), {
        args: args.tool.args,
        cwd,
        timeoutMs: args.tool.timeoutMs ?? args.node.timeoutMs,
        signal: args.signal
    });
    const output = parseAdapterOutput(result);
    return { output: output || { result: result || 'ok', command: normalized } };
};

const parseArgs = (argv: string[]): ParsedArgs => {
    const parsed: ParsedArgs = { _: [] };

    const addOption = (key: string, value: CliArgValue): void => {
        const previous = parsed[key];
        if (previous === undefined) {
            parsed[key] = value;
            return;
        }
        if (Array.isArray(previous)) {
            if (typeof value === 'string') {
                parsed[key] = [...previous, value];
            }
            return;
        }
        if (typeof previous === 'string') {
            if (value === undefined) {
                return;
            }
            if (typeof value === 'string') {
                parsed[key] = [previous, value];
            }
            if (typeof value === 'boolean') {
                parsed[key] = [previous, String(value)];
            }
            return;
        }
        parsed[key] = [String(previous), ...(typeof value === 'string' ? [value] : typeof value === 'boolean' ? [String(value)] : [])];
    };

    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('-')) {
            parsed._.push(token);
            continue;
        }
        if (token === '--') {
            parsed._.push(...argv.slice(index + 1));
            break;
        }
        if (token.startsWith('--')) {
            const [rawName, rawValue] = token.slice(2).split('=', 2);
            if (rawValue !== undefined) {
                addOption(rawName, rawValue);
                continue;
            }
            const next = argv[index + 1];
            if (next && !next.startsWith('-')) {
                index += 1;
                addOption(rawName, next);
            } else {
                addOption(rawName, true);
            }
            continue;
        }
        const short = token.slice(1);
        if (short === 'h' || short === 'v' || short === 'w') {
            const long = short === 'h' ? 'help' : short === 'v' ? 'version' : 'watch';
            addOption(long, true);
            continue;
        }
        const next = argv[index + 1];
        if (next && !next.startsWith('-')) {
            index += 1;
            const long = short === 'p'
                ? 'provider'
                : short === 'm'
                    ? 'model'
                    : short === 'P'
                        ? 'port'
                        : short === 'i'
                            ? 'input'
                            : 'provider';
            addOption(long, next);
        }
    }

    return parsed;
};

const toStringOption = (args: ParsedArgs, key: string, fallback?: string): string | undefined => {
    const value = args[key];
    return typeof value === 'string' ? value : undefined;
};

const toStringArrayOption = (args: ParsedArgs, key: string): string[] => {
    const value = args[key];
    if (!value) {
        return [];
    }
    if (typeof value === 'string') {
        return [value];
    }
    if (Array.isArray(value)) {
        return value.filter(item => typeof item === 'string') as string[];
    }
    return [];
};

const toStringArray = (value: CliArgValue): string[] => {
    if (!value) {
        return [];
    }
    if (typeof value === 'string') {
        return [value];
    }
    if (Array.isArray(value)) {
        return value.filter(item => typeof item === 'string') as string[];
    }
    return [];
};

const toNumberOption = (args: ParsedArgs, key: string): number | undefined => {
    const value = args[key];
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
};

const summarizeValidation = (result: FlowStudioValidationResult): string => {
    if (result.valid) {
        return chalk.green(`Validação OK (${result.errors.length} erros, ${result.warnings.length} avisos)`);
    }
    const lines: string[] = [`Validação inválida (${result.errors.length} erros, ${result.warnings.length} avisos)`];
    for (const issue of result.errors) {
        lines.push(`- ERRO (${issue.code}) ${issue.path}: ${issue.message}`);
    }
    for (const issue of result.warnings) {
        lines.push(`- AVISO (${issue.code}) ${issue.path}: ${issue.message}`);
    }
    return lines.join('\n');
};

const buildModelProfileMap = (...sources: (FlowStudioModelProfile[] | Record<string, FlowStudioModelProfile> | undefined)[]): Record<string, FlowStudioModelProfile> => {
    const result: Record<string, FlowStudioModelProfile> = {
        ...FLOW_STUDIO_DEFAULT_MODEL_PROFILES
    };
    for (const source of sources) {
        if (!source) {
            continue;
        }
        if (Array.isArray(source)) {
            for (const profile of source) {
                if (profile?.id) {
                    result[profile.id] = profile;
                }
            }
            continue;
        }
        for (const [id, profile] of Object.entries(source)) {
            if (id && profile) {
                result[id] = profile;
            }
        }
    }
    return result;
};

const runGraphFromFile = async (graphPath: string, options: FlowStudioCliOptions): Promise<FlowStudioRunResult> => {
    const graph = await readGraphFile(graphPath);
    const input = await parseFlowInput(options.input) ?? {};
    const defaultProvider = parseProviderModel(options.provider, options.model);
    defaultProvider.reasoningEffort = options.reasoning;

    const catalogProfiles = await readModelProfilesFromCatalog(graphPath);
    const modelProfiles = buildModelProfileMap(parseModelProfilesFromBody(graph.modelProfiles), catalogProfiles);
    const workspaceRoot = path.dirname(path.resolve(graphPath));
    const executableGraph = { ...graph, modelProfiles: Object.values(modelProfiles) };
    const providerAdapters = registerGraphRunnerAdapters(parseProviderAdapterOverrides(options['provider-exec'], modelProfiles, workspaceRoot), executableGraph, modelProfiles, workspaceRoot, options.simulate !== true, options['allow-graph-runners'] === true, toStringArray(options['allow-command']), toStringArray(options['allow-runner-host']));
    const toolAdapters = parseToolAdapterOverrides(options['tool-exec'], workspaceRoot);
    const playbookAdapters = parsePlaybookAdapterOverrides(options['playbook-exec'], workspaceRoot);
    const allowCommands = toStringArray(options['allow-command']);
    if (options['allow-graph-tools']) {
        if (!allowCommands.length) throw new Error('--allow-graph-tools exige ao menos um --allow-command <pattern>.');
        toolAdapters['*'] = createGraphCommandToolAdapter(workspaceRoot, allowCommands);
    }
    const memoryApprovals = await readMemoryApprovalOptions(options['memory-approval'], workspaceRoot);

    const result = await runFlowStudioGraph({
        graph: executableGraph,
        input,
        maxSteps: options['max-steps'],
        providerAdapters,
        toolAdapters,
        playbookAdapters,
        memoryAdapter: options['memory-exec'] ? createCommandMemoryAdapter(options['memory-exec'], workspaceRoot) : createWorkspaceMemoryAdapter(workspaceRoot),
        memoryApprovals,
        defaultProvider,
        modelProfiles,
        workspaceRoot,
        resolveSubgraph: async ref => readGraphFile(await resolveWorkspaceFile(workspaceRoot, ref)),
        simulationMode: options.simulate === true,
        onEvent: options.watch
            ? event => process.stdout.write(`${event.at} ${event.kind} - ${event.message}\n`)
            : undefined
    });
    return result;
};

const handleRunCommand = async (graphPath: string, options: FlowStudioCliOptions): Promise<void> => {
    const result = await runGraphFromFile(graphPath, options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
};

const runTemplateCommand = async (args: ParsedArgs, options: FlowStudioCliOptions): Promise<void> => {
    const graph = createFlowStudioTemplate(options.name ?? 'Novo fluxo');
    if (options.file) {
        await writeGraphFile(options.file, graph);
        process.stdout.write(chalk.green(`Template salvo em ${options.file}\n`));
        return;
    }
    process.stdout.write(`${JSON.stringify(graph, null, 2)}\n`);
};

const runValidateCommand = async (graphPath: string): Promise<void> => {
    const graph = await readGraphFile(graphPath);
    const result = validateFlowStudioGraph(graph);
    process.stdout.write(`${summarizeValidation(result)}\n`);
    process.exitCode = result.valid ? 0 : 2;
};

const runAuthorCommand = async (instruction: string, targetPath: string, options: FlowStudioCliOptions): Promise<void> => {
    if (!instruction.trim()) throw new Error('author exige uma instrução.');
    const resolved = defaultGraphPath(targetPath);
    const currentGraph = existsSync(resolved) ? await readGraphFile(resolved) : undefined;
    const catalog = await readModelProfilesFromCatalog(resolved);
    const profiles = buildModelProfileMap(parseModelProfilesFromBody(currentGraph?.modelProfiles), catalog);
    const requestedProfile = options.profile ? profiles[options.profile] : undefined;
    const adapter = resolveAuthorAdapter(path.dirname(resolved), requestedProfile, options['author-exec']);
    if (!adapter) throw new Error('Nenhum autor disponível. Instale Codex/OpenCode CLI ou use --author-exec <comando>.');
    const result = await authorFlowStudioGraph({
        instruction,
        currentGraph,
        availableRunners: currentGraph?.runners,
        availableModels: Object.values(profiles),
        availableTools: uniqueById(currentGraph?.nodes.flatMap(node => node.tools || []), hostToolCatalog(options['tool-exec'])),
        availablePlaybooks: hostPlaybookCatalog(options['playbook-exec'])
    }, adapter);
    await writeGraphFile(resolved, result.graph);
    process.stdout.write(`${JSON.stringify({ ok: true, file: resolved, summary: result.summary, assumptions: result.assumptions, validation: result.validation }, null, 2)}\n`);
};

const providerHostOption = (value: string | undefined): FlowProviderSource | undefined => {
    if (!value) return undefined;
    if (value === 'flow' || value === 'cybervinci' || value === 'opencode') return value;
    throw new Error(`Origem de providers inválida: ${value}. Use flow, cybervinci ou opencode.`);
};

const readProviderSecret = async (options: FlowStudioCliOptions): Promise<string> => {
    const environmentName = options['api-key-env']?.trim();
    if (environmentName) {
        const value = process.env[environmentName];
        if (!value?.trim()) throw new Error(`A variável ${environmentName} não contém uma API key.`);
        return value.trim();
    }
    if (options['api-key-stdin'] || !process.stdin.isTTY || !process.stdout.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const value = Buffer.concat(chunks).toString('utf8').trim();
        if (!value) throw new Error('Nenhuma API key foi recebida por stdin.');
        return value;
    }
    return new Promise<string>((resolve, reject) => {
        const input = process.stdin;
        const output = process.stdout;
        let value = '';
        const finish = (error?: Error): void => {
            input.off('data', onData);
            input.setRawMode?.(false);
            input.pause();
            output.write('\n');
            if (error) reject(error);
            else if (!value.trim()) reject(new Error('A API key é obrigatória.'));
            else resolve(value.trim());
        };
        const onData = (chunk: Buffer | string): void => {
            const text = String(chunk);
            for (const character of text) {
                if (character === '\u0003') return finish(new Error('Login cancelado.'));
                if (character === '\r' || character === '\n') return finish();
                if (character === '\u007f' || character === '\b') {
                    if (value) { value = value.slice(0, -1); output.write('\b \b'); }
                    continue;
                }
                value += character;
                output.write('•');
            }
        };
        output.write('API key: ');
        input.setRawMode?.(true);
        input.resume();
        input.on('data', onData);
    });
};

const runProvidersCommand = async (remaining: string[], options: FlowStudioCliOptions): Promise<void> => {
    const action = remaining[0]?.toLowerCase() || 'list';
    if (action === 'login') {
        const provider = remaining[1] || options.provider;
        if (!provider) throw new Error('providers login exige <provider>.');
        const externalSource = options['provider-host'] === 'cybervinci' || options['provider-host'] === 'opencode';
        if (externalSource || options.method) {
            const host = options['provider-host'] === 'flow' ? undefined : options['provider-host'];
            if (!findProviderHost(host)) throw new Error('Este método de login exige CyberVinci/OpenCode. Para API key standalone, remova --method ou use --source flow.');
            const args = ['providers', 'login', '--provider', provider];
            if (options.method) args.push('--method', options.method);
            process.exitCode = await runProviderHostCommand(args, host);
            return;
        }
        const key = await readProviderSecret(options);
        const broker = new FlowProviderBroker({ workspaceRoot: process.cwd(), preferredHost: 'flow' });
        await broker.setApiKey(provider, key, {
            ...(options['base-url'] ? { baseURL: options['base-url'] } : {}),
            ...(options.headers ? { headers: options.headers } : {}),
            ...(options.protocol ? { protocol: options.protocol } : {})
        });
        process.stdout.write(`Provider ${provider} conectado ao cofre standalone do Flow.\n`);
        return;
    }
    if (action === 'logout') {
        const provider = remaining[1] || options.provider;
        if (!provider) throw new Error('providers logout exige <provider>.');
        if (options['provider-host'] === 'cybervinci' || options['provider-host'] === 'opencode') {
            process.exitCode = await runProviderHostCommand(['providers', 'logout', provider], options['provider-host']);
            return;
        }
        const broker = new FlowProviderBroker({ workspaceRoot: process.cwd(), preferredHost: options['provider-host'] });
        await broker.disconnect(provider);
        await broker.stop();
        process.stdout.write(`Provider ${provider} desconectado do Flow.\n`);
        return;
    }
    if (action !== 'list') throw new Error(`Ação de providers desconhecida: ${action}`);
    const broker = new FlowProviderBroker({ workspaceRoot: process.cwd(), preferredHost: options['provider-host'] });
    try {
        const catalog = await broker.catalog();
        const search = options.search?.trim().toLocaleLowerCase('pt-BR');
        const providers = search ? catalog.providers.filter(provider => `${provider.id} ${provider.name}`.toLocaleLowerCase('pt-BR').includes(search)) : catalog.providers;
        if (options.json) {
            process.stdout.write(`${JSON.stringify({ ...catalog, providers }, null, 2)}\n`);
            return;
        }
        process.stdout.write(`Providers via ${catalog.source} (${providers.length}/${catalog.providers.length})\n\n`);
        for (const provider of providers) {
            const marker = provider.connected ? '●' : '○';
            const defaultModel = provider.defaultModel ? ` · padrão ${provider.defaultModel}` : '';
            process.stdout.write(`${marker} ${provider.id} · ${provider.name} · ${provider.models.length} modelo(s)${defaultModel}\n`);
        }
        process.stdout.write('\n● conectado  ○ requer login/API key\n');
    } finally {
        await broker.stop();
    }
};

const runModelsCommand = async (remaining: string[], options: FlowStudioCliOptions): Promise<void> => {
    const requestedProvider = remaining[0] || options.provider;
    const broker = new FlowProviderBroker({ workspaceRoot: process.cwd(), preferredHost: options['provider-host'] });
    try {
        const catalog = await broker.catalog();
        const search = options.search?.trim().toLocaleLowerCase('pt-BR');
        const models = catalog.providers
            .filter(provider => !requestedProvider || provider.id === requestedProvider)
            .flatMap(provider => provider.models.map(model => ({ provider, model })))
            .filter(item => !search || `${item.model.reference} ${item.model.name} ${item.model.family || ''}`.toLocaleLowerCase('pt-BR').includes(search));
        if (requestedProvider && !catalog.providers.some(provider => provider.id === requestedProvider)) throw new Error(`Provider não encontrado: ${requestedProvider}`);
        if (options.json) {
            process.stdout.write(`${JSON.stringify({ source: catalog.source, models: models.map(item => ({ provider: item.provider.id, connected: item.provider.connected, ...item.model })) }, null, 2)}\n`);
            return;
        }
        process.stdout.write(`Modelos via ${catalog.source} (${models.length})\n\n`);
        for (const { provider, model } of models) {
            const marker = provider.connected ? '●' : '○';
            const context = model.contextWindow ? ` · contexto ${model.contextWindow.toLocaleString('pt-BR')}` : '';
            const status = model.status && model.status !== 'active' ? ` · ${model.status}` : '';
            process.stdout.write(`${marker} ${model.reference} · ${model.name}${context}${status}\n`);
        }
    } finally {
        await broker.stop();
    }
};

const collectBody = async (request: http.IncomingMessage): Promise<Record<string, unknown> | undefined> => {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        request.on('error', reject);
        request.on('data', chunk => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            size += buffer.length;
            if (size > MAX_HTTP_BODY_BYTES) {
                tooLarge = true;
                chunks.length = 0;
                return;
            }
            if (!tooLarge) chunks.push(buffer);
        });
        request.on('end', () => {
            if (tooLarge) {
                reject(new HttpStatusError(413, `Body excede ${MAX_HTTP_BODY_BYTES} bytes.`));
                return;
            }
            const data = Buffer.concat(chunks).toString('utf-8').trim();
            if (!data.length) {
                resolve(undefined);
                return;
            }
            try {
                resolve(JSON.parse(data) as Record<string, unknown>);
            } catch (error) {
                reject(error);
            }
        });
    });
};

const collectProfilesFromPayload = (payload: unknown): Record<string, FlowStudioModelProfile> => {
    if (!payload) {
        return {};
    }
    if (Array.isArray(payload) || typeof payload === 'object') {
        return normalizeProfilePayload(payload);
    }
    return {};
};

const startStudioServerV2 = async (graphPathArg: string | undefined, options: FlowStudioCliOptions): Promise<void> => {
    const port = options.port || DEFAULT_WEB_PORT;
    const host = options.host || DEFAULT_SERVE_HOST;
    const graphPath = defaultGraphPath(graphPathArg);
    const workspaceRoot = path.resolve(options.workspace || path.dirname(graphPath));
    const hostMemoryApprovals = await readMemoryApprovalOptions(options['memory-approval'], workspaceRoot);
    const allowCommands = toStringArray(options['allow-command']);
    const allowRunnerHosts = toStringArray(options['allow-runner-host']);
    if (options['allow-graph-tools'] && !allowCommands.length) throw new Error('--allow-graph-tools exige ao menos um --allow-command <pattern>.');
    const token = options.token?.trim() || randomBytes(24).toString('base64url');
    const webDirCandidates = [path.resolve(__dirname, '../web'), path.resolve(__dirname, '../src/web')];
    const webDir = webDirCandidates.find(candidate => existsSync(path.join(candidate, 'index.html')));
    if (!webDir) throw new Error(`Assets do Flow Studio não encontrados: ${webDirCandidates.join(', ')}`);
    assertInsideWorkspace(workspaceRoot, graphPath);
    await assertCanonicalInsideWorkspace(workspaceRoot, graphPath);
    if (!existsSync(graphPath)) await writeGraphFile(graphPath, createFlowStudioTemplate('Novo fluxo'));

    const staticAssets = await loadStudioAssets(webDir);
    const store = new FlowStudioFileRunStore(path.join(workspaceRoot, '.flow-studio', 'runs'));
    await store.initialize();
    const manager = new FlowStudioRunManager(store);
    await manager.recoverInterruptedRuns();
    const providerBroker = new FlowProviderBroker({ workspaceRoot, preferredHost: options['provider-host'] });
    process.once('exit', () => providerBroker.stopSync());

    const hydrateGraphProfiles = async (graph: FlowStudioGraph): Promise<{ graph: FlowStudioGraph; profiles: Record<string, FlowStudioModelProfile> }> => {
        const catalogProfiles = await readModelProfilesFromCatalog(graphPath);
        const profiles = buildModelProfileMap(parseModelProfilesFromBody(graph.modelProfiles), catalogProfiles);
        return { graph: { ...graph, modelProfiles: Object.values(profiles) }, profiles };
    };

    const buildLaunchOptions = async (graph: FlowStudioGraph, body: Record<string, unknown> | undefined): Promise<FlowStudioRunLaunchOptions> => {
        const hydrated = await hydrateGraphProfiles(graph);
        const providerAdapters = registerGraphRunnerAdapters(parseProviderAdapterOverrides(options['provider-exec'], hydrated.profiles, workspaceRoot), hydrated.graph, hydrated.profiles, workspaceRoot, options.simulate !== true, options['allow-graph-runners'] === true, allowCommands, allowRunnerHosts);
        const toolAdapters = parseToolAdapterOverrides(options['tool-exec'], workspaceRoot);
        const playbookAdapters = parsePlaybookAdapterOverrides(options['playbook-exec'], workspaceRoot);
        if (options['allow-graph-tools']) toolAdapters['*'] = createGraphCommandToolAdapter(workspaceRoot, allowCommands);
        const requestMemoryApprovals = parseMemoryApprovalPayload(body?.memoryApprovals);
        return {
            graph: hydrated.graph,
            input: isRecord(body?.input) ? body?.input : {},
            maxSteps: typeof body?.maxSteps === 'number' ? body.maxSteps : options['max-steps'],
            defaultProvider: parseProviderBinding(body?.defaultProvider as FlowStudioProviderBinding | string | undefined)
                || parseProviderModel(options.provider, options.model),
            providerAdapters,
            toolAdapters,
            playbookAdapters,
            memoryAdapter: options['memory-exec'] ? createCommandMemoryAdapter(options['memory-exec'], workspaceRoot) : createWorkspaceMemoryAdapter(workspaceRoot),
            memoryApprovals: [...hostMemoryApprovals, ...requestMemoryApprovals],
            modelProfiles: hydrated.profiles,
            workspaceRoot,
            resolveSubgraph: async ref => readGraphFile(await resolveWorkspaceFile(workspaceRoot, ref)),
            gatePolicy: parseGatePolicy(body?.gatePolicy),
            simulationMode: options.simulate === true
        };
    };

    const server = http.createServer(async (request, response) => {
        const parsed = new url.URL(request.url || '/', `http://${request.headers.host || `${host}:${port}`}`);
        const pathname = parsed.pathname;
        const method = request.method?.toUpperCase() || 'GET';
        setSecurityHeaders(response);

        try {
            if (!isTrustedOrigin(request, host, port)) return sendJson(response, 403, { ok: false, error: 'Origin não permitida.' });
            if (method === 'OPTIONS') {
                response.writeHead(204);
                response.end();
                return;
            }
            if (method === 'GET' && staticAssets.has(pathname)) {
                const asset = staticAssets.get(pathname) as { body: Buffer | string; type: string };
                response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': pathname.startsWith('/vendor/') ? 'public, max-age=31536000, immutable' : 'no-store' });
                response.end(asset.body);
                return;
            }
            if (!authorized(request, parsed, token)) return sendJson(response, 401, { ok: false, error: 'Token de sessão ausente ou inválido.' });

            if (method === 'GET' && pathname === '/api/health') return sendJson(response, 200, { status: 'ok', product: 'flow-studio-cli', version: FLOW_STUDIO_SCHEMA_VERSION, graphPath, workspaceRoot });
            if (method === 'GET' && pathname === '/api/schema') return sendJson(response, 200, FLOW_STUDIO_GRAPH_SCHEMA);
            if (method === 'GET' && pathname === '/api/template') return sendJson(response, 200, createFlowStudioTemplate(parsed.searchParams.get('name') || 'Novo fluxo'));
            if (method === 'POST' && pathname === '/api/memory/candidate-digest') {
                const body = await collectBody(request);
                const digestRequest = parseMemoryCandidateDigestRequest(body?.candidate, body?.scope);
                return sendJson(response, 200, { candidateDigest: flowStudioMemoryCandidateDigest(digestRequest.candidate, digestRequest.scope) });
            }

            if (method === 'GET' && pathname === '/api/providers') {
                return sendJson(response, 200, await providerBroker.catalog(parsed.searchParams.get('refresh') === '1'));
            }
            if (method === 'POST' && pathname === '/api/providers/profile') {
                const body = await collectBody(request);
                const providerId = typeof body?.providerId === 'string' ? body.providerId : '';
                const modelId = typeof body?.modelId === 'string' ? body.modelId : '';
                const catalog = await providerBroker.catalog();
                const provider = catalog.providers.find(item => item.id === providerId);
                const model = provider?.models.find(item => item.id === modelId || item.reference === modelId);
                if (!provider || !model) return sendJson(response, 404, { ok: false, error: 'Provider ou modelo não encontrado no catálogo.' });
                const profileSource = provider.connectedSources?.includes('flow')
                    ? 'flow'
                    : provider.connectedSources?.find(source => source === 'cybervinci' || source === 'opencode') || 'flow';
                return sendJson(response, 200, { ok: true, profile: catalogModelProfile(profileSource, provider, model) });
            }
            const providerRoute = pathname.match(/^\/api\/providers\/([a-zA-Z0-9._-]+)\/(api-key|auth|oauth\/authorize|oauth\/callback)$/);
            if (providerRoute) {
                const providerId = decodeURIComponent(providerRoute[1]);
                const action = providerRoute[2];
                if (method === 'POST' && action === 'api-key') {
                    const body = await collectBody(request);
                    const metadata = isRecord(body?.metadata) ? Object.fromEntries(Object.entries(body.metadata).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : undefined;
                    await providerBroker.setApiKey(providerId, typeof body?.key === 'string' ? body.key : '', metadata);
                    return sendJson(response, 200, { ok: true, providerId, connected: true });
                }
                if (method === 'DELETE' && action === 'auth') {
                    await providerBroker.disconnect(providerId);
                    return sendJson(response, 200, { ok: true, providerId, connected: false });
                }
                if (method === 'POST' && action === 'oauth/authorize') {
                    const body = await collectBody(request);
                    const inputs = isRecord(body?.inputs) ? Object.fromEntries(Object.entries(body.inputs).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : undefined;
                    const authorization = await providerBroker.authorize(providerId, Number(body?.method), inputs);
                    return sendJson(response, 200, { ok: true, providerId, authorization: authorization || null });
                }
                if (method === 'POST' && action === 'oauth/callback') {
                    const body = await collectBody(request);
                    await providerBroker.callback(providerId, Number(body?.method), typeof body?.code === 'string' ? body.code : undefined);
                    return sendJson(response, 200, { ok: true, providerId, connected: true });
                }
            }

            if (method === 'GET' && pathname === '/api/graph') {
                const resolved = await resolveWorkspaceFile(workspaceRoot, parsed.searchParams.get('path') || graphPath);
                return sendJson(response, 200, { file: resolved, graph: await readGraphFile(resolved) });
            }
            if (method === 'POST' && pathname === '/api/graph') {
                const body = await collectBody(request);
                const graph = body?.graph as FlowStudioGraph | undefined;
                if (!graph) return sendJson(response, 400, { ok: false, error: 'body deve conter graph.' });
                const validation = validateFlowStudioGraph((await hydrateGraphProfiles(graph)).graph);
                if (!validation.valid) return sendJson(response, 400, validation);
                const target = await resolveWorkspaceFile(workspaceRoot, typeof body?.path === 'string' ? body.path : graphPath);
                await writeGraphFile(target, graph);
                return sendJson(response, 200, { ok: true, file: target, validation });
            }
            if (method === 'POST' && pathname === '/api/validate') {
                const body = await collectBody(request);
                const graph = (body?.graph || body) as FlowStudioGraph;
                const validation = validateFlowStudioGraph((await hydrateGraphProfiles(graph)).graph);
                return sendJson(response, validation.valid ? 200 : 400, validation);
            }

            if (method === 'GET' && pathname === '/api/profiles') {
                const graph = await readGraphFile(graphPath);
                const { profiles } = await hydrateGraphProfiles(graph);
                return sendJson(response, 200, { path: resolveModelProfileCatalogPath(graphPath), profiles: Object.values(profiles) });
            }
            if (method === 'POST' && pathname === '/api/profiles') {
                const body = await collectBody(request);
                const profiles = collectProfilesFromPayload(body?.profiles);
                const file = await writeModelProfilesToCatalog(graphPath, profiles);
                return sendJson(response, 200, { ok: true, file, count: Object.keys(profiles).length });
            }

            if (method === 'POST' && pathname === '/api/author') {
                const body = await collectBody(request);
                const instruction = typeof body?.instruction === 'string' ? body.instruction : '';
                if (!instruction.trim()) return sendJson(response, 400, { ok: false, error: 'instruction é obrigatória.' });
                const currentGraph = isRecord(body?.currentGraph) ? body?.currentGraph as unknown as FlowStudioGraph : undefined;
                const hydrated = await hydrateGraphProfiles(currentGraph || await readGraphFile(graphPath));
                const requestedProfile = typeof body?.profileId === 'string' ? hydrated.profiles[body.profileId] : undefined;
                const adapter = resolveAuthorAdapter(workspaceRoot, requestedProfile, options['author-exec']);
                if (!adapter) return sendJson(response, 409, { ok: false, error: 'Nenhum autor disponível. Instale Codex/OpenCode CLI ou configure um comando no perfil.' });
                const authoringGraph = currentGraph || hydrated.graph;
                const result = await authorFlowStudioGraph({
                    instruction,
                    currentGraph,
                    availableRunners: authoringGraph.runners,
                    availableModels: Object.values(hydrated.profiles),
                    availableTools: uniqueById(authoringGraph.nodes.flatMap(node => node.tools || []), hostToolCatalog(options['tool-exec'])),
                    availablePlaybooks: hostPlaybookCatalog(options['playbook-exec']),
                    constraints: Array.isArray(body?.constraints) ? body?.constraints.filter((item): item is string => typeof item === 'string') : undefined
                }, adapter);
                return sendJson(response, 200, { ok: true, ...result });
            }

            if (method === 'POST' && pathname === '/api/run') {
                const body = await collectBody(request);
                const graph = body?.graph as FlowStudioGraph | undefined;
                if (!graph) return sendJson(response, 400, { ok: false, error: 'body deve conter graph.' });
                const record = await manager.runAndWait(await buildLaunchOptions(graph, body));
                return sendJson(response, record.status === 'failed' ? 500 : 200, { ok: record.status === 'completed' || record.status === 'waiting', run: record, result: record.result, events: record.events });
            }
            if (method === 'POST' && pathname === '/api/runs') {
                const body = await collectBody(request);
                const graph = body?.graph as FlowStudioGraph | undefined;
                if (!graph) return sendJson(response, 400, { ok: false, error: 'body deve conter graph.' });
                const record = await manager.start(await buildLaunchOptions(graph, body));
                return sendJson(response, 202, { ok: true, run: record });
            }
            if (method === 'GET' && pathname === '/api/runs') return sendJson(response, 200, { runs: await manager.list(Number(parsed.searchParams.get('limit') || 50)) });
            if (method === 'GET' && pathname === '/api/runs/compare') {
                const leftId = parsed.searchParams.get('left');
                const rightId = parsed.searchParams.get('right');
                if (!leftId || !rightId) return sendJson(response, 400, { ok: false, error: 'left e right são obrigatórios.' });
                return sendJson(response, 200, { ok: true, comparison: compareRunRecords(await manager.status(leftId), await manager.status(rightId)) });
            }

            const runRoute = pathname.match(/^\/api\/runs\/([a-zA-Z0-9:_-]+)(?:\/(events|cancel|resume|replay))?$/);
            if (runRoute) {
                const runId = runRoute[1];
                const action = runRoute[2];
                if (method === 'GET' && !action) return sendJson(response, 200, { run: await manager.status(runId) });
                if (method === 'GET' && action === 'events') return streamRunEvents(request, response, manager, runId, Number(parsed.searchParams.get('cursor') || 0));
                if (method === 'POST' && action === 'cancel') {
                    const cancelled = manager.cancel(runId);
                    return sendJson(response, cancelled ? 202 : 409, { ok: cancelled, runId });
                }
                if (method === 'POST' && (action === 'resume' || action === 'replay')) {
                    const body = await collectBody(request);
                    const source = await manager.status(runId);
                    const launch = await buildLaunchOptions(source.graph, { input: source.input, memoryApprovals: body?.memoryApprovals });
                    const gate = parseHumanGatePayload(body?.gate);
                    const record = action === 'replay'
                        ? await manager.replay(runId, typeof body?.checkpointId === 'string' ? body.checkpointId : undefined, launch)
                        : await manager.resume(runId, {
                            ...launch,
                            checkpointId: typeof body?.checkpointId === 'string' ? body.checkpointId : undefined,
                            gate,
                            resumeSignal: isRecord(body?.signal) ? body.signal : undefined,
                            fork: body?.fork === true
                        });
                    return sendJson(response, 202, { ok: true, run: record });
                }
            }

            return sendJson(response, 404, { ok: false, error: `Rota não encontrada: ${pathname}` });
        } catch (error) {
            const status = error instanceof HttpStatusError
                ? error.status
                : error instanceof FlowStudioRunRequestError
                    ? 400
                    : error instanceof FlowStudioRunConflictError ? 409 : 500;
            return sendJson(response, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
    });
    const publicUrl = `http://${host}:${port}/?token=${encodeURIComponent(token)}`;
    process.stdout.write(chalk.green(`Flow Studio server em ${publicUrl}\n`));
    process.stdout.write(chalk.gray(`Workspace: ${workspaceRoot}\n`));
};

const loadStudioAssets = async (webDir: string): Promise<Map<string, { body: Buffer | string; type: string }>> => {
    const assets = new Map<string, { body: Buffer | string; type: string }>();
    assets.set('/', { body: await fs.readFile(path.join(webDir, 'index.html'), 'utf-8'), type: 'text/html; charset=utf-8' });
    assets.set('/studio.css', { body: await fs.readFile(path.join(webDir, 'studio.css')), type: 'text/css; charset=utf-8' });
    assets.set('/studio.js', { body: await fs.readFile(path.join(webDir, 'studio.js')), type: 'text/javascript; charset=utf-8' });
    const packages: Array<[string, string, string, string]> = [
        ['/vendor/react.js', 'react', 'umd/react.production.min.js', 'text/javascript; charset=utf-8'],
        ['/vendor/react-dom.js', 'react-dom', 'umd/react-dom.production.min.js', 'text/javascript; charset=utf-8'],
        ['/vendor/reactflow.js', 'reactflow', 'dist/umd/index.js', 'text/javascript; charset=utf-8'],
        ['/vendor/reactflow.css', 'reactflow', 'dist/style.css', 'text/css; charset=utf-8']
    ];
    for (const [route, packageName, relative, type] of packages) {
        const resolvedEntry = require.resolve(packageName);
        const packageRoot = packageName === 'reactflow'
            ? path.resolve(path.dirname(resolvedEntry), '..', '..')
            : path.dirname(resolvedEntry);
        assets.set(route, { body: await fs.readFile(path.join(packageRoot, relative)), type });
    }
    return assets;
};

const sendJson = (response: http.ServerResponse, status: number, payload: unknown): void => {
    if (response.headersSent) return;
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(payload));
};

const setSecurityHeaders = (response: http.ServerResponse): void => {
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self' http://127.0.0.1:* http://localhost:*");
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
};

const isTrustedOrigin = (request: http.IncomingMessage, host: string, port: number): boolean => {
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
        const parsed = new URL(origin);
        return (parsed.hostname === host || (['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) && ['127.0.0.1', 'localhost', '::1'].includes(host))) && Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)) === port;
    } catch {
        return false;
    }
};

const authorized = (request: http.IncomingMessage, parsed: URL, token: string): boolean => {
    const header = request.headers['x-flow-studio-token'];
    return parsed.searchParams.get('token') === token || (typeof header === 'string' && header === token);
};

const assertInsideWorkspace = (workspaceRoot: string, candidate: string): void => {
    const relative = path.relative(path.resolve(workspaceRoot), path.resolve(candidate));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Caminho fora do workspace: ${candidate}`);
};

const resolveWorkspaceFile = async (workspaceRoot: string, candidate: string): Promise<string> => {
    const resolved = path.resolve(workspaceRoot, candidate);
    assertInsideWorkspace(workspaceRoot, resolved);
    await assertCanonicalInsideWorkspace(workspaceRoot, resolved);
    return resolved;
};

class HttpStatusError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
}

const assertCanonicalInsideWorkspace = async (workspaceRoot: string, candidate: string): Promise<void> => {
    const root = await fs.realpath(path.resolve(workspaceRoot));
    let probe = path.resolve(candidate);
    while (!existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
    }
    const canonicalExisting = await fs.realpath(probe);
    const relativeTail = path.relative(probe, path.resolve(candidate));
    const canonicalCandidate = path.resolve(canonicalExisting, relativeTail);
    const relative = path.relative(root, canonicalCandidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new HttpStatusError(403, `Caminho canônico fora do workspace: ${candidate}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const compareRunRecords = (left: FlowStudioRunRecord, right: FlowStudioRunRecord): Record<string, unknown> => {
    const leftResult = left.result;
    const rightResult = right.result;
    const leftUsage = leftResult?.usage || { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };
    const rightUsage = rightResult?.usage || { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };
    const delta = Object.fromEntries(Object.keys(leftUsage).map(key => [key, Number(rightUsage[key as keyof typeof rightUsage] || 0) - Number(leftUsage[key as keyof typeof leftUsage] || 0)]));
    const leftVisited = new Set(leftResult?.visited || []);
    const rightVisited = new Set(rightResult?.visited || []);
    const leftContext = leftResult?.finalContext || {};
    const rightContext = rightResult?.finalContext || {};
    const contextKeys = [...new Set([...Object.keys(leftContext), ...Object.keys(rightContext)])];
    return {
        left: { runId: left.id, status: left.status, usage: leftUsage, events: left.events.length, checkpoints: left.checkpoints.length, effects: left.effects.length },
        right: { runId: right.id, status: right.status, usage: rightUsage, events: right.events.length, checkpoints: right.checkpoints.length, effects: right.effects.length },
        delta,
        visited: {
            onlyLeft: [...leftVisited].filter(nodeId => !rightVisited.has(nodeId)),
            onlyRight: [...rightVisited].filter(nodeId => !leftVisited.has(nodeId))
        },
        changedContextKeys: contextKeys.filter(key => JSON.stringify(leftContext[key]) !== JSON.stringify(rightContext[key]))
    };
};

const streamRunEvents = async (request: http.IncomingMessage, response: http.ServerResponse, manager: FlowStudioRunManager, runId: string, initialCursor: number): Promise<void> => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    let cursor = Math.max(0, initialCursor);
    let closed = false;
    request.once('close', () => { closed = true; });
    while (!closed) {
        const record = await manager.status(runId);
        for (; cursor < record.events.length; cursor += 1) response.write(`id: ${cursor + 1}\nevent: flow\ndata: ${JSON.stringify(record.events[cursor])}\n\n`);
        if (record.status !== 'running') {
            response.write(`event: done\ndata: ${JSON.stringify({ status: record.status, cursor })}\n\n`);
            response.end();
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
};

const startStudioServer = startStudioServerV2;
const printUsage = (): void => {
    process.stdout.write(`
Uso:
  flow template [nome] [arquivo]
  flow validate <arquivo>
  flow providers [list|login|logout] [provider] [--source <flow|cybervinci|opencode>] [--method <nome>] [--api-key-stdin | --api-key-env <variavel>] [--base-url <url>] [--headers <json>] [--protocol <auto|openai|anthropic|google>] [--search <texto>] [--json]
  flow models [provider] [--source <flow|cybervinci|opencode>] [--search <texto>] [--json]
  flow author <pedido> [arquivo] [--profile <id>] [--author-exec <comando>] [--tool-exec <toolId=cmd>] [--playbook-exec <playbookId=cmd>]
  flow run <arquivo> [--input <json|@arquivo>] [--provider <provider>] [--model <provider/model>] [--reasoning <none|low|medium|high|xhigh>] [--provider-exec <provider[:model]=cmd>] [--tool-exec <toolId=cmd>] [--playbook-exec <playbookId=cmd>] [--memory-exec <comando>] [--memory-approval <json|@arquivo>] [--allow-graph-tools --allow-command <pattern>] [--allow-graph-runners --allow-command <pattern> --allow-runner-host <host>] [--max-steps <numero>] [--watch] [--simulate]
  flow serve [arquivo] [--host <host>] [--port <porta>] [--workspace <pasta>] [--token <token>] [--provider-host <flow|cybervinci|opencode>] [--author-exec <comando>] [--playbook-exec <playbookId=cmd>] [--memory-exec <comando>] [--memory-approval <json|@arquivo>] [--allow-graph-tools --allow-command <pattern>] [--allow-graph-runners --allow-command <pattern> --allow-runner-host <host>] [--simulate]
  flow tui [arquivo] [as mesmas opcoes de host de run/serve]
`);
};

const extractOptions = (args: ParsedArgs): FlowStudioCliOptions => {
    const providerExec = toStringArrayOption(args, 'provider-exec');
    const toolExec = toStringArrayOption(args, 'tool-exec');
    const playbookExec = toStringArrayOption(args, 'playbook-exec');
    const memoryApprovals = toStringArrayOption(args, 'memory-approval');
    const allowCommands = toStringArrayOption(args, 'allow-command');
    const allowRunnerHosts = toStringArrayOption(args, 'allow-runner-host');
    const result: FlowStudioCliOptions = {
        name: toStringOption(args, 'name'),
        file: args._[0],
        input: toStringOption(args, 'input'),
        provider: toStringOption(args, 'provider') || toStringOption(args, 'p'),
        model: toStringOption(args, 'model') || toStringOption(args, 'm'),
        profile: toStringOption(args, 'profile'),
        reasoning: toStringOption(args, 'reasoning') as FlowStudioReasoningEffort | undefined,
        host: toStringOption(args, 'host'),
        port: toNumberOption(args, 'port') || toNumberOption(args, 'P'),
        watch: args.watch === true,
        'max-steps': toNumberOption(args, 'max-steps'),
        'provider-exec': providerExec.length === 1 ? providerExec[0] : providerExec.length ? providerExec : undefined,
        'tool-exec': toolExec.length === 1 ? toolExec[0] : toolExec.length ? toolExec : undefined
        , 'playbook-exec': playbookExec.length === 1 ? playbookExec[0] : playbookExec.length ? playbookExec : undefined
        , 'memory-exec': toStringOption(args, 'memory-exec')
        , 'memory-approval': memoryApprovals.length === 1 ? memoryApprovals[0] : memoryApprovals.length ? memoryApprovals : undefined
        , 'author-exec': toStringOption(args, 'author-exec')
        , token: toStringOption(args, 'token')
        , workspace: toStringOption(args, 'workspace')
        , simulate: args.simulate === true
        , 'allow-graph-tools': args['allow-graph-tools'] === true
        , 'allow-graph-runners': args['allow-graph-runners'] === true
        , 'allow-command': allowCommands.length === 1 ? allowCommands[0] : allowCommands.length ? allowCommands : undefined
        , 'allow-runner-host': allowRunnerHosts.length === 1 ? allowRunnerHosts[0] : allowRunnerHosts.length ? allowRunnerHosts : undefined
        , out: toStringOption(args, 'out')
        , json: args.json === true
        , search: toStringOption(args, 'search')
        , method: toStringOption(args, 'method')
        , 'api-key-stdin': args['api-key-stdin'] === true
        , 'api-key-env': toStringOption(args, 'api-key-env')
        , 'base-url': toStringOption(args, 'base-url')
        , headers: toStringOption(args, 'headers')
        , protocol: toStringOption(args, 'protocol')
        , 'provider-host': providerHostOption(toStringOption(args, 'provider-host') || toStringOption(args, 'source'))
    };
    return result;
};

export async function createFlowStudioCli(argv: string[]): Promise<void> {
    const args = parseArgs(argv);
    if (args.help === true || args._.includes('--help')) {
        printUsage();
        return;
    }
    if (args.version === true) {
        process.stdout.write('flow 1.74.0\n');
        return;
    }

    const command = args._[0]?.toLowerCase();
    const remaining = args._.slice(1);
    const options = extractOptions(args);
    const fallbackPath = options.file;

    switch (command) {
        case 'template': {
            const [name, file] = [remaining[0], remaining[1]];
            await runTemplateCommand(args, { name, file });
            break;
        }
        case 'validate': {
            const file = remaining[0] ?? fallbackPath;
            if (!file) {
                throw new Error('validate exige <arquivo>.');
            }
            await runValidateCommand(file);
            break;
        }
        case 'providers':
            await runProvidersCommand(remaining, options);
            break;
        case 'models':
            await runModelsCommand(remaining, options);
            break;
        case 'author': {
            const instruction = remaining[0];
            if (!instruction) throw new Error('author exige <pedido>.');
            const file = options.out || remaining[1] || defaultGraphPath();
            await runAuthorCommand(instruction, file, options);
            break;
        }
        case 'run': {
            const file = remaining[0] ?? fallbackPath;
            if (!file) {
                throw new Error('run exige <arquivo>.');
            }
            await handleRunCommand(file, {
                input: options.input,
                provider: options.provider,
                model: options.model,
                reasoning: options.reasoning,
                'provider-exec': options['provider-exec'],
                'tool-exec': options['tool-exec'],
                'playbook-exec': options['playbook-exec'],
                'memory-exec': options['memory-exec'],
                'memory-approval': options['memory-approval'],
                'allow-graph-tools': options['allow-graph-tools'],
                'allow-graph-runners': options['allow-graph-runners'],
                'allow-command': options['allow-command'],
                'allow-runner-host': options['allow-runner-host'],
                'max-steps': options['max-steps'],
                watch: options.watch,
                simulate: options.simulate
            });
            break;
        }
        case 'serve': {
            const file = remaining[0] ?? fallbackPath;
            await startStudioServer(file, {
                file: fallbackPath,
                host: options.host,
                port: options.port,
                workspace: options.workspace,
                token: options.token,
                provider: options.provider,
                model: options.model,
                reasoning: options.reasoning,
                'provider-exec': options['provider-exec'],
                'tool-exec': options['tool-exec'],
                'playbook-exec': options['playbook-exec'],
                'memory-exec': options['memory-exec'],
                'memory-approval': options['memory-approval'],
                'allow-graph-tools': options['allow-graph-tools'],
                'allow-graph-runners': options['allow-graph-runners'],
                'allow-command': options['allow-command'],
                'allow-runner-host': options['allow-runner-host'],
                'author-exec': options['author-exec'],
                'max-steps': options['max-steps'],
                'provider-host': options['provider-host'],
                simulate: options.simulate
            });
            break;
        }
        case 'tui':
            await runFlowStudioTui(remaining[0] ?? fallbackPath, options);
            break;
        default:
            if (!command) {
                printUsage();
                return;
            }
            throw new Error(`Comando desconhecido: ${command}`);
    }
}
