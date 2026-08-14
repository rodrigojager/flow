import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import plugin from '../lib/opencode-plugin.js';
import { FlowStudioController } from '../lib/controller.js';

test('CyberVinci/OpenCode entrypoint exports exactly the seven short Flow tools', async () => {
    const hooks = await plugin({
        client: { app: { log: async () => ({}) } },
        project: {},
        directory: process.cwd(),
        worktree: process.cwd(),
        experimental_workspace: { register() {} },
        serverUrl: new URL('http://127.0.0.1')
    }, {});
    assert.deepEqual(Object.keys(hooks.tool).sort(), [
        'flow_author', 'flow_cancel', 'flow_open', 'flow_replay',
        'flow_resume', 'flow_run', 'flow_status'
    ]);
    assert.equal(Object.keys(hooks.tool).some(name => name.startsWith('flow_studio_')), false);
    await hooks.dispose();
});

test('controller starts the real authenticated CLI and preserves GraphSpec v2 execution', async t => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-studio-controller-'));
    const file = path.join(workspace, 'flow.json');
    const graph = {
        version: 'flow-studio/v2', id: 'controller-smoke', name: 'Controller smoke', start: 'agent',
        permissions: { allow: ['runner:invoke'] },
        nodes: [
            { id: 'agent', type: 'agent', label: 'Agent', prompt: 'hello', provider: { providerId: 'opencode' }, next: 'end' },
            { id: 'end', type: 'end', label: 'End' }
        ],
        edges: [{ from: 'agent', to: 'end' }],
        budget: { maxSteps: 30, maxDurationMs: 10_000 }
    };
    await fs.writeFile(file, JSON.stringify(graph), 'utf8');
    const controller = new FlowStudioController();
    t.after(async () => { await controller.stop(); await fs.rm(workspace, { recursive: true, force: true }); });
    const session = await controller.start(file, { workspace, simulate: true });
    assert.ok(session.pid > 0);
    assert.equal((await controller.health()).version, 'flow-studio/v2');
    assert.equal((await controller.loadGraph()).graph.version, 'flow-studio/v2');
    const executed = await controller.run(graph, { request: 'smoke' });
    assert.equal(executed.run.status, 'completed');
});

test('controller forwards the independent host allowlist for graph-defined command runners', async t => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-studio-controller-runner-'));
    const file = path.join(workspace, 'flow.json');
    const adapter = path.join(workspace, 'runner.cjs');
    await fs.writeFile(adapter, `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({output:{result:'host-runner'}})));`, 'utf8');
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(adapter)}`;
    const graph = {
        version: 'flow-studio/v2', id: 'controller-runner', name: 'Controller runner', start: 'agent',
        permissions: { allow: ['runner:invoke'], commandPatterns: ['*'], fileRoots: ['.'] },
        runners: [{ id: 'host-runner', name: 'Host runner', kind: 'command', command, capabilities: ['chat'] }],
        modelProfiles: [{ id: 'host-profile', name: 'Host profile', providerId: 'host', modelId: 'host/model', runnerId: 'host-runner' }],
        nodes: [
            { id: 'agent', type: 'agent', label: 'Agent', prompt: 'hello', provider: { providerId: 'host', modelId: 'host/model', profileId: 'host-profile', runnerId: 'host-runner' }, next: 'end' },
            { id: 'end', type: 'end', label: 'End' }
        ], edges: [], budget: { maxSteps: 20, maxDurationMs: 10_000 }
    };
    await fs.writeFile(file, JSON.stringify(graph), 'utf8');
    const controller = new FlowStudioController();
    t.after(async () => { await controller.stop(); await fs.rm(workspace, { recursive: true, force: true }); });
    await controller.start(file, { workspace, allowGraphRunners: true, allowCommands: [command] });
    const executed = await controller.run(graph, {});
    assert.equal(executed.run.status, 'completed', executed.run.error);
    const deniedGraph = structuredClone(graph);
    deniedGraph.id = 'controller-runner-denied';
    deniedGraph.runners[0].command = 'definitely-not-approved';
    await assert.rejects(controller.run(deniedGraph, {}), /allowlist independente do host/i);
});

test('author preview apply saves the exact reviewed proposal without regenerating it', async t => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-studio-proposal-'));
    const file = path.join(workspace, 'flow-studio.graph.json');
    const counter = path.join(workspace, 'author-count.txt');
    const capture = path.join(workspace, 'author-request.json');
    const adapter = path.join(workspace, 'author-adapter.cjs');
    const initial = {
        version: 'flow-studio/v2', id: 'initial', name: 'Initial', start: 'end',
        nodes: [{ id: 'end', type: 'end', label: 'End' }], edges: []
    };
    await fs.writeFile(file, JSON.stringify(initial), 'utf8');
    await fs.writeFile(adapter, `const fs=require('node:fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(capture)},input);let n=0;try{n=Number(fs.readFileSync(${JSON.stringify(counter)},'utf8'))||0}catch{};n++;fs.writeFileSync(${JSON.stringify(counter)},String(n));process.stdout.write(JSON.stringify({graph:{version:'flow-studio/v2',id:'proposal',name:'Proposal '+n,start:'end',nodes:[{id:'end',type:'end',label:'End'}],edges:[]},summary:'proposal '+n,assumptions:[]}));});`, 'utf8');
    const pluginOptions = {
        authorExec: `"${process.execPath}" "${adapter}"`,
        toolExec: ['host-tool=unused-tool-command'],
        playbookExec: ['host-playbook=unused-playbook-command']
    };
    const hooks = await plugin({
        client: { app: { log: async () => ({}) } }, project: {}, directory: workspace, worktree: workspace,
        experimental_workspace: { register() {} }, serverUrl: new URL('http://127.0.0.1')
    }, pluginOptions);
    t.after(async () => { await hooks.dispose(); await fs.rm(workspace, { recursive: true, force: true }); });
    const context = { directory: workspace, worktree: workspace, abort: new AbortController().signal, metadata() {} };
    const previewEnvelope = await hooks.tool.flow_author.execute({ instruction: 'Create it', file, apply: false }, context);
    const preview = JSON.parse(previewEnvelope.output);
    assert.equal(preview.applied, false);
    assert.ok(preview.proposalId);
    const proposalGraph = previewEnvelope.metadata.graph;
    assert.equal(proposalGraph.name, 'Proposal 1');
    const captured = JSON.parse(await fs.readFile(capture, 'utf8'));
    assert.ok(captured.request.availableTools.some(item => item.id === 'host-tool'));
    assert.ok(captured.request.availablePlaybooks.some(item => item.id === 'host-playbook'));

    const applyEnvelope = await hooks.tool.flow_author.execute({ proposalId: preview.proposalId, file, apply: true }, context);
    const applied = JSON.parse(applyEnvelope.output);
    assert.equal(applied.applied, true);
    assert.equal(await fs.readFile(counter, 'utf8'), '1');
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).name, 'Proposal 1');

    const runEnvelope = await hooks.tool.flow_run.execute({ file, input: {}, wait: true }, context);
    const run = JSON.parse(runEnvelope.output);
    const statusEnvelope = await hooks.tool.flow_status.execute({ file, runId: run.runId, detail: 'effects', eventCursor: 0, limit: 20 }, context);
    const status = JSON.parse(statusEnvelope.output);
    assert.ok(Array.isArray(status.effects), 'detail=effects exposes the effect ledger without requesting the full run');
});
