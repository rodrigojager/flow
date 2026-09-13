'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { runProductionQueue, retryProductionPreparation } = require('../lib/production-loop');
const { FlowStudioFileRunStore } = require('../lib/run-store');
const { validateFlowStudioGraph } = require('@cybervinci/flow-shared');

const hash = text => createHash('sha256').update(text).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Explicitly synthetic transport/score fixtures, NOT actual asset evaluations.
function syntheticReview(role, args) {
    const m = args.frozen.manifest;
    const binding = { role, invocationId: `${args.assetId}-${args.revision}-${role}-invocation`,
        sessionId: `${args.assetId}-${args.revision}-${role}-session`, attachmentsDigest: hash('synthetic attachments'),
        manifestHash: m.manifestHash, evidenceIds: [...m.requiredEvidence] };
    const output = {
        assetId: m.assetId, revision: m.revision, scopeHash: m.scopeHash, rubricHash: m.rubricHash,
        referenceHash: m.referenceHash, manifestHash: m.manifestHash, status: 'PASS',
        criteria: Array.from({ length: 10 }, (_, i) => ({ id: `C${i + 1}`, score: 10,
            justification: 'Synthetic unit-test assertion only.', evidenceIds: [...m.requiredEvidence] })),
        total: 100, coveredRequirements: [...m.requiredRequirements], inspectedEvidence: [...m.requiredEvidence],
        open_findings: [], unverified: [], improvements: [], resolvedFindingIds: [...args.unresolvedByRole[role]]
    };
    return { assignment: { ...binding, output }, visualReceipt: { ...binding, verified: true }, rawReport: JSON.stringify(output) };
}

async function fixture(t, overrides = {}) {
    const parent = path.join(os.tmpdir(), 'cybervinci');
    await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, 'production-loop-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const stateDir = path.join(root, 'control'), artifact = path.join(root, 'synthetic-asset.txt');
    const calls = [];
    const state = () => fs.readFile(path.join(stateDir, 'queue.json'), 'utf8').then(JSON.parse);
    const store = new FlowStudioFileRunStore(path.join(stateDir, 'runs'));
    const adapters = {
        reviewEffect: 'network', reviewEndpoint: 'https://synthetic.invalid/review',
        async prepare(args) {
            const persisted = await state();
            assert.equal(persisted.pending.runId, args.runId, 'run ID precedes every host callback');
            assert.ok(persisted.runIds.includes(args.runId));
            assert.equal(args.stateDir, undefined);
            calls.push(`prepare:${args.assetId}:${args.revision}`);
            return { status: 'READY', brief: { scope: 'entire synthetic asset', family: args.entry.family } };
        },
        async produce(args) {
            const record = await store.get(args.runId);
            const effect = record.effects.find(e => e.nodeId === 'produce');
            assert.equal(effect.status, 'started', 'whole invocation has persisted write-ahead');
            assert.equal(effect.kind, 'command');
            assert.equal(effect.idempotencyKey, `${args.idempotencyKey}:produce`);
            calls.push(`produce:${args.assetId}:${args.revision}`);
            await fs.writeFile(artifact, `synthetic:${args.assetId}:${args.revision}`);
            return { invocationId: `${args.assetId}-${args.revision}-producer-invocation`,
                sessionId: `${args.assetId}-${args.revision}-producer-session`, trustedReceipt: 'synthetic-receipt' };
        },
        async freeze(args) {
            calls.push(`freeze:${args.assetId}:${args.revision}`);
            return { manifest: { assetId: args.assetId, revision: args.revision, scopeHash: hash('full scope'),
                rubricHash: hash('ten synthetic criteria'), referenceHash: hash('synthetic references'),
                manifestHash: hash(await fs.readFile(artifact)), requiredRequirements: ['full-scope'], requiredEvidence: ['view-all'],
                producerInvocationId: args.receipt.invocationId }, producerSessionId: args.receipt.sessionId,
                visualProbePassed: true, signature: 'synthetic-signature' };
        },
        async verifyFrozen(args) {
            calls.push(`verify:${args.phase}:${args.assetId}:${args.revision}`);
            return hash(await fs.readFile(artifact)) === args.frozen.manifest.manifestHash && args.frozen.signature === 'synthetic-signature';
        },
        async review(role, args) {
            calls.push(`review:${role}:${args.assetId}:${args.revision}`);
            return syntheticReview(role, args);
        },
        ...overrides
    };
    const options = { stateDir, queue: [{ id: 'a', family: 'same-a' }, { id: 'b', family: 'same-b' }],
        adapters, maxRevisionsPerSession: 6, timeoutMs: 10_000 };
    return { root, artifact, options, calls, state, store };
}

test('real graph: REVISE then ACCEPT, next ID only after atomic approval; ledger and raw history', async t => {
    const f = await fixture(t);
    let concurrent = 0, peak = 0;
    const both = new Map();
    f.options.adapters.review = async (role, args) => {
        concurrent++; peak = Math.max(peak, concurrent);
        const key = `${args.assetId}:${args.revision}`;
        let pair = both.get(key);
        if (!pair) both.set(key, pair = { arrived: 0, done: deferred() });
        if (++pair.arrived === 2) pair.done.resolve();
        await pair.done.promise;
        const result = syntheticReview(role, args);
        if (args.assetId === 'a' && args.revision === 1 && role === 'artistic') {
            result.assignment.output.criteria[0].score = 9; result.assignment.output.total = 99;
            result.assignment.output.improvements = [{ id: 'A-detail', criterionId: 'C1',
                justification: 'Synthetic improvement.', evidenceIds: ['view-all'] }];
        }
        if (args.assetId === 'a' && args.revision === 2) {
            assert.deepEqual(args.unresolvedByRole.artistic, ['A-detail']);
            assert.equal(args.history[0].outputs.artistic.assignment.output.total, 99);
        }
        concurrent--;
        return result;
    };
    const prepare = f.options.adapters.prepare;
    f.options.adapters.prepare = async args => {
        if (args.assetId === 'b') {
            const saved = await f.state();
            assert.equal(saved.current, 1); assert.equal(saved.approvals[0].assetId, 'a');
            assert.equal(saved.history.length, 2); assert.equal(saved.revision, 1);
        }
        return prepare(args);
    };
    const state = await runProductionQueue(f.options);
    assert.equal(state.status, 'COMPLETED', JSON.stringify(state.reasons));
    assert.equal(peak, 2);
    assert.deepEqual(f.calls.filter(c => c.startsWith('produce')), ['produce:a:1', 'produce:a:2', 'produce:b:1']);
    assert.deepEqual(state.history.map(h => h.result.verdict), ['REVISE', 'ACCEPT', 'ACCEPT']);
    assert.deepEqual(state.approvals.map(a => [a.assetId, a.revision]), [['a', 2], ['b', 1]]);
    assert.equal(state.pending, undefined);
    assert.deepEqual(await f.state(), state);
    const record = await f.store.get(state.runIds[0]);
    assert.equal(validateFlowStudioGraph(record.graph).valid, true);
    assert.equal(record.graph.nodes.find(n => n.id === 'joined').join.strategy, 'all');
    assert.equal(record.events.filter(e => e.kind === 'node.enter' && e.nodeId === 'finalize').length, 1);
    assert.equal(record.events.filter(e => e.kind === 'branch.started').length, 2);
    assert.deepEqual(record.effects.map(e => e.nodeId).sort(), ['artistic', 'finalize', 'freeze', 'prepare', 'produce', 'technical', 'verify']);
    assert.ok(record.effects.every(e => e.status === 'completed'));
    assert.equal(record.effects.find(e => e.nodeId === 'produce').output.produce.trustedReceipt, 'synthetic-receipt');
    assert.deepEqual(record.effects.find(e => e.nodeId === 'freeze').output.freeze, state.history[0].outputs.freeze);
    assert.equal(record.effects.find(e => e.nodeId === 'artistic').output.artistic.rawReport, state.history[0].outputs.artistic.rawReport);
    assert.ok(record.graph.nodes.flatMap(n => n.tools || []).every(tool => tool.command.startsWith('host:') && tool.retries === 0));
    const count = f.calls.length;
    await runProductionQueue(f.options);
    assert.equal(f.calls.length, count, 'completed queue does not rerun');
});

test('BLOCKED enters real wait checkpoint once, no producer and no busy retry', async t => {
    let prepares = 0;
    const f = await fixture(t, { prepare: async () => { prepares++; return { status: 'BLOCKED', reasons: ['Missing reference.'] }; } });
    const state = await runProductionQueue(f.options);
    assert.equal(state.status, 'WAITING'); assert.equal(state.current, 0); assert.equal(state.revision, 1);
    assert.deepEqual(state.reasons, ['Missing reference.']); assert.deepEqual(f.calls, []);
    const record = await f.store.get(state.pending.runId);
    assert.equal(record.status, 'waiting');
    assert.equal(record.checkpoints.find(c => c.id === state.history[0].checkpointId).reason, 'wait');
    await runProductionQueue(f.options);
    assert.equal(prepares, 1);
});

for (const mode of ['duplicate session', '99 points', 'no evidence', 'missing visual receipt', 'swapped roles', 'partial full scope']) {
    test(`${mode}: never advances asset or creates approval`, async t => {
        const f = await fixture(t, { review: async (role, args) => {
            const review = syntheticReview(role, args), output = review.assignment.output;
            if (mode === 'duplicate session') review.assignment.sessionId = review.visualReceipt.sessionId = 'shared-judge-session';
            if (mode === '99 points') { output.criteria[9].score = 9; output.total = 99; }
            if (mode === 'no evidence') output.inspectedEvidence = [];
            if (mode === 'missing visual receipt') delete review.visualReceipt;
            if (mode === 'swapped roles') review.assignment.role = review.visualReceipt.role = role === 'artistic' ? 'technical' : 'artistic';
            if (mode === 'partial full scope') output.coveredRequirements = ['unrecognized-scope'];
            return review;
        } });
        f.options.maxRevisionsPerSession = 1;
        const state = await runProductionQueue(f.options);
        assert.equal(state.current, 0); assert.deepEqual(state.approvals, []);
        assert.equal(state.status, mode === '99 points' ? 'PAUSED' : 'WAITING');
        assert.equal(state.revision, mode === '99 points' ? 2 : 1);
        assert.equal(state.history[0].result.verdict, mode === '99 points' ? 'REVISE' : 'WAIT');
        assert.deepEqual(f.calls.filter(c => c.startsWith('produce')), ['produce:a:1']);
    });
}

test('finite revision/assets budgets pause, preserve outstanding IDs and resume only from safe boundary', async t => {
    const f = await fixture(t, { review: async (role, args) => {
        const review = syntheticReview(role, args);
        if (args.revision === 1 && role === 'artistic') review.assignment.output.open_findings = [
            { id: 'old-id', criterionId: 'C1', justification: 'Synthetic defect.', evidenceIds: ['view-all'] }];
        if (args.revision === 2) review.assignment.output.resolvedFindingIds = [];
        return review;
    } });
    f.options.maxRevisionsPerSession = 1;
    const first = await runProductionQueue(f.options);
    assert.equal(first.status, 'PAUSED'); assert.deepEqual(first.unresolvedByRole.artistic, ['old-id']);
    const second = await runProductionQueue(f.options);
    assert.equal(second.current, 0); assert.equal(second.revision, 3);
    assert.deepEqual(second.unresolvedByRole.artistic, ['old-id'], 'dropping finding ID never clears history');
    f.options.maxRevisionsPerSession = 10; f.options.maxAssetsPerSession = 1;
    const third = await runProductionQueue(f.options);
    assert.equal(third.status, 'PAUSED'); assert.equal(third.current, 1); assert.equal(third.revision, 1);
    assert.equal(third.approvals[0].revision, 3); assert.equal(third.pending, undefined);
});

test('catalog identity pinned; input/callback mutation cannot edit owner state', async t => {
    const f = await fixture(t);
    const prepare = f.options.adapters.prepare;
    f.options.adapters.prepare = async args => {
        const result = await prepare(args);
        args.entry.id = 'injected'; args.unresolvedByRole.artistic.push('injected'); args.history.length = 0;
        f.options.queue[0].family = 'external input mutation';
        return result;
    };
    const original = structuredClone(f.options.queue);
    const state = await runProductionQueue({ ...f.options, maxAssetsPerSession: 1 });
    assert.equal(state.approvals[0].assetId, 'a'); assert.deepEqual(state.queue, original);
    await assert.rejects(runProductionQueue(f.options), /changed catalog/);
    await assert.rejects(runProductionQueue({ ...f.options, queue: original.toReversed() }), /changed catalog/);
    assert.equal(f.calls.filter(c => c.startsWith('produce')).length, 1);
});

test('exclusive queue lock spans the entire producer; existing stale/malformed lock is explicitly rejected', { timeout: 15_000 }, async t => {
    const entered = deferred(), finish = deferred();
    const f = await fixture(t);
    const produce = f.options.adapters.produce;
    f.options.adapters.produce = async args => { entered.resolve(); await finish.promise; return produce(args); };
    const running = runProductionQueue(f.options);
    await Promise.race([entered.promise, running.then(state => assert.fail(JSON.stringify(state.reasons)))]);
    await assert.rejects(runProductionQueue(f.options), /queue locked/);
    finish.resolve(); await running;
    await fs.writeFile(path.join(f.options.stateDir, 'queue.lock'), 'malformed stale owner');
    await assert.rejects(runProductionQueue(f.options), /verify owner PID/);
    assert.equal(await fs.readFile(path.join(f.options.stateDir, 'queue.lock'), 'utf8'), 'malformed stale owner');
});

for (const mode of ['throw', 'timeout', 'cancel']) {
    test(`mutable ${mode} is uncertain, pauses queue, no duplicate invocation on next call`, async t => {
        let produces = 0;
        const abort = new AbortController();
        const f = await fixture(t, { produce: async args => {
            produces++;
            if (mode === 'throw') throw new Error('Lost producer acknowledgement.');
            const stopped = new Promise((resolve, reject) => args.signal.addEventListener('abort', () => reject(new Error('Synthetic interruption.')), { once: true }));
            if (mode === 'cancel') abort.abort();
            return stopped;
        } });
        f.options.signal = abort.signal;
        if (mode === 'timeout') f.options.timeoutMs = 500;
        const state = await runProductionQueue(f.options);
        assert.equal(state.status, 'WAITING'); assert.equal(state.current, 0); assert.equal(state.revision, 1);
        const record = await f.store.get(state.pending.runId);
        assert.equal(record.effects.find(e => e.nodeId === 'produce').status, 'uncertain');
        assert.equal(state.history.length, 1);
        await runProductionQueue({ ...f.options, signal: undefined });
        assert.equal(produces, 1);
    });
}

test('non-cooperative timed-out producer retains host lock until it settles', async t => {
    const finish = deferred();
    const f = await fixture(t, { produce: async () => finish.promise });
    const state = await runProductionQueue({ ...f.options, timeoutMs: 500 });
    assert.equal(state.status, 'WAITING');
    await assert.rejects(runProductionQueue(f.options), /queue locked/);
    finish.resolve({ invocationId: 'late', sessionId: 'late' });
    for (let i = 0; i < 100; i++) {
        try { await fs.access(path.join(f.options.stateDir, 'queue.lock')); await delay(10); }
        catch (error) { if (error.code !== 'ENOENT') throw error; break; }
    }
    const restarted = await runProductionQueue(f.options);
    assert.equal(restarted.status, 'WAITING'); assert.equal(restarted.runIds.length, 1);
    assert.equal(restarted.history[0].outputs.produce, undefined, 'late output never becomes confirmed');
});

for (const mode of ['hash mutation', 'signature mutation', 'pre-review failure', 'wrong producer binding', 'failed visual probe']) {
    test(`${mode}: verifyFrozen/binding fail closed`, async t => {
        const f = await fixture(t);
        const freeze = f.options.adapters.freeze, review = f.options.adapters.review;
        f.options.adapters.freeze = async args => {
            const frozen = await freeze(args);
            if (mode === 'pre-review failure') await fs.writeFile(f.artifact, 'changed before review');
            if (mode === 'wrong producer binding') frozen.manifest.producerInvocationId = 'unbound-producer';
            if (mode === 'failed visual probe') frozen.visualProbePassed = false;
            return frozen;
        };
        let signature = 'synthetic-signature';
        const verify = f.options.adapters.verifyFrozen;
        f.options.adapters.verifyFrozen = async args => await verify(args) && signature === args.frozen.signature;
        f.options.adapters.review = async (role, args) => {
            const result = await review(role, args);
            if (mode === 'hash mutation') await fs.writeFile(f.artifact, 'changed during review');
            if (mode === 'signature mutation') signature = 'changed signature';
            return result;
        };
        const state = await runProductionQueue(f.options);
        assert.equal(state.status, 'WAITING'); assert.equal(state.current, 0); assert.equal(state.approvals.length, 0);
        assert.equal(state.history[0].result.verdict, 'WAIT');
        assert.equal(f.calls.filter(c => c.startsWith('review')).length, ['pre-review failure', 'wrong producer binding', 'failed visual probe'].includes(mode) ? 0 : 2);
    });
}

test('actual process interruption: persisted pending/run ID blocks restart before any callbacks', async t => {
    const f = await fixture(t);
    const source = `
        const { runProductionQueue } = require(process.argv[1]);
        setInterval(() => {}, 1000);
        runProductionQueue({ stateDir: process.argv[2], queue: ['a', 'b'], maxRevisionsPerSession: 2,
            adapters: { prepare: async () => ({ status: 'READY', brief: 'Synthetic crash fixture' }),
                produce: async args => { process.send({ runId: args.runId }); return new Promise(() => {}); },
                freeze: async () => { throw new Error('Unexpected freeze after interrupted producer.'); },
                verifyFrozen: async () => false,
                review: async () => { throw new Error('Unexpected review after interrupted producer.'); } }
        }).catch(error => { process.send({ error: error.message }); process.exitCode = 1; });
    `;
    const child = spawn(process.execPath, ['-e', source, require.resolve('../lib/production-loop'), f.options.stateDir],
        { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(10_000) });
    assert.equal(message.error, undefined);
    const before = await f.state();
    assert.equal(before.pending.runId, message.runId); assert.deepEqual(before.runIds, [message.runId]);
    const record = await f.store.get(message.runId);
    assert.equal(record.effects.find(e => e.nodeId === 'produce').status, 'started');
    const exited = once(child, 'exit'); child.kill(); await exited;
    await assert.rejects(runProductionQueue({ ...f.options, queue: ['a', 'b'] }), /queue locked/);
    assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH');
    // Explicit test-host recovery only after confirming the dead PID. No effect replay.
    await fs.unlink(path.join(f.options.stateDir, 'queue.lock'));
    const state = await runProductionQueue({ ...f.options, queue: ['a', 'b'] });
    assert.equal(state.status, 'WAITING'); assert.equal(state.current, 0);
    assert.equal(state.pending.runId, message.runId); assert.deepEqual(f.calls, []);
    assert.equal((await f.store.get(message.runId)).effects.find(e => e.nodeId === 'produce').status, 'started');
});

test('rejects non-finite budgets/duplicate IDs; already-aborted signal creates no run', async t => {
    const f = await fixture(t);
    for (const maxRevisionsPerSession of [undefined, 0, -1, Infinity, NaN, 1.5]) {
        await assert.rejects(runProductionQueue({ ...f.options, maxRevisionsPerSession }), /finite positive/);
    }
    await assert.rejects(runProductionQueue({ ...f.options, queue: ['a', { id: 'a' }] }), /unique nonblank/);
    const state = await runProductionQueue({ ...f.options, signal: AbortSignal.abort() });
    assert.equal(state.status, 'PAUSED'); assert.deepEqual(state.runIds, []); assert.deepEqual(f.calls, []);
});

test('freeze command and remote reviewer exceptions are uncertain; partial raw reports survive', async t => {
    for (const step of ['freeze', 'review']) {
        const f = await fixture(t);
        if (step === 'freeze') f.options.adapters.freeze = async () => { throw new Error('Freeze acknowledgement lost.'); };
        else f.options.adapters.review = async (role, args) => {
            if (role === 'artistic') throw new Error('Remote response lost.');
            return syntheticReview(role, args);
        };
        const state = await runProductionQueue(f.options);
        assert.equal(state.status, 'WAITING'); assert.equal(state.current, 0);
        const record = await f.store.get(state.pending.runId);
        assert.equal(record.effects.find(e => e.nodeId === (step === 'freeze' ? 'freeze' : 'artistic')).status, 'uncertain');
        if (step === 'review') assert.equal(state.history[0].outputs.technical.assignment.output.total, 100);
        const count = f.calls.length;
        await runProductionQueue(f.options);
        assert.equal(f.calls.length, count);
    }
});

test('reused judge sessions across revisions wait and cannot clear historical finding IDs', async t => {
    const f = await fixture(t, { review: async (role, args) => {
        const review = syntheticReview(role, args);
        if (role === 'artistic' && args.revision === 1) review.assignment.output.improvements = [
            { id: 'keep-id', criterionId: 'C1', justification: 'Synthetic improvement.', evidenceIds: ['view-all'] }];
        if (args.revision === 2) review.assignment.sessionId = review.visualReceipt.sessionId = `a-1-${role}-session`;
        return review;
    } });
    const state = await runProductionQueue(f.options);
    assert.equal(state.current, 0); assert.equal(state.revision, 2); assert.equal(state.status, 'WAITING');
    assert.deepEqual(state.history.map(h => h.result.verdict), ['REVISE', 'WAIT']);
    assert.deepEqual(state.unresolvedByRole.artistic, ['keep-id']);
    assert.match(state.reasons.join(' '), /reused invocation\/session/);
});

test('pending descriptor without run ID also blocks launch; changed object key order preserves catalog', async t => {
    const f = await fixture(t);
    const state = await runProductionQueue({ ...f.options, signal: AbortSignal.abort() });
    state.pending = { token: 'synthetic-before-start-crash', entry: state.queue[0], revision: 1, idempotencyKey: 'synthetic' };
    state.status = 'RUNNING';
    await fs.writeFile(path.join(f.options.stateDir, 'queue.json'), JSON.stringify(state));
    const result = await runProductionQueue({ ...f.options, queue: f.options.queue.map(e => ({ family: e.family, id: e.id })) });
    assert.equal(result.status, 'WAITING'); assert.deepEqual(result.runIds, []); assert.deepEqual(f.calls, []);
});

test('read-only freeze/review adapters use read ledger; remote endpoint declarations fail closed', async t => {
    const f = await fixture(t);
    for (const reviewEndpoint of [undefined, 'file:///control', 'https://user:secret@synthetic.invalid', 'https://synthetic.invalid?token=secret']) {
        await assert.rejects(runProductionQueue({ ...f.options, adapters: { ...f.options.adapters, reviewEndpoint } }));
    }
    assert.deepEqual(f.calls, []);
    const state = await runProductionQueue({ ...f.options, maxAssetsPerSession: 1,
        adapters: { ...f.options.adapters, freezeEffect: 'read', reviewEffect: 'read', reviewEndpoint: undefined } });
    assert.equal(state.current, 1);
    const record = await f.store.get(state.runIds[0]);
    assert.ok(record.effects.filter(e => ['freeze', 'artistic', 'technical'].includes(e.nodeId)).every(e => e.kind === 'read'));
});

for (const key of ['constructor', 'prototype', '__proto__']) {
    for (const location of ['output', 'assignment', 'visualReceipt', 'manifest']) {
        test(`raw ${location} with own ${key}: false must WAIT, never accept sanitized data`, async t => {
            const f = await fixture(t);
            const freeze = f.options.adapters.freeze;
            f.options.adapters.freeze = async args => {
                const frozen = await freeze(args);
                if (location === 'manifest') Object.defineProperty(frozen.manifest, key, { value: false, enumerable: true });
                return frozen;
            };
            f.options.adapters.review = async (role, args) => {
                const review = syntheticReview(role, args);
                if (role === 'artistic' && location !== 'manifest') {
                    const target = location === 'output' ? review.assignment.output : review[location];
                    Object.defineProperty(target, key, { value: false, enumerable: true });
                }
                return review;
            };
            const state = await runProductionQueue({ ...f.options, maxAssetsPerSession: 1 });
            assert.equal(state.status, 'WAITING'); assert.equal(state.current, 0); assert.equal(state.revision, 1);
            assert.deepEqual(state.approvals, []);
            assert.equal(state.history[0].outputs.finalize.verdict, 'WAIT');
            assert.match(state.reasons.join(' '), /unexpected fields/);
            const saved = await f.state();
            const outputs = saved.history[0].outputs;
            const original = location === 'manifest' ? outputs.freeze.manifest
                : location === 'output' ? outputs.artistic.assignment.output : outputs.artistic[location];
            assert.equal(Object.hasOwn(original, key), true); assert.equal(original[key], false);
            const record = await f.store.get(state.pending.runId);
            assert.equal(record.status, 'waiting');
            const count = f.calls.length;
            await runProductionQueue(f.options);
            assert.equal(f.calls.length, count, 'malformed original cannot retry or advance on restart');
        });
    }
}

test('raw brief/producer/frozen metadata reaches host callbacks without engine sanitization or owner mutation', async t => {
    const f = await fixture(t);
    const original = { ...f.options.adapters };
    const metadata = JSON.parse('{"constructor":false,"prototype":false,"__proto__":false}');
    f.options.adapters.prepare = async args => ({ ...await original.prepare(args), brief: { metadata } });
    f.options.adapters.produce = async args => {
        assert.deepEqual(args.brief.metadata, metadata);
        return { ...await original.produce(args), metadata };
    };
    f.options.adapters.freeze = async args => {
        assert.deepEqual(args.brief.metadata, metadata); assert.deepEqual(args.receipt.metadata, metadata);
        args.receipt.metadata.constructor = true;
        return { ...await original.freeze(args), metadata };
    };
    f.options.adapters.verifyFrozen = async args => {
        assert.deepEqual(args.frozen.metadata, metadata);
        args.frozen.metadata.constructor = true;
        return original.verifyFrozen(args);
    };
    f.options.adapters.review = async (role, args) => {
        assert.deepEqual(args.frozen.metadata, metadata);
        args.frozen.metadata.prototype = true;
        return syntheticReview(role, args);
    };
    const state = await runProductionQueue({ ...f.options, maxAssetsPerSession: 1 });
    assert.equal(state.status, 'PAUSED', JSON.stringify(state.reasons)); assert.equal(state.current, 1);
    assert.deepEqual(state.history[0].outputs.produce.metadata, metadata);
    assert.deepEqual(state.history[0].outputs.freeze.metadata, metadata);
});

test('class adapters retain prototype methods/getters and private-field this for every callback', async t => {
    const f = await fixture(t);
    class ClassAdapters {
        #delegate;
        #calls = [];
        constructor(delegate) { this.#delegate = delegate; }
        get freezeEffect() { return 'read'; }
        get reviewEffect() { return this.#delegate.reviewEffect; }
        get reviewEndpoint() { return this.#delegate.reviewEndpoint; }
        get calls() { return [...this.#calls]; }
        prepare(args) { this.#calls.push('prepare'); return this.#delegate.prepare(args); }
        produce(args) { this.#calls.push('produce'); return this.#delegate.produce(args); }
        freeze(args) { this.#calls.push('freeze'); return this.#delegate.freeze(args); }
        verifyFrozen(args) { this.#calls.push('verifyFrozen'); return this.#delegate.verifyFrozen(args); }
        review(role, args) { this.#calls.push('review'); return this.#delegate.review(role, args); }
    }
    const adapters = new ClassAdapters(f.options.adapters);
    assert.equal(Object.hasOwn(adapters, 'prepare'), false);
    const state = await runProductionQueue({ ...f.options, adapters });
    assert.equal(state.status, 'COMPLETED', JSON.stringify(state.reasons)); assert.equal(state.current, 2);
    for (const method of ['prepare', 'produce', 'freeze', 'verifyFrozen', 'review']) {
        assert.equal(adapters.calls.filter(c => c === method).length, ['review', 'verifyFrozen'].includes(method) ? 4 : 2);
    }
    const record = await f.store.get(state.runIds[0]);
    assert.equal(record.effects.find(e => e.nodeId === 'freeze').kind, 'read');
    assert.equal(record.effects.find(e => e.nodeId === 'artistic').kind, 'network');
    assert.deepEqual(record.graph.permissions.networkHosts, ['synthetic.invalid']);
});

test('missing adapter methods fail before creating queue state or invoking callbacks', async t => {
    const f = await fixture(t);
    for (const method of ['prepare', 'produce', 'freeze', 'verifyFrozen', 'review']) {
        const adapters = { ...f.options.adapters, [method]: undefined };
        await assert.rejects(runProductionQueue({ ...f.options, adapters }), new RegExp(`adapter ${method} must be a function`));
    }
    await assert.rejects(fs.access(f.options.stateDir), { code: 'ENOENT' });
    assert.deepEqual(f.calls, []);
});

test('completed host import INVALID revises same asset, then frozen revision 2 needs both judges before next ID', async t => {
    const f = await fixture(t);
    const freeze = f.options.adapters.freeze, prepare = f.options.adapters.prepare;
    const correction = { status: 'REVISE', reasons: ['Synthetic missing texture.', 'Synthetic invalid geometry.'],
        importAuditReceipt: { id: 'synthetic-import-a-1', completed: true, status: 'INVALID',
            checks: [{ id: 'texture', passed: false }, { id: 'geometry', passed: false }],
            raw: JSON.parse('{"constructor":false,"prototype":false,"__proto__":false}') } };
    f.options.adapters.freeze = async args => {
        if (args.assetId === 'a' && args.revision === 1) {
            f.calls.push('freeze:a:1');
            const record = await f.store.get(args.runId);
            assert.equal(record.effects.find(e => e.nodeId === 'freeze').status, 'started');
            return correction;
        }
        return freeze(args);
    };
    f.options.adapters.prepare = async args => {
        if (args.assetId === 'a' && args.revision === 2) {
            assert.deepEqual(args.history[0].outputs.freeze, correction);
            const saved = await f.state();
            assert.equal(saved.current, 0); assert.equal(saved.revision, 2); assert.deepEqual(saved.approvals, []);
        }
        if (args.assetId === 'b') assert.equal((await f.state()).approvals[0].revision, 2);
        return prepare(args);
    };
    const state = await runProductionQueue(f.options);
    assert.equal(state.status, 'COMPLETED', JSON.stringify(state.reasons));
    assert.deepEqual(f.calls.filter(c => c.startsWith('produce')), ['produce:a:1', 'produce:a:2', 'produce:b:1']);
    assert.deepEqual(state.history.map(h => h.result.verdict), ['REVISE', 'ACCEPT', 'ACCEPT']);
    assert.deepEqual(state.approvals.map(a => [a.assetId, a.revision]), [['a', 2], ['b', 1]]);
    const first = state.history[0];
    assert.deepEqual(first.outputs.freeze, correction);
    assert.deepEqual(first.outputs.finalize, { verdict: 'REVISE', reasons: correction.reasons });
    assert.equal(first.outputs.artistic, undefined); assert.equal(first.outputs.technical, undefined);
    assert.equal(f.calls.filter(c => /^(verify|review):.*:a:1$/.test(c)).length, 0);
    assert.equal(f.calls.filter(c => /^review:.*:a:2$/.test(c)).length, 2);
    const record = await f.store.get(first.runId);
    assert.equal(validateFlowStudioGraph(record.graph).valid, true);
    assert.equal(record.status, 'completed');
    assert.deepEqual(record.effects.find(e => e.nodeId === 'freeze').output.freeze, correction);
    assert.ok(record.effects.every(e => e.status === 'completed'));
    assert.deepEqual(record.effects.map(e => e.nodeId), ['prepare', 'produce', 'freeze', 'verify', 'finalize']);
    assert.equal(record.events.filter(e => e.kind === 'branch.started').length, 0);
    assert.equal(record.events.filter(e => e.kind === 'node.enter' && e.nodeId === 'finalize').length, 1);
    assert.deepEqual(await f.state(), state);
});

for (const mode of ['BLOCKED', 'throw']) {
    test(`host import ${mode} never becomes a correctable retry, including after restart`, async t => {
        let freezes = 0;
        const blocked = { status: 'BLOCKED', reasons: ['Synthetic import completion unknown.'], importAuditReceipt: { id: 'blocked-audit' } };
        const f = await fixture(t, { freeze: async () => {
            freezes++;
            if (mode === 'throw') throw Object.assign(new Error('Import acknowledgement lost.'), { status: 'REVISE', reasons: ['Do not retry an exception.'] });
            return blocked;
        } });
        const state = await runProductionQueue(f.options);
        assert.equal(state.status, 'WAITING'); assert.equal(state.current, 0); assert.equal(state.revision, 1);
        assert.equal(state.history.length, 1); assert.deepEqual(state.approvals, []);
        assert.equal(state.history[0].result.verdict, 'WAIT');
        assert.equal(f.calls.filter(c => /^(verify|review):/.test(c)).length, 0);
        const record = await f.store.get(state.pending.runId);
        assert.equal(record.effects.find(e => e.nodeId === 'freeze').status, mode === 'throw' ? 'uncertain' : 'completed');
        if (mode === 'BLOCKED') assert.deepEqual(state.history[0].outputs.freeze, blocked);
        await runProductionQueue(f.options);
        assert.equal(freezes, 1);
        assert.deepEqual(f.calls.filter(c => c.startsWith('produce')), ['produce:a:1']);
    });
}

test('cancelled freeze cannot turn a late correction response into a safe REVISE', async t => {
    const abort = new AbortController();
    let freezes = 0;
    const f = await fixture(t, { freeze: async () => {
        freezes++;
        abort.abort();
        return { status: 'REVISE', reasons: ['Synthetic classification arrived after cancellation.'], importAuditReceipt: { id: 'late-audit' } };
    } });
    const state = await runProductionQueue({ ...f.options, signal: abort.signal });
    assert.equal(state.status, 'WAITING'); assert.equal(state.current, 0); assert.equal(state.revision, 1);
    assert.deepEqual(state.approvals, []); assert.equal(state.history[0].result.verdict, 'WAIT');
    assert.equal(state.history[0].outputs.finalize, undefined);
    assert.equal(f.calls.filter(c => /^(verify|review):/.test(c)).length, 0);
    const record = await f.store.get(state.pending.runId);
    assert.equal(record.effects.find(e => e.nodeId === 'freeze').status, 'uncertain');
    await runProductionQueue(f.options);
    assert.equal(freezes, 1);
});

for (const [name, correction] of [
    ['missing reasons', { status: 'REVISE' }],
    ['empty reasons', { status: 'REVISE', reasons: [] }],
    ['blank reason', { status: 'REVISE', reasons: [' \n '] }],
    ['nonstring reason', { status: 'REVISE', reasons: ['Synthetic issue.', null] }],
    ['nonarray reasons', { status: 'REVISE', reasons: 'Synthetic issue.' }],
    ['PASS status', { status: 'PASS', reasons: ['Cannot self-approve.'] }],
    ['ACCEPT status', { status: 'ACCEPT', reasons: ['Cannot self-approve.'] }],
    ['nested model raw only', { output: { status: 'REVISE', reasons: ['Model text is not a host classification.'] } }]
]) {
    test(`malformed correction (${name}) fails closed without verifying, grading or advancing`, async t => {
        let freezes = 0;
        const f = await fixture(t, { freeze: async () => { freezes++; return correction; } });
        const state = await runProductionQueue(f.options);
        assert.equal(state.status, 'WAITING'); assert.equal(state.current, 0); assert.equal(state.revision, 1);
        assert.deepEqual(state.approvals, []); assert.equal(state.history[0].result.verdict, 'WAIT');
        assert.deepEqual(state.history[0].outputs.freeze, correction);
        assert.equal(f.calls.filter(c => /^(verify|review):/.test(c)).length, 0);
        await runProductionQueue(f.options);
        assert.equal(freezes, 1);
    });
}

test('malformed correction cannot fall back to an attached frozen candidate', async t => {
    const f = await fixture(t);
    const freeze = f.options.adapters.freeze;
    f.options.adapters.freeze = async args => ({ ...await freeze(args), status: 'REVISE', reasons: [] });
    const state = await runProductionQueue(f.options);
    assert.equal(state.status, 'WAITING'); assert.equal(state.current, 0); assert.equal(state.revision, 1);
    assert.deepEqual(state.approvals, []);
    assert.equal(f.calls.filter(c => /^(verify|review):/.test(c)).length, 0);
});

test('correction finalization can only emit REVISE; embedded PASS grades/ACCEPT fields are inert audit data', async t => {
    const f = await fixture(t);
    const freeze = f.options.adapters.freeze;
    let correction;
    f.options.adapters.freeze = async args => {
        const frozen = await freeze(args);
        correction = { ...frozen, status: 'REVISE', reasons: ['Synthetic host import INVALID.'], verdict: 'ACCEPT', total: 100,
            finalize: { verdict: 'ACCEPT', reasons: [] },
            artistic: syntheticReview('artistic', { ...args, frozen }), technical: syntheticReview('technical', { ...args, frozen }) };
        return correction;
    };
    const state = await runProductionQueue({ ...f.options, maxRevisionsPerSession: 1 });
    assert.equal(state.status, 'PAUSED'); assert.equal(state.current, 0); assert.equal(state.revision, 2);
    assert.deepEqual(state.approvals, []); assert.equal(state.pending, undefined);
    assert.deepEqual(state.history[0].outputs.freeze, correction);
    assert.deepEqual(state.history[0].outputs.finalize, { verdict: 'REVISE', reasons: correction.reasons });
    assert.deepEqual(state.history[0].result, { verdict: 'REVISE', reasons: correction.reasons });
    assert.equal(state.history[0].outputs.artistic, undefined); assert.equal(state.history[0].outputs.technical, undefined);
    assert.equal(f.calls.filter(c => /^(verify|review):/.test(c)).length, 0);
});

test('correction respects session budget and preserves unresolved judge IDs until a later reviewed revision', async t => {
    const f = await fixture(t);
    const freeze = f.options.adapters.freeze;
    f.options.adapters.freeze = async args => args.revision === 2
        ? { status: 'REVISE', reasons: ['Synthetic geometry import INVALID.'], importAuditReceipt: { id: 'second-import' } }
        : freeze(args);
    f.options.adapters.review = async (role, args) => {
        const review = syntheticReview(role, args);
        if (args.revision === 1 && role === 'artistic') review.assignment.output.open_findings = [
            { id: 'still-open', criterionId: 'C1', justification: 'Synthetic original issue.', evidenceIds: ['view-all'] }];
        if (args.revision === 3) assert.deepEqual(args.unresolvedByRole.artistic, ['still-open']);
        return review;
    };
    const paused = await runProductionQueue({ ...f.options, maxRevisionsPerSession: 2 });
    assert.equal(paused.status, 'PAUSED'); assert.equal(paused.current, 0); assert.equal(paused.revision, 3);
    assert.deepEqual(paused.history.map(h => h.result.verdict), ['REVISE', 'REVISE']);
    assert.deepEqual(paused.unresolvedByRole.artistic, ['still-open']);
    assert.equal(paused.pending, undefined); assert.deepEqual(paused.approvals, []);
    const accepted = await runProductionQueue({ ...f.options, maxAssetsPerSession: 1 });
    assert.equal(accepted.current, 1); assert.equal(accepted.approvals[0].revision, 3);
    assert.deepEqual(f.calls.filter(c => c.startsWith('produce')), ['produce:a:1', 'produce:a:2', 'produce:a:3']);
});

async function preparationRetryFixture(t) {
    const f = await fixture(t), prepare = f.options.adapters.prepare;
    const blocked = { status: 'BLOCKED', reasons: ['Synthetic preparation protocol needs correction.'] };
    f.options.adapters.prepare = async args => { await prepare(args); return blocked; };
    const before = await runProductionQueue(f.options);
    const retryOptions = { stateDir: f.options.stateDir, expectedRunId: before.pending.runId,
        expectedCatalogHash: before.catalogHash, reason: 'Host corrected the synthetic preparation protocol.' };
    return { ...f, prepare, before, retryOptions, queuePath: path.join(f.options.stateDir, 'queue.json'),
        runPath: f.store.pathFor(before.pending.runId) };
}

async function assertPreparationRetryRejected(f, overrides = {}, expectedError) {
    const beforeQueue = await fs.readFile(f.queuePath, 'utf8');
    const beforeRun = await fs.readFile(f.runPath, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; });
    const calls = [...f.calls];
    await assert.rejects(retryProductionPreparation({ ...f.retryOptions, ...overrides }), expectedError);
    assert.equal(await fs.readFile(f.queuePath, 'utf8'), beforeQueue, 'rejected reconciliation cannot rewrite queue state');
    assert.equal(await fs.readFile(f.runPath, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; }), beforeRun,
        'reconciliation cannot rewrite the old run');
    assert.deepEqual(f.calls, calls, 'reconciliation never invokes host callbacks');
}

test('preparation recovery only records reconciliation, then a NEW prepare and both judges are required', async t => {
    const f = await preparationRetryFixture(t), oldRun = await fs.readFile(f.runPath, 'utf8');
    const calls = [...f.calls];
    const recovered = await retryProductionPreparation(f.retryOptions);
    assert.deepEqual(f.calls, calls);
    const audit = recovered.preparationRetries[0];
    assert.ok(Number.isFinite(Date.parse(audit.at)));
    assert.deepEqual(audit, { oldRunId: f.before.pending.runId, checkpointId: f.before.history[0].checkpointId,
        assetId: 'a', revision: 1, catalogHash: f.before.catalogHash, reason: f.retryOptions.reason, at: audit.at });
    const expected = { ...f.before, status: 'PAUSED', preparationRetries: [audit] };
    delete expected.pending;
    assert.deepEqual(recovered, expected); assert.deepEqual(await f.state(), expected);
    assert.equal(await fs.readFile(f.runPath, 'utf8'), oldRun);
    await assertPreparationRetryRejected(f);
    f.options.adapters.prepare = async args => {
        assert.notEqual(args.runId, f.before.pending.runId);
        assert.deepEqual(args.history, f.before.history);
        assert.deepEqual((await f.store.get(args.runId)).effects.map(e => [e.nodeId, e.status]), [['prepare', 'started']]);
        return f.prepare(args);
    };
    const produced = await runProductionQueue({ ...f.options, maxAssetsPerSession: 1 });
    assert.equal(produced.status, 'PAUSED'); assert.equal(produced.current, 1);
    assert.equal(produced.approvals.length, 1); assert.equal(produced.approvals[0].runId, produced.runIds[1]);
    assert.equal(produced.runIds.length, 2); assert.deepEqual(produced.history[0], f.before.history[0]);
    assert.deepEqual(f.calls.filter(c => c.startsWith('prepare')), ['prepare:a:1', 'prepare:a:1']);
    assert.deepEqual(f.calls.filter(c => c.startsWith('produce')), ['produce:a:1']);
    assert.equal(f.calls.filter(c => c.startsWith('review')).length, 2);
    assert.equal(await fs.readFile(f.runPath, 'utf8'), oldRun, 'superseded old wait run/checkpoints are immutable');
});

test('preparation recovery is optimistic, append-only across repeated BLOCKED preparations and never resumes old runs', async t => {
    const f = await preparationRetryFixture(t);
    await retryProductionPreparation(f.retryOptions);
    const again = await runProductionQueue(f.options);
    assert.equal(again.status, 'WAITING'); assert.equal(again.revision, 1); assert.equal(again.current, 0);
    await assertPreparationRetryRejected(f);
    const recovered = await retryProductionPreparation({ ...f.retryOptions, expectedRunId: again.pending.runId, reason: 'Second host protocol correction.' });
    assert.equal(recovered.preparationRetries.length, 2);
    assert.deepEqual(recovered.runIds, again.runIds); assert.deepEqual(recovered.history, again.history);
    assert.equal((await f.store.get(f.before.pending.runId)).status, 'waiting');
    assert.equal((await f.store.get(again.pending.runId)).status, 'waiting');
    assert.deepEqual(f.calls.filter(c => c.startsWith('produce')), []);
});

test('preparation recovery preserves previous approvals, revision and unresolved findings', async t => {
    const f = await fixture(t);
    await runProductionQueue({ ...f.options, maxAssetsPerSession: 1 });
    const prepare = f.options.adapters.prepare;
    f.options.adapters.review = async (role, args) => {
        const review = syntheticReview(role, args);
        if (role === 'technical') review.assignment.output.improvements = [
            { id: 'keep-technical', criterionId: 'C2', justification: 'Synthetic issue.', evidenceIds: ['view-all'] }];
        return review;
    };
    await runProductionQueue({ ...f.options, maxRevisionsPerSession: 1 });
    f.options.adapters.prepare = async args => { await prepare(args); return { status: 'BLOCKED', reasons: ['Synthetic protocol blocker.'] }; };
    const before = await runProductionQueue(f.options);
    assert.equal(before.current, 1); assert.equal(before.revision, 2);
    assert.deepEqual(before.unresolvedByRole.technical, ['keep-technical']);
    const recovered = await retryProductionPreparation({ stateDir: f.options.stateDir, expectedRunId: before.pending.runId,
        expectedCatalogHash: before.catalogHash, reason: 'Host corrected protocol, not artistic requirements.' });
    for (const key of ['approvals', 'history', 'runIds', 'revision', 'current', 'queue', 'catalogHash', 'unresolvedByRole']) {
        assert.deepEqual(recovered[key], before[key]);
    }
    assert.equal(recovered.status, 'PAUSED'); assert.equal(recovered.pending, undefined);
});

test('preparation recovery requires nonblank reason, correct expected IDs and the same exclusive queue lock', async t => {
    const f = await preparationRetryFixture(t);
    for (const reason of [undefined, '', ' \n ', 1]) await assertPreparationRetryRejected(f, { reason });
    await assertPreparationRetryRejected(f, { expectedRunId: 'f'.repeat(32) });
    await assertPreparationRetryRejected(f, { expectedCatalogHash: 'f'.repeat(64) });
    const lockPath = path.join(f.options.stateDir, 'queue.lock');
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, token: 'synthetic-owner' }), { flag: 'wx' });
    try {
        await assertPreparationRetryRejected(f, {}, /queue locked/);
        await assert.rejects(runProductionQueue(f.options), /queue locked/);
    } finally { await fs.unlink(lockPath); }
    const results = await Promise.allSettled([retryProductionPreparation(f.retryOptions), retryProductionPreparation(f.retryOptions)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await f.state()).preparationRetries.length, 1);
});

test('preparation recovery rejects a live run lease even while its saved status is waiting', async t => {
    const f = await preparationRetryFixture(t), lease = await f.store.claimRunLease(f.retryOptions.expectedRunId);
    assert.ok(lease);
    try { await assertPreparationRetryRejected(f, {}, /lease/); }
    finally { await lease.release(); }
    assert.equal((await retryProductionPreparation(f.retryOptions)).status, 'PAUSED');
});

for (const kind of ['stale process identity', 'expired malformed owner', 'expired missing owner']) {
    test(`preparation recovery leaves existing lease untouched: ${kind}`, async t => {
        const f = await preparationRetryFixture(t), runId = f.retryOptions.expectedRunId;
        const leaseRoot = path.join(f.store.root, '.leases'), lockDirectory = path.join(leaseRoot, `${runId}.lock`);
        const ownerFile = path.join(lockDirectory, 'owner.json'), old = new Date(0);
        await fs.mkdir(lockDirectory);
        const owner = kind === 'stale process identity' ? JSON.stringify({ runId, token: 'synthetic-stale-owner', pid: process.pid,
            processStartedAt: old.toISOString(), createdAt: old.toISOString(), heartbeatAt: old.toISOString(), leaseMs: 15_000 }) : '{';
        if (kind !== 'expired missing owner') {
            await fs.writeFile(ownerFile, owner, { flag: 'wx' });
            await fs.utimes(ownerFile, old, old);
        }
        await fs.utimes(lockDirectory, old, old);
        const before = await fs.stat(lockDirectory), entries = await fs.readdir(leaseRoot);
        await assertPreparationRetryRejected(f, {}, /stale recovery is disabled/);
        assert.deepEqual(await fs.readdir(leaseRoot), entries, 'no quarantine or replacement lease may be created');
        const after = await fs.stat(lockDirectory);
        assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
        if (kind === 'expired missing owner') await assert.rejects(fs.access(ownerFile), { code: 'ENOENT' });
        else {
            assert.equal(await fs.readFile(ownerFile, 'utf8'), owner);
            assert.equal((await fs.stat(ownerFile)).mtimeMs, old.getTime());
        }
        assert.deepEqual(await f.state(), f.before, 'pending and reconciliation audit remain unchanged');
    });
}

test('no-stale-recovery concurrent claimers cannot replace a fresh lease using cached stale owner data', { timeout: 10_000 }, async t => {
    const f = await preparationRetryFixture(t), runId = f.retryOptions.expectedRunId;
    const ownerFile = path.join(f.store.root, '.leases', `${runId}.lock`, 'owner.json');
    const replacement = await f.store.claimRunLease(runId, { recoverStale: false });
    assert.ok(replacement);
    const owner = await fs.readFile(ownerFile, 'utf8'), readFile = fs.readFile.bind(fs), rename = fs.rename.bind(fs);
    const stale = JSON.stringify({ ...JSON.parse(owner), token: 'superseded-synthetic-owner', processStartedAt: new Date(0).toISOString() });
    let ownerReads = 0, renames = 0, results = [];
    // Inject an obsolete observation while a newer lease actually owns the path.
    // The opt-out must return on EEXIST before consulting that stale observation.
    const readMock = t.mock.method(fs, 'readFile', async (file, ...args) => {
        if (typeof file === 'string' && path.resolve(file) === path.resolve(ownerFile)) { ownerReads++; return stale; }
        return readFile(file, ...args);
    });
    const renameMock = t.mock.method(fs, 'rename', async (...args) => { renames++; return rename(...args); });
    try {
        results = await Promise.allSettled([new FlowStudioFileRunStore(f.store.root), new FlowStudioFileRunStore(f.store.root)]
            .map(store => store.claimRunLease(runId, { recoverStale: false })));
        assert.deepEqual(results, [{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }]);
        await assertPreparationRetryRejected(f, {}, /lease/);
        assert.equal(ownerReads, 0, 'staleness must not be evaluated on the opt-out path');
        assert.equal(renames, 0, 'neither contender can quarantine the replacement lease');
        readMock.mock.restore(); renameMock.mock.restore();
        await replacement.assertOwned();
        assert.equal(await fs.readFile(ownerFile, 'utf8'), owner);
        assert.deepEqual(await f.state(), f.before);
    } finally {
        readMock.mock.restore(); renameMock.mock.restore();
        for (const result of results) if (result.status === 'fulfilled' && result.value) await result.value.release();
        await replacement.release();
    }
});

test('run-store retains stale recovery when omitted or explicitly enabled', async t => {
    const f = await preparationRetryFixture(t), runId = f.retryOptions.expectedRunId;
    const lockDirectory = path.join(f.store.root, '.leases', `${runId}.lock`), ownerFile = path.join(lockDirectory, 'owner.json');
    for (const options of [undefined, { recoverStale: true }]) {
        await fs.mkdir(lockDirectory);
        await fs.writeFile(ownerFile, '{', { flag: 'wx' });
        await fs.utimes(ownerFile, new Date(0), new Date(0));
        await fs.utimes(lockDirectory, new Date(0), new Date(0));
        const lease = options === undefined ? await f.store.claimRunLease(runId) : await f.store.claimRunLease(runId, options);
        assert.ok(lease, 'legacy callers still recover stale leases by default');
        try { await lease.assertOwned(); assert.equal(JSON.parse(await fs.readFile(ownerFile, 'utf8')).token, lease.token); }
        finally { await lease.release(); }
    }
    assert.deepEqual(await f.state(), f.before);
    assert.deepEqual(f.calls, ['prepare:a:1']);
});

for (const [name, mutate] of [
    ['catalog mutation', s => { s.queue[0].family = 'changed'; }],
    ['cursor outside queue', s => { s.current = s.queue.length; }],
    ['wrong queue status', s => { s.status = 'RUNNING'; }],
    ['missing pending', s => { delete s.pending; }],
    ['wrong pending entry', s => { s.pending.entry.id = 'different'; }],
    ['wrong pending revision', s => { s.pending.revision++; }],
    ['wrong idempotency key', s => { s.pending.idempotencyKey = 'different'; }],
    ['crash without history', s => { s.history = []; }],
    ['wrong history asset', s => { s.history[0].assetId = 'different'; }],
    ['wrong history revision', s => { s.history[0].revision++; }],
    ['wrong history run ID', s => { s.history[0].runId = 'f'.repeat(32); }],
    ['extra mutation output', s => { s.history[0].outputs.produce = null; }],
    ['READY instead of BLOCKED', s => { s.history[0].outputs.prepare = { status: 'READY', brief: 'not blocked' }; }],
    ['malformed BLOCKED reasons', s => { s.history[0].outputs.prepare.reasons = []; }],
    ['raw history differs from ledger', s => { s.history[0].outputs.prepare.constructor = false; }],
    ['unproven effect IDs', s => { s.history[0].effectIds = ['different-effect']; }],
    ['invented approval', s => { s.approvals.push({ assetId: 'a', revision: 1 }); }],
    ['changed outstanding IDs', s => { s.unresolvedByRole.artistic = ['invented']; }],
    ['bad reconciliation audit', s => { s.preparationRetries = [{ oldRunId: 'unknown' }]; }]
]) {
    test(`preparation recovery rejects invalid owner state: ${name}`, async t => {
        const f = await preparationRetryFixture(t), state = await f.state();
        mutate(state);
        await fs.writeFile(f.queuePath, JSON.stringify(state));
        await assertPreparationRetryRejected(f);
    });
}

for (const [name, mutate] of [
    ['running', r => { r.status = 'running'; }],
    ['failed', r => { r.status = 'failed'; }],
    ['cancelled', r => { r.status = 'cancelled'; }],
    ['completed', r => { r.status = 'completed'; }],
    ['run identity mismatch', r => { r.input.pending.token = 'different'; }],
    ['missing effects', r => { r.effects = []; }],
    ['started receipt', r => { r.effects[0].status = 'started'; }],
    ['uncertain receipt', r => { r.effects[0].status = 'uncertain'; }],
    ['failed receipt', r => { r.effects[0].status = 'failed'; }],
    ['mutable prepare', r => { r.effects[0].kind = 'command'; }],
    ['wrong tool', r => { r.effects[0].toolId = 'host:produce'; }],
    ['missing raw response', r => { delete r.effects[0].output; }],
    ['raw READY hidden by BLOCKED context', r => { r.effects[0].output.prepare = { status: 'READY', brief: 'different original' }; }],
    ['raw response field sanitized away', r => { r.effects[0].output.prepare.constructor = false; }],
    ['read-only freeze receipt', r => { r.effects.push({ ...r.effects[0], id: 'other', kind: 'read', nodeId: 'freeze', toolId: 'host:freeze' }); }],
    ['read-only judge receipt', r => { r.effects.push({ ...r.effects[0], id: 'other', kind: 'read', nodeId: 'technical', toolId: 'host:technical' }); }],
    ['earlier checkpoint contains a mutation', r => { r.checkpoints[0].effects.push({ ...r.effects[0], id: 'other', kind: 'command', nodeId: 'produce' }); }],
    ['producer ever started in events', r => { r.events.push({ kind: 'effect.started', nodeId: 'produce', runId: r.id, detail: { effectId: 'other' } }); }],
    ['judge ever started in visits', r => { r.result.visited.push('artistic'); }],
    ['nested result contains hidden mutation', r => { r.result.effects = [{ ...r.effects[0], kind: 'command', nodeId: 'produce' }]; }],
    ['missing checkpoint', r => { r.checkpoints.pop(); }],
    ['wrong authoritative checkpoint', r => { r.result.waiting.checkpointId = r.checkpoints[0].id; }],
    ['unsafe checkpoint continuation', r => { r.checkpoints.at(-1).nextNodeId = 'produce'; }],
    ['changed graph digest', r => { r.graph.name = 'changed after waiting'; }],
    ['unsafe wait continuation', r => { r.graph.nodes.find(n => n.id === 'wait').next = 'produce'; }],
    ['replay instead of original run', r => { r.parentRunId = 'f'.repeat(32); }]
]) {
    test(`preparation recovery rejects unsafe/missing run evidence: ${name}`, async t => {
        const f = await preparationRetryFixture(t), record = await f.store.get(f.retryOptions.expectedRunId);
        mutate(record);
        // Deliberately corrupt synthetic persistent evidence, never real control files.
        await fs.writeFile(f.runPath, JSON.stringify(record));
        await assertPreparationRetryRejected(f);
    });
}

test('preparation recovery rejects missing and malformed persisted run files without repairing them', async t => {
    const f = await preparationRetryFixture(t);
    await fs.unlink(f.runPath);
    await assertPreparationRetryRejected(f, {}, /missing/);
    await fs.writeFile(f.runPath, '{');
    await assertPreparationRetryRejected(f);
    await fs.writeFile(f.runPath, '{}');
    await assertPreparationRetryRejected(f);
});

test('preparation recovery compares original raw receipts, not sanitized checkpoint context', async t => {
    const blocked = JSON.parse('{"status":"BLOCKED","reasons":["Synthetic protocol mismatch."],"constructor":false,"__proto__":false}');
    const f = await fixture(t, { prepare: async () => blocked });
    const before = await runProductionQueue(f.options), runId = before.pending.runId;
    const record = await f.store.get(runId);
    assert.equal(Object.hasOwn(record.checkpoints.at(-1).context.prepare, 'constructor'), false);
    assert.equal(Object.hasOwn(record.effects[0].output.prepare, 'constructor'), true);
    const recovered = await retryProductionPreparation({ stateDir: f.options.stateDir, expectedRunId: runId,
        expectedCatalogHash: before.catalogHash, reason: 'Host explicitly corrects blocked protocol.' });
    assert.equal(recovered.status, 'PAUSED'); assert.deepEqual(recovered.history[0].outputs.prepare, blocked);
    assert.deepEqual(recovered.history, before.history);
});

test('preparation recovery accepts a consistent completed none-effect preparation, never a mutable effect', async t => {
    const f = await preparationRetryFixture(t), record = await f.store.get(f.retryOptions.expectedRunId);
    // Synthetic persisted equivalent of the same read-only host preparation with effect:none.
    record.graph.nodes.find(n => n.id === 'prepare').tools[0].effect = 'none';
    record.effects[0].kind = 'none';
    const graphDigest = hash(JSON.stringify(record.graph));
    for (const checkpoint of record.checkpoints) { checkpoint.effects = structuredClone(record.effects); checkpoint.graphDigest = graphDigest; }
    for (const event of record.events) if (event.kind === 'effect.started') event.detail.kind = 'none';
    await fs.writeFile(f.runPath, JSON.stringify(record));
    const beforeRun = await fs.readFile(f.runPath, 'utf8');
    assert.equal((await retryProductionPreparation(f.retryOptions)).status, 'PAUSED');
    assert.equal(await fs.readFile(f.runPath, 'utf8'), beforeRun);
});

for (const mode of ['producer uncertainty', 'read-only freeze BLOCKED', 'read-only missing review', 'frozen mutation', 'prepare throws']) {
    test(`preparation recovery never unlocks other WAIT causes: ${mode}`, async t => {
        const f = await fixture(t);
        if (mode === 'producer uncertainty') f.options.adapters.produce = async () => { throw new Error('Unknown producer completion.'); };
        if (mode === 'read-only freeze BLOCKED') {
            f.options.adapters.freezeEffect = 'read';
            f.options.adapters.freeze = async () => ({ status: 'BLOCKED', reasons: ['Read-only freeze failed.'] });
        }
        if (mode === 'read-only missing review') { f.options.adapters.reviewEffect = 'read'; f.options.adapters.review = async () => ({}); }
        if (mode === 'frozen mutation') f.options.adapters.verifyFrozen = async () => false;
        if (mode === 'prepare throws') f.options.adapters.prepare = async () => { throw new Error('No completed preparation.'); };
        const before = await runProductionQueue(f.options);
        assert.equal(before.status, 'WAITING');
        await assertPreparationRetryRejected({ ...f, queuePath: path.join(f.options.stateDir, 'queue.json'),
            runPath: f.store.pathFor(before.pending.runId), retryOptions: { stateDir: f.options.stateDir,
                expectedRunId: before.pending.runId, expectedCatalogHash: before.catalogHash, reason: 'Not eligible despite this reason.' } });
    });
}
