import { randomBytes } from 'node:crypto';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type {
    FlowStudioAuthorResult,
    FlowStudioContext,
    FlowStudioGateResult,
    FlowStudioGraph,
    FlowStudioMemoryApproval,
    FlowStudioValidationResult
} from '@cybervinci/flow-shared';

export interface FlowStudioControllerOptions {
    host?: string;
    port?: number;
    workspace?: string;
    token?: string;
    provider?: string;
    model?: string;
    providerHost?: 'flow' | 'cybervinci' | 'opencode';
    providerExec?: string[];
    toolExec?: string[];
    playbookExec?: string[];
    memoryExec?: string;
    allowGraphTools?: boolean;
    allowGraphRunners?: boolean;
    allowCommands?: string[];
    allowRunnerHosts?: string[];
    authorExec?: string;
    maxSteps?: number;
    simulate?: boolean;
    openBrowser?: boolean;
    signal?: AbortSignal;
}

export interface FlowStudioRunOptions {
    maxSteps?: number;
    defaultProvider?: Record<string, unknown>;
    gatePolicy?: Record<string, unknown>;
    /** Host-trusted immutable approval receipts; intentionally not exposed by the OpenCode agent tool. */
    memoryApprovals?: FlowStudioMemoryApproval[];
}

export interface FlowStudioSession {
    baseUrl: string;
    studioUrl: string;
    token: string;
    host: string;
    port: number;
    graphFile: string;
    workspace: string;
    pid: number;
    process: ChildProcess;
    stop(): Promise<void>;
}

export interface FlowStudioRunRecord {
    id: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting';
    graph: FlowStudioGraph;
    input: FlowStudioContext;
    events: unknown[];
    checkpoints: unknown[];
    effects: unknown[];
    result?: unknown;
    error?: string;
}

const DEFAULT_HOST = '127.0.0.1';
const STARTUP_TIMEOUT_MS = 20_000;

export class FlowStudioController {
    protected session?: FlowStudioSession;

    get activeSession(): FlowStudioSession | undefined {
        return this.session;
    }

    async start(graphFile: string, options: FlowStudioControllerOptions = {}): Promise<FlowStudioSession> {
        if (this.session && this.session.process.exitCode === null) return this.session;
        const graph = path.resolve(graphFile);
        const workspace = path.resolve(options.workspace || path.dirname(graph));
        assertInsideWorkspace(workspace, graph);
        const host = options.host || DEFAULT_HOST;
        if (!isLoopback(host)) throw new Error('O controlador OpenCode só inicia o Studio em loopback.');
        const port = options.port || await reservePort(host);
        const token = options.token || randomBytes(24).toString('base64url');
        const cliScript = createRequire(import.meta.url).resolve('@cybervinci/flow/lib/index.js');
        const args = [cliScript, 'serve', graph, '--host', host, '--port', String(port), '--workspace', workspace, '--token', token];
        appendOption(args, '--provider', options.provider);
        appendOption(args, '--model', options.model);
        appendOption(args, '--provider-host', options.providerHost);
        appendOption(args, '--author-exec', options.authorExec);
        appendOption(args, '--memory-exec', options.memoryExec);
        appendOption(args, '--max-steps', options.maxSteps);
        for (const value of options.providerExec || []) appendOption(args, '--provider-exec', value);
        for (const value of options.toolExec || []) appendOption(args, '--tool-exec', value);
        for (const value of options.playbookExec || []) appendOption(args, '--playbook-exec', value);
        for (const value of options.allowCommands || []) appendOption(args, '--allow-command', value);
        for (const value of options.allowRunnerHosts || []) appendOption(args, '--allow-runner-host', value);
        if (options.allowGraphTools) args.push('--allow-graph-tools');
        if (options.allowGraphRunners) args.push('--allow-graph-runners');
        if (options.simulate) args.push('--simulate');

        const child = spawn(process.execPath, args, {
            cwd: workspace,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        if (!child.pid) throw new Error('Não foi possível iniciar o Flow Studio CLI.');
        let stderr = '';
        child.stderr?.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-16_384); });
        const baseUrl = `http://${host}:${port}`;
        try {
            await waitForHealth(baseUrl, token, child, () => stderr, options.signal);
        } catch (error) {
            await stopChild(child);
            throw error;
        }

        const session: FlowStudioSession = {
            baseUrl,
            studioUrl: `${baseUrl}/?token=${encodeURIComponent(token)}`,
            token,
            host,
            port,
            graphFile: graph,
            workspace,
            pid: child.pid,
            process: child,
            stop: () => stopChild(child)
        };
        child.once('exit', () => { if (this.session === session) this.session = undefined; });
        this.session = session;
        if (options.openBrowser) openBrowser(session.studioUrl);
        return session;
    }

    async stop(): Promise<void> {
        const current = this.session;
        this.session = undefined;
        if (current) await current.stop();
    }

    async health(signal?: AbortSignal): Promise<Record<string, unknown>> { return this.request('GET', '/api/health', undefined, false, signal); }
    async schema(signal?: AbortSignal): Promise<Record<string, unknown>> { return this.request('GET', '/api/schema', undefined, false, signal); }
    async loadGraph(file?: string, signal?: AbortSignal): Promise<{ file: string; graph: FlowStudioGraph }> {
        return this.request('GET', `/api/graph${file ? `?path=${encodeURIComponent(file)}` : ''}`, undefined, false, signal);
    }
    async saveGraph(graph: FlowStudioGraph, file?: string, signal?: AbortSignal): Promise<{ ok: boolean; file: string; validation: FlowStudioValidationResult }> {
        return this.request('POST', '/api/graph', { graph, path: file }, false, signal);
    }
    async validate(graph: FlowStudioGraph, signal?: AbortSignal): Promise<FlowStudioValidationResult> {
        return this.request('POST', '/api/validate', { graph }, true, signal);
    }
    async profiles(signal?: AbortSignal): Promise<{ profiles: unknown[]; path: string }> { return this.request('GET', '/api/profiles', undefined, false, signal); }
    async saveProfiles(profiles: unknown[], signal?: AbortSignal): Promise<Record<string, unknown>> { return this.request('POST', '/api/profiles', { profiles }, false, signal); }
    async author(instruction: string, currentGraph?: FlowStudioGraph, profileId?: string, constraints?: string[], signal?: AbortSignal): Promise<FlowStudioAuthorResult & { ok: boolean }> {
        return this.request('POST', '/api/author', { instruction, currentGraph, profileId, constraints }, false, signal);
    }
    async run(graph: FlowStudioGraph, input: FlowStudioContext = {}, options: FlowStudioRunOptions = {}, signal?: AbortSignal): Promise<{ ok: boolean; run: FlowStudioRunRecord }> {
        return this.request('POST', '/api/run', { graph, input, ...options }, false, signal);
    }
    async startRun(graph: FlowStudioGraph, input: FlowStudioContext = {}, options: FlowStudioRunOptions = {}, signal?: AbortSignal): Promise<{ ok: boolean; run: FlowStudioRunRecord }> {
        return this.request('POST', '/api/runs', { graph, input, ...options }, false, signal);
    }
    async listRuns(limit = 50, signal?: AbortSignal): Promise<{ runs: FlowStudioRunRecord[] }> { return this.request('GET', `/api/runs?limit=${Math.max(1, Math.min(limit, 500))}`, undefined, false, signal); }
    async status(runId: string, signal?: AbortSignal): Promise<{ run: FlowStudioRunRecord }> { return this.request('GET', `/api/runs/${encodeURIComponent(runId)}`, undefined, false, signal); }
    async compare(leftRunId: string, rightRunId: string, signal?: AbortSignal): Promise<{ ok: boolean; comparison: Record<string, unknown> }> {
        return this.request('GET', `/api/runs/compare?left=${encodeURIComponent(leftRunId)}&right=${encodeURIComponent(rightRunId)}`, undefined, false, signal);
    }
    async cancel(runId: string, signal?: AbortSignal): Promise<{ ok: boolean; runId: string }> { return this.request('POST', `/api/runs/${encodeURIComponent(runId)}/cancel`, {}, false, signal); }
    async resume(runId: string, options: { checkpointId?: string; gate?: FlowStudioGateResult; signal?: Record<string, unknown>; fork?: boolean; memoryApprovals?: FlowStudioMemoryApproval[] }, signal?: AbortSignal): Promise<{ ok: boolean; run: FlowStudioRunRecord }> {
        return this.request('POST', `/api/runs/${encodeURIComponent(runId)}/resume`, options, false, signal);
    }
    async replay(runId: string, checkpointId?: string, signal?: AbortSignal): Promise<{ ok: boolean; run: FlowStudioRunRecord }> {
        return this.request('POST', `/api/runs/${encodeURIComponent(runId)}/replay`, { checkpointId }, false, signal);
    }
    open(): void { openBrowser(this.requireSession().studioUrl); }

    protected async request<T>(method: string, route: string, body?: unknown, acceptValidationError = false, signal?: AbortSignal): Promise<T> {
        const session = this.requireSession();
        const response = await fetch(`${session.baseUrl}${route}`, {
            method,
            headers: { 'Content-Type': 'application/json', 'X-Flow-Studio-Token': session.token },
            body: method === 'GET' ? undefined : JSON.stringify(body || {}),
            signal
        });
        const payload = await response.json().catch(() => ({})) as T & {
            error?: string;
            run?: { error?: string; result?: { error?: string; statusMessage?: string } };
            result?: { error?: string; statusMessage?: string };
        };
        if (!response.ok && !(acceptValidationError && response.status === 400)) {
            throw new Error(payload.error
                || payload.run?.error
                || payload.run?.result?.error
                || payload.run?.result?.statusMessage
                || payload.result?.error
                || payload.result?.statusMessage
                || `Flow Studio respondeu HTTP ${response.status}.`);
        }
        return payload;
    }

    protected requireSession(): FlowStudioSession {
        if (!this.session || this.session.process.exitCode !== null) throw new Error('Nenhuma sessão Flow Studio ativa. Inicie com start().');
        return this.session;
    }
}

export async function executeParsedArgs(argv: string[]): Promise<number> {
    const parsed = parseArgs(argv);
    const command = parsed.positionals[0]?.toLowerCase();
    if (!command || command === 'help' || parsed.flags.has('help')) {
        printUsage();
        return 0;
    }

    if (['template', 'validate', 'run', 'author', 'tui'].includes(command)) return forwardToCli(argv);

    const file = parsed.positionals[1] || parsed.values.get('file') || defaultGraphFile();
    const controller = new FlowStudioController();
    const options: FlowStudioControllerOptions = {
        host: parsed.values.get('host'),
        port: numberValue(parsed.values.get('port')),
        workspace: parsed.values.get('workspace'),
        token: parsed.values.get('token'),
        provider: parsed.values.get('provider'),
        model: parsed.values.get('model'),
        providerHost: providerHostValue(parsed.values.get('provider-host') || parsed.values.get('source')),
        providerExec: parsed.multi.get('provider-exec'),
        toolExec: parsed.multi.get('tool-exec'),
        playbookExec: parsed.multi.get('playbook-exec'),
        memoryExec: parsed.values.get('memory-exec'),
        allowGraphTools: parsed.flags.has('allow-graph-tools'),
        allowGraphRunners: parsed.flags.has('allow-graph-runners'),
        allowCommands: parsed.multi.get('allow-command'),
        allowRunnerHosts: parsed.multi.get('allow-runner-host'),
        authorExec: parsed.values.get('author-exec'),
        maxSteps: numberValue(parsed.values.get('max-steps')),
        simulate: parsed.flags.has('simulate'),
        openBrowser: command === 'open' || parsed.flags.has('open')
    };

    if (command !== 'serve' && command !== 'open') throw new Error(`Comando desconhecido: ${command}`);
    const session = await controller.start(file, options);
    process.stdout.write(`${JSON.stringify({ ok: true, url: session.studioUrl, pid: session.pid, file: session.graphFile }, null, 2)}\n`);
    await new Promise<void>((resolve, reject) => {
        session.process.once('exit', code => code === 0 || code === null ? resolve() : reject(new Error(`Flow Studio encerrou com código ${code}.`)));
        session.process.once('error', reject);
        process.once('SIGINT', () => { void session.stop().finally(resolve); });
        process.once('SIGTERM', () => { void session.stop().finally(resolve); });
    });
    return 0;
}

function parseArgs(argv: string[]): { positionals: string[]; values: Map<string, string>; multi: Map<string, string[]>; flags: Set<string> } {
    const positionals: string[] = [];
    const values = new Map<string, string>();
    const multi = new Map<string, string[]>();
    const flags = new Set<string>();
    const repeatable = new Set(['provider-exec', 'tool-exec', 'playbook-exec', 'allow-command', 'allow-runner-host']);
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) { positionals.push(token); continue; }
        const [rawKey, inline] = token.slice(2).split('=', 2);
        const next = inline ?? (argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : undefined);
        if (next === undefined) { flags.add(rawKey); continue; }
        values.set(rawKey, next);
        if (repeatable.has(rawKey)) multi.set(rawKey, [...(multi.get(rawKey) || []), next]);
    }
    return { positionals, values, multi, flags };
}

function forwardToCli(argv: string[]): number {
    const cliScript = createRequire(import.meta.url).resolve('@cybervinci/flow/lib/index.js');
    const result = spawnSync(process.execPath, [cliScript, ...argv], { stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    return result.status ?? 1;
}

function appendOption(args: string[], key: string, value: string | number | undefined): void {
    if (value !== undefined && String(value).trim()) args.push(key, String(value));
}

async function reservePort(host: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, host, () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            server.close(error => error ? reject(error) : resolve(port));
        });
    });
}

async function waitForHealth(baseUrl: string, token: string, child: ChildProcess, readStderr: () => string, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error('Inicialização do Flow Studio cancelada.');
        if (child.exitCode !== null) throw new Error(`Flow Studio encerrou durante a inicialização. ${readStderr()}`.trim());
        try {
            const response = await fetch(`${baseUrl}/api/health`, { headers: { 'X-Flow-Studio-Token': token }, signal });
            if (response.ok) return;
        } catch { /* servidor ainda inicializando */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Flow Studio não respondeu em ${baseUrl}. ${readStderr()}`.trim());
}

async function stopChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await waitForChildExit(child, 3_000);
    if (child.exitCode === null) {
        child.kill('SIGKILL');
        await waitForChildExit(child, 1_000);
    }
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
    if (child.exitCode !== null) return;
    await Promise.race([
        new Promise<void>(resolve => child.once('exit', () => resolve())),
        new Promise<void>(resolve => setTimeout(resolve, timeoutMs))
    ]);
}

function openBrowser(target: string): void {
    let executable: string;
    let args: string[];
    if (process.platform === 'win32') {
        executable = 'rundll32.exe';
        args = ['url.dll,FileProtocolHandler', target];
    } else if (process.platform === 'darwin') {
        executable = 'open';
        args = [target];
    } else {
        executable = 'xdg-open';
        args = [target];
    }
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
}

function isLoopback(host: string): boolean { return ['127.0.0.1', 'localhost', '::1'].includes(host); }

function assertInsideWorkspace(workspace: string, candidate: string): void {
    const relative = path.relative(path.resolve(workspace), path.resolve(candidate));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Arquivo fora do workspace: ${candidate}`);
}

function numberValue(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const result = Number(value);
    if (!Number.isFinite(result)) throw new Error(`Número inválido: ${value}`);
    return result;
}

function providerHostValue(value: string | undefined): 'flow' | 'cybervinci' | 'opencode' | undefined {
    if (!value) return undefined;
    if (value === 'flow' || value === 'cybervinci' || value === 'opencode') return value;
    throw new Error(`Provider host inválido: ${value}`);
}

function defaultGraphFile(): string {
    const preferred = path.resolve('flow.graph.json');
    const legacy = path.resolve('flow-studio.graph.json');
    return existsSync(preferred) || !existsSync(legacy) ? preferred : legacy;
}

function printUsage(): void {
    process.stdout.write(`Flow Controller para CyberVinci/OpenCode\n\n`);
    process.stdout.write(`  flow-controller open <grafo> [--workspace <pasta>] [--provider-exec chave=comando] [--playbook-exec id=comando] [--memory-exec comando]\n`);
    process.stdout.write(`  flow-controller serve <grafo> [--port <porta>] [--simulate]\n`);
    process.stdout.write(`  flow-controller template|validate|run|author|tui ...\n\n`);
    process.stdout.write(`O plugin CyberVinci/OpenCode usa FlowStudioController diretamente e mantém o CLI como fonte única de execução.\n`);
}
