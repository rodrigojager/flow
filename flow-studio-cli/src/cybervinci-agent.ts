import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

/** HOST-owned policy, never deserialize this (or executable/env) from a GraphSpec.
 * Tool classifications must come from reviewed implementations, not name prefixes.
 * Config injection is NOT an OS/Blender sandbox. The installed CLI, global MCP
 * registrations and managed config must be trusted. This bridge does not read
 * personal auth/provider config; the child retains user paths for its existing pool.
 * Permission alias groups are indivisible when requested: [read, list_mcp_resources,
 * list_mcp_resource_templates, read_mcp_resource] and [edit, write, apply_patch].
 * Every member must be explicit in nativeToolsIds AND a trusted classification;
 * nothing is implicitly granted. Unrequested groups need not be classified.
 */
export interface CyberVinciAgentPolicy {
    readonlyTools: readonly string[];
    writableTools: readonly string[];
    allowedAttachmentRoots: readonly string[];
    /** Aggregate input limit, also applied to every file. Default: 10 MiB. */
    maxAttachmentBytes?: number;
    /** Combined stdout/stderr limit, including inline tool media. Default: 16 MiB. */
    maxOutputBytes?: number;
    /** Explicit HOST-built overrides only; bridge safety flags cannot be overridden.
     * CYBERVINCI_EXPERIMENTAL_NATIVE_LLM is reserved/pinned false: late tool_use
     * after step_finish is not supported. The default AI SDK runtime is required.
     */
    env?: Readonly<Record<string, string>>;
}

export interface CyberVinciAgentOptions {
    /** Absolute binary path, or [absolute binary, ...trusted launcher arguments]. No shell. */
    executable: string | readonly [string, ...string[]];
    workspace: string;
    model: string;
    prompt: string;
    nativeToolsIds: readonly string[];
    attachments?: readonly { path: string; digest: string }[];
    readonly: boolean;
    policy: CyberVinciAgentPolicy;
    /** Each exact ID must have a completed local tool_use (not providerExecuted) in the main session. */
    requiredToolCalls?: readonly string[];
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface CyberVinciAgentResult {
    /** Entire JSON object from the final tool-free stop step, not its nested `output`.
     * Validate its schema in the host. Intermediate stop steps with local tools may resume.
     */
    output: Record<string, unknown>;
    sessionId: string;
    trace: {
        toolId: string;
        status: 'completed';
        callID: string;
        /** SHA-256 of the attachment URL string; never raw URLs, filenames or base64. */
        attachments: { mime: string; digest: string }[];
    }[];
    usage: {
        inputTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        totalTokens: number;
        cost: number;
        steps: number;
    };
    /** SHA-256 of ordered JSON [{path: realpath, digest: sha256:<hex>, bytes}]. */
    attachmentsDigest: string;
}

export class CyberVinciAgentError extends Error {
    constructor(public readonly code: string) {
        super(`CyberVinci agent: ${code}`);
        this.name = 'CyberVinciAgentError';
    }
}

// Same minimal user/runtime-path strategy as cli.ts, without config variables,
// proxy credentials, generic secrets or runtime injection (NODE_OPTIONS, etc.).
const ENV_KEYS = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'CODEX_HOME', 'HOME', 'XDG_CONFIG_HOME',
    'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'LANG', 'LC_ALL', 'LC_CTYPE'
]);
const ID = /^[a-zA-Z][a-zA-Z0-9_.-]{0,199}$/;
// CyberVinci permission/index.ts maps these native IDs to one shared permission.
const TOOL_ALIAS_GROUPS = [
    ['read', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'],
    ['edit', 'write', 'apply_patch']
] as const;
// Defense against accidental HOST misclassification, not an authorization heuristic.
const NEVER_READONLY = new Set([
    'bash', 'edit', 'write', 'apply_patch', 'task', 'shell', 'exec', 'execBlender',
    'flow', 'flow_author', 'flow_open', 'flow_run', 'flow_cancel', 'flow_replay', 'flow_resume',
    'execute_blender_code', 'blender_execute_blender_code', 'blender_execute_code'
]);

/** One fresh invocation only. No retries, fallback, session reuse or ledger.
 * The host must write-ahead the WHOLE invocation, including tools, before calling.
 * Keep verified input files/roots immutable until the child exits: --file reopens
 * paths, so validation cannot prevent a concurrent filesystem/Blender writer.
 * Prefer verified attachments over granting the broad native `read` permission.
 */
export async function executeCyberVinciAgent(options: CyberVinciAgentOptions): Promise<CyberVinciAgentResult> {
    const deadline = Date.now() + positiveLimit(options.timeoutMs, 120_000);
    const check = (): void => {
        if (options.signal?.aborted) throw new CyberVinciAgentError('CANCELLED');
        if (Date.now() >= deadline) throw new CyberVinciAgentError('TIMEOUT');
    };
    check();
    const policy = options.policy;
    if (!policy || typeof options.readonly !== 'boolean') throw new CyberVinciAgentError('INVALID_POLICY');
    const reads = toolIds(policy.readonlyTools);
    const writes = toolIds(policy.writableTools);
    if ([...reads].some(id => writes.has(id) || NEVER_READONLY.has(id))) throw new CyberVinciAgentError('INVALID_CLASSIFICATION');
    const tools = toolIds(options.nativeToolsIds);
    for (const id of tools) {
        if (!reads.has(id) && !writes.has(id)) throw new CyberVinciAgentError('UNKNOWN_TOOL');
        if (options.readonly && !reads.has(id)) throw new CyberVinciAgentError('READONLY_TOOL');
    }
    for (const group of TOOL_ALIAS_GROUPS) {
        if (group.some(id => tools.has(id)) && !group.every(id => tools.has(id))) throw new CyberVinciAgentError('INCOMPLETE_TOOL_ALIAS_GROUP');
    }
    const required = toolIds(options.requiredToolCalls ?? []);
    if ([...required].some(id => !tools.has(id))) throw new CyberVinciAgentError('REQUIRED_TOOL_NOT_ALLOWED');
    const executable = typeof options.executable === 'string' ? [options.executable] : [...options.executable];
    if (!executable.length || !path.isAbsolute(executable[0]) || executable.some(arg => typeof arg !== 'string' || arg.includes('\0'))
        || /\.(cmd|bat)$/i.test(executable[0])) throw new CyberVinciAgentError('INVALID_EXECUTABLE');
    if (!/^[a-zA-Z0-9._-]+\/[^\s\0]+$/.test(options.model) || options.model.length > 300
        || typeof options.prompt !== 'string' || !options.prompt.trim()
        || typeof options.workspace !== 'string' || !path.isAbsolute(options.workspace)) throw new CyberVinciAgentError('INVALID_INPUT');
    const maxOutputBytes = positiveLimit(policy.maxOutputBytes, 16 * 1024 * 1024);
    const maxAttachmentBytes = positiveLimit(policy.maxAttachmentBytes, 10 * 1024 * 1024);
    const workspace = await fs.realpath(options.workspace).catch(() => { throw new CyberVinciAgentError('INVALID_WORKSPACE'); });
    if (!(await fs.stat(workspace).catch(() => { throw new CyberVinciAgentError('INVALID_WORKSPACE'); })).isDirectory()) throw new CyberVinciAgentError('INVALID_WORKSPACE');
    const attachments = await verifyAttachments(options.attachments ?? [], policy.allowedAttachmentRoots, maxAttachmentBytes, check);
    check();

    const name = `flow_bridge_${randomUUID().replace(/-/g, '')}`;
    const permission = Object.fromEntries([['*', 'deny'], ...[...tools].map(id => [id, 'allow'])]);
    const config = {
        $schema: 'https://opencode.ai/config.json',
        default_agent: name, model: options.model, share: 'disabled', autoupdate: false,
        snapshot: false, compaction: { auto: false }, permission,
        agent: {
            ...Object.fromEntries(['build', 'plan', 'general', 'explore', 'compaction', 'title', 'summary'].map(id => [id, { disable: true }])),
            [name]: {
                mode: 'primary', model: options.model, permission,
                prompt: 'Use only permitted tools. Return the final response as one JSON object, without Markdown or surrounding text.'
            }
        }
    };
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (ENV_KEYS.has(key.toUpperCase()) && value !== undefined) env[process.platform === 'win32' ? key.toUpperCase() : key] = value;
    }
    for (const [key, value] of Object.entries(policy.env ?? {})) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) throw new CyberVinciAgentError('INVALID_ENV');
        // Never allow an alternate config, permission overlay or auto-approval path.
        if (/^(CYBERVINCI_(CONFIG.*|PERMISSION|PURE|AUTO.*|DISABLE_.*)|OPENCODE_.*|NODE_OPTIONS|BUN_OPTIONS)$/i.test(key)) throw new CyberVinciAgentError('RESERVED_ENV');
        if (key.toUpperCase() === 'CYBERVINCI_EXPERIMENTAL_NATIVE_LLM') throw new CyberVinciAgentError('RESERVED_ENV');
        env[process.platform === 'win32' ? key.toUpperCase() : key] = value;
    }
    Object.assign(env, {
        CYBERVINCI_CONFIG_CONTENT: JSON.stringify(config), CYBERVINCI_PURE: '1',
        CYBERVINCI_EXPERIMENTAL_NATIVE_LLM: 'false',
        CYBERVINCI_DISABLE_PROJECT_CONFIG: '1', CYBERVINCI_DISABLE_AUTOUPDATE: '1',
        CYBERVINCI_DISABLE_AUTOCOMPACT: '1', CYBERVINCI_DISABLE_EXTERNAL_SKILLS: '1',
        CYBERVINCI_DISABLE_CLAUDE_CODE_SKILLS: '1', NO_COLOR: '1'
    });
    const args = [...executable.slice(1), 'run', '--pure', '--format', 'json', '--model', options.model,
        '--agent', name, '--dir', workspace, '--title', 'Flow agent', '--no-share', '--no-auto',
        ...attachments.flatMap(attachment => ['--file', attachment.path])];
    check();
    const raw = await new Promise<string>((resolve, reject) => {
        const child = spawn(executable[0], args, { cwd: workspace, env, shell: false, windowsHide: true,
            detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
        const chunks: Buffer[] = [];
        let bytes = 0;
        let failure: CyberVinciAgentError | undefined;
        let killing: Promise<void> | undefined;
        const onAbort = (): void => stop('CANCELLED');
        const cleanup = (): void => {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
        };
        const stop = (code: string): void => {
            if (failure) return;
            failure = new CyberVinciAgentError(code);
            child.stdin.destroy();
            if (child.pid) killing = terminateTree(child.pid).catch(() => {
                failure = new CyberVinciAgentError('TERMINATION_FAILED');
                cleanup();
                child.stdout.destroy();
                child.stderr.destroy();
                child.unref();
                // Outcome is uncertain; the host must not replay this invocation.
                reject(failure);
            });
        };
        const collect = (keep: boolean) => (chunk: Buffer): void => {
            if (failure) return;
            bytes += chunk.length;
            if (bytes > maxOutputBytes) return stop('OUTPUT_LIMIT');
            if (keep) chunks.push(chunk);
        };
        child.stdout.on('data', collect(true));
        child.stderr.on('data', collect(false));
        child.once('error', () => stop('SPAWN_FAILED'));
        child.stdin.on('error', () => stop('STDIN_FAILED'));
        options.signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => stop('TIMEOUT'), Math.max(1, deadline - Date.now()));
        child.once('close', async code => {
            cleanup();
            await killing;
            if (failure) return reject(failure);
            if (code !== 0) return reject(new CyberVinciAgentError('EXIT_FAILED'));
            resolve(Buffer.concat(chunks).toString('utf8'));
        });
        if (options.signal?.aborted) onAbort();
        if (!failure) child.stdin.end(options.prompt);
    });
    check();
    const result = { ...parseOutput(raw, tools, required), attachmentsDigest: digest(JSON.stringify(attachments)) };
    check();
    return result;
}

async function verifyAttachments(attachments: readonly { path: string; digest: string }[], roots: readonly string[], maxBytes: number, check: () => void) {
    if (!Array.isArray(attachments) || !Array.isArray(roots) || roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) throw new CyberVinciAgentError('INVALID_ATTACHMENTS');
    try {
        const allowed = await Promise.all(roots.map(async root => {
            const canonical = await fs.realpath(root);
            if (!(await fs.stat(canonical)).isDirectory()) throw new Error();
            return canonical;
        }));
        const verified: { path: string; digest: string; bytes: number }[] = [];
        let total = 0;
        for (const attachment of attachments) {
            check();
            if (!attachment || typeof attachment.path !== 'string' || !path.isAbsolute(attachment.path)
                || typeof attachment.digest !== 'string' || !/^(?:sha256:)?[a-fA-F0-9]{64}$/.test(attachment.digest)) throw new CyberVinciAgentError('INVALID_ATTACHMENT');
            const canonical = await fs.realpath(attachment.path);
            if (!allowed.some(root => {
                const relative = path.relative(root, canonical);
                return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
            })) throw new CyberVinciAgentError('ATTACHMENT_OUTSIDE_ROOT');
            const before = await fs.lstat(canonical);
            if (!before.isFile()) throw new CyberVinciAgentError('ATTACHMENT_NOT_REGULAR');
            const file = await fs.open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
            try {
                const stat = await file.stat();
                if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw new CyberVinciAgentError('ATTACHMENT_CHANGED');
                if (stat.size > maxBytes - total) throw new CyberVinciAgentError('ATTACHMENT_LIMIT');
                const hash = createHash('sha256');
                const buffer = Buffer.alloc(64 * 1024);
                let bytes = 0;
                while (true) {
                    check();
                    const read = await file.read(buffer, 0, buffer.length, null);
                    if (!read.bytesRead) break;
                    bytes += read.bytesRead;
                    if (bytes > maxBytes - total) throw new CyberVinciAgentError('ATTACHMENT_LIMIT');
                    hash.update(buffer.subarray(0, read.bytesRead));
                }
                const after = await file.stat();
                const current = await fs.lstat(canonical);
                if (bytes !== stat.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs
                    || !current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino
                    || await fs.realpath(attachment.path) !== canonical) throw new CyberVinciAgentError('ATTACHMENT_CHANGED');
                const actual = `sha256:${hash.digest('hex')}`;
                if (actual !== `sha256:${attachment.digest.replace(/^sha256:/, '').toLowerCase()}`) throw new CyberVinciAgentError('ATTACHMENT_DIGEST');
                total += bytes;
                verified.push({ path: canonical, digest: actual, bytes });
            } finally { await file.close(); }
        }
        return verified;
    } catch (error) {
        if (error instanceof CyberVinciAgentError) throw error;
        throw new CyberVinciAgentError('ATTACHMENT_IO');
    }
}

function parseOutput(raw: string, tools: Set<string>, required: Set<string>): Omit<CyberVinciAgentResult, 'attachmentsDigest'> {
    const trace: CyberVinciAgentResult['trace'] = [];
    const usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, cost: 0, steps: 0 };
    let sessionId: string | undefined;
    let step: { messageId: string; texts: string[]; hasTools: boolean; hasLocalTools: boolean; finish?: string } | undefined;
    const partIds = new Set<string>();
    const callIds = new Set<string>();
    const completedLocalTools = new Set<string>();
    for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const event = object(parseJson(line));
        const session = identifier(event.sessionID);
        sessionId ??= session;
        if (session !== sessionId) throw new CyberVinciAgentError('SESSION_MISMATCH');
        if (event.type === 'error') throw new CyberVinciAgentError('CLI_ERROR');
        if (!['step_start', 'step_finish', 'text', 'tool_use', 'reasoning'].includes(String(event.type))) throw new CyberVinciAgentError('UNKNOWN_EVENT');
        const part = object(event.part);
        if (part.sessionID !== sessionId) throw new CyberVinciAgentError('SESSION_MISMATCH');
        const messageId = identifier(part.messageID);
        const partId = identifier(part.id);
        if (partIds.has(partId)) throw new CyberVinciAgentError('DUPLICATE_PART');
        partIds.add(partId);
        if (event.type === 'step_start') {
            if (part.type !== 'step-start' || (step && step.finish !== 'tool-calls'
                && !(step.finish === 'stop' && step.hasLocalTools))) throw new CyberVinciAgentError('INVALID_STEP');
            step = { messageId, texts: [], hasTools: false, hasLocalTools: false };
            continue;
        }
        if (!step || step.messageId !== messageId) throw new CyberVinciAgentError('INVALID_STEP');
        if (event.type === 'text' || event.type === 'reasoning') {
            if (part.type !== event.type || typeof part.text !== 'string' || typeof object(part.time).end !== 'number') throw new CyberVinciAgentError('INVALID_TEXT');
            if (event.type === 'text' && !part.synthetic && !part.ignored) step.texts.push(part.text);
            continue;
        }
        if (event.type === 'tool_use') {
            if (part.type !== 'tool' || step.finish) throw new CyberVinciAgentError('INVALID_TOOL_EVENT');
            const toolId = identifier(part.tool);
            const callID = identifier(part.callID);
            const state = object(part.state);
            if (!tools.has(toolId)) throw new CyberVinciAgentError('UNAUTHORIZED_TOOL_TRACE');
            if (state.status === 'error') throw new CyberVinciAgentError('TOOL_ERROR');
            if (state.status !== 'completed' || callIds.has(callID)) throw new CyberVinciAgentError('INVALID_TOOL_EVENT');
            const time = object(state.time);
            if (typeof state.output !== 'string' || typeof time.start !== 'number' || typeof time.end !== 'number'
                || !Number.isFinite(time.start) || !Number.isFinite(time.end) || time.start < 0 || time.end < time.start) throw new CyberVinciAgentError('INVALID_TOOL_EVENT');
            const providerExecuted = part.metadata === undefined ? undefined : object(part.metadata).providerExecuted;
            if (providerExecuted !== undefined && typeof providerExecuted !== 'boolean') throw new CyberVinciAgentError('INVALID_TOOL_EVENT');
            step.hasTools = true;
            if (providerExecuted !== true) {
                step.hasLocalTools = true;
                completedLocalTools.add(toolId);
            }
            callIds.add(callID);
            if (state.attachments !== undefined && !Array.isArray(state.attachments)) throw new CyberVinciAgentError('INVALID_TOOL_ATTACHMENT');
            const attachments = (state.attachments as unknown[] | undefined ?? []).map(item => {
                const file = object(item);
                if (file.type !== 'file' || typeof file.mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(file.mime)
                    || file.mime.length > 100 || typeof file.url !== 'string') throw new CyberVinciAgentError('INVALID_TOOL_ATTACHMENT');
                return { mime: file.mime, digest: digest(file.url) };
            });
            trace.push({ toolId, status: 'completed', callID, attachments });
            continue;
        }
        if (part.type !== 'step-finish' || step.finish) throw new CyberVinciAgentError('INVALID_STEP');
        if (part.reason !== 'stop' && part.reason !== 'tool-calls') throw new CyberVinciAgentError('INVALID_FINISH');
        step.finish = part.reason;
        const tokens = object(part.tokens);
        const cache = object(tokens.cache);
        const input = nonNegative(tokens.input);
        const output = nonNegative(tokens.output);
        const reasoning = nonNegative(tokens.reasoning);
        const read = nonNegative(cache.read);
        const write = nonNegative(cache.write);
        usage.inputTokens += input;
        usage.outputTokens += output;
        usage.reasoningTokens += reasoning;
        usage.cacheReadTokens += read;
        usage.cacheWriteTokens += write;
        usage.totalTokens += tokens.total === undefined ? input + output + reasoning + read + write : nonNegative(tokens.total);
        usage.cost += nonNegative(part.cost);
        usage.steps += 1;
    }
    if (!sessionId || step?.finish !== 'stop' || step.hasTools) throw new CyberVinciAgentError('INCOMPLETE_OUTPUT');
    if (Object.values(usage).some(value => !Number.isFinite(value))) throw new CyberVinciAgentError('INVALID_USAGE');
    if ([...required].some(id => !completedLocalTools.has(id))) throw new CyberVinciAgentError('MISSING_REQUIRED_TOOL');
    return { output: object(parseJson(step.texts.join(''))), sessionId, trace, usage };
}

function toolIds(ids: readonly string[]): Set<string> {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !ID.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id))
        || new Set(ids).size !== ids.length) throw new CyberVinciAgentError('INVALID_TOOL_IDS');
    return new Set(ids);
}

function identifier(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(value)) throw new CyberVinciAgentError('INVALID_EVENT_ID');
    return value;
}

function positiveLimit(value: number | undefined, fallback: number): number {
    const limit = value ?? fallback;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 2_147_483_647) throw new CyberVinciAgentError('INVALID_LIMIT');
    return limit;
}

function nonNegative(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new CyberVinciAgentError('INVALID_USAGE');
    return value;
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CyberVinciAgentError('INVALID_JSON_OBJECT');
    return value as Record<string, unknown>;
}

function parseJson(value: string): unknown {
    try { return JSON.parse(value); } catch { throw new CyberVinciAgentError('INVALID_JSON'); }
}

function digest(value: string): string {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function terminateTree(pid: number): Promise<void> {
    if (process.platform === 'win32') {
        const root = process.env.SystemRoot || process.env.SYSTEMROOT;
        if (!root || !path.isAbsolute(root)) throw new CyberVinciAgentError('TERMINATION_FAILED');
        await new Promise<void>((resolve, reject) => {
            execFile(path.join(root, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'],
                { windowsHide: true, timeout: 5_000, env: { SystemRoot: root, WINDIR: root } },
                error => error ? reject(new CyberVinciAgentError('TERMINATION_FAILED')) : resolve());
        });
        return;
    }
    try { process.kill(-pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
}
