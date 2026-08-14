import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { FlowStudioController, type FlowStudioControllerOptions } from './controller.js';

export interface FlowStudioToolWorkspace {
    directory: string;
    worktree: string;
    abort: AbortSignal;
}

interface PendingControllerStart {
    readonly controller: FlowStudioController;
    readonly abort: AbortController;
    readonly promise: Promise<FlowStudioController>;
}

export class FlowStudioControllerPool {
    private readonly controllers = new Map<string, FlowStudioController>();
    private readonly pendingStarts = new Map<string, PendingControllerStart>();
    private readonly browserOpenedFor = new WeakSet<FlowStudioSessionIdentity>();
    private stopped = false;
    private stopPromise?: Promise<void>;

    constructor(
        private readonly options: Omit<FlowStudioControllerOptions, 'workspace' | 'signal' | 'openBrowser'> = {},
        private readonly createController: () => FlowStudioController = () => new FlowStudioController()
    ) {}

    async get(context: FlowStudioToolWorkspace, file?: string, openBrowser = false): Promise<{ controller: FlowStudioController; file: string }> {
        const worktree = await fs.realpath(path.resolve(context.worktree));
        const requestedFile = file || await defaultGraphFile(context.directory);
        const resolvedFile = await resolveInsideWorktree(worktree, path.resolve(context.directory, requestedFile));
        if (this.stopped) throw poolStoppedError();
        if (context.abort.aborted) throw callerAbortedError();
        const key = `${worktree}\u0000${resolvedFile}`;
        let controller = this.controllers.get(key);
        if (controller?.activeSession) {
            if (openBrowser) this.openOnce(controller);
            return { controller, file: resolvedFile };
        }
        if (controller) this.controllers.delete(key);

        let pending = this.pendingStarts.get(key);
        if (!pending) {
            pending = this.createPendingStart(key, worktree, resolvedFile);
            this.pendingStarts.set(key, pending);
        }
        controller = await waitForCaller(pending.promise, context.abort);
        if (this.stopped) {
            await controller.stop();
            throw poolStoppedError();
        }
        if (openBrowser) this.openOnce(controller);
        return { controller, file: resolvedFile };
    }

    async stopAll(): Promise<void> {
        if (this.stopPromise) return this.stopPromise;
        this.stopped = true;
        const activeControllers = [...this.controllers.values()];
        const pending = [...this.pendingStarts.values()];
        this.controllers.clear();
        for (const start of pending) start.abort.abort();
        this.stopPromise = (async () => {
            const settled = await Promise.allSettled(pending.map(start => start.promise));
            const controllers = new Set(activeControllers);
            for (const start of pending) controllers.add(start.controller);
            for (const result of settled) {
                if (result.status === 'fulfilled') controllers.add(result.value);
            }
            await Promise.allSettled([...controllers].map(controller => controller.stop()));
            this.pendingStarts.clear();
        })();
        return this.stopPromise;
    }

    private createPendingStart(key: string, worktree: string, resolvedFile: string): PendingControllerStart {
        const controller = this.createController();
        const abort = new AbortController();
        const pending = {} as PendingControllerStart;
        Object.assign(pending, {
            controller,
            abort,
            promise: (async () => {
                try {
                    await controller.start(resolvedFile, {
                        ...this.options,
                        workspace: worktree,
                        signal: abort.signal,
                        openBrowser: false
                    });
                    if (this.stopped) {
                        await controller.stop();
                        throw poolStoppedError();
                    }
                    this.controllers.set(key, controller);
                    return controller;
                } catch (error) {
                    if (this.controllers.get(key) === controller) this.controllers.delete(key);
                    await controller.stop().catch(() => undefined);
                    throw error;
                } finally {
                    if (this.pendingStarts.get(key) === pending) this.pendingStarts.delete(key);
                }
            })()
        });
        return pending;
    }

    private openOnce(controller: FlowStudioController): void {
        const session = controller.activeSession;
        if (!session || this.browserOpenedFor.has(session)) return;
        this.browserOpenedFor.add(session);
        controller.open();
    }
}

async function defaultGraphFile(directory: string): Promise<string> {
    const preferred = path.resolve(directory, 'flow.graph.json');
    const legacy = path.resolve(directory, 'flow-studio.graph.json');
    try {
        await fs.access(preferred);
        return preferred;
    } catch {
        try {
            await fs.access(legacy);
            return legacy;
        } catch {
            return preferred;
        }
    }
}

type FlowStudioSessionIdentity = NonNullable<FlowStudioController['activeSession']>;

async function waitForCaller<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw callerAbortedError();
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => {
            cleanup();
            reject(callerAbortedError());
        };
        const cleanup = (): void => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            value => { cleanup(); resolve(value); },
            error => { cleanup(); reject(error); }
        );
    });
}

function callerAbortedError(): Error {
    return new Error('Inicialização do Flow Studio cancelada para esta ferramenta.');
}

function poolStoppedError(): Error {
    return new Error('O pool do Flow Studio já foi encerrado.');
}

async function resolveInsideWorktree(worktree: string, candidate: string): Promise<string> {
    const lexical = path.relative(worktree, candidate);
    if (lexical.startsWith('..') || path.isAbsolute(lexical)) throw new Error(`Arquivo Flow Studio fora do worktree: ${candidate}`);
    let probe = candidate;
    while (true) {
        try { await fs.access(probe); break; }
        catch {
            const parent = path.dirname(probe);
            if (parent === probe) throw new Error(`Não foi possível resolver o arquivo: ${candidate}`);
            probe = parent;
        }
    }
    const canonicalParent = await fs.realpath(probe);
    const canonical = path.resolve(canonicalParent, path.relative(probe, candidate));
    const relative = path.relative(worktree, canonical);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Arquivo Flow Studio atravessa um link para fora do worktree: ${candidate}`);
    return canonical;
}
