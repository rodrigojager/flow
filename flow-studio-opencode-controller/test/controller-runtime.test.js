import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { executeParsedArgs, FlowStudioController } from '../lib/controller.js';
import plugin from '../lib/opencode-plugin.js';

const realExecPath = process.execPath;
const realSpawnSync = childProcess.spawnSync;
const realSpawn = childProcess.spawn;
const realFetch = globalThis.fetch;
const executable = name => `${name}${process.platform === 'win32' ? '.exe' : ''}`;
const appHost = path.resolve('Compiled Host', executable('cybervinci'));
const pathNode = path.resolve('Node Runtime', executable('node'));
const workspace = process.cwd();
const graphFile = path.join(workspace, 'graph with spaces.json');

test('compiled app host selects absolute PATH Node and preserves CLI boundaries', async t => {
    const fixture = mockRuntime(t);
    const controller = new FlowStudioController();
    t.after(() => controller.stop());
    const command = '"C:\\Host Tools\\runner.exe" --mode safe';
    const session = await controller.start(graphFile, {
        workspace, port: 43210, token: 'host-test-token',
        providerHost: 'cybervinci', providerExec: [`host=${command}`],
        toolExec: [`tool=${command}`], playbookExec: [`book=${command}`], memoryExec: command,
        allowGraphRunners: true, allowGraphTools: true,
        allowCommands: [command], allowRunnerHosts: ['cybervinci']
    });
    assert.equal(fixture.probes.length, 1);
    assert.equal(fixture.probes[0].file, pathNode);
    const [{ file, args, options }] = fixture.starts;
    assert.equal(file, pathNode);
    assert.notEqual(file, process.execPath);
    assert.match(args[0], /[\\/]flow[^\\/]*[\\/]lib[\\/]index\.js$/);
    assert.deepEqual(args.slice(1), [
        'serve', graphFile, '--host', '127.0.0.1', '--port', '43210', '--workspace', workspace,
        '--token', 'host-test-token', '--provider-host', 'cybervinci', '--memory-exec', command,
        '--provider-exec', `host=${command}`, '--tool-exec', `tool=${command}`, '--playbook-exec', `book=${command}`,
        '--allow-command', command, '--allow-runner-host', 'cybervinci', '--allow-graph-tools', '--allow-graph-runners'
    ]);
    assert.equal(options.cwd, workspace);
    assert.equal(options.env, process.env);
    assert.notEqual(options.shell, true);
    assert.equal(options.windowsHide, true);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(session.baseUrl, 'http://127.0.0.1:43210');
    assert.deepEqual(fixture.requests, [{ url: `${session.baseUrl}/api/health`, token: 'host-test-token' }]);
    assert.equal(fixture.probes[0].args.join(' ').includes('host-test-token'), false);
});

for (const name of ['node', 'bun']) {
    test(`normal ${name} keeps process.execPath even without Node on PATH`, async t => {
        const host = path.resolve('Normal Runtime', executable(name));
        const fixture = mockRuntime(t, { host, searchPath: '', files: [host] });
        const controller = new FlowStudioController();
        t.after(() => controller.stop());
        await controller.start(graphFile, { port: 43210 });
        assert.deepEqual(fixture.probes.map(call => call.file), [host]);
        assert.equal(fixture.starts[0].file, host);
    });
}

test('compiled process.execPath uses a real Node interpreter for the probe, without starting Flow', async t => {
    const fixture = mockRuntime(t, {
        searchPath: path.dirname(realExecPath), files: [realExecPath],
        probe: (file, args, options) => realSpawnSync(file, args, options)
    });
    const controller = new FlowStudioController();
    t.after(() => controller.stop());
    await controller.start(graphFile, { port: 43210 });
    assert.equal(fixture.probes[0].file, realExecPath);
    assert.equal(fixture.starts[0].file, realExecPath);
    assert.notEqual(process.execPath, realExecPath);
});

test('explicit host runtime takes precedence over environment and automatic discovery', async t => {
    const runtimePath = path.resolve('Explicit Runtime', executable('custom-node'));
    const fixture = mockRuntime(t, { files: [runtimePath, pathNode], override: 'invalid environment command' });
    const controller = new FlowStudioController();
    t.after(() => controller.stop());
    await controller.start(graphFile, { port: 43210, runtimePath });
    assert.deepEqual(fixture.probes.map(call => call.file), [runtimePath]);
    assert.equal(fixture.starts[0].file, runtimePath);
});

for (const explicit of [false, true]) {
    test(`forwardToCli validates ${explicit ? 'environment override' : 'PATH Node'} instead of using the compiled host`, async t => {
        const runtimePath = explicit ? path.resolve('Explicit Runtime', executable('bun')) : pathNode;
        const fixture = mockRuntime(t, { files: [runtimePath], override: explicit ? runtimePath : undefined });
        const argv = ['validate', graphFile, '--workspace', workspace];
        assert.equal(await executeParsedArgs(argv), 17);
        assert.deepEqual(fixture.probes.map(call => call.file), [runtimePath]);
        assert.equal(fixture.forwards[0].file, runtimePath);
        assert.deepEqual(fixture.forwards[0].args.slice(1), argv);
        assert.equal(fixture.forwards[0].options.stdio, 'inherit');
        assert.notEqual(fixture.forwards[0].options.shell, true);
        assert.equal(fixture.starts.length, 0);
    });
}

test('environment override is also used by controller.start', async t => {
    const runtimePath = path.resolve('Environment Runtime', executable('bun'));
    const fixture = mockRuntime(t, { files: [runtimePath], override: runtimePath });
    const controller = new FlowStudioController();
    t.after(() => controller.stop());
    await controller.start(graphFile, { port: 43210 });
    assert.equal(fixture.starts[0].file, runtimePath);
});

test('invalid explicit paths fail closed before probing or launching any fallback', async t => {
    const invalidPaths = ['', 'node', 'node --eval malicious', `"${pathNode}"`, `${pathNode} --eval malicious`,
        path.resolve(executable('missing-runtime')), `${pathNode}\0`, null, 42];
    if (process.platform === 'win32') invalidPaths.push(path.resolve('node.cmd'), path.resolve('node.bat'));
    for (const runtimePath of invalidPaths) {
        await t.test(JSON.stringify(runtimePath), async t => {
            const fixture = mockRuntime(t);
            const controller = new FlowStudioController();
            await assert.rejects(controller.start(graphFile, { port: 43210, runtimePath }), /runtimePath/);
            assert.equal(controller.activeSession, undefined);
            assert.equal(fixture.probes.length, 0);
            assert.equal(fixture.starts.length, 0);
        });
    }
});

test('failed interpreter probes are bounded, redact output and never fall back from an override', async t => {
    const secret = 'probe-output-host-secret';
    const cases = {
        'version output is not JavaScript execution': () => ({ status: 0, signal: null, stdout: 'v24.0.0', stderr: secret }),
        'nonzero exit': marker => ({ status: 1, signal: null, stdout: marker, stderr: secret }),
        'terminated process': marker => ({ status: 0, signal: 'SIGKILL', stdout: marker, stderr: secret }),
        timeout: marker => ({ status: 0, signal: null, stdout: marker, error: Object.assign(new Error(secret), { code: 'ETIMEDOUT' }) }),
        'output limit': marker => ({ status: 0, signal: null, stdout: marker, error: Object.assign(new Error(secret), { code: 'ENOBUFS' }) }),
        'extra output': marker => ({ status: 0, signal: null, stdout: marker + secret }),
        'spawn throws': () => { throw new Error(secret); }
    };
    for (const [name, result] of Object.entries(cases)) {
        await t.test(name, async t => {
            const runtimePath = path.resolve('Bad Runtime', executable('app'));
            const fixture = mockRuntime(t, {
                files: [runtimePath, pathNode],
                probe: (_file, args) => result(args[1].match(/flow-runtime-[a-f0-9]{32}/)[0])
            });
            await assert.rejects(new FlowStudioController().start(graphFile, { port: 43210, runtimePath }), error => {
                assert.match(error.message, /no fallback attempted/);
                assert.equal(error.message.includes(secret), false);
                return true;
            });
            assert.deepEqual(fixture.probes.map(call => call.file), [runtimePath]);
            assert.equal(fixture.starts.length, 0);
            const { options } = fixture.probes[0];
            assert.equal(options.timeout, 1500);
            assert.equal(options.maxBuffer, 4096);
            assert.equal(options.killSignal, 'SIGKILL');
            assert.equal(options.shell, false);
            assert.equal(options.windowsHide, true);
            assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
            assert.equal(options.cwd, path.dirname(runtimePath));
        });
    }
});

test('invalid environment override also prevents forwardToCli fallback', async t => {
    const fixture = mockRuntime(t, { override: appHost, files: [appHost, pathNode], probe: () => ({ status: 0, signal: null, stdout: 'compiled app' }) });
    await assert.rejects(executeParsedArgs(['validate', graphFile]), /no fallback attempted/);
    assert.deepEqual(fixture.probes.map(call => call.file), [appHost]);
    assert.equal(fixture.forwards.length, 0);
});

test('compiled host is never used as fallback when PATH has no absolute runtime', async t => {
    const fixture = mockRuntime(t, { searchPath: ['', '.', 'relative-runtime'].join(path.delimiter), files: [appHost, pathNode] });
    await assert.rejects(new FlowStudioController().start(graphFile, { port: 43210 }), /No valid JavaScript runtime/);
    await assert.rejects(executeParsedArgs(['validate', graphFile]), /No valid JavaScript runtime/);
    assert.equal(fixture.probes.length, 0);
    assert.equal(fixture.starts.length, 0);
    assert.equal(fixture.forwards.length, 0);
});

test('invalid PATH Node is rejected without falling back to compiled process.execPath', async t => {
    const fixture = mockRuntime(t, { probe: () => ({ status: 0, signal: null, stdout: 'compiled app' }) });
    await assert.rejects(new FlowStudioController().start(graphFile, { port: 43210 }), /No valid JavaScript runtime/);
    assert.deepEqual(fixture.probes.map(call => call.file), [pathNode]);
    assert.equal(fixture.starts.length, 0);
});

test('host named node must still pass the probe before being used', async t => {
    const host = path.resolve('Renamed Compiled Host', executable('node'));
    const fixture = mockRuntime(t, { host, searchPath: '', files: [host], probe: () => ({ status: 0, signal: null, stdout: 'compiled app' }) });
    await assert.rejects(new FlowStudioController().start(graphFile, { port: 43210 }), /No valid JavaScript runtime/);
    assert.deepEqual(fixture.probes.map(call => call.file), [host]);
    assert.equal(fixture.starts.length, 0);
});

test('workspace and loopback restrictions still reject before probing a runtime', async t => {
    const fixture = mockRuntime(t);
    const controller = new FlowStudioController();
    await assert.rejects(controller.start(graphFile, { workspace, host: '0.0.0.0', port: 43210 }), /loopback/);
    await assert.rejects(controller.start(path.resolve(workspace, '..', 'outside.json'), { workspace, port: 43210 }), /fora do workspace/);
    assert.equal(fixture.probes.length, 0);
    assert.equal(fixture.starts.length, 0);
});

test('plugin runtimePath is host-only, reaches the controller and rejects non-string configuration', async t => {
    const input = { client: { app: { log: async () => ({}) } } };
    const runtimePath = path.resolve('Host Runtime', executable('node'));
    let captured;
    t.mock.method(FlowStudioController.prototype, 'start', async (_file, options) => { captured = options; });
    const hooks = await plugin(input, { runtimePath });
    t.after(() => hooks.dispose());
    for (const tool of Object.values(hooks.tool)) assert.equal('runtimePath' in tool.args, false);
    await hooks.tool.flow_open.execute({ file: graphFile, browser: false, runtimePath: appHost }, {
        directory: workspace, worktree: workspace, abort: new AbortController().signal, metadata() {}
    });
    assert.equal(captured.runtimePath, runtimePath);
    for (const invalid of [null, 42, ['node']]) await assert.rejects(plugin(input, { runtimePath: invalid }), /runtimePath/);
});

test('Windows browser uses verified System32 paths even with a workspace rundll32 trap', { skip: process.platform !== 'win32' }, t => {
    const systemRoot = 'C:\\Trusted Windows';
    const directory = path.win32.join(systemRoot, 'System32');
    const browser = path.win32.join(directory, 'rundll32.exe');
    const library = path.win32.join(directory, 'url.dll');
    const fixture = mockRuntime(t, { files: [browser, library, path.resolve('rundll32.exe'), path.resolve('url.dll')] });
    const previousRoot = process.env.SystemRoot;
    process.env.SystemRoot = systemRoot;
    t.after(() => {
        if (previousRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = previousRoot;
    });
    const controller = new FlowStudioController();
    const target = 'http://127.0.0.1:43210/?token=test-browser-token';
    controller.session = { studioUrl: target, process: { exitCode: null } };
    controller.open();
    const [{ file, args, options, child }] = fixture.starts;
    assert.equal(file, browser);
    assert.deepEqual(args, ['url.dll,FileProtocolHandler', target]);
    assert.deepEqual(options, { cwd: directory, detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    assert.equal(child.unreferenced, true);
    assert.equal(fixture.probes.length, 0, 'browser does not use runtime discovery');
    assert.doesNotThrow(() => child.emit('error', new Error('late browser failure')));
});

test('Windows browser fails closed for invalid SystemRoot, missing files or workspace redirection', { skip: process.platform !== 'win32' }, async t => {
    const systemRoot = 'C:\\Trusted Windows';
    const browser = path.win32.join(systemRoot, 'System32', 'rundll32.exe');
    const library = path.win32.join(systemRoot, 'System32', 'url.dll');
    const cases = [
        { name: 'unset root', root: undefined },
        { name: 'empty root', root: '' },
        { name: 'relative root', root: 'Windows' },
        { name: 'drive relative root', root: 'C:Windows' },
        { name: 'root without drive', root: '\\Windows' },
        { name: 'UNC root', root: '\\\\server\\Windows' },
        { name: 'missing executable', root: systemRoot, files: [library, path.resolve('rundll32.exe')] },
        { name: 'missing DLL', root: systemRoot, files: [browser, path.resolve('url.dll')] },
        { name: 'redirected executable', root: systemRoot, files: [browser, library], redirect: browser },
        { name: 'redirected DLL', root: systemRoot, files: [browser, library], redirect: library }
    ];
    for (const { name, root, files = [], redirect } of cases) {
        await t.test(name, t => {
            const fixture = mockRuntime(t, { files, canonicalPath: file => file === redirect ? path.resolve(path.win32.basename(file)) : file });
            const previousRoot = process.env.SystemRoot;
            if (root === undefined) delete process.env.SystemRoot;
            else process.env.SystemRoot = root;
            t.after(() => {
                if (previousRoot === undefined) delete process.env.SystemRoot;
                else process.env.SystemRoot = previousRoot;
            });
            const controller = new FlowStudioController();
            controller.session = { studioUrl: 'http://127.0.0.1/?token=test-browser-token', process: { exitCode: null } };
            assert.throws(() => controller.open(), error => {
                assert.match(error.message, /Cannot open browser/);
                assert.equal(error.message.includes('test-browser-token'), false);
                return true;
            });
            assert.equal(fixture.starts.length, 0);
            assert.equal(fixture.probes.length, 0);
        });
    }
});

test('real spawn with nonexistent workspace rejects ENOENT without an unhandled child error', { timeout: 3000 }, async t => {
    const missingWorkspace = path.join(workspace, 'test', 'nonexistent-spawn-workspace');
    assert.equal(fs.existsSync(missingWorkspace), false);
    const fixture = mockRuntime(t, {
        files: [realExecPath], start: realSpawn,
        request: (_url, { signal }) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    });
    const controller = new FlowStudioController();
    const started = performance.now();
    await assert.rejects(controller.start(path.join(missingWorkspace, 'flow.json'), {
        workspace: missingWorkspace, runtimePath: realExecPath, port: 43210, token: 'private-startup-token'
    }), error => {
        assert.match(error.message, /ENOENT/);
        assert.equal(JSON.stringify(error).includes('private-startup-token'), false);
        assert.equal(error.message.includes('private-startup-token'), false);
        assert.equal('spawnargs' in error, false);
        return true;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(controller.activeSession, undefined);
    assert.equal(fixture.starts[0].child.pid, undefined);
    assert.ok(fixture.starts[0].child.listenerCount('error') > 0);
    assert.ok(performance.now() - started < 2000, 'no four-second cleanup wait for a process without a PID');
});

test('missing PID with an early healthy response still rejects and handles a later error', async t => {
    const child = new EventEmitter();
    child.exitCode = null;
    const fixture = mockRuntime(t, { start: () => child });
    const controller = new FlowStudioController();
    await assert.rejects(controller.start(graphFile, { port: 43210 }), /Não foi possível iniciar/);
    await new Promise(resolve => setImmediate(resolve));
    assert.doesNotThrow(() => child.emit('error', Object.assign(new Error('late ENOENT'), { code: 'ENOENT' })));
    assert.equal(fixture.starts.length, 1);
    assert.equal(controller.activeSession, undefined);
});

for (const failure of ['deadline', 'caller cancellation', 'child error']) {
    test(`health connection with no headers is bounded by ${failure}`, { timeout: 5000 }, async t => {
        let accepted;
        const requestAccepted = new Promise(resolve => { accepted = resolve; });
        const sockets = new Set();
        const server = createServer((request, _response) => {
            assert.equal(request.url, '/api/health');
            assert.equal(request.headers['x-flow-studio-token'], 'private-health-token');
            accepted(); // Intentionally keep the HTTP response open without sending headers.
        });
        server.on('connection', socket => {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        t.after(async () => {
            for (const socket of sockets) socket.destroy();
            await new Promise(resolve => server.close(resolve));
        });
        let requestSignal;
        const fixture = mockRuntime(t, { request: (url, options) => {
            requestSignal = options.signal;
            return realFetch(url, options);
        } });
        if (failure === 'deadline') {
            // Keep real networking/timers, but leave only one second of the controller's 20-second budget.
            const baseline = Date.now();
            const since = performance.now();
            let first = true;
            t.mock.method(Date, 'now', () => {
                if (first) { first = false; return baseline; }
                return baseline + 19000 + Math.floor(performance.now() - since);
            });
        }
        const controller = new FlowStudioController();
        t.after(() => controller.stop());
        const caller = new AbortController();
        const started = performance.now();
        const pending = controller.start(graphFile, {
            port: server.address().port, token: 'private-health-token', signal: caller.signal
        });
        const rejected = assert.rejects(pending, failure === 'deadline' ? /não respondeu/ : failure === 'child error' ? /ENOENT/ : /cancelada/);
        await requestAccepted;
        if (failure === 'caller cancellation') caller.abort(new Error('private caller reason'));
        if (failure === 'child error') fixture.starts[0].child.emit('error', Object.assign(new Error('private spawn error'), { code: 'ENOENT' }));
        await rejected;
        assert.equal(requestSignal.aborted, true);
        assert.notEqual(requestSignal, caller.signal);
        assert.equal(fixture.starts[0].child.exitCode, 0, 'failed startup terminates the spawned child');
        assert.equal(controller.activeSession, undefined);
        assert.equal(fixture.requests.length, 1);
        assert.ok(performance.now() - started < 2500, 'startup does not wait for HTTP headers beyond its budget or cancellation');
    });
}

test('a healthy response cannot hide concurrent caller cancellation', async t => {
    const caller = new AbortController();
    const fixture = mockRuntime(t, { request: async () => { caller.abort(); return { ok: true }; } });
    const controller = new FlowStudioController();
    await assert.rejects(controller.start(graphFile, { port: 43210, signal: caller.signal }), /cancelada/);
    assert.equal(controller.activeSession, undefined);
    assert.equal(fixture.starts[0].child.exitCode, 0);
});

test('health retries use the remaining deadline and release response bodies', async t => {
    let now = Date.now();
    let cancelledBodies = 0;
    let requests = 0;
    const budgets = [];
    const timeout = AbortSignal.timeout;
    mockRuntime(t, { request: async () => {
        requests += 1;
        if (requests === 1) now += 19750;
        return { ok: requests === 2, body: { cancel: async () => { cancelledBodies += 1; } } };
    } });
    t.mock.method(Date, 'now', () => now);
    t.mock.method(AbortSignal, 'timeout', milliseconds => { budgets.push(milliseconds); return timeout(milliseconds); });
    const controller = new FlowStudioController();
    t.after(() => controller.stop());
    await controller.start(graphFile, { port: 43210 });
    assert.deepEqual(budgets, [20000, 250]);
    assert.equal(cancelledBodies, 2);
});

function mockRuntime(t, { host = appHost, searchPath = process.platform === 'win32' ? `"${path.dirname(pathNode)}"` : path.dirname(pathNode), files = [pathNode], override, probe, start, request, canonicalPath = file => file } = {}) {
    const execDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath');
    const pathKey = Object.keys(process.env).find(key => process.platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH') || 'PATH';
    const oldPath = process.env[pathKey];
    const oldOverride = process.env.FLOW_STUDIO_RUNTIME_PATH;
    Object.defineProperty(process, 'execPath', { ...execDescriptor, value: host });
    process.env[pathKey] = searchPath;
    if (override === undefined) delete process.env.FLOW_STUDIO_RUNTIME_PATH;
    else process.env.FLOW_STUDIO_RUNTIME_PATH = override;
    t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
        Object.defineProperty(process, 'execPath', execDescriptor);
        if (oldPath === undefined) delete process.env[pathKey];
        else process.env[pathKey] = oldPath;
        if (oldOverride === undefined) delete process.env.FLOW_STUDIO_RUNTIME_PATH;
        else process.env.FLOW_STUDIO_RUNTIME_PATH = oldOverride;
    });
    const fixture = { probes: [], starts: [], forwards: [], requests: [] };
    t.mock.method(fs, 'statSync', file => {
        if (files.includes(file)) return { isFile: () => true };
        throw Object.assign(new Error('Fixture executable does not exist'), { code: 'ENOENT' });
    });
    t.mock.method(fs, 'realpathSync', canonicalPath);
    t.mock.method(childProcess, 'spawnSync', (file, args, options) => {
        if (args[0] !== '--eval') {
            fixture.forwards.push({ file, args, options });
            return { status: 17, signal: null };
        }
        fixture.probes.push({ file, args, options });
        return probe ? probe(file, args, options) : {
            status: 0, signal: null, stdout: args[1].match(/flow-runtime-[a-f0-9]{32}/)[0], stderr: ''
        };
    });
    t.mock.method(childProcess, 'spawn', (file, args, options) => {
        const child = start ? start(file, args, options) : new EventEmitter();
        if (!start) {
            child.pid = 43210;
            child.exitCode = null;
            child.stderr = new EventEmitter();
            child.kill = () => { child.exitCode = 0; child.emit('exit', 0); return true; };
            child.unref = () => { child.unreferenced = true; return child; };
        }
        fixture.starts.push({ file, args, options, child });
        return child;
    });
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        fixture.requests.push({ url, token: options.headers['X-Flow-Studio-Token'] });
        return request ? request(url, options) : { ok: true };
    });
    syncBuiltinESMExports();
    return fixture;
}
