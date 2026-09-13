'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { executeCyberVinciAgent, CyberVinciAgentError } = require('../lib/cybervinci-agent');

const GETTER = 'blender_get_scene_info';
const WRITER = 'blender_execute_blender_code';
const READ_GROUP = ['read', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'];
const EDIT_GROUP = ['edit', 'write', 'apply_patch'];
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const tokens = { input: 10, output: 3, reasoning: 2, cache: { read: 4, write: 1 } };
let sequence = 0;
function event(type, part = {}, messageID = 'msg_main') {
    return { type, sessionID: 'ses_main', timestamp: 1, part: {
        id: `prt_${++sequence}`, sessionID: 'ses_main', messageID,
        type: { step_start: 'step-start', step_finish: 'step-finish', tool_use: 'tool' }[type] || type, ...part
    } };
}
const start = () => event('step_start');
const text = value => event('text', { text: typeof value === 'string' ? value : JSON.stringify(value), time: { start: 1, end: 2 } });
const finish = (reason = 'stop') => event('step_finish', { reason, tokens, cost: 0.25 });
const tool = (id = GETTER, state = {}) => event('tool_use', { tool: id, callID: `call_${++sequence}`, state: { status: 'completed', time: { start: 1, end: 2 }, input: { secret: 'TOOL_SECRET' }, output: '{"output":{"fake":true}}', ...state } });
const success = () => [start(), text({ output: { ok: true } }), finish()];

// Actual subprocess fixture. No real provider, personal config or Blender access.
const fixtureSource = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
(async () => {
    const spec = JSON.parse(fs.readFileSync(process.env.FLOW_FIXTURE_SPEC, 'utf8'));
    let stdin = '';
    for await (const chunk of process.stdin) stdin += chunk;
    fs.appendFileSync(spec.capture, JSON.stringify({ argv: process.argv.slice(2), env: process.env, stdin, pid: process.pid, cwd: process.cwd() }) + '\n');
    if (spec.hang) {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        fs.writeFileSync(spec.ready, JSON.stringify({ pid: process.pid, child: child.pid }));
        setInterval(() => {}, 1000);
        if (spec.flood) setInterval(() => process[spec.flood].write('X'.repeat(4096)), 10);
        return;
    }
    if (spec.stderr) process.stderr.write(spec.stderr);
    const output = spec.raw === undefined ? spec.events.map(e => JSON.stringify(e)).join('\n') + '\n' : spec.raw;
    if (spec.chunked) {
        for (const byte of Buffer.from(output)) process.stdout.write(Buffer.from([byte]));
    } else process.stdout.write(output);
    process.exitCode = spec.exit || 0;
})().catch(() => { process.exitCode = 99; });
`;

async function setup(t, spec = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-agent-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const fixture = path.join(root, 'fixture with spaces.cjs');
    const specPath = path.join(root, 'spec.json');
    const capture = path.join(root, 'capture.ndjson');
    const ready = path.join(root, 'ready.json');
    await fs.writeFile(fixture, fixtureSource);
    await fs.writeFile(specPath, JSON.stringify({ events: success(), capture, ready, ...spec }));
    const options = {
        executable: [process.execPath, fixture], workspace: root, model: 'test/model',
        prompt: 'private prompt\n--auto --session attacker " & echo nope', nativeToolsIds: [], readonly: true,
        timeoutMs: 5_000,
        policy: { readonlyTools: [GETTER, 'read'], writableTools: [WRITER, 'bash'], allowedAttachmentRoots: [root], env: { FLOW_FIXTURE_SPEC: specPath } }
    };
    return { root, options, capture, ready, records: async () => (await fs.readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse) };
}

function fails(code) {
    return error => {
        assert.ok(error instanceof CyberVinciAgentError);
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /TOOL_SECRET|STDERR_SECRET|private prompt|base64/);
        return true;
    };
}

test('deny by default, unique primary/fresh sessions, exact permissions, stdin and minimal env', async t => {
    const f = await setup(t);
    const secrets = { OPENAI_API_KEY: 'GENERIC_SECRET', RANDOM_TOKEN: 'GENERIC_SECRET', CYBERVINCI_CONFIG: 'personal.json',
        CYBERVINCI_CONFIG_CONTENT: '{"permission":"allow"}', CYBERVINCI_PERMISSION: '{"*":"allow"}', NODE_OPTIONS: '--trace-warnings',
        CYBERVINCI_SERVER_PASSWORD: 'GENERIC_SECRET', HTTPS_PROXY: 'https://user:password@proxy.test',
        CYBERVINCI_EXPERIMENTAL_NATIVE_LLM: 'true' };
    const before = Object.fromEntries(Object.keys(secrets).map(key => [key, process.env[key]]));
    t.after(() => { for (const [key, value] of Object.entries(before)) value === undefined ? delete process.env[key] : process.env[key] = value; });
    Object.assign(process.env, secrets);
    const result = await executeCyberVinciAgent(f.options);
    assert.deepEqual(result.output, { output: { ok: true } });
    assert.equal(result.sessionId, 'ses_main');
    assert.deepEqual(result.trace, []);
    assert.equal(result.attachmentsDigest, sha('[]'));
    await executeCyberVinciAgent({ ...f.options, nativeToolsIds: [GETTER] });
    const records = await f.records();
    assert.equal(records.length, 2);
    const configs = records.map(record => JSON.parse(record.env.CYBERVINCI_CONFIG_CONTENT));
    assert.notEqual(configs[0].default_agent, configs[1].default_agent);
    for (const [i, record] of records.entries()) {
        const config = configs[i];
        const allowed = i ? { '*': 'deny', [GETTER]: 'allow' } : { '*': 'deny' };
        assert.deepEqual(config.permission, allowed);
        assert.deepEqual(config.agent[config.default_agent].permission, allowed);
        assert.deepEqual(Object.entries(config.agent).filter(([, agent]) => !agent.disable).map(([id]) => id), [config.default_agent]);
        assert.equal(config.agent[config.default_agent].mode, 'primary');
        assert.equal(config.share, 'disabled');
        assert.equal(record.stdin, f.options.prompt);
        assert.equal(record.cwd, await fs.realpath(f.root));
        assert.ok(record.argv.includes('--pure'));
        assert.ok(record.argv.includes('--no-auto'));
        assert.ok(record.argv.includes('--no-share'));
        assert.equal(record.argv[record.argv.indexOf('--agent') + 1], config.default_agent);
        assert.ok(!record.argv.some(arg => ['--session', '--continue', '--fork', '--attach', '--auto', '--yolo', '--dangerously-skip-permissions'].includes(arg)));
        assert.ok(!record.argv.includes(f.options.prompt));
        assert.doesNotMatch(JSON.stringify(record.env), /GENERIC_SECRET|personal\.json|trace-warnings|user:password/);
        assert.equal(record.env.CYBERVINCI_DISABLE_PROJECT_CONFIG, '1');
        assert.equal(record.env.CYBERVINCI_PURE, '1');
        assert.equal(record.env.CYBERVINCI_EXPERIMENTAL_NATIVE_LLM, 'false');
        for (const key of ['USERPROFILE', 'APPDATA', 'HOME', 'CODEX_HOME']) if (process.env[key]) assert.equal(record.env[key], process.env[key]);
    }
});

test('rejects unknown IDs, wildcards, readonly writes and invalid host classifications before spawn', async t => {
    const f = await setup(t);
    for (const id of ['blender_get_unknown', 'unknown', 'read_mcp_resource']) {
        await assert.rejects(executeCyberVinciAgent({ ...f.options, nativeToolsIds: [id] }), fails('UNKNOWN_TOOL'));
    }
    for (const id of ['*', 'blender_*', 'read?', '__proto__', '0', 'read\n']) {
        await assert.rejects(executeCyberVinciAgent({ ...f.options, nativeToolsIds: [id] }), fails('INVALID_TOOL_IDS'));
    }
    for (const id of [WRITER, 'bash']) await assert.rejects(executeCyberVinciAgent({ ...f.options, nativeToolsIds: [id] }), fails('READONLY_TOOL'));
    for (const id of ['bash', 'edit', 'write', 'apply_patch', 'task', 'flow', 'flow_run', 'execBlender', WRITER]) {
        await assert.rejects(executeCyberVinciAgent({ ...f.options, policy: { ...f.options.policy, readonlyTools: [id], writableTools: [] }, nativeToolsIds: [id] }), fails('INVALID_CLASSIFICATION'));
    }
    await assert.rejects(executeCyberVinciAgent({ ...f.options, policy: { ...f.options.policy, writableTools: [GETTER] } }), fails('INVALID_CLASSIFICATION'));
    await assert.rejects(executeCyberVinciAgent({ ...f.options, requiredToolCalls: [GETTER] }), fails('REQUIRED_TOOL_NOT_ALLOWED'));
    for (const key of ['CYBERVINCI_CONFIG', 'cybervinci_config_content', 'CYBERVINCI_PERMISSION', 'CYBERVINCI_PURE', 'NODE_OPTIONS']) {
        await assert.rejects(executeCyberVinciAgent({ ...f.options, policy: { ...f.options.policy, env: { [key]: 'bad' } } }), fails('RESERVED_ENV'));
    }
    await assert.rejects(fs.stat(f.capture), { code: 'ENOENT' });
});

test('host-reviewed opaque tool IDs are allowed without prefix inference; mutable call runs once', async t => {
    const f = await setup(t, { events: [start(), tool(WRITER), finish('tool-calls'), ...success()] });
    const result = await executeCyberVinciAgent({ ...f.options, nativeToolsIds: [WRITER], readonly: false, requiredToolCalls: [WRITER] });
    assert.equal(result.trace[0].toolId, WRITER);
    assert.equal((await f.records()).length, 1);
    const opaque = await setup(t, { events: [start(), tool('host_reviewed_snapshot'), finish('tool-calls'), ...success()] });
    assert.equal((await executeCyberVinciAgent({ ...opaque.options, nativeToolsIds: ['host_reviewed_snapshot'],
        policy: { ...opaque.options.policy, readonlyTools: ['host_reviewed_snapshot'] } })).trace.length, 1);
});

test('permission alias groups fail closed for every partial request or incomplete host classification before spawn', async t => {
    const f = await setup(t);
    for (const group of [READ_GROUP, EDIT_GROUP]) {
        const options = { ...f.options, readonly: group === READ_GROUP,
            policy: { ...f.options.policy, readonlyTools: READ_GROUP, writableTools: EDIT_GROUP } };
        for (let mask = 1; mask < (1 << group.length) - 1; mask++) {
            const nativeToolsIds = group.filter((_, i) => mask & (1 << i));
            await assert.rejects(executeCyberVinciAgent({ ...options, nativeToolsIds }), fails('INCOMPLETE_TOOL_ALIAS_GROUP'));
        }
        for (const missing of group) {
            const policy = { ...options.policy, readonlyTools: READ_GROUP.filter(id => id !== missing), writableTools: EDIT_GROUP.filter(id => id !== missing) };
            await assert.rejects(executeCyberVinciAgent({ ...options, policy, nativeToolsIds: group }), fails('UNKNOWN_TOOL'));
        }
    }
    await assert.rejects(executeCyberVinciAgent({ ...f.options, readonly: true, nativeToolsIds: EDIT_GROUP,
        policy: { ...f.options.policy, writableTools: EDIT_GROUP } }), fails('READONLY_TOOL'));
    await assert.rejects(fs.stat(f.capture), { code: 'ENOENT' });
});

test('complete trusted alias groups grant exactly the declared IDs and preserve native trace IDs', async t => {
    for (const group of [READ_GROUP, EDIT_GROUP]) {
        const f = await setup(t, { events: [start(), ...group.map(id => tool(id)), finish(), ...success()] });
        const result = await executeCyberVinciAgent({ ...f.options, readonly: group === READ_GROUP, nativeToolsIds: group, requiredToolCalls: group,
            policy: { ...f.options.policy, readonlyTools: READ_GROUP, writableTools: EDIT_GROUP } });
        assert.deepEqual(result.trace.map(call => call.toolId), group);
        assert.deepEqual(result.output, { output: { ok: true } });
        const [record] = await f.records();
        const config = JSON.parse(record.env.CYBERVINCI_CONFIG_CONTENT);
        const permission = Object.fromEntries([['*', 'deny'], ...group.map(id => [id, 'allow'])]);
        assert.deepEqual(config.permission, permission);
        assert.deepEqual(config.agent[config.default_agent].permission, permission);
        assert.equal((await f.records()).length, 1);
    }
});

test('native runtime env opt-in is blocked exactly and values/content keys never escape', async t => {
    const f = await setup(t);
    for (const key of ['CYBERVINCI_EXPERIMENTAL_NATIVE_LLM', 'cybervinci_experimental_native_llm']) {
        for (const value of ['true', '1', 'false', 'SECRET_CONTENT_KEY']) {
            await assert.rejects(executeCyberVinciAgent({ ...f.options,
                policy: { ...f.options.policy, env: { ...f.options.policy.env, [key]: value } } }), error => {
                fails('RESERVED_ENV')(error);
                assert.doesNotMatch(JSON.stringify(error), /SECRET_CONTENT_KEY|CYBERVINCI_EXPERIMENTAL_NATIVE_LLM/);
                return true;
            });
        }
    }
    await assert.rejects(fs.stat(f.capture), { code: 'ENOENT' });
    const result = await executeCyberVinciAgent({ ...f.options, policy: { ...f.options.policy,
        env: { ...f.options.policy.env, CYBERVINCI_EXPERIMENTAL_OUTPUT_TOKEN_MAX: '2048', HOST_CONTENT_KEY: 'SECRET_CONTENT_VALUE' } } });
    const [record] = await f.records();
    assert.equal(record.env.CYBERVINCI_EXPERIMENTAL_OUTPUT_TOKEN_MAX, '2048');
    assert.equal(record.env.CYBERVINCI_EXPERIMENTAL_NATIVE_LLM, 'false');
    assert.doesNotMatch(JSON.stringify(result), /HOST_CONTENT_KEY|SECRET_CONTENT_VALUE/);
});

test('verifies canonical attachment paths, SHA-256 and ordered aggregate digest, passes --file', async t => {
    const f = await setup(t);
    const file = path.join(f.root, 'image with spaces.png');
    const bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
    await fs.writeFile(file, bytes);
    const canonical = await fs.realpath(file);
    const result = await executeCyberVinciAgent({ ...f.options, attachments: [{ path: file, digest: sha(bytes).slice(7).toUpperCase() }],
        policy: { ...f.options.policy, maxAttachmentBytes: bytes.length } });
    assert.equal(result.attachmentsDigest, sha(JSON.stringify([{ path: canonical, digest: sha(bytes), bytes: bytes.length }])));
    const [record] = await f.records();
    assert.equal(record.argv[record.argv.indexOf('--file') + 1], canonical);
    assert.deepEqual(JSON.parse(record.env.CYBERVINCI_CONFIG_CONTENT).permission, { '*': 'deny' });
    assert.ok(!record.argv.includes(sha(bytes)));
});

test('attachment bounds, digest, regular file, traversal and sibling-prefix escapes fail before spawn', async t => {
    const f = await setup(t);
    const allowed = path.join(f.root, 'allowed');
    const sibling = path.join(f.root, 'allowed-sibling');
    await fs.mkdir(allowed);
    await fs.mkdir(sibling);
    const file = path.join(allowed, 'a.png');
    const outside = path.join(sibling, 'a.png');
    await fs.writeFile(file, 'abcd');
    await fs.writeFile(outside, 'abcd');
    const options = { ...f.options, policy: { ...f.options.policy, allowedAttachmentRoots: [allowed], maxAttachmentBytes: 4 } };
    const attachment = { path: file, digest: sha('abcd') };
    await assert.rejects(executeCyberVinciAgent({ ...options, attachments: [{ ...attachment, digest: sha('other') }] }), fails('ATTACHMENT_DIGEST'));
    await assert.rejects(executeCyberVinciAgent({ ...options, attachments: [attachment], policy: { ...options.policy, maxAttachmentBytes: 3 } }), fails('ATTACHMENT_LIMIT'));
    await assert.rejects(executeCyberVinciAgent({ ...options, attachments: [attachment, attachment] }), fails('ATTACHMENT_LIMIT'));
    for (const escaped of [outside, path.join(allowed, '..', 'allowed-sibling', 'a.png')]) {
        await assert.rejects(executeCyberVinciAgent({ ...options, attachments: [{ ...attachment, path: escaped }] }), fails('ATTACHMENT_OUTSIDE_ROOT'));
    }
    const directory = path.join(allowed, 'directory');
    await fs.mkdir(directory);
    await assert.rejects(executeCyberVinciAgent({ ...options, attachments: [{ ...attachment, path: directory }] }), fails('ATTACHMENT_NOT_REGULAR'));
    await assert.rejects(executeCyberVinciAgent({ ...options, attachments: [{ ...attachment, path: 'relative.png' }] }), fails('INVALID_ATTACHMENT'));
    await assert.rejects(executeCyberVinciAgent({ ...options, attachments: [{ ...attachment, digest: 'invalid' }] }), fails('INVALID_ATTACHMENT'));
    await assert.rejects(executeCyberVinciAgent({ ...options, attachments: [attachment], policy: { ...options.policy, allowedAttachmentRoots: [] } }), fails('ATTACHMENT_OUTSIDE_ROOT'));
    await assert.rejects(fs.stat(f.capture), { code: 'ENOENT' });
});

test('realpath rejects a Windows junction (or POSIX symlink) escaping an allowed root', async t => {
    const f = await setup(t);
    const allowed = path.join(f.root, 'allowed');
    const outside = path.join(f.root, 'outside');
    await fs.mkdir(allowed);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'image.png'), 'image');
    await fs.symlink(outside, path.join(allowed, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(executeCyberVinciAgent({ ...f.options,
        attachments: [{ path: path.join(allowed, 'escape', 'image.png'), digest: sha('image') }],
        policy: { ...f.options.policy, allowedAttachmentRoots: [allowed] } }), fails('ATTACHMENT_OUTSIDE_ROOT'));
});

test('parses only final main-session text, sums step usage, proves tools and redacts media/input/output', async t => {
    const media = 'data:image/png;base64,U0VDUkVUX01FRElB';
    const f = await setup(t, { chunked: true, events: [
        start(), text({ output: { fake: 'early JSON' } }),
        tool(GETTER, { attachments: [{ type: 'file', mime: 'image/png', filename: 'SECRET_FILE.png', url: media }] }), finish('tool-calls'),
        start(), event('reasoning', { text: 'SECRET_REASONING', time: { end: 2 } }),
        text('{"output":'), text('{"ok":true,"label":"\u00e7"}}'), finish()
    ] });
    const result = await executeCyberVinciAgent({ ...f.options, nativeToolsIds: [GETTER], requiredToolCalls: [GETTER] });
    assert.deepEqual(result.output, { output: { ok: true, label: '\u00e7' } });
    assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 6, reasoningTokens: 4, cacheReadTokens: 8, cacheWriteTokens: 2, totalTokens: 40, cost: 0.5, steps: 2 });
    assert.equal(result.trace[0].status, 'completed');
    assert.match(result.trace[0].callID, /^call_/);
    assert.deepEqual(result.trace[0].attachments, [{ mime: 'image/png', digest: sha(media) }]);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|base64|U0VDUkVU|fake|early JSON/);
});

test('stop with a completed local tool resumes to a final tool-free JSON step', async t => {
    const local = tool(GETTER, { output: '{"SECRET_CONTENT_KEY":"TOOL_SECRET"}' });
    local.part.metadata = { providerExecuted: false, SECRET_CONTENT_KEY: 'SECRET_METADATA' };
    const f = await setup(t, { events: [
        start(), text({ output: { fake: 'SECRET_EARLY_ENVELOPE' } }), local, finish(),
        event('step_start', {}, 'msg_final'),
        event('text', { text: '{"output":{"ok":true}}', time: { end: 2 } }, 'msg_final'),
        event('step_finish', { reason: 'stop', tokens, cost: 0.5 }, 'msg_final')
    ] });
    const result = await executeCyberVinciAgent({ ...f.options, nativeToolsIds: [GETTER], requiredToolCalls: [GETTER] });
    assert.deepEqual(result.output, { output: { ok: true } });
    assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 6, reasoningTokens: 4, cacheReadTokens: 8, cacheWriteTokens: 2, totalTokens: 40, cost: 0.75, steps: 2 });
    assert.deepEqual(result.trace, [{ toolId: GETTER, status: 'completed', callID: local.part.callID, attachments: [] }]);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|fake|providerExecuted/);
    assert.equal((await f.records()).length, 1);
});

test('provider-executed tools cannot prove a required local getter', async t => {
    const remote = tool();
    remote.part.metadata = { providerExecuted: true };
    const f = await setup(t, { events: [start(), remote, finish('tool-calls'), ...success()] });
    await assert.rejects(executeCyberVinciAgent({ ...f.options, nativeToolsIds: [GETTER], requiredToolCalls: [GETTER] }), fails('MISSING_REQUIRED_TOOL'));
});

test('rejects tool-only output, missing proof, errors, unknown events/finishes and other-session text', async t => {
    const remote = tool();
    remote.part.metadata = { providerExecuted: true };
    const cases = [
        ['INCOMPLETE_OUTPUT', [start(), tool(), finish()]],
        ['INCOMPLETE_OUTPUT', [start(), text('{"SECRET_CONTENT_KEY":true}'), tool(), finish()]],
        ['INVALID_STEP', [...success(), ...success()]],
        ['INVALID_STEP', [start(), remote, finish(), ...success()]],
        ['INCOMPLETE_OUTPUT', [start(), remote, text('{}'), finish()]],
        ['MISSING_REQUIRED_TOOL', success()],
        ['TOOL_ERROR', [start(), tool(GETTER, { status: 'error', error: 'TOOL_SECRET' }), ...success()]],
        ['INVALID_TOOL_EVENT', [start(), tool(GETTER, { status: 'running' }), ...success()]],
        ['INVALID_TOOL_EVENT', [start(), tool(GETTER, { output: undefined }), finish()]],
        ['INVALID_TOOL_EVENT', [...success(), tool()]],
        ['INVALID_TOOL_EVENT', [start(), finish('tool-calls'), tool(), ...success()]],
        ['INVALID_STEP', [start(), tool(), finish(), event('step_start', {}, 'msg_next'), tool()]],
        ['CLI_ERROR', [start(), { type: 'error', sessionID: 'ses_main', error: { message: 'TOOL_SECRET' } }, ...success()]],
        ['UNKNOWN_EVENT', [start(), { type: 'finish', sessionID: 'ses_main' }]],
        ['INVALID_FINISH', [start(), text({ output: {} }), finish('unknown')]],
        ['INVALID_FINISH', [start(), text({ output: {} }), finish('length')]],
        ['INVALID_FINISH', [start(), text({ output: {} }), finish('error')]],
        ['INVALID_FINISH', [start(), text({ output: {} }), finish('content-filter')]],
        ['INCOMPLETE_OUTPUT', [start(), text({ output: {} })]],
        ['INCOMPLETE_OUTPUT', [start(), text({ output: {} }), finish('tool-calls')]],
        ['SESSION_MISMATCH', [start(), { ...text({ output: {} }), sessionID: 'ses_other' }, finish()]],
        ['SESSION_MISMATCH', [start(), event('text', { text: '{}', sessionID: 'ses_child', time: { end: 2 } }), finish()]],
        ['INVALID_STEP', [start(), event('text', { text: '{}', time: { end: 2 } }, 'msg_other'), finish()]],
        ['UNAUTHORIZED_TOOL_TRACE', [start(), tool(WRITER), finish()]],
        ['INVALID_JSON_OBJECT', [start(), text('[]'), finish()]],
        ['INVALID_JSON', [start(), text('```json\n{}\n```'), finish()]],
        ['INVALID_USAGE', [start(), text('{}'), event('step_finish', { reason: 'stop', cost: 0, tokens: { ...tokens, input: -1 } })]]
    ];
    for (const [code, events] of cases) await t.test(code, async t => {
        const f = await setup(t, { events });
        await assert.rejects(executeCyberVinciAgent({ ...f.options, nativeToolsIds: [GETTER], requiredToolCalls: code === 'MISSING_REQUIRED_TOOL' ? [GETTER] : [] }), fails(code));
        assert.equal((await f.records()).length, 1);
    });
});

test('malformed NDJSON and nonzero exits fail without leaking stderr or retrying', async t => {
    for (const spec of [{ raw: 'STDERR_SECRET\n' }, { exit: 2, stderr: 'STDERR_SECRET' }]) {
        const f = await setup(t, spec);
        await assert.rejects(executeCyberVinciAgent(f.options), fails(spec.exit ? 'EXIT_FAILED' : 'INVALID_JSON'));
        assert.equal((await f.records()).length, 1);
    }
});

async function waitReady(file) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const value = await fs.readFile(file, 'utf8').catch(() => undefined);
        if (value) return JSON.parse(value);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('fixture did not start');
}

function alive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

test('timeout, cancellation and output limits kill only the owned child tree, without retry', async t => {
    for (const mode of ['timeout', 'cancel', 'stdout', 'stderr']) await t.test(mode, async t => {
        const f = await setup(t, { hang: true, flood: ['stdout', 'stderr'].includes(mode) ? mode : undefined });
        const controller = new AbortController();
        const pending = executeCyberVinciAgent({ ...f.options, timeoutMs: mode === 'timeout' ? 1_000 : 5_000,
            signal: controller.signal, policy: { ...f.options.policy, maxOutputBytes: 1024 } });
        const rejected = assert.rejects(pending, fails(mode === 'timeout' ? 'TIMEOUT' : mode === 'cancel' ? 'CANCELLED' : 'OUTPUT_LIMIT'));
        const pids = await waitReady(f.ready);
        if (mode === 'cancel') controller.abort('TOOL_SECRET');
        await rejected;
        assert.equal(alive(pids.pid), false);
        // POSIX orphan reaping may lag behind process-group termination.
        for (let i = 0; i < 50 && alive(pids.child); i++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(alive(pids.child), false);
        assert.equal(alive(process.pid), true);
        assert.equal((await f.records()).length, 1);
    });
});

test('pre-cancelled signals and invalid limits never launch a process; spawn failures do not retry', async t => {
    const f = await setup(t);
    await assert.rejects(executeCyberVinciAgent({ ...f.options, signal: AbortSignal.abort('TOOL_SECRET') }), fails('CANCELLED'));
    for (const timeoutMs of [0, -1, NaN, Infinity]) await assert.rejects(executeCyberVinciAgent({ ...f.options, timeoutMs }), fails('INVALID_LIMIT'));
    await assert.rejects(executeCyberVinciAgent({ ...f.options, executable: path.join(f.root, 'missing.exe') }), fails('SPAWN_FAILED'));
    await assert.rejects(fs.stat(f.capture), { code: 'ENOENT' });
});

test('Windows taskkill failure reports an uncertain outcome instead of hanging or retrying', { skip: process.platform !== 'win32' }, async t => {
    const root = process.env.SystemRoot;
    let pids;
    // Register before setup's directory cleanup: Windows holds the child's cwd open.
    t.after(async () => {
        process.env.SystemRoot = root;
        if (!pids) return;
        await new Promise((resolve, reject) => execFile(path.join(root, 'System32', 'taskkill.exe'), ['/PID', String(pids.pid), '/T', '/F'],
            { windowsHide: true, env: { SystemRoot: root }, timeout: 5_000 }, error => error ? reject(error) : resolve()));
    });
    const f = await setup(t, { hang: true });
    const controller = new AbortController();
    const pending = executeCyberVinciAgent({ ...f.options, signal: controller.signal });
    const rejected = assert.rejects(pending, fails('TERMINATION_FAILED'));
    pids = await waitReady(f.ready);
    process.env.SystemRoot = path.join(f.root, 'missing-system-root');
    controller.abort();
    await rejected;
    assert.equal((await f.records()).length, 1);
});
