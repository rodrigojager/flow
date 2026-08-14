'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { flowStudioMemoryCandidateDigest } = require('../../flow-studio-shared/lib');
const { FlowStudioFileRunStore } = require('../lib/run-store');
const { FlowStudioRunManager } = require('../lib/run-manager');

const HOST = '127.0.0.1';
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const CLI_ENTRY = path.join(PACKAGE_ROOT, 'lib', 'index.js');
const BODY_LIMIT_BYTES = 2 * 1024 * 1024;

test('Flow Studio CLI HTTP integration and security contract', { timeout: 120_000 }, async t => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-studio-cli-test-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-studio-cli-outside-'));
    const graphPath = path.join(workspace, 'flow-studio.graph.json');
    const token = `test-${process.pid}-${Date.now()}`;
    await writeJson(graphPath, simpleGraph('boot'));
    await writeJson(path.join(outside, 'secret.json'), { secret: 'FLOW_STUDIO_MUST_NOT_DISCLOSE_THIS' });

    let server = await startCliServer({ workspace, graphPath, token });
    let completedRun;

    t.after(async () => {
        await server?.stop();
        await fs.rm(workspace, { recursive: true, force: true });
        await fs.rm(outside, { recursive: true, force: true });
    });

    await t.test('requires the session token for every API route', async () => {
        const missing = await request(server, '/api/health', { auth: false });
        assert.equal(missing.status, 401);
        assert.match(await missing.text(), /token/i);

        const wrong = await request(server, '/api/health', {
            auth: false,
            headers: { 'x-flow-studio-token': 'wrong-token' }
        });
        assert.equal(wrong.status, 401);

        const accepted = await request(server, '/api/health');
        assert.equal(accepted.status, 200);
        const payload = await accepted.json();
        assert.equal(payload.status, 'ok');
        assert.equal(payload.version, 'flow-studio/v2');
    });

    await t.test('rejects untrusted browser origins and accepts its exact local origin', async () => {
        const rejected = await request(server, '/api/health', { origin: 'https://evil.example' });
        assert.equal(rejected.status, 403);
        assert.match(await rejected.text(), /origin/i);

        const accepted = await request(server, '/api/health', { origin: server.baseUrl });
        assert.equal(accepted.status, 200);
        assert.equal(accepted.headers.get('access-control-allow-origin'), null);
    });

    await t.test('calculates an authenticated immutable memory candidate digest without persisting it', async () => {
        const candidate = { id: 'candidate-digest', status: 'candidate', revision: 3, scope: 'project', kind: 'decision', value: { rule: 'strict' }, tags: ['flow'] };
        const response = await request(server, '/api/memory/candidate-digest', { method: 'POST', json: { candidate, scope: 'project' } });
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal((await response.json()).candidateDigest, flowStudioMemoryCandidateDigest(candidate, 'project'));
        const malformed = await request(server, '/api/memory/candidate-digest', { method: 'POST', json: { candidate: { status: 'approved' }, scope: 'project' } });
        assert.equal(malformed.status, 400);
    });

    await t.test('validates GraphSpec v2 and rejects the obsolete schema', async () => {
        const validResponse = await request(server, '/api/validate', {
            method: 'POST',
            json: { graph: simpleGraph('valid-v2') }
        });
        assert.equal(validResponse.status, 200);
        const valid = await validResponse.json();
        assert.equal(valid.valid, true);
        assert.deepEqual(valid.errors, []);

        const obsolete = { ...simpleGraph('obsolete'), version: 'flow-studio/v1' };
        const obsoleteResponse = await request(server, '/api/validate', {
            method: 'POST',
            json: { graph: obsolete }
        });
        assert.equal(obsoleteResponse.status, 400);
        const invalid = await obsoleteResponse.json();
        assert.equal(invalid.valid, false);
        assert.ok(invalid.errors.some(issue => issue.code === 'graph.version'));
    });

    await t.test('blocks lexical read and write traversal outside the configured workspace', async () => {
        const secretFile = path.join(outside, 'secret.json');
        const readResponse = await request(server, `/api/graph?path=${encodeURIComponent(secretFile)}`);
        const readBody = await readResponse.text();
        assert.ok(readResponse.status >= 400, `unexpected status ${readResponse.status}: ${readBody}`);
        assert.doesNotMatch(readBody, /FLOW_STUDIO_MUST_NOT_DISCLOSE_THIS/);

        const escapedTarget = path.join(outside, 'escaped-write.json');
        const writeResponse = await request(server, '/api/graph', {
            method: 'POST',
            json: { path: escapedTarget, graph: simpleGraph('escaped-write') }
        });
        assert.ok(writeResponse.status >= 400, `unexpected status ${writeResponse.status}`);
        await assert.rejects(fs.access(escapedTarget), error => error && error.code === 'ENOENT');
    });

    await t.test('does not follow a workspace symlink or junction to files outside the workspace', async t => {
        const link = path.join(workspace, 'outside-link');
        try {
            await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error) {
            if (error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOSYS')) {
                t.skip(`symlink/junction unavailable: ${error.code}`);
                return;
            }
            throw error;
        }

        const response = await request(server, `/api/graph?path=${encodeURIComponent(path.join(link, 'secret.json'))}`);
        const body = await response.text();
        assert.ok(response.status >= 400, `symlink escape returned ${response.status}: ${body}`);
        assert.doesNotMatch(body, /FLOW_STUDIO_MUST_NOT_DISCLOSE_THIS/);
    });

    await t.test('rejects bodies above the configured limit with HTTP 413 and remains healthy', async () => {
        const oversized = JSON.stringify({ padding: 'x'.repeat(BODY_LIMIT_BYTES + 1024) });
        let response;
        try {
            response = await request(server, '/api/validate', {
                method: 'POST',
                body: oversized,
                headers: { 'content-type': 'application/json' },
                timeoutMs: 15_000
            });
        } catch (error) {
            assert.fail(`oversized body reset the connection instead of returning 413: ${error.message}`);
        }
        assert.equal(response.status, 413, await response.text());

        const health = await request(server, '/api/health');
        assert.equal(health.status, 200);
    });

    await t.test('runs an agent only in explicit simulation mode and persists its complete status', async () => {
        const response = await request(server, '/api/run', {
            method: 'POST',
            json: { graph: simulatedAgentGraph('simulated-run'), input: { request: 'hello' } }
        });
        assert.equal(response.status, 200, await response.clone().text());
        const payload = await response.json();
        assert.equal(payload.ok, true);
        assert.equal(payload.run.status, 'completed');
        assert.equal(payload.result.status, 'completed');
        assert.ok(payload.events.some(event => event.kind === 'run.completed'));
        assert.equal(payload.result.finalContext.result, 'Handle hello');
        assert.ok(payload.events.some(event => /simulou o nó agent/i.test(event.message)));

        completedRun = payload.run;
        const persistedPath = path.join(workspace, '.flow-studio', 'runs', `${completedRun.id}.json`);
        const persisted = JSON.parse(await fs.readFile(persistedPath, 'utf8'));
        assert.equal(persisted.id, completedRun.id);
        assert.equal(persisted.status, 'completed');
        assert.ok(Array.isArray(persisted.events) && persisted.events.length > 0);
        assert.ok(Array.isArray(persisted.checkpoints) && persisted.checkpoints.length > 0);
    });

    await t.test('loads persisted run status after a real CLI server restart', async () => {
        assert.ok(completedRun, 'simulation run must exist');
        await server.stop();
        server = await startCliServer({ workspace, graphPath, token });

        const response = await request(server, `/api/runs/${completedRun.id}`);
        assert.equal(response.status, 200);
        const payload = await response.json();
        assert.equal(payload.run.id, completedRun.id);
        assert.equal(payload.run.status, 'completed');
        assert.ok(payload.run.result);
    });

    await t.test('executes an explicitly enabled graph command through the permission boundary', async () => {
        await server.stop();
        await assert.rejects(
            startCliServer({ workspace, graphPath, token, extraArgs: ['--allow-graph-tools'] }),
            /allow-command/i,
            'allow-graph-tools must fail closed without a host command allowlist'
        );
        server = await startCliServer({ workspace, graphPath, token, extraArgs: ['--allow-graph-tools', '--allow-command', 'node*'] });
        const graph = {
            version: 'flow-studio/v2', id: 'real-tool', name: 'Real tool', start: 'action',
            permissions: { allow: ['tool:command'], commandPatterns: ['node*'] },
            nodes: [
                {
                    id: 'action', type: 'action', label: 'Action', next: 'end',
                    tools: [{ id: 'node-smoke', name: 'Node smoke', command: 'node', args: ['-e', 'process.stdout.write(JSON.stringify({result:"real-tool"}))'], effect: 'command', requiredPermissions: ['tool:command'], idempotencyKey: 'real-tool-once' }],
                    outputs: { result: 'flow.tool' }
                },
                { id: 'end', type: 'end', label: 'End' }
            ],
            edges: [{ from: 'action', to: 'end' }],
            budget: { maxSteps: 30, maxDurationMs: 10_000 }
        };
        const response = await request(server, '/api/run', { method: 'POST', json: { graph } });
        assert.equal(response.status, 200, await response.clone().text());
        const payload = await response.json();
        assert.equal(payload.result.status, 'completed', payload.result.error);
        assert.equal(payload.result.finalContext.flow.tool, 'real-tool');
    });

    await t.test('rejects a graph command outside the independent host allowlist', async () => {
        const graph = {
            version: 'flow-studio/v2', id: 'denied-host-tool', name: 'Denied host tool', start: 'action',
            permissions: { allow: ['tool:command'], commandPatterns: ['*'] },
            nodes: [
                { id: 'action', type: 'action', label: 'Action', tools: [{ id: 'denied', name: 'Denied', command: 'powershell.exe', args: ['-NoProfile'], effect: 'command', requiredPermissions: ['tool:command'], idempotencyKey: 'denied-once' }], next: 'end' },
                { id: 'end', type: 'end', label: 'End' }
            ], edges: [], budget: { maxSteps: 20, maxDurationMs: 10_000 }
        };
        const response = await request(server, '/api/run', { method: 'POST', json: { graph } });
        assert.equal(response.status, 500);
        const payload = await response.json();
        assert.match(payload.run.error, /allowlist do host/i);
    });

    await t.test('anchors graph tool cwd and relative file roots to the configured workspace', async () => {
        const nested = path.join(workspace, 'nested-tool-cwd');
        await fs.mkdir(nested, { recursive: true });
        const graph = {
            version: 'flow-studio/v2', id: 'tool-workspace', name: 'Tool workspace', start: 'action',
            permissions: { allow: ['tool:command'], commandPatterns: ['node*'], fileRoots: ['.'] },
            nodes: [
                {
                    id: 'action', type: 'action', label: 'Action', next: 'end',
                    tools: [{ id: 'cwd', name: 'cwd', command: 'node', args: ['-e', 'process.stdout.write(JSON.stringify({cwd:process.cwd()}))'], cwd: 'nested-tool-cwd', effect: 'command', requiredPermissions: ['tool:command'], idempotencyKey: 'cwd-once' }],
                    outputs: { cwd: 'flow.cwd' }
                },
                { id: 'end', type: 'end', label: 'End' }
            ], edges: [], budget: { maxSteps: 20, maxDurationMs: 10_000 }
        };
        const response = await request(server, '/api/run', { method: 'POST', json: { graph } });
        assert.equal(response.status, 200, await response.clone().text());
        const payload = await response.json();
        assert.equal(payload.result.status, 'completed', payload.result.error);
        assert.equal(path.resolve(payload.result.finalContext.flow.cwd), path.resolve(nested));
    });

    await t.test('runs every restored legacy block through real CLI host adapters', async () => {
        const playbookScript = path.join(workspace, 'playbook-adapter.cjs');
        await fs.writeFile(playbookScript, `'use strict';\nlet input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const request=JSON.parse(input);process.stdout.write(JSON.stringify({ok:true,message:'playbook ok',output:{playbookValue:request.parameters.value},signals:{source:'cli'}}));});\n`, 'utf8');
        await fs.writeFile(path.join(workspace, 'context.md'), '# Contexto confiável\nRegra operacional.', 'utf8');
        await server.stop();
        server = await startCliServer({
            workspace,
            graphPath,
            token,
            extraArgs: ['--allow-graph-tools', '--allow-command', 'node*', '--playbook-exec', `quality=${JSON.stringify(process.execPath)} ${JSON.stringify(playbookScript)}`]
        });
        const graph = {
            version: 'flow-studio/v2', id: 'restored-legacy-blocks', name: 'Restored legacy blocks', start: 'context',
            permissions: {
                allow: ['memory:read', 'memory:write', 'tool:read', 'playbook:run'],
                commandPatterns: ['flow-studio:*', 'playbook:*', 'node*'],
                fileRoots: ['.']
            },
            nodes: [
                { id: 'context', type: 'context', label: 'Context', context: { filePaths: ['context.md'], statePaths: ['request'], scopes: ['workspace'], maxItems: 10, maxBytes: 32_000, outputPath: 'loadedContext', required: true }, next: 'memory' },
                { id: 'memory', type: 'memory_write', label: 'Memory', memoryWrite: { scope: 'workspace', candidatesFrom: 'memoryCandidates', policy: 'approved-only', onEmpty: 'fail', outputPath: 'memoryWrites', idempotencyKey: 'memory-v1' }, next: 'command' },
                { id: 'command', type: 'command', label: 'Command', command: { command: 'node', args: ['-e', 'process.stdout.write(JSON.stringify({commandValue:"ok", leaked:Boolean(process.env.FLOW_STUDIO_TEST_SECRET)}))'], effect: 'read', requiredPermissions: ['tool:read'], idempotencyKey: 'command-v1' }, next: 'playbook' },
                { id: 'playbook', type: 'playbook', label: 'Playbook', playbook: { playbookId: 'quality', parameters: { value: 42 }, idempotencyKey: 'playbook-v1' }, next: 'dynamic' },
                { id: 'dynamic', type: 'dynamic_parallel', label: 'Dynamic', dynamicParallel: { itemsFrom: 'items', itemVariable: 'item', concurrency: 2, maxItems: 8, failurePolicy: 'fail_fast', joinStrategy: 'require_all', outputPath: 'dynamicResults', worker: { id: 'worker', type: 'transform', label: 'Worker', condition: '({ doubled: item * 2 })' } }, next: 'tournament' },
                { id: 'tournament', type: 'tournament', label: 'Tournament', tournament: { candidatesFrom: 'candidates', strategy: 'single_round', criteria: ['quality'], winnerCount: 1, maxComparisons: 1, tieBreaker: 'first_candidate', outputPath: 'tournamentResult', blind: false, judge: { id: 'judge', type: 'transform', label: 'Judge', condition: '({ winnerIds: [context.tournament.candidates.find(candidate => candidate.value.answer === "A").id], scores: Object.fromEntries(context.tournament.candidates.map(candidate => [candidate.id, candidate.value.answer === "A" ? 1 : 0])), reason: "quality" })' } }, next: 'end' },
                { id: 'end', type: 'end', label: 'End' }
            ],
            edges: [],
            budget: { maxSteps: 100, maxDurationMs: 20_000, maxParallelism: 4 }
        };
        const input = {
            request: 'assemble context',
            memoryCandidates: [{ id: 'decision-1', status: 'approved', revision: 1, scope: 'workspace', kind: 'decision', value: 'Use strict gates', approvedBy: 'tester' }],
            items: [1, 2, 3],
            candidates: [{ answer: 'A' }, { answer: 'B' }]
        };
        const memoryApprovals = [{
            id: input.memoryCandidates[0].id,
            revision: input.memoryCandidates[0].revision,
            scope: input.memoryCandidates[0].scope,
            graphId: graph.id,
            nodeId: 'memory',
            candidateDigest: flowStudioMemoryCandidateDigest(input.memoryCandidates[0], input.memoryCandidates[0].scope)
        }];
        const response = await request(server, '/api/run', { method: 'POST', json: { graph, input, memoryApprovals } });
        assert.equal(response.status, 200, await response.clone().text());
        const payload = await response.json();
        assert.equal(payload.result.status, 'completed', payload.result.error);
        assert.match(payload.result.finalContext.loadedContext.files[0].content, /Contexto confiável/);
        assert.equal(payload.result.finalContext.memoryWrites['decision-1'].status, 'written');
        assert.equal(payload.result.finalContext.commandValue, 'ok');
        assert.equal(payload.result.finalContext.leaked, false, 'child adapter inherited a non-allowlisted secret');
        assert.equal(payload.result.finalContext.playbookValue, 42);
        assert.deepEqual(payload.result.finalContext.dynamicResults.results.map(item => item.output.doubled), [2, 4, 6]);
        assert.equal(payload.result.finalContext.tournamentResult.winners[0].value.answer, 'A');
        const memoryStore = JSON.parse(await fs.readFile(path.join(workspace, '.flow-studio', 'memory.json'), 'utf8'));
        assert.equal(memoryStore.entries.length, 1);
        assert.equal(memoryStore.entries[0].value, 'Use strict gates');
        assert.notEqual(memoryStore.entries[0].approvedBy, 'tester', 'candidate cannot forge approval provenance');
        assert.equal(memoryStore.entries[0].graphId, graph.id);
        assert.equal(memoryStore.entries[0].nodeId, 'memory');
        assert.ok(payload.result.artifacts.some(artifact => artifact.name.startsWith('Context pack')));
    });

    await t.test('recovers an old malformed memory lock and bounds local memory retention', async () => {
        const lockDirectory = path.join(workspace, '.flow-studio', 'memory.json.lock');
        await fs.rm(lockDirectory, { recursive: true, force: true });
        await fs.mkdir(lockDirectory, { recursive: true });
        const old = new Date(Date.now() - 60_000);
        await fs.utimes(lockDirectory, old, old);
        const graph = {
            version: 'flow-studio/v2', id: 'bounded-memory-store', name: 'Bounded memory store', start: 'memory',
            permissions: { allow: ['memory:write'] },
            nodes: [
                { id: 'memory', type: 'memory_write', label: 'Memory', memoryWrite: { scope: 'workspace', candidatesFrom: 'memoryCandidates', policy: 'approved-only', onEmpty: 'fail', outputPath: 'memoryWrites', idempotencyKey: 'bounded-memory' }, next: 'end' },
                { id: 'end', type: 'end', label: 'End' }
            ], edges: [], budget: { maxSteps: 10, maxDurationMs: 10_000 }
        };
        for (let revision = 1; revision <= 21; revision += 1) {
            const candidate = { id: 'retained-candidate', status: 'candidate', revision, scope: 'workspace', kind: 'fact', value: `revision-${revision}` };
            const approval = { id: candidate.id, revision, scope: 'workspace', graphId: graph.id, nodeId: 'memory', candidateDigest: flowStudioMemoryCandidateDigest(candidate, 'workspace') };
            const response = await request(server, '/api/run', { method: 'POST', json: { graph, input: { memoryCandidates: [candidate] }, memoryApprovals: [approval] } });
            assert.equal(response.status, 200, await response.clone().text());
            const payload = await response.json();
            assert.equal(payload.result.status, 'completed', payload.result.error);
        }
        await fs.mkdir(lockDirectory, { recursive: true });
        const ownerFile = path.join(lockDirectory, 'owner.json');
        await fs.writeFile(ownerFile, JSON.stringify({ pid: 2147483647, token: 'dead-owner', createdAt: old.toISOString(), processStartedAt: '2000-01-01T00:00:00.000Z' }), 'utf8');
        await fs.utimes(ownerFile, old, old);
        const leaseCandidate = { id: 'lease-candidate', status: 'candidate', revision: 1, scope: 'workspace', value: 'lease recovered' };
        const leaseApproval = { id: leaseCandidate.id, revision: 1, scope: 'workspace', graphId: graph.id, nodeId: 'memory', candidateDigest: flowStudioMemoryCandidateDigest(leaseCandidate, 'workspace') };
        const leaseResponse = await request(server, '/api/run', { method: 'POST', json: { graph, input: { memoryCandidates: [leaseCandidate] }, memoryApprovals: [leaseApproval] } });
        assert.equal(leaseResponse.status, 200, await leaseResponse.clone().text());
        assert.equal((await leaseResponse.json()).result.status, 'completed');
        const store = JSON.parse(await fs.readFile(path.join(workspace, '.flow-studio', 'memory.json'), 'utf8'));
        const retained = store.entries.filter(entry => entry.candidateId === 'retained-candidate');
        assert.equal(retained.length, 20);
        assert.equal(retained[0].revision, 2);
        assert.equal(retained[19].revision, 21);
        await assert.rejects(fs.access(lockDirectory), error => error?.code === 'ENOENT');
    });

    await t.test('rejects an oversized local memory record before persistence', async () => {
        const graph = {
            version: 'flow-studio/v2', id: 'oversized-memory-record', name: 'Oversized memory record', start: 'memory',
            permissions: { allow: ['memory:write'] },
            nodes: [
                { id: 'memory', type: 'memory_write', label: 'Memory', memoryWrite: { scope: 'workspace', candidatesFrom: 'memoryCandidates', policy: 'approved-only', onEmpty: 'fail', outputPath: 'memoryWrites', idempotencyKey: 'oversized-memory' }, next: 'end' },
                { id: 'end', type: 'end', label: 'End' }
            ], edges: [], budget: { maxSteps: 10, maxDurationMs: 10_000 }
        };
        const candidate = { id: 'oversized-candidate', status: 'candidate', revision: 1, scope: 'workspace', value: 'x'.repeat(600 * 1024) };
        const approval = { id: candidate.id, revision: 1, scope: 'workspace', graphId: graph.id, nodeId: 'memory', candidateDigest: flowStudioMemoryCandidateDigest(candidate, 'workspace') };
        const response = await request(server, '/api/run', { method: 'POST', json: { graph, input: { memoryCandidates: [candidate] }, memoryApprovals: [approval] } });
        assert.equal(response.status, 500, await response.clone().text());
        const payload = await response.json();
        assert.equal(payload.result.status, 'failed');
        assert.match(payload.result.error, /excede o limite/i);
        const store = JSON.parse(await fs.readFile(path.join(workspace, '.flow-studio', 'memory.json'), 'utf8'));
        assert.equal(store.entries.some(entry => entry.candidateId === candidate.id), false);
    });

    await t.test('uses the trusted memory-exec bridge for context and approved writes', async () => {
        const memoryScript = path.join(workspace, 'memory-adapter.cjs');
        const memoryLog = path.join(workspace, 'memory-adapter.jsonl');
        await fs.writeFile(memoryScript, `'use strict';const fs=require('node:fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const request=JSON.parse(input);fs.appendFileSync(${JSON.stringify(memoryLog)},JSON.stringify(request)+'\\n');if(request.operation==='loadContext'){process.stdout.write(JSON.stringify({pack:{summary:'CyberVinci Memory bridge',memories:[{source:'bridge'}]}}));return;}process.stdout.write(JSON.stringify({candidateId:request.candidate.id==='forged-bridge'?'different-candidate':request.candidate.id,revision:request.candidate.revision,scope:request.approval.scope,status:'written',digest:request.approval.candidateDigest,writtenAt:new Date().toISOString()}));});`, 'utf8');
        await server.stop();
        server = await startCliServer({
            workspace,
            graphPath,
            token,
            extraArgs: ['--memory-exec', `${JSON.stringify(process.execPath)} ${JSON.stringify(memoryScript)}`, '--allow-graph-tools', '--allow-command', 'node*']
        });
        const graph = {
            version: 'flow-studio/v2', id: 'memory-bridge', name: 'Memory bridge', start: 'context',
            permissions: { allow: ['memory:read', 'memory:write'] },
            nodes: [
                { id: 'context', type: 'context', label: 'Context', context: { query: 'bridge', scopes: ['project'], required: true, outputPath: 'contextPack' }, next: 'memory' },
                { id: 'memory', type: 'memory_write', label: 'Memory', memoryWrite: { scope: 'project', candidatesFrom: 'memoryCandidates', policy: 'approved-only', onEmpty: 'fail', outputPath: 'memoryWrites', idempotencyKey: 'bridge-write' }, next: 'end' },
                { id: 'end', type: 'end', label: 'End' }
            ], edges: [], budget: { maxSteps: 20, maxDurationMs: 10_000 }
        };
        const candidate = { id: 'bridge-decision', status: 'approved', revision: 1, scope: 'project', kind: 'decision', value: 'Bridge only' };
        const memoryApprovals = [{ id: candidate.id, revision: candidate.revision, scope: candidate.scope, graphId: graph.id, nodeId: 'memory', candidateDigest: flowStudioMemoryCandidateDigest(candidate, candidate.scope) }];
        const response = await request(server, '/api/run', { method: 'POST', json: { graph, input: { memoryCandidates: [candidate] }, memoryApprovals } });
        assert.equal(response.status, 200, await response.clone().text());
        const payload = await response.json();
        assert.equal(payload.result.finalContext.contextPack.summary, 'CyberVinci Memory bridge');
        assert.equal(payload.result.finalContext.memoryWrites[candidate.id].status, 'written');
        const operations = (await fs.readFile(memoryLog, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
        assert.deepEqual(operations.map(item => item.operation), ['loadContext', 'writeCandidate']);
        assert.equal(operations[1].approval.candidateDigest, memoryApprovals[0].candidateDigest);

        const forgedCandidate = { ...candidate, id: 'forged-bridge', value: 'Must not accept another candidate receipt' };
        const forgedApprovals = [{ id: forgedCandidate.id, revision: forgedCandidate.revision, scope: forgedCandidate.scope, graphId: graph.id, nodeId: 'memory', candidateDigest: flowStudioMemoryCandidateDigest(forgedCandidate, forgedCandidate.scope) }];
        const forged = await request(server, '/api/run', { method: 'POST', json: { graph, input: { memoryCandidates: [forgedCandidate] }, memoryApprovals: forgedApprovals } });
        assert.equal(forged.status, 500, await forged.clone().text());
        assert.match((await forged.json()).result.error, /recibo.*não corresponde/i);
    });

    await t.test('forwards explicit digest-bound memory approvals from a human gate resume', async () => {
        const candidate = { id: 'resume-decision', status: 'approved', revision: 2, scope: 'project', kind: 'decision', value: 'Approved at gate' };
        const approval = { id: candidate.id, revision: candidate.revision, scope: candidate.scope, graphId: 'resume-memory-approval', nodeId: 'memory', candidateDigest: flowStudioMemoryCandidateDigest(candidate, candidate.scope) };
        const graph = {
            version: 'flow-studio/v2', id: 'resume-memory-approval', name: 'Resume memory approval', start: 'approval',
            permissions: { allow: ['memory:write'] },
            nodes: [
                { id: 'approval', type: 'gate', label: 'Approve memory', gate: { kind: 'human', prompt: 'Approve?' }, gateDecisions: [{ id: 'approve', label: 'Approve', decision: 'continue', toNodeId: 'memory' }] },
                { id: 'memory', type: 'memory_write', label: 'Memory', memoryWrite: { scope: 'project', candidatesFrom: 'memoryCandidates', policy: 'approved-only', onEmpty: 'fail', outputPath: 'memoryWrites', idempotencyKey: 'resume-memory' }, next: 'end' },
                { id: 'end', type: 'end', label: 'End' }
            ], edges: [], budget: { maxSteps: 20, maxDurationMs: 10_000 }
        };
        const waitingResponse = await request(server, '/api/run', { method: 'POST', json: { graph, input: { memoryCandidates: [candidate] } } });
        assert.equal(waitingResponse.status, 200, await waitingResponse.clone().text());
        const waiting = await waitingResponse.json();
        assert.equal(waiting.run.status, 'waiting');
        const resumeResponse = await request(server, `/api/runs/${waiting.run.id}/resume`, {
            method: 'POST',
            json: { checkpointId: waiting.result.waiting.checkpointId, gate: { action: 'continue', decisionId: 'approve', memoryApprovals: [approval] } }
        });
        assert.equal(resumeResponse.status, 202, await resumeResponse.clone().text());
        const resumed = await waitForRun(server, waiting.run.id, record => record.status !== 'running');
        assert.equal(resumed.status, 'completed', resumed.error);
        assert.equal(resumed.result.finalContext.memoryWrites[candidate.id].status, 'written');
    });

    await t.test('persists effect write-ahead and completion receipts before the node checkpoint', async () => {
        const graph = {
            version: 'flow-studio/v2', id: 'effect-write-ahead-store', name: 'Effect receipts', start: 'action',
            permissions: { allow: ['tool:command'], commandPatterns: ['node*'] },
            nodes: [
                { id: 'action', type: 'action', label: 'Action', tools: [{ id: 'slow-effect', name: 'Slow effect', command: 'node', args: ['-e', 'setTimeout(() => process.stdout.write(JSON.stringify({done:true})), 250)'], effect: 'command', requiredPermissions: ['tool:command'], idempotencyKey: 'slow-effect-once' }], next: 'end' },
                { id: 'end', type: 'end', label: 'End' }
            ], edges: [], budget: { maxSteps: 20, maxDurationMs: 5_000 }
        };
        const launchResponse = await request(server, '/api/runs', { method: 'POST', json: { graph } });
        assert.equal(launchResponse.status, 202, await launchResponse.clone().text());
        const launch = await launchResponse.json();
        const started = await waitForRun(server, launch.run.id, record => record.effects.some(effect => effect.status === 'started'));
        assert.equal(started.effects[0].status, 'started');
        assert.equal(started.checkpoints.some(checkpoint => checkpoint.nodeId === 'action'), false);
        const completed = await waitForRun(server, launch.run.id, record => record.status !== 'running');
        assert.equal(completed.status, 'completed', completed.error);
        assert.equal(completed.effects[0].status, 'completed');
    });

    await t.test('persists a human gate, resumes it with a declared decision, and completes', async () => {
        const waitingResponse = await request(server, '/api/run', {
            method: 'POST',
            json: { graph: humanGateGraph('gate-resume') }
        });
        assert.equal(waitingResponse.status, 200, await waitingResponse.clone().text());
        const waitingPayload = await waitingResponse.json();
        assert.equal(waitingPayload.run.status, 'waiting');
        assert.equal(waitingPayload.result.waiting.kind, 'gate');
        const checkpointId = waitingPayload.result.waiting.checkpointId;
        assert.ok(checkpointId);

        const resumeResponse = await request(server, `/api/runs/${waitingPayload.run.id}/resume`, {
            method: 'POST',
            json: {
                checkpointId,
                gate: { action: 'continue', decisionId: 'approve', message: 'Approved by integration test' }
            }
        });
        assert.equal(resumeResponse.status, 202, await resumeResponse.clone().text());
        const resumedLaunch = await resumeResponse.json();
        assert.equal(resumedLaunch.run.id, waitingPayload.run.id);

        const resumed = await waitForRun(server, waitingPayload.run.id, record => record.status !== 'running');
        assert.equal(resumed.status, 'completed', resumed.error);
        assert.ok(resumed.events.some(event => event.kind === 'run.resumed'));
        assert.ok(resumed.events.some(event => event.kind === 'gate.resolved'));
        assert.ok(resumed.events.some(event => event.kind === 'run.completed'));
    });

    await t.test('in-place resume rejects stale checkpoints while replay keeps historical checkpoints available', async () => {
        const graph = {
            version: 'flow-studio/v2', id: 'authoritative-resume', name: 'Authoritative resume', start: 'wait',
            nodes: [
                { id: 'wait', type: 'wait', label: 'Wait', wait: { kind: 'event', eventName: 'ready', timeoutMs: 60_000, onTimeout: 'fail' }, next: 'end' },
                { id: 'end', type: 'end', label: 'End' }
            ],
            edges: [], budget: { maxSteps: 10, maxDurationMs: 5_000 }
        };
        const launchedResponse = await request(server, '/api/run', { method: 'POST', json: { graph } });
        assert.equal(launchedResponse.status, 200, await launchedResponse.clone().text());
        const launched = await launchedResponse.json();
        const sourceCheckpointId = launched.result.waiting.checkpointId;

        const pollResponse = await request(server, `/api/runs/${launched.run.id}/resume`, {
            method: 'POST',
            json: { checkpointId: sourceCheckpointId, signal: { eventName: 'not-ready' } }
        });
        assert.equal(pollResponse.status, 202, await pollResponse.clone().text());
        const resuspended = await waitForRun(server, launched.run.id, record => record.status !== 'running');
        assert.equal(resuspended.status, 'waiting', resuspended.error);
        const successorCheckpointId = resuspended.result.waiting.checkpointId;
        assert.notEqual(successorCheckpointId, sourceCheckpointId);

        const staleResume = await request(server, `/api/runs/${launched.run.id}/resume`, {
            method: 'POST',
            json: { checkpointId: sourceCheckpointId, signal: { eventName: 'not-ready' } }
        });
        assert.equal(staleResume.status, 400, await staleResume.clone().text());
        assert.match((await staleResume.json()).error, /fronteira autoritativa|replay/i);

        const replayResponse = await request(server, `/api/runs/${launched.run.id}/replay`, {
            method: 'POST', json: { checkpointId: sourceCheckpointId }
        });
        assert.equal(replayResponse.status, 202, await replayResponse.clone().text());
        const replay = await replayResponse.json();
        assert.notEqual(replay.run.id, launched.run.id);
        const replayed = await waitForRun(server, replay.run.id, record => record.status !== 'running');
        assert.equal(replayed.status, 'waiting', replayed.error);
    });

    await t.test('resumes a Subgraph Gate through its child interaction envelope and reaches its Wait', async () => {
        const child = {
            version: 'flow-studio/v2', id: 'cli-interaction-child', name: 'CLI interaction child', start: 'approval',
            nodes: [
                {
                    id: 'approval', type: 'gate', label: 'Child approval',
                    gate: { kind: 'human', prompt: 'Approve child work?' },
                    gateDecisions: [{ id: 'approve', label: 'Approve', decision: 'continue', toNodeId: 'wait' }]
                },
                { id: 'wait', type: 'wait', label: 'Child event', wait: { kind: 'event', eventName: 'child.completed', correlationKey: 'child-42' }, next: 'end' },
                { id: 'end', type: 'end', label: 'End' }
            ], edges: [], budget: { maxSteps: 20 }
        };
        const parent = {
            version: 'flow-studio/v2', id: 'cli-interaction-parent', name: 'CLI interaction parent', start: 'child',
            nodes: [
                { id: 'child', type: 'subgraph', label: 'Child', subgraph: { inline: child }, next: 'end' },
                { id: 'end', type: 'end', label: 'End' }
            ], edges: [], budget: { maxSteps: 30 }
        };
        const launchResponse = await request(server, '/api/run', { method: 'POST', json: { graph: parent } });
        assert.equal(launchResponse.status, 200, await launchResponse.clone().text());
        const launched = await launchResponse.json();
        assert.equal(launched.run.status, 'waiting');
        assert.equal(launched.result.waiting.detail.interaction.graphId, child.id);
        assert.equal(launched.result.waiting.detail.interaction.nodeId, 'approval');

        const gateResponse = await request(server, `/api/runs/${launched.run.id}/resume`, {
            method: 'POST',
            json: { checkpointId: launched.result.waiting.checkpointId, gate: { decisionId: 'approve', action: 'continue' } }
        });
        assert.equal(gateResponse.status, 202, await gateResponse.clone().text());
        const waiting = await waitForRun(server, launched.run.id, record => record.status !== 'running');
        assert.equal(waiting.status, 'waiting', waiting.error);
        assert.equal(waiting.result.waiting.detail.interaction.type, 'wait');
        assert.equal(waiting.result.waiting.detail.interaction.eventName, 'child.completed');
        assert.equal(waiting.result.waiting.detail.interaction.correlationKey, 'child-42');
    });

    await t.test('resumes a human gate with its default declared decision and ignores a conflicting client action', async () => {
        const graph = {
            version: 'flow-studio/v2', id: 'default-human-decisions', name: 'Default human decisions', start: 'gate',
            nodes: [
                { id: 'gate', type: 'gate', label: 'Gate', gate: { kind: 'human', prompt: 'Continue?' }, next: 'end' },
                { id: 'end', type: 'end', label: 'End' }
            ], edges: [], budget: { maxSteps: 10, maxDurationMs: 10_000 }
        };
        const waitingResponse = await request(server, '/api/run', { method: 'POST', json: { graph } });
        assert.equal(waitingResponse.status, 200, await waitingResponse.clone().text());
        const waiting = await waitingResponse.json();
        assert.equal(waiting.result.status, 'waiting');
        const resumeResponse = await request(server, `/api/runs/${waiting.run.id}/resume`, {
            method: 'POST',
            json: { checkpointId: waiting.result.waiting.checkpointId, gate: { decisionId: 'continue', action: 'fail' } }
        });
        assert.equal(resumeResponse.status, 202, await resumeResponse.clone().text());
        const resumed = await waitForRun(server, waiting.run.id, record => record.status !== 'running');
        assert.equal(resumed.status, 'completed', resumed.error);
        assert.ok(resumed.events.some(event => event.kind === 'gate.resolved'));
    });

    await t.test('binds an explicit Gate route to the selected decision before mutating the run', async () => {
        const graph = {
            version: 'flow-studio/v2', id: 'gate-route-binding-cli', name: 'Gate route binding', start: 'gate',
            nodes: [
                {
                    id: 'gate', type: 'gate', label: 'Choose route', gate: { kind: 'human', prompt: 'Choose route' },
                    gateDecisions: [
                        { id: 'route-a', label: 'Route A', decision: 'continue', toNodeId: 'a' },
                        { id: 'route-b', label: 'Route B', decision: 'continue', toNodeId: 'b' }
                    ]
                },
                { id: 'a', type: 'end', label: 'A' },
                { id: 'b', type: 'end', label: 'B' }
            ], edges: [], budget: { maxSteps: 10, maxDurationMs: 10_000 }
        };
        const launchResponse = await request(server, '/api/run', { method: 'POST', json: { graph } });
        assert.equal(launchResponse.status, 200, await launchResponse.clone().text());
        const waiting = await launchResponse.json();
        const endpoint = `/api/runs/${waiting.run.id}/resume`;
        const checkpointId = waiting.result.waiting.checkpointId;

        const forged = await request(server, endpoint, {
            method: 'POST',
            json: { checkpointId, gate: { decisionId: 'route-a', toNodeId: 'b' } }
        });
        assert.equal(forged.status, 400, await forged.clone().text());
        assert.match(await forged.text(), /não pertence à decisão/i);
        assert.equal((await (await request(server, `/api/runs/${waiting.run.id}`)).json()).run.status, 'waiting');

        const accepted = await request(server, endpoint, {
            method: 'POST',
            json: { checkpointId, gate: { decisionId: 'route-a', toNodeId: 'a' } }
        });
        assert.equal(accepted.status, 202, await accepted.clone().text());
        const completed = await waitForRun(server, waiting.run.id, record => record.status !== 'running');
        assert.equal(completed.status, 'completed', completed.error);
        assert.ok(completed.result.visited.includes('a'));
        assert.equal(completed.result.visited.includes('b'), false);
    });

    await t.test('rejects a required-evidence approval synchronously before mutating the waiting run', async () => {
        const graph = humanGateGraph('gate-required-evidence');
        graph.nodes[0].gate.requireEvidence = true;
        const launchResponse = await request(server, '/api/run', { method: 'POST', json: { graph } });
        assert.equal(launchResponse.status, 200, await launchResponse.clone().text());
        const launched = await launchResponse.json();
        const endpoint = `/api/runs/${launched.run.id}/resume`;
        const checkpointId = launched.result.waiting.checkpointId;
        const rejected = await request(server, endpoint, {
            method: 'POST', json: { checkpointId, gate: { decisionId: 'approve', action: 'continue' } }
        });
        assert.equal(rejected.status, 400, await rejected.clone().text());
        assert.equal((await (await request(server, `/api/runs/${launched.run.id}`)).json()).run.status, 'waiting');

        const accepted = await request(server, endpoint, {
            method: 'POST',
            json: {
                checkpointId,
                gate: {
                    decisionId: 'approve', action: 'continue',
                    evidence: [{ id: 'gate-evidence', nodeId: 'approval', kind: 'evidence', name: 'Approval evidence', payload: { approved: true } }]
                }
            }
        });
        assert.equal(accepted.status, 202, await accepted.clone().text());
        assert.equal((await waitForRun(server, launched.run.id, record => record.status !== 'running')).status, 'completed');
    });

    await t.test('rejects forged human gate payloads before a run can resume', async () => {
        const waitingResponse = await request(server, '/api/run', { method: 'POST', json: { graph: humanGateGraph('gate-forgery') } });
        assert.equal(waitingResponse.status, 200, await waitingResponse.clone().text());
        const waiting = await waitingResponse.json();
        const endpoint = `/api/runs/${waiting.run.id}/resume`;
        const checkpointId = waiting.result.waiting.checkpointId;

        const missingDecision = await request(server, endpoint, {
            method: 'POST',
            json: { checkpointId, gate: { action: 'continue', toNodeId: 'end' } }
        });
        assert.equal(missingDecision.status, 400, await missingDecision.clone().text());
        const inventedAction = await request(server, endpoint, {
            method: 'POST',
            json: { checkpointId, gate: { decisionId: 'approve', action: 'approved-by-me', toNodeId: 'end' } }
        });
        assert.equal(inventedAction.status, 400, await inventedAction.clone().text());
        const unknownDecision = await request(server, endpoint, {
            method: 'POST',
            json: { checkpointId, gate: { decisionId: 'invented', action: 'continue' } }
        });
        assert.equal(unknownDecision.status, 400, await unknownDecision.clone().text());

        const valid = await request(server, endpoint, {
            method: 'POST',
            json: { checkpointId, gate: { decisionId: 'approve', action: 'continue' } }
        });
        assert.equal(valid.status, 202, await valid.clone().text());
        const completed = await waitForRun(server, waiting.run.id, record => record.status !== 'running');
        assert.equal(completed.status, 'completed', completed.error);
        const nonGateCheckpoint = completed.checkpoints.find(item => item.reason === 'node-complete');
        assert.ok(nonGateCheckpoint);
        const wrongCheckpointKind = await request(server, endpoint, {
            method: 'POST',
            json: { checkpointId: nonGateCheckpoint.id, gate: { decisionId: 'continue', action: 'continue' } }
        });
        assert.equal(wrongCheckpointKind.status, 400, await wrongCheckpointKind.clone().text());
    });

    await t.test('serializes concurrent resumes so an external effect runs exactly once', async () => {
        const marker = path.join(workspace, 'concurrent-resume-marker.txt');
        const script = path.join(workspace, 'slow-effect.js');
        await fs.writeFile(script, `'use strict';const fs=require('node:fs');fs.appendFileSync(process.argv[2],'effect\\n');setTimeout(()=>process.stdout.write(JSON.stringify({ok:true})),350);\n`, 'utf8');
        const graph = {
            version: 'flow-studio/v2', id: 'concurrent-resume', name: 'Concurrent resume', start: 'approval',
            permissions: { allow: ['tool:write'], commandPatterns: ['node*'], fileRoots: ['.'] },
            nodes: [
                { id: 'approval', type: 'gate', label: 'Approval', gate: { kind: 'human', prompt: 'Approve once?' }, gateDecisions: [{ id: 'approve', label: 'Approve', decision: 'continue', toNodeId: 'effect' }] },
                { id: 'effect', type: 'command', label: 'Effect', command: { command: 'node', args: [script, marker], effect: 'write', requiredPermissions: ['tool:write'], idempotencyKey: 'concurrent-resume-effect' }, next: 'end' },
                { id: 'end', type: 'end', label: 'End' }
            ], edges: [], budget: { maxSteps: 20, maxDurationMs: 10_000 }
        };
        const waitingResponse = await request(server, '/api/run', { method: 'POST', json: { graph } });
        assert.equal(waitingResponse.status, 200, await waitingResponse.clone().text());
        const waiting = await waitingResponse.json();
        const resume = () => request(server, `/api/runs/${waiting.run.id}/resume`, {
            method: 'POST',
            json: { checkpointId: waiting.result.waiting.checkpointId, gate: { decisionId: 'approve', action: 'continue' } }
        });
        const responses = await Promise.all([resume(), resume()]);
        assert.deepEqual(responses.map(response => response.status).sort((a, b) => a - b), [202, 409]);
        const completed = await waitForRun(server, waiting.run.id, record => record.status !== 'running');
        assert.equal(completed.status, 'completed', completed.error);
        assert.equal((await fs.readFile(marker, 'utf8')).trim().split(/\r?\n/).length, 1);
    });

    await t.test('coordinates active recovery and resume leases across two real CLI servers', async () => {
        const activeScript = path.join(workspace, 'cross-process-active.js');
        const activeRelease = path.join(workspace, 'cross-process-active.release');
        await fs.writeFile(activeScript, `'use strict';const fs=require('node:fs');const release=process.argv[2];const deadline=Date.now()+15000;const poll=()=>{if(fs.existsSync(release))return process.stdout.write(JSON.stringify({result:'active-finished'}));if(Date.now()>=deadline){process.stderr.write('release timeout');process.exitCode=1;return;}setTimeout(poll,25);};poll();\n`, 'utf8');
        const activeGraph = {
            version: 'flow-studio/v2', id: 'cross-process-active', name: 'Cross process active', start: 'effect',
            permissions: { allow: ['tool:write'], commandPatterns: ['node*'], fileRoots: ['.'] },
            nodes: [
                { id: 'effect', type: 'command', label: 'Slow active effect', command: { command: 'node', args: [activeScript, activeRelease], effect: 'write', requiredPermissions: ['tool:write'], idempotencyKey: 'cross-process-active' }, next: 'end' },
                { id: 'end', type: 'end', label: 'End' }
            ], edges: [], budget: { maxSteps: 20, maxDurationMs: 10_000 }
        };
        const activeLaunchResponse = await request(server, '/api/runs', { method: 'POST', json: { graph: activeGraph } });
        assert.equal(activeLaunchResponse.status, 202, await activeLaunchResponse.clone().text());
        const activeLaunch = await activeLaunchResponse.json();
        await waitForRun(server, activeLaunch.run.id, record => record.status === 'running');

        const peer = await startCliServer({
            workspace,
            graphPath,
            token,
            extraArgs: ['--allow-graph-tools', '--allow-command', 'node*']
        });
        try {
            const peerView = await request(peer, `/api/runs/${activeLaunch.run.id}`);
            assert.equal(peerView.status, 200, await peerView.clone().text());
            assert.equal((await peerView.json()).run.status, 'running', 'peer startup must not recover a run leased by the first server');
            const activeReplay = await request(peer, `/api/runs/${activeLaunch.run.id}/replay`, { method: 'POST', json: {} });
            assert.equal(activeReplay.status, 409, await activeReplay.clone().text());
            assert.match((await activeReplay.json()).error, /execução|fronteira estável|replay/i);
            await fs.writeFile(activeRelease, 'release', 'utf8');
            const activeCompleted = await waitForRun(server, activeLaunch.run.id, record => record.status !== 'running', 20_000);
            assert.equal(activeCompleted.status, 'completed', activeCompleted.error);

            const marker = path.join(workspace, 'cross-process-resume-marker.txt');
            const effectScript = path.join(workspace, 'cross-process-resume.js');
            await fs.writeFile(effectScript, `'use strict';const fs=require('node:fs');fs.appendFileSync(process.argv[2],'effect\\n');setTimeout(()=>process.stdout.write(JSON.stringify({ok:true})),500);\n`, 'utf8');
            const graph = {
                version: 'flow-studio/v2', id: 'cross-process-resume', name: 'Cross process resume', start: 'approval',
                permissions: { allow: ['tool:write'], commandPatterns: ['node*'], fileRoots: ['.'] },
                nodes: [
                    { id: 'approval', type: 'gate', label: 'Approval', gate: { kind: 'human', prompt: 'Approve once?' }, gateDecisions: [{ id: 'approve', label: 'Approve', decision: 'continue', toNodeId: 'effect' }] },
                    { id: 'effect', type: 'command', label: 'Effect', command: { command: 'node', args: [effectScript, marker], effect: 'write', requiredPermissions: ['tool:write'], idempotencyKey: 'cross-process-resume-effect' }, next: 'end' },
                    { id: 'end', type: 'end', label: 'End' }
                ], edges: [], budget: { maxSteps: 20, maxDurationMs: 10_000 }
            };
            const waitingResponse = await request(server, '/api/run', { method: 'POST', json: { graph } });
            assert.equal(waitingResponse.status, 200, await waitingResponse.clone().text());
            const waiting = await waitingResponse.json();
            const resumeFrom = target => request(target, `/api/runs/${waiting.run.id}/resume`, {
                method: 'POST',
                json: { checkpointId: waiting.result.waiting.checkpointId, gate: { decisionId: 'approve', action: 'continue' } }
            });
            const responses = await Promise.all([resumeFrom(server), resumeFrom(peer)]);
            assert.deepEqual(responses.map(response => response.status).sort((a, b) => a - b), [202, 409]);
            const completed = await waitForRun(server, waiting.run.id, record => record.status !== 'running', 20_000);
            assert.equal(completed.status, 'completed', completed.error);
            assert.equal((await fs.readFile(marker, 'utf8')).trim().split(/\r?\n/).length, 1);
        } finally {
            await fs.writeFile(activeRelease, 'release', 'utf8').catch(() => undefined);
            await peer.stop();
        }
    });

    await t.test('caps individual run records and retains only the configured history budget', async () => {
        const root = path.join(workspace, 'bounded-run-store');
        const store = new FlowStudioFileRunStore(root, { recordBytes: 4096, files: 2, totalBytes: 8192 });
        const record = (id, updatedAt, input = {}) => ({
            version: 'flow-studio-run/v2', id, graph: simpleGraph(`graph-${id}`), input,
            status: 'completed', createdAt: updatedAt, updatedAt, events: [], checkpoints: [], effects: []
        });
        await store.save(record('bounded-0001', '2026-01-01T00:00:00.000Z'));
        await new Promise(resolve => setTimeout(resolve, 5));
        await store.save(record('bounded-0002', '2026-01-02T00:00:00.000Z'));
        await new Promise(resolve => setTimeout(resolve, 5));
        await store.save(record('bounded-0003', '2026-01-03T00:00:00.000Z'));
        assert.deepEqual((await store.list(10)).map(item => item.id), ['bounded-0003', 'bounded-0002']);
        await assert.rejects(store.save(record('bounded-huge', '2026-01-04T00:00:00.000Z', { payload: 'x'.repeat(5000) })), /excede o limite persistente/i);
        await assert.rejects(fs.access(store.pathFor('bounded-huge')), error => error?.code === 'ENOENT');
    });

    await t.test('skips malformed and oversized history files during startup recovery', async () => {
        const root = path.join(workspace, 'tolerant-run-history');
        const store = new FlowStudioFileRunStore(root, { recordBytes: 4096, files: 10, totalBytes: 64_000 });
        await store.initialize();
        await fs.writeFile(path.join(root, 'corrupt-history.json'), '{not-json', 'utf8');
        await fs.writeFile(path.join(root, 'invalid-shape-history.json'), '{}', 'utf8');
        await fs.writeFile(path.join(root, 'oversized-history.json'), 'x'.repeat(5000), 'utf8');
        const now = new Date().toISOString();
        await store.save({
            version: 'flow-studio-run/v2', id: 'recover-valid-run', graph: simpleGraph('recover-valid-run'), input: {},
            status: 'running', createdAt: now, updatedAt: now, events: [], checkpoints: [], effects: []
        });
        const manager = new FlowStudioRunManager(store);
        assert.equal(await manager.recoverInterruptedRuns(), 1);
        const listed = await manager.list(10);
        assert.deepEqual(listed.map(item => item.id), ['recover-valid-run']);
        assert.equal(listed[0].status, 'failed');
    });

    await t.test('retention preserves waiting and running records and fails before creating a phantom run', async () => {
        const root = path.join(workspace, 'protected-run-store');
        const store = new FlowStudioFileRunStore(root, { recordBytes: 16_384, files: 2, totalBytes: 32_768 });
        const record = (id, status, updatedAt) => ({
            version: 'flow-studio-run/v2', id, graph: simpleGraph(`graph-${id}`), input: {},
            status, createdAt: updatedAt, updatedAt, events: [], checkpoints: [], effects: []
        });
        const waiting = record('protected-waiting', 'waiting', '2026-01-01T00:00:00.000Z');
        await store.save(waiting);
        await store.save(record('evictable-done1', 'completed', '2026-01-02T00:00:00.000Z'));
        await store.save(record('evictable-done2', 'completed', '2026-01-03T00:00:00.000Z'));
        assert.deepEqual(new Set((await store.list(10)).map(item => item.id)), new Set(['protected-waiting', 'evictable-done2']));

        await store.save(record('protected-running', 'running', '2026-01-04T00:00:00.000Z'));
        assert.deepEqual(new Set((await store.list(10)).map(item => item.id)), new Set(['protected-waiting', 'protected-running']));
        await assert.rejects(
            store.save(record('phantom-running', 'running', '2026-01-05T00:00:00.000Z')),
            /retenção segura|protegidos/i
        );
        await assert.rejects(fs.access(store.pathFor('phantom-running')), error => error?.code === 'ENOENT');
        assert.equal((await store.get('protected-waiting')).status, 'waiting');
        assert.equal((await store.get('protected-running')).status, 'running');
    });

    await t.test('never steals a well-formed run lease while its owner PID is alive', async () => {
        const root = path.join(workspace, 'live-run-lease');
        const store = new FlowStudioFileRunStore(root);
        const runId = 'live-lease-owner';
        const lease = await store.claimRunLease(runId);
        assert.ok(lease);
        try {
            const ownerFile = path.join(root, '.leases', `${runId}.lock`, 'owner.json');
            const old = new Date(Date.now() - 10 * 60_000);
            await fs.utimes(ownerFile, old, old);
            assert.equal(await store.claimRunLease(runId), undefined, 'an expired heartbeat must not fence a live PID');
        } finally {
            await lease.release();
        }
        const replacement = await store.claimRunLease(runId);
        assert.ok(replacement, 'released lease should be claimable');
        await replacement.release();
    });

    await t.test('serializes retention commits across independent store instances', async () => {
        const root = path.join(workspace, 'concurrent-retention-store');
        const stores = Array.from({ length: 6 }, () => new FlowStudioFileRunStore(root, { recordBytes: 16_384, files: 2, totalBytes: 32_768 }));
        const record = (id, status) => ({
            version: 'flow-studio-run/v2', id, graph: simpleGraph(`graph-${id}`), input: {}, status,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [], checkpoints: [], effects: []
        });
        await stores[0].save(record('concurrent-waiting', 'waiting'));
        await Promise.all(stores.map((store, index) => store.save(record(`concurrent-done-${index}`, 'completed'))));
        const records = await stores[0].list(10);
        assert.equal(records.length, 2);
        assert.ok(records.some(item => item.id === 'concurrent-waiting'));
        assert.equal(records.filter(item => item.status === 'completed').length, 1);

        const completed = records.find(item => item.status === 'completed');
        const orphan = `${stores[0].pathFor(completed.id)}.retention-delete.crash-simulation`;
        await fs.rename(stores[0].pathFor(completed.id), orphan);
        await stores[1].save(record('concurrent-waiting', 'waiting'));
        await fs.access(stores[0].pathFor(completed.id));
        assert.equal((await fs.readdir(root)).some(name => name.includes('.retention-delete.')), false);
    });

    await t.test('a transient persistence failure does not poison later saves or skip manager cleanup', async () => {
        const root = path.join(workspace, 'flaky-run-store');
        class FlakyRunStore extends FlowStudioFileRunStore {
            constructor(directory) { super(directory); this.saveCalls = 0; this.failed = false; }
            async save(record) {
                this.saveCalls += 1;
                if (!this.failed && this.saveCalls > 1) {
                    this.failed = true;
                    throw new Error('injected persistence failure');
                }
                return super.save(record);
            }
        }
        const store = new FlakyRunStore(root);
        const manager = new FlowStudioRunManager(store);
        const failed = await manager.runAndWait({ graph: simpleGraph('flaky-persistence'), input: {} });
        assert.equal(failed.status, 'failed');
        assert.match(failed.error, /persist|injected/i);
        const persisted = await store.get(failed.id);
        assert.equal(persisted.status, 'failed');
        assert.ok(persisted.events.some(event => event.kind === 'run.failed' && event.detail?.reason === 'persistence-failure'));
        assert.equal(manager.cancel(failed.id), false, 'active map must always be cleaned');

        const healthy = await manager.runAndWait({ graph: simpleGraph('healthy-after-flaky-save'), input: {} });
        assert.equal(healthy.status, 'completed', healthy.error);
    });

    await t.test('replaces a real oversized running record with a bounded terminal receipt', async () => {
        const root = path.join(workspace, 'oversized-run-receipt');
        const recordBytes = 16 * 1024 * 1024;
        const store = new FlowStudioFileRunStore(root, { recordBytes, files: 5, totalBytes: 64 * 1024 * 1024 });
        const manager = new FlowStudioRunManager(store);
        const nodes = Array.from({ length: 4 }, (_, index) => ({
            id: `agent-${index + 1}`,
            type: 'agent',
            label: `Agent ${index + 1}`,
            prompt: 'Produce a bounded shard',
            provider: { providerId: 'oversized' },
            outputs: { payload: `shard${index + 1}` },
            next: index === 3 ? 'end' : `agent-${index + 2}`
        }));
        const graph = {
            version: 'flow-studio/v2', id: 'oversized-record', name: 'Oversized record', start: 'agent-1',
            permissions: { allow: ['runner:invoke'] },
            nodes: [...nodes, { id: 'end', type: 'end', label: 'End' }], edges: [],
            budget: { maxSteps: 20, maxDurationMs: 30_000 }
        };
        const failed = await manager.runAndWait({
            graph,
            input: { request: 'large but valid accumulated context' },
            runnerAdapters: { oversized: async () => ({ output: { payload: 'x'.repeat(3 * 1024 * 1024) } }) }
        });
        assert.equal(failed.status, 'failed');
        assert.match(failed.error, /persist|limite/i);
        const persisted = await store.get(failed.id);
        assert.equal(persisted.status, 'failed', 'on-disk state must not remain running after overflow');
        assert.equal(persisted.result, undefined);
        assert.deepEqual(persisted.input, { request: 'large but valid accumulated context' });
        assert.equal(persisted.graph.id, graph.id);
        assert.ok(persisted.events.some(event => event.kind === 'run.failed' && event.detail?.reason === 'persistence-failure'));
        assert.ok((await fs.stat(store.pathFor(failed.id))).size <= recordBytes);
        assert.equal(manager.cancel(failed.id), false, 'oversized run must release all active state');
    });

    await t.test('rejects a near-cap run before persisting running state when no terminal receipt can fit', async () => {
        const root = path.join(workspace, 'terminal-receipt-reservation');
        const store = new FlowStudioFileRunStore(root, { recordBytes: 7_000, files: 5, totalBytes: 64_000 });
        const manager = new FlowStudioRunManager(store);
        await assert.rejects(
            manager.start({ graph: simpleGraph('near-cap-terminal-receipt'), input: { payload: 'x'.repeat(5_000) } }),
            /receipt terminal seguro/i
        );
        assert.deepEqual(await store.list(10), []);
    });

    await t.test('rejects replay and resume when the only persisted checkpoint lost its context snapshot', async () => {
        const root = path.join(workspace, 'non-replayable-context-checkpoint');
        const store = new FlowStudioFileRunStore(root, { recordBytes: 128_000, files: 5, totalBytes: 512_000 });
        const manager = new FlowStudioRunManager(store);
        const now = new Date().toISOString();
        const graph = simpleGraph('non-replayable-context-checkpoint');
        const reason = 'Checkpoint de falha não reproduzível: o contexto excedeu o limite e o snapshot foi omitido.';
        const checkpoint = {
            id: 'blocked-context', runId: 'blocked-run', graphId: graph.id, graphVersion: graph.version,
            graphDigest: 'not-used-before-selection', nodeId: 'end', reason: 'failure', context: {}, visited: ['end'], effects: [], artifacts: [],
            usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 10 }, createdAt: now,
            metadata: { replayable: false, replayBlockedReason: reason }
        };
        await store.save({
            version: 'flow-studio-run/v2', id: 'blocked-run', graph, input: {}, status: 'failed', createdAt: now, updatedAt: now,
            events: [], checkpoints: [checkpoint], effects: [], error: 'Context too large'
        });

        await assert.rejects(manager.replay('blocked-run', checkpoint.id), new RegExp(reason));
        await assert.rejects(manager.resume('blocked-run', {}), /não possui uma fronteira ativa de espera.*replay/i);
        assert.equal((await store.get('blocked-run')).status, 'failed');
    });

    await t.test('persists ledgers once at the top level while retaining the useful result summary', async () => {
        const root = path.join(workspace, 'compact-result-run-store');
        const store = new FlowStudioFileRunStore(root, { recordBytes: 32_768, files: 5, totalBytes: 128_000 });
        const now = new Date().toISOString();
        const event = { kind: 'run.completed', runId: 'compact-result', message: 'done', step: 1, at: now };
        const effect = { id: 'effect-1', idempotencyKey: 'effect-1', runId: 'compact-result', nodeId: 'end', kind: 'write', status: 'completed', startedAt: now, finishedAt: now };
        const record = {
            version: 'flow-studio-run/v2', id: 'compact-result', graph: simpleGraph('compact-result'), input: {},
            status: 'completed', createdAt: now, updatedAt: now, events: [event], checkpoints: [], effects: [effect],
            result: {
                runId: 'compact-result', status: 'completed', visited: ['start', 'end'], finalContext: { answer: 42 },
                events: [event], checkpoints: [], effects: [effect], artifacts: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 1 }
            }
        };
        await store.save(record);
        const persisted = JSON.parse(await fs.readFile(store.pathFor(record.id), 'utf8'));
        assert.equal(persisted.events.length, 1);
        assert.equal(persisted.effects.length, 1);
        assert.deepEqual(persisted.result.events, []);
        assert.deepEqual(persisted.result.effects, []);
        assert.deepEqual(persisted.result.finalContext, { answer: 42 });
        assert.deepEqual(persisted.result.visited, ['start', 'end']);
    });

    await t.test('forks a replay from a persisted checkpoint and links it to its parent run', async () => {
        assert.ok(completedRun, 'completed run must exist');
        const statusResponse = await request(server, `/api/runs/${completedRun.id}`);
        const source = (await statusResponse.json()).run;
        const checkpoint = source.checkpoints.find(item => item.nodeId === 'agent' && item.nextNodeId === 'end');
        assert.ok(checkpoint, 'agent checkpoint with next=end was not persisted');

        const replayResponse = await request(server, `/api/runs/${source.id}/replay`, {
            method: 'POST',
            json: { checkpointId: checkpoint.id }
        });
        assert.equal(replayResponse.status, 202, await replayResponse.clone().text());
        const replayLaunch = await replayResponse.json();
        assert.notEqual(replayLaunch.run.id, source.id);
        assert.equal(replayLaunch.run.parentRunId, source.id);

        const replayed = await waitForRun(server, replayLaunch.run.id, record => record.status !== 'running');
        assert.equal(replayed.status, 'completed', replayed.error);
        assert.equal(replayed.parentRunId, source.id);
        assert.ok(replayed.events.some(event => event.kind === 'run.resumed'));
    });

    await t.test('cancels an active asynchronous run and persists the cancelled terminal state', async () => {
        const launchResponse = await request(server, '/api/runs', {
            method: 'POST',
            json: { graph: longTransformGraph('cancel-run', 500) },
            timeoutMs: 20_000
        });
        assert.equal(launchResponse.status, 202, await launchResponse.clone().text());
        const launch = await launchResponse.json();
        assert.equal(launch.run.status, 'running');

        const cancelResponse = await request(server, `/api/runs/${launch.run.id}/cancel`, { method: 'POST' });
        assert.equal(cancelResponse.status, 202, await cancelResponse.clone().text());
        const cancelled = await waitForRun(server, launch.run.id, record => record.status !== 'running', 20_000);
        assert.equal(cancelled.status, 'cancelled', cancelled.error);
        assert.ok(cancelled.events.some(event => event.kind === 'run.cancelled'));

        const resumeResponse = await request(server, `/api/runs/${launch.run.id}/resume`, { method: 'POST', json: {} });
        assert.equal(resumeResponse.status, 400, await resumeResponse.clone().text());
        assert.match((await resumeResponse.json()).error, /cancelled|replay/i);
    });

    await t.test('hydrates external model profiles for validation and execution', async () => {
        const profile = { id: 'catalog-profile', name: 'Catalog profile', providerId: 'catalog-provider', modelId: 'catalog/model', capabilities: ['text', 'reasoning'], reasonDefault: 'low' };
        const saved = await request(server, '/api/profiles', { method: 'POST', json: { profiles: [profile] } });
        assert.equal(saved.status, 200, await saved.clone().text());
        const graph = {
            version: 'flow-studio/v2', id: 'catalog-run', name: 'Catalog run', start: 'agent',
            permissions: { allow: ['runner:invoke'] },
            nodes: [
                { id: 'agent', type: 'agent', label: 'Agent', prompt: 'Use catalog', provider: { providerId: 'catalog-provider', profileId: 'catalog-profile' }, outputs: { result: 'result' }, next: 'end' },
                { id: 'end', type: 'end', label: 'End' }
            ],
            edges: [], budget: { maxSteps: 20 }
        };
        const validation = await request(server, '/api/validate', { method: 'POST', json: { graph } });
        assert.equal(validation.status, 200, await validation.clone().text());
        const executed = await request(server, '/api/run', { method: 'POST', json: { graph } });
        assert.equal(executed.status, 200, await executed.clone().text());
        assert.equal((await executed.json()).run.status, 'completed');
    });

    await t.test('resolves a graphRef inside the workspace and maps subgraph output', async () => {
        await writeJson(path.join(workspace, 'child.graph.json'), {
            version: 'flow-studio/v2', id: 'child-file', name: 'Child file', start: 'transform',
            nodes: [
                { id: 'transform', type: 'transform', label: 'Transform', condition: '({ answer: Number(context.value) + 1 })', next: 'end' },
                { id: 'end', type: 'end', label: 'End' }
            ], edges: []
        });
        const parent = {
            version: 'flow-studio/v2', id: 'parent-file', name: 'Parent file', start: 'child',
            nodes: [
                { id: 'child', type: 'subgraph', label: 'Child', subgraph: { graphRef: 'child.graph.json', input: { source: 'value' }, output: { answer: 'result.answer' }, isolated: true }, next: 'end' },
                { id: 'end', type: 'end', label: 'End' }
            ], edges: []
        };
        const response = await request(server, '/api/run', { method: 'POST', json: { graph: parent, input: { source: 41 } } });
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal((await response.json()).result.finalContext.result.answer, 42);
    });

    await t.test('replay from an older checkpoint keeps later effect receipts and does not repeat them', async () => {
        const marker = path.join(workspace, 'effect-marker.txt');
        const appendScript = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x')`;
        const graph = {
            version: 'flow-studio/v2', id: 'replay-effects', name: 'Replay effects', start: 'one',
            permissions: { allow: ['tool:command'], commandPatterns: ['node*'] },
            nodes: [
                { id: 'one', type: 'action', label: 'One', tools: [{ id: 'one-tool', name: 'One tool', command: 'node', args: ['-e', appendScript], effect: 'command', requiredPermissions: ['tool:command'], idempotencyKey: 'effect-one' }], next: 'two' },
                { id: 'two', type: 'action', label: 'Two', tools: [{ id: 'two-tool', name: 'Two tool', command: 'node', args: ['-e', appendScript], effect: 'command', requiredPermissions: ['tool:command'], idempotencyKey: 'effect-two' }], next: 'end' },
                { id: 'end', type: 'end', label: 'End' }
            ], edges: [], budget: { maxSteps: 20 }
        };
        const response = await request(server, '/api/run', { method: 'POST', json: { graph } });
        assert.equal(response.status, 200, await response.clone().text());
        const source = (await response.json()).run;
        assert.equal(await fs.readFile(marker, 'utf8'), 'xx');
        const checkpoint = source.checkpoints.find(item => item.nodeId === 'one');
        assert.ok(checkpoint);
        const replayResponse = await request(server, `/api/runs/${source.id}/replay`, { method: 'POST', json: { checkpointId: checkpoint.id } });
        assert.equal(replayResponse.status, 202, await replayResponse.clone().text());
        const replay = await replayResponse.json();
        const replayed = await waitForRun(server, replay.run.id, record => record.status !== 'running');
        assert.equal(replayed.status, 'completed', replayed.error);
        assert.equal(await fs.readFile(marker, 'utf8'), 'xx');
        assert.ok(replayed.events.some(event => event.kind === 'effect.skipped'));
    });

    await t.test('executes an HTTP runner only when its host is explicitly allowed', async () => {
        const runnerServer = http.createServer((request, response) => {
            if (request.url === '/redirect') {
                response.writeHead(307, { location: 'http://example.invalid/escaped' });
                response.end();
                return;
            }
            let body = '';
            request.on('data', chunk => { body += String(chunk); });
            request.on('end', () => {
                const payload = JSON.parse(body);
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ output: { answer: `remote:${payload.prompt}` }, summary: 'remote runner' }));
            });
        });
        await new Promise((resolve, reject) => { runnerServer.once('error', reject); runnerServer.listen(0, HOST, resolve); });
        try {
            const address = runnerServer.address();
            assert.ok(address && typeof address === 'object');
            const endpoint = `http://${HOST}:${address.port}/run`;
            await server.stop();
            server = await startCliServer({ workspace, graphPath, token, extraArgs: ['--allow-graph-runners', '--allow-runner-host', `${HOST}:${address.port}`] });
            const graph = {
                version: 'flow-studio/v2', id: 'http-runner', name: 'HTTP runner', start: 'agent',
                permissions: { allow: ['runner:invoke'], networkHosts: [`${HOST}:${address.port}`] },
                runners: [{ id: 'remote', name: 'Remote', kind: 'http', endpoint, capabilities: ['text', 'structured-output'] }],
                nodes: [
                    { id: 'agent', type: 'agent', label: 'Agent', prompt: 'hello', runner: { runnerId: 'remote', providerId: 'remote' }, outputs: { answer: 'answer' }, next: 'end' },
                    { id: 'end', type: 'end', label: 'End' }
                ], edges: []
            };
            const response = await request(server, '/api/run', { method: 'POST', json: { graph } });
            assert.equal(response.status, 200, await response.clone().text());
            assert.equal((await response.json()).result.finalContext.answer, 'remote:hello');
            const denied = structuredClone(graph);
            denied.id = 'http-runner-denied';
            denied.permissions.networkHosts = [];
            const validation = await request(server, '/api/validate', { method: 'POST', json: { graph: denied } });
            assert.equal(validation.status, 400);
            assert.match(await validation.text(), /nao esta autorizado|não está autorizado/i);

            const redirected = structuredClone(graph);
            redirected.id = 'http-runner-redirect';
            redirected.runners[0].endpoint = `http://${HOST}:${address.port}/redirect`;
            const redirectResponse = await request(server, '/api/run', { method: 'POST', json: { graph: redirected } });
            assert.equal(redirectResponse.status, 500, await redirectResponse.clone().text());
            const redirectResult = await redirectResponse.json();
            assert.equal(redirectResult.result.status, 'failed');
            assert.match(redirectResult.result.error, /redirect.*não são permitidos/i);
        } finally {
            await new Promise(resolve => runnerServer.close(resolve));
        }
    });

    await t.test('run history compares executions and startup recovers interrupted records', async () => {
        const historyResponse = await request(server, '/api/runs?limit=30');
        const runs = (await historyResponse.json()).runs;
        assert.ok(runs.length >= 2);
        const comparisonResponse = await request(server, `/api/runs/compare?left=${runs[1].id}&right=${runs[0].id}`);
        assert.equal(comparisonResponse.status, 200, await comparisonResponse.clone().text());
        assert.ok((await comparisonResponse.json()).comparison.delta);

        await server.stop();
        const interruptedId = 'interrupted-test-run';
        const now = new Date().toISOString();
        await writeJson(path.join(workspace, '.flow-studio', 'runs', `${interruptedId}.json`), {
            version: 'flow-studio-run/v2', id: interruptedId, graph: simpleGraph('interrupted'), input: {}, status: 'running', createdAt: now, updatedAt: now, events: [], checkpoints: [], effects: []
        });
        server = await startCliServer({ workspace, graphPath, token, extraArgs: ['--allow-graph-tools', '--allow-command', 'node*'] });
        const recoveredResponse = await request(server, `/api/runs/${interruptedId}`);
        assert.equal(recoveredResponse.status, 200);
        const recovered = (await recoveredResponse.json()).run;
        assert.equal(recovered.status, 'failed');
        assert.match(recovered.error, /interrompida/i);
        assert.equal(recovered.events.at(-1).detail.reason, 'process-restart');
    });
});

function simpleGraph(id) {
    return {
        version: 'flow-studio/v2',
        id,
        name: id,
        start: 'start',
        nodes: [
            { id: 'start', type: 'input', label: 'Start', next: 'end' },
            { id: 'end', type: 'end', label: 'End' }
        ],
        edges: [],
        budget: { maxSteps: 20, maxDurationMs: 10_000 }
    };
}

function simulatedAgentGraph(id) {
    return {
        version: 'flow-studio/v2',
        id,
        name: id,
        start: 'agent',
        permissions: { allow: ['runner:invoke'] },
        nodes: [
            {
                id: 'agent',
                type: 'agent',
                label: 'Agent',
                prompt: 'Handle {{request}}',
                runner: { providerId: 'opencode', modelId: 'opencode/gpt-5.5' },
                outputs: { result: 'result' },
                next: 'end'
            },
            { id: 'end', type: 'end', label: 'End' }
        ],
        edges: [],
        budget: { maxSteps: 20, maxDurationMs: 10_000, maxCostUsd: 1 }
    };
}

function humanGateGraph(id) {
    return {
        version: 'flow-studio/v2',
        id,
        name: id,
        start: 'approval',
        nodes: [
            {
                id: 'approval',
                type: 'gate',
                label: 'Approval',
                gate: { kind: 'human', prompt: 'Approve this flow?' },
                gateDecisions: [
                    { id: 'approve', label: 'Approve', decision: 'continue', toNodeId: 'end' },
                    { id: 'reject', label: 'Reject', decision: 'fail' }
                ]
            },
            { id: 'end', type: 'end', label: 'End' }
        ],
        edges: [],
        budget: { maxSteps: 20, maxDurationMs: 10_000 }
    };
}

function longTransformGraph(id, count) {
    const nodes = Array.from({ length: count }, (_unused, index) => ({
        id: `transform-${index}`,
        type: 'transform',
        label: `Transform ${index}`,
        prompt: '({})',
        next: index + 1 < count ? `transform-${index + 1}` : 'end'
    }));
    nodes.push({ id: 'end', type: 'end', label: 'End' });
    return {
        version: 'flow-studio/v2',
        id,
        name: id,
        start: nodes[0].id,
        nodes,
        edges: [],
        budget: { maxSteps: count + 10, maxDurationMs: 60_000 }
    };
}

async function startCliServer({ workspace, graphPath, token, extraArgs = [] }) {
    const port = await reservePort();
    const child = spawn(process.execPath, [
        CLI_ENTRY,
        'serve',
        graphPath,
        '--host', HOST,
        '--port', String(port),
        '--workspace', workspace,
        '--token', token,
        '--simulate',
        ...extraArgs
    ], {
        cwd: workspace,
        env: { ...process.env, FORCE_COLOR: '0', FLOW_STUDIO_TEST_SECRET: 'must-not-reach-adapters' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const server = {
        baseUrl: `http://${HOST}:${port}`,
        child,
        graphPath,
        port,
        token,
        workspace,
        get output() { return `${stdout}\n${stderr}`.trim(); },
        stop: () => stopChild(child)
    };

    try {
        await waitFor(async () => {
            if (child.exitCode !== null) {
                const error = new Error(`CLI exited with ${child.exitCode}: ${server.output}`);
                error.fatal = true;
                throw error;
            }
            try {
                const response = await request(server, '/api/health', { timeoutMs: 1000 });
                return response.status === 200;
            } catch {
                return false;
            }
        }, 20_000, `CLI did not become ready: ${server.output}`);
        return server;
    } catch (error) {
        await stopChild(child);
        throw error;
    }
}

async function request(server, pathname, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.auth !== false) headers.set('x-flow-studio-token', server.token);
    if (options.origin) headers.set('origin', options.origin);
    let body = options.body;
    if (Object.prototype.hasOwnProperty.call(options, 'json')) {
        headers.set('content-type', 'application/json');
        body = JSON.stringify(options.json);
    }
    return fetch(`${server.baseUrl}${pathname}`, {
        method: options.method || 'GET',
        headers,
        body,
        signal: AbortSignal.timeout(options.timeoutMs || 10_000)
    });
}

async function waitForRun(server, runId, predicate, timeoutMs = 15_000) {
    return waitFor(async () => {
        const response = await request(server, `/api/runs/${runId}`);
        assert.equal(response.status, 200, await response.clone().text());
        const record = (await response.json()).run;
        return predicate(record) ? record : false;
    }, timeoutMs, `run ${runId} did not reach the expected status`);
}

async function waitFor(predicate, timeoutMs, message) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const value = await predicate();
            if (value) return value;
        } catch (error) {
            if (error.fatal) throw error;
            lastError = error;
        }
        await delay(50);
    }
    throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

async function reservePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, HOST, resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
}

async function stopChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit').catch(() => undefined);
    child.kill('SIGTERM');
    await Promise.race([exited, delay(3000)]);
    if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await Promise.race([once(child, 'exit').catch(() => undefined), delay(3000)]);
    }
}

async function writeJson(target, value) {
    await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
