import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FlowStudioControllerPool } from '../lib/controller-pool.js';
import { FlowStudioController } from '../lib/controller.js';

test('parallel first-use requests coalesce into one controller start and one session', async t => {
    const fixture = await createFixture(t, 'coalesce');
    const releaseStart = deferred();
    const controllers = [];
    const pool = new FlowStudioControllerPool({}, () => {
        const controller = new FakeController(() => releaseStart.promise);
        controllers.push(controller);
        return controller;
    });
    t.after(() => pool.stopAll());

    const first = pool.get(fixture.context(), fixture.fileName);
    const second = pool.get(fixture.context(), fixture.fileName);
    await waitFor(() => controllers[0]?.startCalls === 1);
    assert.equal(controllers.length, 1, 'only one controller is allocated for the workspace and graph');
    assert.equal(controllers[0].startCalls, 1, 'only one CLI startup is attempted');

    releaseStart.resolve();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(left.controller, right.controller);
    assert.equal(left.controller.activeSession, right.controller.activeSession);
    assert.equal(controllers[0].startCalls, 1);
});

test('cancelling one parallel caller does not cancel the shared startup needed by another caller', async t => {
    const fixture = await createFixture(t, 'caller-cancel');
    const releaseStart = deferred();
    const controller = new FakeController(() => releaseStart.promise);
    const pool = new FlowStudioControllerPool({}, () => controller);
    t.after(() => pool.stopAll());
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();

    const first = pool.get(fixture.context(firstAbort.signal), fixture.fileName);
    const second = pool.get(fixture.context(secondAbort.signal), fixture.fileName);
    await controller.started.promise;
    firstAbort.abort();
    await assert.rejects(first, /cancelada para esta ferramenta/i);

    releaseStart.resolve();
    const result = await second;
    assert.equal(result.controller, controller);
    assert.ok(controller.activeSession);
    assert.equal(controller.startCalls, 1);
});

test('stopAll aborts and awaits a pending startup without leaving an active session', async t => {
    const fixture = await createFixture(t, 'stop-pending');
    const controller = new FakeController(signal => new Promise((resolve, reject) => {
        if (signal?.aborted) reject(new Error('fake startup aborted'));
        else signal?.addEventListener('abort', () => reject(new Error('fake startup aborted')), { once: true });
    }));
    const pool = new FlowStudioControllerPool({}, () => controller);
    const request = pool.get(fixture.context(), fixture.fileName);
    await controller.started.promise;

    await pool.stopAll();
    await assert.rejects(request, /fake startup aborted|pool do Flow Studio já foi encerrado/i);
    assert.equal(controller.activeSession, undefined);
    assert.ok(controller.stopCalls >= 1);
    await assert.rejects(pool.get(fixture.context(), fixture.fileName), /pool do Flow Studio já foi encerrado/i);
});

test('a failed startup is removed cleanly so the next request can create one healthy session', async t => {
    const fixture = await createFixture(t, 'retry');
    const controllers = [];
    const pool = new FlowStudioControllerPool({}, () => {
        const controller = new FakeController(controllers.length === 0
            ? async () => { throw new Error('startup boom'); }
            : async () => undefined);
        controllers.push(controller);
        return controller;
    });
    t.after(() => pool.stopAll());

    await assert.rejects(pool.get(fixture.context(), fixture.fileName), /startup boom/);
    const result = await pool.get(fixture.context(), fixture.fileName);
    assert.equal(controllers.length, 2);
    assert.equal(controllers[0].activeSession, undefined);
    assert.ok(controllers[0].stopCalls >= 1);
    assert.equal(result.controller, controllers[1]);
    assert.ok(result.controller.activeSession);
    assert.equal(controllers[1].startCalls, 1);
});

test('the default graph name is flow.graph.json for new workspaces', async t => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-default-name-'));
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const controller = new FakeController(async () => undefined);
    const pool = new FlowStudioControllerPool({}, () => controller);
    t.after(() => pool.stopAll());

    const result = await pool.get({ directory: workspace, worktree: workspace, abort: new AbortController().signal });
    assert.equal(result.file, path.join(workspace, 'flow.graph.json'));
});

test('the default graph name falls back to an existing legacy flow-studio.graph.json', async t => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-legacy-name-'));
    const legacy = path.join(workspace, 'flow-studio.graph.json');
    await fs.writeFile(legacy, '{}', 'utf8');
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const controller = new FakeController(async () => undefined);
    const pool = new FlowStudioControllerPool({}, () => controller);
    t.after(() => pool.stopAll());

    const result = await pool.get({ directory: workspace, worktree: workspace, abort: new AbortController().signal });
    assert.equal(result.file, legacy);
});

class FakeController extends FlowStudioController {
    constructor(startBehavior) {
        super();
        this.startBehavior = startBehavior;
        this.started = deferred();
        this.startCalls = 0;
        this.stopCalls = 0;
        this.openCalls = 0;
        this.fakeSession = undefined;
    }

    get activeSession() {
        return this.fakeSession;
    }

    async start(graphFile, options = {}) {
        this.startCalls += 1;
        this.started.resolve(options.signal);
        await this.startBehavior(options.signal);
        this.fakeSession = { graphFile, pid: 40_000 + this.startCalls };
        return this.fakeSession;
    }

    async stop() {
        this.stopCalls += 1;
        this.fakeSession = undefined;
    }

    open() {
        this.openCalls += 1;
    }
}

async function createFixture(t, name) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `flow-studio-pool-${name}-`));
    const fileName = 'flow.json';
    await fs.writeFile(path.join(workspace, fileName), '{}', 'utf8');
    t.after(() => fs.rm(workspace, { recursive: true, force: true }));
    return {
        fileName,
        context(signal = new AbortController().signal) {
            return { directory: workspace, worktree: workspace, abort: signal };
        }
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function waitFor(predicate) {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition.');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}
