import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
    FlowStudioCheckpoint,
    FlowStudioContext,
    FlowStudioEffectRecord,
    FlowStudioGraph,
    FlowStudioRunEvent,
    FlowStudioRunResult,
    FlowStudioRunStatus
} from '@cybervinci/flow-shared';

export const FLOW_STUDIO_RUN_RECORD_VERSION = 'flow-studio-run/v2' as const;
export const FLOW_STUDIO_RUN_RECORD_MAX_BYTES = 256 * 1024 * 1024;
export const FLOW_STUDIO_RUN_STORE_MAX_FILES = 500;
export const FLOW_STUDIO_RUN_STORE_MAX_BYTES = 512 * 1024 * 1024;
export const FLOW_STUDIO_RUN_LEASE_MS = 15_000;
const FLOW_STUDIO_RUN_LEASE_HEARTBEAT_MS = 2_000;
const FLOW_STUDIO_MALFORMED_RUN_LEASE_STALE_MS = 60_000;
const FLOW_STUDIO_RETENTION_LOCK_WAIT_MS = 60_000;
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

export interface FlowStudioRunStoreLimits {
    recordBytes: number;
    files: number;
    totalBytes: number;
}

export interface FlowStudioRunRecord {
    version: typeof FLOW_STUDIO_RUN_RECORD_VERSION;
    id: string;
    graph: FlowStudioGraph;
    input: FlowStudioContext;
    status: FlowStudioRunStatus;
    createdAt: string;
    updatedAt: string;
    parentRunId?: string;
    events: FlowStudioRunEvent[];
    checkpoints: FlowStudioCheckpoint[];
    effects: FlowStudioEffectRecord[];
    result?: FlowStudioRunResult;
    error?: string;
}

export interface FlowStudioRunLease {
    readonly runId: string;
    readonly token: string;
    readonly signal: AbortSignal;
    assertOwned(): Promise<void>;
    release(): Promise<void>;
}

interface FlowStudioRunLeaseOwner {
    runId: string;
    token: string;
    pid: number;
    createdAt: string;
    heartbeatAt: string;
    leaseMs: number;
    processStartedAt: string;
}

interface RetentionFile {
    path: string;
    runId: string;
    size: number;
    mtimeMs: number;
    protected: boolean;
}

export class FlowStudioFileRunStore {
    private readonly queues = new Map<string, Promise<void>>();
    private retentionQueue = Promise.resolve();
    readonly limits: FlowStudioRunStoreLimits;

    constructor(readonly root: string, limits: Partial<FlowStudioRunStoreLimits> = {}) {
        this.limits = {
            recordBytes: positiveLimit(limits.recordBytes, FLOW_STUDIO_RUN_RECORD_MAX_BYTES),
            files: positiveLimit(limits.files, FLOW_STUDIO_RUN_STORE_MAX_FILES),
            totalBytes: positiveLimit(limits.totalBytes, FLOW_STUDIO_RUN_STORE_MAX_BYTES)
        };
    }

    async initialize(): Promise<void> {
        await fs.mkdir(this.root, { recursive: true });
    }

    async save(record: FlowStudioRunRecord): Promise<void> {
        const previous = this.queues.get(record.id) || Promise.resolve();
        const pending = previous.then(async () => {
            await this.initialize();
            const target = this.pathFor(record.id);
            const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
            const serialized = `${JSON.stringify(compactRecordForPersistence(record), null, 2)}\n`;
            const bytes = Buffer.byteLength(serialized);
            if (bytes > this.limits.recordBytes) {
                throw new Error(`Run ${record.id} excede o limite persistente de ${this.limits.recordBytes} bytes (${bytes}).`);
            }
            await fs.writeFile(temporary, serialized, { encoding: 'utf-8', mode: 0o600 });
            const commit = this.retentionQueue.then(() => this.commitWithRetention(record, temporary, target, bytes));
            this.retentionQueue = commit.catch(() => undefined);
            await commit;
        });
        this.queues.set(record.id, pending);
        try {
            await pending;
        } finally {
            if (this.queues.get(record.id) === pending) this.queues.delete(record.id);
        }
    }

    async get(runId: string): Promise<FlowStudioRunRecord | undefined> {
        assertRunId(runId);
        try {
            const file = this.pathFor(runId);
            const stat = await fs.stat(file);
            if (stat.size > this.limits.recordBytes) {
                throw new Error(`Run ${runId} excede o limite persistente de ${this.limits.recordBytes} bytes (${stat.size}).`);
            }
            const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf-8'));
            if (!isFlowStudioRunRecord(parsed, runId)) throw new Error(`Registro persistente do run ${runId} é inválido.`);
            return parsed;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
        }
    }

    async list(limit = 50): Promise<FlowStudioRunRecord[]> {
        await this.initialize();
        const entries = await fs.readdir(this.root, { withFileTypes: true });
        const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'));
        // One corrupt or externally-created history file must not prevent the
        // server from starting or recovering every other valid run.
        const records = await Promise.all(files.map(async entry => {
            try { return await this.get(entry.name.slice(0, -5)); }
            catch { return undefined; }
        }));
        return records.filter((record): record is FlowStudioRunRecord => Boolean(record))
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
            .slice(0, Math.max(1, Math.min(limit, this.limits.files)));
    }

    pathFor(runId: string): string {
        assertRunId(runId);
        return path.join(this.root, `${runId}.json`);
    }

    async claimRunLease(runId: string): Promise<FlowStudioRunLease | undefined> {
        assertRunId(runId);
        await this.initialize();
        const leaseRoot = path.join(this.root, '.leases');
        const lockDirectory = path.join(leaseRoot, `${runId}.lock`);
        const ownerFile = path.join(lockDirectory, 'owner.json');
        const token = randomBytes(24).toString('hex');
        await fs.mkdir(leaseRoot, { recursive: true, mode: 0o700 });
        for (let attempt = 0; attempt < 8; attempt += 1) {
            try {
                await fs.mkdir(lockDirectory, { mode: 0o700 });
                const now = new Date().toISOString();
                const owner: FlowStudioRunLeaseOwner = {
                    runId,
                    token,
                    pid: process.pid,
                    createdAt: now,
                    heartbeatAt: now,
                    leaseMs: FLOW_STUDIO_RUN_LEASE_MS,
                    processStartedAt: PROCESS_STARTED_AT
                };
                try {
                    await fs.writeFile(ownerFile, `${JSON.stringify(owner, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
                } catch (error) {
                    await fs.rm(lockDirectory, { recursive: true, force: true });
                    throw error;
                }
                return createRunLease(runId, token, lockDirectory, ownerFile);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                if (!await runLeaseIsStale(lockDirectory, ownerFile)) return undefined;
                const quarantine = `${lockDirectory}.stale.${token}`;
                try {
                    await fs.rename(lockDirectory, quarantine);
                    await fs.rm(quarantine, { recursive: true, force: true });
                } catch (breakError) {
                    if ((breakError as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
                }
            }
        }
        return undefined;
    }

    private async commitWithRetention(record: FlowStudioRunRecord, temporary: string, target: string, bytes: number): Promise<void> {
        let releaseRetentionLock!: () => Promise<void>;
        try {
            releaseRetentionLock = await acquireRetentionLock(this.root);
        } catch (error) {
            try { await fs.unlink(temporary); } catch { /* best effort cleanup */ }
            throw error;
        }
        try {
            await this.commitWithRetentionLocked(record, temporary, target, bytes);
        } finally {
            await releaseRetentionLock();
        }
    }

    private async commitWithRetentionLocked(record: FlowStudioRunRecord, temporary: string, target: string, bytes: number): Promise<void> {
        let previous: Buffer | undefined;
        try { previous = await fs.readFile(target); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        let removals: string[];
        try {
            removals = await this.planRetention(record, target, bytes);
        } catch (error) {
            try { await fs.unlink(temporary); } catch { /* best effort cleanup */ }
            throw error;
        }
        const quarantineToken = randomBytes(16).toString('hex');
        const staged: Array<{ original: string; quarantine: string }> = [];
        try {
            for (const original of removals) {
                const quarantine = `${original}.retention-delete.${quarantineToken}`;
                await renamePreservingSource(original, quarantine);
                staged.push({ original, quarantine });
            }
            await renameWithRetry(temporary, target);
            await this.assertRetentionWithinLimits();
        } catch (error) {
            await restoreTarget(target, previous).catch(() => undefined);
            for (const item of staged.reverse()) {
                await renamePreservingSource(item.quarantine, item.original).catch(() => undefined);
            }
            try { await fs.unlink(temporary); } catch { /* rename may already have consumed it */ }
            throw error;
        }
        // Once both target commit and the locked recheck succeeded, old
        // histories are no longer part of the transaction. Cleanup is best
        // effort; a later lock acquisition repairs any leftover quarantine.
        await Promise.all(staged.map(item => fs.rm(item.quarantine, { force: true }).catch(() => undefined)));
    }

    private async assertRetentionWithinLimits(): Promise<void> {
        const entries = await fs.readdir(this.root, { withFileTypes: true });
        const files = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'));
        const sizes = await Promise.all(files.map(entry => fs.stat(path.join(this.root, entry.name)).then(stat => stat.size)));
        const totalBytes = sizes.reduce((total, size) => total + size, 0);
        if (files.length > this.limits.files || totalBytes > this.limits.totalBytes) {
            throw new Error(`Run store excedeu a retenção após o commit (${files.length} arquivos, ${totalBytes} bytes).`);
        }
    }

    private async planRetention(record: FlowStudioRunRecord, target: string, bytes: number): Promise<string[]> {
        const entries = await fs.readdir(this.root, { withFileTypes: true });
        const existing = await Promise.all(entries
            .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
            .map(async entry => {
                const filePath = path.join(this.root, entry.name);
                if (path.resolve(filePath) === path.resolve(target)) return undefined;
                const stat = await fs.stat(filePath);
                let status: FlowStudioRunStatus | undefined;
                try { status = (JSON.parse(await fs.readFile(filePath, 'utf-8')) as FlowStudioRunRecord).status; } catch { /* malformed history is evictable */ }
                return {
                    path: filePath,
                    runId: entry.name.slice(0, -5),
                    size: stat.size,
                    mtimeMs: stat.mtimeMs,
                    protected: status === 'running' || status === 'waiting'
                } satisfies RetentionFile;
            }));
        const candidate: RetentionFile = {
            path: target,
            runId: record.id,
            size: bytes,
            mtimeMs: Number.POSITIVE_INFINITY,
            protected: true
        };
        const files = [candidate, ...existing.filter((file): file is RetentionFile => Boolean(file))];
        const protectedFiles = files.filter(file => file.protected);
        const protectedBytes = protectedFiles.reduce((total, file) => total + file.size, 0);
        if (protectedFiles.length > this.limits.files || protectedBytes > this.limits.totalBytes) {
            throw new Error(`Run store excederia a retenção segura (${protectedFiles.length} arquivos protegidos, ${protectedBytes} bytes) porque há execuções running/waiting protegidas.`);
        }
        let keptFiles = protectedFiles.length;
        let keptBytes = protectedBytes;
        const removals: string[] = [];
        const evictable = files.filter(file => !file.protected).sort((left, right) => right.mtimeMs - left.mtimeMs);
        for (const file of evictable) {
            if (keptFiles + 1 <= this.limits.files && keptBytes + file.size <= this.limits.totalBytes) {
                keptFiles += 1;
                keptBytes += file.size;
            } else {
                removals.push(file.path);
            }
        }
        return removals;
    }
}

async function renameWithRetry(source: string, target: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
            await fs.rename(source, target);
            return;
        } catch (error) {
            lastError = error;
            const code = (error as NodeJS.ErrnoException).code;
            if (!['EPERM', 'EACCES', 'EBUSY'].includes(code || '') || attempt === 7) break;
            await new Promise(resolve => setTimeout(resolve, 12 * (attempt + 1)));
        }
    }
    try { await fs.unlink(source); } catch { /* preserve original error */ }
    throw lastError;
}

async function renamePreservingSource(source: string, target: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
            await fs.rename(source, target);
            return;
        } catch (error) {
            lastError = error;
            const code = (error as NodeJS.ErrnoException).code;
            if (!['EPERM', 'EACCES', 'EBUSY'].includes(code || '') || attempt === 7) break;
            await delay(12 * (attempt + 1));
        }
    }
    throw lastError;
}

function compactRecordForPersistence(record: FlowStudioRunRecord): FlowStudioRunRecord {
    if (!record.result) return record;
    return {
        ...record,
        result: {
            ...record.result,
            events: [],
            checkpoints: [],
            effects: []
        }
    };
}

function createRunLease(runId: string, token: string, lockDirectory: string, ownerFile: string): FlowStudioRunLease {
    const lost = new AbortController();
    let released = false;
    let heartbeat = Promise.resolve();
    const assertOwned = async (): Promise<void> => {
        if (released) throw new Error(`Lease do run ${runId} já foi liberado.`);
        if (lost.signal.aborted) throw leaseLostError(runId, lost.signal.reason);
        try {
            const owner = JSON.parse(await fs.readFile(ownerFile, 'utf-8')) as Partial<FlowStudioRunLeaseOwner>;
            if (owner.token !== token || owner.runId !== runId) throw leaseLostError(runId);
        } catch (error) {
            if (!lost.signal.aborted) lost.abort(error);
            throw leaseLostError(runId, error);
        }
    };
    const renew = async (): Promise<void> => {
        try {
            await assertOwned();
            const now = new Date();
            await fs.utimes(ownerFile, now, now);
        } catch (error) {
            if (!lost.signal.aborted) lost.abort(error);
        }
    };
    const timer = setInterval(() => {
        heartbeat = heartbeat.catch(() => undefined).then(renew);
    }, FLOW_STUDIO_RUN_LEASE_HEARTBEAT_MS);
    timer.unref();
    return {
        runId,
        token,
        signal: lost.signal,
        assertOwned,
        async release(): Promise<void> {
            if (released) return;
            released = true;
            clearInterval(timer);
            await heartbeat.catch(() => undefined);
            try {
                const owner = JSON.parse(await fs.readFile(ownerFile, 'utf-8')) as Partial<FlowStudioRunLeaseOwner>;
                if (owner.token === token && owner.runId === runId) await fs.rm(lockDirectory, { recursive: true, force: true });
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
        }
    };
}

async function acquireRetentionLock(root: string): Promise<() => Promise<void>> {
    const lockDirectory = path.join(root, '.retention.lock');
    const ownerFile = path.join(lockDirectory, 'owner.json');
    const token = randomBytes(24).toString('hex');
    const deadline = Date.now() + FLOW_STUDIO_RETENTION_LOCK_WAIT_MS;
    while (Date.now() < deadline) {
        try {
            await fs.mkdir(lockDirectory, { mode: 0o700 });
            const now = new Date().toISOString();
            const owner: FlowStudioRunLeaseOwner = {
                runId: '__retention__', token, pid: process.pid, createdAt: now, heartbeatAt: now,
                leaseMs: FLOW_STUDIO_RUN_LEASE_MS, processStartedAt: PROCESS_STARTED_AT
            };
            try {
                await fs.writeFile(ownerFile, `${JSON.stringify(owner, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
            } catch (error) {
                await fs.rm(lockDirectory, { recursive: true, force: true });
                throw error;
            }
            try {
                await recoverRetentionQuarantines(root);
            } catch (error) {
                await fs.rm(lockDirectory, { recursive: true, force: true });
                throw error;
            }
            return async () => {
                try {
                    const current = JSON.parse(await fs.readFile(ownerFile, 'utf-8')) as Partial<FlowStudioRunLeaseOwner>;
                    if (current.token === token) await fs.rm(lockDirectory, { recursive: true, force: true });
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
            };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            if (await runLeaseIsStale(lockDirectory, ownerFile)) {
                const quarantine = `${lockDirectory}.stale.${token}`;
                try {
                    await fs.rename(lockDirectory, quarantine);
                    await fs.rm(quarantine, { recursive: true, force: true });
                    continue;
                } catch (breakError) {
                    if ((breakError as NodeJS.ErrnoException).code !== 'ENOENT') {
                        await delay(20);
                    }
                    continue;
                }
            }
            await delay(20);
        }
    }
    throw new Error('Tempo limite aguardando o lock global de retenção do run store.');
}

async function recoverRetentionQuarantines(root: string): Promise<void> {
    const marker = '.retention-delete.';
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const markerIndex = entry.name.lastIndexOf(marker);
        if (markerIndex <= 0) continue;
        const quarantine = path.join(root, entry.name);
        const original = path.join(root, entry.name.slice(0, markerIndex));
        try {
            await fs.access(original);
            await fs.rm(quarantine, { force: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            await renamePreservingSource(quarantine, original);
        }
    }
}

async function runLeaseIsStale(lockDirectory: string, ownerFile: string): Promise<boolean> {
    try {
        const owner = JSON.parse(await fs.readFile(ownerFile, 'utf-8')) as Partial<FlowStudioRunLeaseOwner>;
        const stat = await fs.stat(ownerFile);
        if (typeof owner.pid !== 'number' || typeof owner.token !== 'string' || typeof owner.runId !== 'string'
            || typeof owner.processStartedAt !== 'string' || !Number.isFinite(Date.parse(owner.processStartedAt))) {
            return Date.now() - stat.mtimeMs >= FLOW_STUDIO_MALFORMED_RUN_LEASE_STALE_MS;
        }
        // Heartbeats are observability only. A process can legitimately miss the
        // lease interval while serializing a large run record or while its event
        // loop is otherwise blocked. Without a fencing token enforced by every
        // writer, stealing a well-formed lease from a live PID would permit two
        // concurrent writers and duplicate external effects.
        const identity = await flowStudioProcessIdentityMatches(owner.pid, owner.processStartedAt);
        return identity === false;
    } catch {
        try {
            const stat = await fs.stat(lockDirectory);
            return Date.now() - stat.mtimeMs >= FLOW_STUDIO_MALFORMED_RUN_LEASE_STALE_MS;
        } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ENOENT';
        }
    }
}

async function restoreTarget(target: string, previous: Buffer | undefined): Promise<void> {
    if (!previous) {
        try { await fs.unlink(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        return;
    }
    const rollback = `${target}.${process.pid}.${Date.now()}.rollback`;
    await fs.writeFile(rollback, previous, { mode: 0o600 });
    await renameWithRetry(rollback, target);
}

function leaseLostError(runId: string, reason?: unknown): Error {
    const detail = reason instanceof Error ? ` ${reason.message}` : '';
    return new Error(`Lease exclusivo do run ${runId} foi perdido.${detail}`);
}

function isProcessAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export async function flowStudioProcessIdentityMatches(pid: number, expectedStartedAt: unknown): Promise<boolean | undefined> {
    if (!isProcessAlive(pid)) return false;
    if (typeof expectedStartedAt !== 'string' || !Number.isFinite(Date.parse(expectedStartedAt))) return undefined;
    if (pid === process.pid) return sameProcessStart(expectedStartedAt, PROCESS_STARTED_AT);
    try {
        const actual = process.platform === 'win32'
            ? await windowsProcessStartedAt(pid)
            : await posixProcessStartedAt(pid);
        return actual ? sameProcessStart(expectedStartedAt, actual) : undefined;
    } catch {
        // Identity lookup unavailable: fail closed and preserve the lock.
        return undefined;
    }
}

async function windowsProcessStartedAt(pid: number): Promise<string | undefined> {
    const script = `$p=Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().ToString('O')`;
    const output = await execFileText('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]);
    return output.trim() || undefined;
}

async function posixProcessStartedAt(pid: number): Promise<string | undefined> {
    const output = await execFileText('ps', ['-p', String(pid), '-o', 'lstart=']);
    const timestamp = Date.parse(output.trim());
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function execFileText(file: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(file, args, { encoding: 'utf-8', timeout: 5_000, windowsHide: true }, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
        });
    });
}

function sameProcessStart(left: string, right: string): boolean {
    return Math.abs(Date.parse(left) - Date.parse(right)) < 10_000;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function assertRunId(runId: string): void {
    if (!/^[a-zA-Z0-9:_-]{8,160}$/.test(runId)) throw new Error('runId inválido.');
}

function isFlowStudioRunRecord(value: unknown, expectedId: string): value is FlowStudioRunRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Partial<FlowStudioRunRecord>;
    const graph = record.graph as Partial<FlowStudioGraph> | undefined;
    return record.version === FLOW_STUDIO_RUN_RECORD_VERSION
        && record.id === expectedId
        && typeof graph?.id === 'string'
        && Array.isArray(graph.nodes)
        && Boolean(record.input) && typeof record.input === 'object' && !Array.isArray(record.input)
        && ['running', 'waiting', 'completed', 'failed', 'cancelled'].includes(String(record.status))
        && typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt))
        && typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt))
        && Array.isArray(record.events)
        && Array.isArray(record.checkpoints)
        && Array.isArray(record.effects)
        && (record.error === undefined || typeof record.error === 'string');
}

function positiveLimit(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
