'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const compiledEntry = require.resolve('../lib');
const {
    FLOW_STUDIO_SCHEMA_VERSION,
    FLOW_STUDIO_MAX_ARTIFACT_BYTES,
    FLOW_STUDIO_MAX_CHECKPOINTS,
    FLOW_STUDIO_MAX_CONTEXT_BYTES,
    FLOW_STUDIO_MAX_EVENTS,
    FLOW_STUDIO_MAX_NODE_OUTPUT_BYTES,
    flowStudioMemoryCandidateDigest,
    createFlowStudioTemplate,
    runFlowStudioGraph,
    validateFlowStudioGraph
} = require('../lib');

function graph(id, start, nodes, options = {}) {
    const { edges = [], permissions, ...rest } = options;
    return {
        version: FLOW_STUDIO_SCHEMA_VERSION,
        id,
        name: id,
        start,
        nodes,
        edges,
        permissions: {
            ...(permissions || {}),
            allow: [...new Set(['runner:invoke', 'memory:read', 'memory:write', 'playbook:run', 'tool:read', ...(permissions?.allow || [])])]
        },
        ...rest
    };
}

function node(id, type, options = {}) {
    return { id, type, label: id, ...options };
}

function entered(result, nodeId) {
    return result.events.filter(event => event.kind === 'node.enter' && event.nodeId === nodeId).length;
}

function assertValid(candidate) {
    const validation = validateFlowStudioGraph(candidate);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors, null, 2));
}

test('the suite imports the compiled lib entrypoint, not src', () => {
    assert.equal(path.basename(compiledEntry), 'index.js');
    assert.equal(path.basename(path.dirname(compiledEntry)), 'lib');
    assert.equal(FLOW_STUDIO_SCHEMA_VERSION, 'flow-studio/v2');
});

test('fork executes every branch but executes the join and downstream chain exactly once', async () => {
    const candidate = graph('fork-once', 'fork', [
        node('fork', 'fork', {
            fork: { branches: ['branch-a', 'branch-b'], join: 'join', maxConcurrency: 2 }
        }),
        node('branch-a', 'transform', {
            condition: '({ branchA: true })',
            next: 'join'
        }),
        node('branch-b', 'transform', {
            condition: '({ branchB: true })',
            next: 'join'
        }),
        node('join', 'join', {
            join: { strategy: 'all' },
            next: 'downstream'
        }),
        node('downstream', 'transform', {
            condition: '({ downstreamRuns: (context.downstreamRuns || 0) + 1 })',
            next: 'end'
        }),
        node('end', 'end')
    ], {
        edges: [
            { id: 'branch-a-to-join', from: 'branch-a', to: 'join' },
            { id: 'branch-b-to-join', from: 'branch-b', to: 'join' }
        ]
    });
    assertValid(candidate);

    const result = await runFlowStudioGraph({ graph: candidate });

    assert.equal(result.status, 'completed', result.error);
    assert.equal(entered(result, 'branch-a'), 1);
    assert.equal(entered(result, 'branch-b'), 1);
    assert.equal(entered(result, 'join'), 1);
    assert.equal(entered(result, 'downstream'), 1);
    assert.equal(result.finalContext.downstreamRuns, 1);
    assert.equal(result.finalContext.branchA, true);
    assert.equal(result.finalContext.branchB, true);
});

test('join any selects the first completed branch and cancelRemaining aborts slower work', async () => {
    const candidate = graph('fork-any-fastest', 'fork', [
        node('fork', 'fork', { fork: { branches: ['slow', 'fast'], join: 'join', maxConcurrency: 2 } }),
        node('slow', 'agent', { prompt: 'slow', provider: { providerId: 'test' }, outputs: { winner: 'winner' }, next: 'join' }),
        node('fast', 'agent', { prompt: 'fast', provider: { providerId: 'test' }, outputs: { winner: 'winner' }, next: 'join' }),
        node('join', 'join', { join: { strategy: 'any', cancelRemaining: true }, next: 'end' }),
        node('end', 'end')
    ], { edges: [{ from: 'slow', to: 'join' }, { from: 'fast', to: 'join' }] });
    let slowAborted = false;
    const startedAt = Date.now();
    const result = await runFlowStudioGraph({
        graph: candidate,
        runnerAdapters: {
            test: ({ node, signal }) => new Promise((resolve, reject) => {
                const timer = setTimeout(() => resolve({ output: { winner: node.id } }), node.id === 'slow' ? 180 : 8);
                signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    if (node.id === 'slow') slowAborted = true;
                    const error = new Error('aborted');
                    error.name = 'AbortError';
                    reject(error);
                }, { once: true });
            })
        }
    });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.finalContext.winner, 'fast');
    assert.equal(slowAborted, true);
    assert.ok(Date.now() - startedAt < 150, 'the join should not wait for the slow branch');
});

test('a wait inside one fork branch resumes without losing completed sibling state', async () => {
    const candidate = graph('fork-wait-resume', 'fork', [
        node('fork', 'fork', { fork: { branches: ['sibling', 'wait'], join: 'join', maxConcurrency: 2 } }),
        node('sibling', 'transform', { condition: '({ sibling: "preserved" })', next: 'join' }),
        node('wait', 'wait', { wait: { kind: 'event', eventName: 'continue', correlationKey: 'fork-1' }, next: 'after-wait' }),
        node('after-wait', 'transform', { condition: '({ resumedBranch: true })', next: 'join' }),
        node('join', 'join', { join: { strategy: 'all' }, next: 'end' }),
        node('end', 'end')
    ], { edges: [{ from: 'sibling', to: 'join' }, { from: 'after-wait', to: 'join' }] });
    const suspended = await runFlowStudioGraph({ graph: candidate });
    assert.equal(suspended.status, 'waiting');
    assert.equal(suspended.waiting?.nodeId, 'wait');
    const checkpoint = suspended.checkpoints.find(item => item.id === suspended.waiting?.checkpointId);
    assert.ok(checkpoint?.metadata?.forkState);

    const resumed = await runFlowStudioGraph({
        graph: candidate,
        resume: { checkpoint, signal: { eventName: 'continue', correlationKey: 'fork-1' } },
        effects: suspended.effects
    });
    assert.equal(resumed.status, 'completed', resumed.error);
    assert.equal(resumed.finalContext.sibling, 'preserved');
    assert.equal(resumed.finalContext.resumedBranch, true);
    assert.equal(entered(resumed, 'join'), 1);
});

test('a composite Gate inside a Fork reevaluates automatic children after the human resume', async () => {
    const candidate = graph('fork-composite-gate', 'fork', [
        node('fork', 'fork', { fork: { branches: ['gate', 'sibling'], join: 'join', maxConcurrency: 2 } }),
        node('gate', 'gate', {
            gate: { kind: 'composite', combine: 'all', children: [
                { kind: 'human', prompt: 'Approve branch?' },
                { kind: 'ai', prompt: 'Recheck branch', reviewer: { providerId: 'reviewer' } }
            ] },
            next: 'join'
        }),
        node('sibling', 'transform', { condition: '({ sibling: true })', next: 'join' }),
        node('join', 'join', { join: { strategy: 'all' }, next: 'end' }),
        node('end', 'end')
    ]);
    let reviewerCalls = 0;
    const adapters = { reviewer: async () => ({ output: { approved: ++reviewerCalls === 1 } }) };
    const suspended = await runFlowStudioGraph({ graph: candidate, runnerAdapters: adapters });
    assert.equal(suspended.status, 'waiting', suspended.error);
    assert.equal(suspended.waiting?.detail?.pendingHumanPath, 'root.0');
    const checkpoint = suspended.checkpoints.find(item => item.id === suspended.waiting?.checkpointId);
    assert.ok(checkpoint?.metadata?.forkState);

    const resumed = await runFlowStudioGraph({
        graph: candidate,
        runnerAdapters: adapters,
        resume: { checkpoint, gate: { decisionId: 'continue' } }
    });
    assert.equal(resumed.status, 'failed');
    assert.equal(reviewerCalls, 2);
    assert.equal(entered(resumed, 'end'), 0);
});

test('a human gate suspends, persists a checkpoint, and resumes only through a declared decision', async () => {
    const candidate = graph('human-gate', 'approval', [
        node('approval', 'gate', {
            gate: { kind: 'human', prompt: 'Approve this run?' },
            gateDecisions: [
                { id: 'approve', label: 'Approve', decision: 'continue', toNodeId: 'after' },
                { id: 'reject', label: 'Reject', decision: 'fail' }
            ]
        }),
        node('after', 'transform', {
            condition: '({ approved: true })',
            next: 'end'
        }),
        node('end', 'end')
    ]);
    assertValid(candidate);

    const suspended = await runFlowStudioGraph({ graph: candidate });

    assert.equal(suspended.status, 'waiting');
    assert.deepEqual(
        { nodeId: suspended.waiting?.nodeId, kind: suspended.waiting?.kind },
        { nodeId: 'approval', kind: 'gate' }
    );
    const checkpoint = suspended.checkpoints.find(item => item.reason === 'gate');
    assert.ok(checkpoint, 'the human gate must persist a resumable checkpoint');
    assert.equal(checkpoint.nodeId, 'approval');

    const resumed = await runFlowStudioGraph({
        graph: candidate,
        resume: { checkpoint, gate: { decisionId: 'approve' } }
    });

    assert.equal(resumed.status, 'completed', resumed.error);
    assert.equal(entered(resumed, 'after'), 1);
    assert.equal(resumed.finalContext.approved, true);
    assert.ok(resumed.events.some(event => event.kind === 'gate.resolved' && event.nodeId === 'approval'));

    const rejected = await runFlowStudioGraph({
        graph: candidate,
        resume: { checkpoint, gate: { decisionId: 'reject' } }
    });
    assert.equal(rejected.status, 'failed');
    assert.equal(entered(rejected, 'after'), 0);
});

test('a human gate that requires evidence cannot be approved without an evidence artifact', async () => {
    const candidate = graph('evidence-gate', 'approval', [
        node('approval', 'gate', {
            gate: { kind: 'human', prompt: 'Approve with evidence?', requireEvidence: true },
            gateDecisions: [{ id: 'approve', label: 'Approve', decision: 'continue', toNodeId: 'end' }]
        }),
        node('end', 'end')
    ]);
    assertValid(candidate);
    const suspended = await runFlowStudioGraph({ graph: candidate });
    const checkpoint = suspended.checkpoints.find(item => item.reason === 'gate');
    assert.ok(checkpoint);

    const missing = await runFlowStudioGraph({ graph: candidate, resume: { checkpoint, gate: { decisionId: 'approve' } } });
    assert.equal(missing.status, 'failed');
    assert.match(missing.error, /exige evidência/);

    const evidence = { id: 'evidence-1', nodeId: 'approval', kind: 'evidence', name: 'Manual check', payload: 'Reviewed output.' };
    const approved = await runFlowStudioGraph({ graph: candidate, resume: { checkpoint, gate: { decisionId: 'approve', evidence: [evidence] } } });
    assert.equal(approved.status, 'completed', approved.error);
    assert.ok(approved.artifacts.some(artifact => artifact.id === evidence.id));
});

test('a human gate without explicit decisions uses safe defaults and the declared decision controls action and target', async () => {
    const candidate = graph('human-gate-default-decisions', 'approval', [
        node('approval', 'gate', { gate: { kind: 'human', prompt: 'Continue?' }, next: 'end' }),
        node('end', 'end')
    ]);
    assertValid(candidate);
    const suspended = await runFlowStudioGraph({ graph: candidate });
    const checkpoint = suspended.checkpoints.find(item => item.reason === 'gate');
    assert.ok(checkpoint);

    const approved = await runFlowStudioGraph({
        graph: candidate,
        resume: { checkpoint, gate: { decisionId: 'continue', action: 'fail' } }
    });
    assert.equal(approved.status, 'completed', approved.error);
    assert.equal(entered(approved, 'end'), 1);

    const forgedRoute = await runFlowStudioGraph({
        graph: candidate,
        resume: { checkpoint, gate: { decisionId: 'continue', toNodeId: 'untrusted-target' } }
    });
    assert.equal(forgedRoute.status, 'failed');
    assert.match(forgedRoute.error || '', /não pertence à decisão/i);
    assert.equal(entered(forgedRoute, 'end'), 0);

    const rejected = await runFlowStudioGraph({
        graph: candidate,
        resume: { checkpoint, gate: { decisionId: 'fail', action: 'continue', toNodeId: 'end' } }
    });
    assert.equal(rejected.status, 'failed');
    assert.match(rejected.error || '', /não pertence à decisão/i);
    assert.equal(entered(rejected, 'end'), 0);
});

test('a Gate decision cannot borrow the route declared by another decision', async () => {
    const candidate = graph('gate-route-binding', 'gate', [
        node('gate', 'gate', {
            gate: { kind: 'human', prompt: 'Choose one route' },
            gateDecisions: [
                { id: 'route-a', label: 'Route A', decision: 'continue', toNodeId: 'a' },
                { id: 'route-b', label: 'Route B', decision: 'continue', toNodeId: 'b' }
            ]
        }),
        node('a', 'end'),
        node('b', 'end')
    ]);
    const suspended = await runFlowStudioGraph({ graph: candidate });
    const checkpoint = suspended.checkpoints.find(item => item.id === suspended.waiting?.checkpointId);
    assert.ok(checkpoint);

    const forged = await runFlowStudioGraph({
        graph: candidate,
        resume: { checkpoint, gate: { decisionId: 'route-a', toNodeId: 'b' } }
    });
    assert.equal(forged.status, 'failed');
    assert.match(forged.error || '', /Destino "b" não pertence à decisão "route-a"/i);
    assert.equal(entered(forged, 'a'), 0);
    assert.equal(entered(forged, 'b'), 0);

    const valid = await runFlowStudioGraph({
        graph: candidate,
        resume: { checkpoint, gate: { decisionId: 'route-a', toNodeId: 'a' } }
    });
    assert.equal(valid.status, 'completed', valid.error);
    assert.equal(entered(valid, 'a'), 1);
    assert.equal(entered(valid, 'b'), 0);
});

test('external Gate responses require a declared decisionId and reject forged or arbitrary fields in main, Fork, and Loop resumes', async t => {
    const custom = graph('strict-external-gate', 'gate', [
        node('gate', 'gate', {
            gate: { kind: 'human', prompt: 'Choose a declared route' },
            gateDecisions: [
                { id: 'approve', label: 'Approve', decision: 'continue', toNodeId: 'approved' },
                { id: 'reject', label: 'Reject', decision: 'fail' }
            ],
            next: 'direct'
        }),
        node('direct', 'transform', { condition: '({ forged: true })', next: 'end' }),
        node('approved', 'transform', { condition: '({ approved: true })', next: 'end' }),
        node('end', 'end')
    ]);
    const suspended = await runFlowStudioGraph({ graph: custom });
    const checkpoint = suspended.checkpoints.find(item => item.id === suspended.waiting?.checkpointId);
    assert.ok(checkpoint);

    const noResponse = await runFlowStudioGraph({ graph: custom, resume: { checkpoint } });
    assert.equal(noResponse.status, 'waiting');
    assert.notEqual(noResponse.waiting?.checkpointId, checkpoint.id);
    const refreshedGateCheckpoint = noResponse.checkpoints.find(item => item.id === noResponse.waiting?.checkpointId);
    assert.ok(refreshedGateCheckpoint);
    assert.equal(refreshedGateCheckpoint.reason, 'gate');
    assert.deepEqual(refreshedGateCheckpoint.context, checkpoint.context);

    for (const gate of [
        { action: 'continue', toNodeId: 'direct' },
        { action: 'approved-by-me', toNodeId: 'direct' },
        {}
    ]) {
        const result = await runFlowStudioGraph({ graph: custom, resume: { checkpoint, gate } });
        assert.equal(result.status, 'failed');
        assert.match(result.error || '', /decisionId|action deve/i);
        assert.equal(entered(result, 'direct'), 0);
        assert.equal(entered(result, 'approved'), 0);
    }

    await t.test('Fork', async () => {
        const candidate = graph('strict-gate-fork', 'fork', [
            node('fork', 'fork', { fork: { branches: ['gate', 'sibling'], join: 'join' } }),
            node('gate', 'gate', { gate: { kind: 'human' }, gateDecisions: [{ id: 'approve', label: 'Approve', decision: 'continue', toNodeId: 'join' }], next: 'join' }),
            node('sibling', 'transform', { condition: '({ sibling: true })', next: 'join' }),
            node('join', 'join', { join: { strategy: 'all' }, next: 'end' }),
            node('end', 'end')
        ]);
        const waiting = await runFlowStudioGraph({ graph: candidate });
        const forkCheckpoint = waiting.checkpoints.find(item => item.id === waiting.waiting?.checkpointId);
        const result = await runFlowStudioGraph({ graph: candidate, resume: { checkpoint: forkCheckpoint, gate: { action: 'continue', toNodeId: 'join' } } });
        assert.equal(result.status, 'failed');
        assert.match(result.error || '', /decisionId/i);
        assert.equal(entered(result, 'join'), 0);
    });

    await t.test('Loop', async () => {
        const candidate = graph('strict-gate-loop', 'loop', [
            node('loop', 'loop', { loop: { bodyStart: 'gate', condition: 'iteration < 1', maxIterations: 1 }, next: 'end' }),
            node('gate', 'gate', { gate: { kind: 'human' }, gateDecisions: [{ id: 'approve', label: 'Approve', decision: 'continue', toNodeId: 'loop' }], next: 'loop' }),
            node('end', 'end')
        ]);
        const waiting = await runFlowStudioGraph({ graph: candidate });
        const loopCheckpoint = waiting.checkpoints.find(item => item.id === waiting.waiting?.checkpointId);
        const result = await runFlowStudioGraph({ graph: candidate, resume: { checkpoint: loopCheckpoint, gate: { action: 'continue', toNodeId: 'loop' } } });
        assert.equal(result.status, 'failed');
        assert.match(result.error || '', /decisionId/i);
        assert.equal(entered(result, 'end'), 0);
    });
});

test('composite gates implement any, all, and majority without conflating failed criteria', async t => {
    const cases = [
        { combine: 'any', expressions: ['true', 'false'], status: 'completed' },
        { combine: 'all', expressions: ['true', 'false'], status: 'failed' },
        { combine: 'majority', expressions: ['true', 'false', 'true'], status: 'completed' }
    ];
    for (const spec of cases) await t.test(spec.combine, async () => {
        const candidate = graph(`composite-${spec.combine}`, 'gate', [
            node('gate', 'gate', {
                gate: {
                    kind: 'composite',
                    combine: spec.combine,
                    children: spec.expressions.map((expression, index) => ({ kind: 'deterministic', expression, prompt: `criterion-${index}` }))
                },
                next: 'end'
            }),
            node('end', 'end')
        ]);
        const result = await runFlowStudioGraph({ graph: candidate });
        assert.equal(result.status, spec.status, result.error);
    });
});

test('a resumed composite gate reevaluates automated children and never lets a human approval hide a later failure', async () => {
    const candidate = graph('composite-reevaluation', 'gate', [
        node('gate', 'gate', {
            gate: {
                kind: 'composite',
                combine: 'all',
                children: [
                    { kind: 'human', prompt: 'Human review' },
                    { kind: 'ai', prompt: 'Automated review', reviewer: { providerId: 'reviewer' } }
                ]
            },
            next: 'end'
        }),
        node('end', 'end')
    ]);
    let reviewerCalls = 0;
    const adapters = { reviewer: async () => ({ output: { approved: ++reviewerCalls === 1 } }) };
    const suspended = await runFlowStudioGraph({ graph: candidate, runnerAdapters: adapters });
    assert.equal(suspended.status, 'waiting', suspended.error);
    assert.equal(suspended.waiting?.detail?.pendingHumanPath, 'root.0');
    const checkpoint = suspended.checkpoints.find(item => item.id === suspended.waiting?.checkpointId);
    assert.ok(checkpoint?.metadata?.compositeGate);

    const resumed = await runFlowStudioGraph({
        graph: candidate,
        runnerAdapters: adapters,
        resume: { checkpoint, gate: { decisionId: 'continue' } }
    });
    assert.equal(resumed.status, 'failed');
    assert.equal(reviewerCalls, 2, 'the automated criterion must be reevaluated on resume');
    assert.equal(entered(resumed, 'end'), 0);
});

test('composite human-child interaction exposes its evidence contract and enforces it on resume', async () => {
    const candidate = graph('composite-child-evidence', 'gate', [
        node('gate', 'gate', {
            gate: { kind: 'composite', combine: 'all', children: [
                { kind: 'human', prompt: 'Review the release evidence', requireEvidence: true },
                { kind: 'deterministic', expression: 'true' }
            ] },
            gateDecisions: [{ id: 'approve', label: 'Approve', decision: 'continue', toNodeId: 'end' }],
            next: 'end'
        }),
        node('end', 'end')
    ]);
    const suspended = await runFlowStudioGraph({ graph: candidate });
    assert.equal(suspended.status, 'waiting');
    assert.deepEqual(suspended.waiting?.detail?.interaction, {
        type: 'gate', graphId: 'composite-child-evidence', nodeId: 'gate', kind: 'human', label: 'Review the release evidence',
        decisions: [{ id: 'approve', label: 'Approve', decision: 'continue', toNodeId: 'end' }],
        requireEvidence: true, pendingHumanPath: 'root.0', memoryWriteTargets: []
    });
    const checkpoint = suspended.checkpoints.find(item => item.id === suspended.waiting?.checkpointId);
    const rejected = await runFlowStudioGraph({ graph: candidate, resume: { checkpoint, gate: { decisionId: 'approve' } } });
    assert.equal(rejected.status, 'failed');
    assert.match(rejected.error || '', /exige evidência/i);

    const evidence = { id: 'composite-evidence', nodeId: 'gate', kind: 'evidence', name: 'review.json', payload: { approved: true } };
    const approved = await runFlowStudioGraph({ graph: candidate, resume: { checkpoint, gate: { decisionId: 'approve', evidence: [evidence] } } });
    assert.equal(approved.status, 'completed', approved.error);
});

test('a resumed composite Gate preserves only the authoritative declared human route', async t => {
    const evidence = { id: 'review-evidence', nodeId: 'approval', kind: 'evidence', name: 'review.md', payload: { approved: true } };

    await t.test('approved custom decision reaches Wait without node.next', async () => {
        const candidate = graph('composite-custom-route', 'approval', [
            node('approval', 'gate', {
                gate: { kind: 'composite', combine: 'all', children: [
                    { kind: 'human', prompt: 'Review release', requireEvidence: true },
                    { kind: 'deterministic', expression: 'true' }
                ] },
                gateDecisions: [
                    { id: 'approve-review', label: 'Approve review', decision: 'continue', toNodeId: 'external-event' },
                    { id: 'reject-review', label: 'Reject review', decision: 'fail' }
                ]
            }),
            node('external-event', 'wait', { wait: { kind: 'event', eventName: 'review.published' }, next: 'end' }),
            node('end', 'end')
        ]);
        const gated = await runFlowStudioGraph({ graph: candidate });
        assert.equal(gated.status, 'waiting', gated.error);
        const gateCheckpoint = gated.checkpoints.find(item => item.id === gated.waiting?.checkpointId);

        const waiting = await runFlowStudioGraph({
            graph: candidate,
            resume: { checkpoint: gateCheckpoint, gate: { decisionId: 'approve-review', evidence: [evidence] } }
        });
        assert.equal(waiting.status, 'waiting', waiting.error);
        assert.equal(waiting.waiting?.nodeId, 'external-event');
        assert.ok(waiting.events.some(event => event.kind === 'gate.resolved' && event.nodeId === 'approval'));
        const waitCheckpoint = waiting.checkpoints.find(item => item.id === waiting.waiting?.checkpointId);

        const completed = await runFlowStudioGraph({
            graph: candidate,
            resume: { checkpoint: waitCheckpoint, signal: { eventName: 'review.published' } }
        });
        assert.equal(completed.status, 'completed', completed.error);
    });

    await t.test('a declared fail decision cannot be forged into continue by another passing criterion', async () => {
        const candidate = graph('composite-human-veto', 'approval', [
            node('approval', 'gate', {
                gate: { kind: 'composite', combine: 'any', children: [
                    { kind: 'human', prompt: 'Owner decision' },
                    { kind: 'deterministic', expression: 'context.signal?.automaticApproval === true' }
                ] },
                gateDecisions: [
                    { id: 'approve', label: 'Approve', decision: 'continue', toNodeId: 'external-event' },
                    { id: 'reject', label: 'Reject', decision: 'fail' }
                ],
                next: 'external-event'
            }),
            node('external-event', 'wait', { wait: { kind: 'event', eventName: 'should-not-run' }, next: 'end' }),
            node('end', 'end')
        ]);
        const gated = await runFlowStudioGraph({ graph: candidate });
        assert.equal(gated.status, 'waiting', gated.error);
        const checkpoint = gated.checkpoints.find(item => item.id === gated.waiting?.checkpointId);
        const rejected = await runFlowStudioGraph({
            graph: candidate,
            resume: {
                checkpoint,
                gate: { decisionId: 'reject', action: 'continue', toNodeId: 'external-event' },
                signal: { automaticApproval: true }
            }
        });
        assert.equal(rejected.status, 'failed');
        assert.match(rejected.error || '', /recusado|rejeit|fail|não pertence à decisão/i);
        assert.equal(entered(rejected, 'external-event'), 0);
    });
});

test('composite gates preserve sequential human decisions, reevaluate every automated criterion, and carry trusted memory approvals', async () => {
    const approvedCandidate = { id: 'composite-memory', status: 'candidate', revision: 3, value: { decision: 'keep' }, approvedAt: 'spoofed', approvedBy: 'candidate-spoof' };
    const candidate = graph('composite-full-resume', 'gate', [
        node('gate', 'gate', {
            gate: {
                kind: 'composite',
                combine: 'all',
                children: [
                    { kind: 'human', prompt: 'Owner approval' },
                    { kind: 'human', prompt: 'Reviewer approval' },
                    { kind: 'deterministic', expression: 'context.ready === true' },
                    { kind: 'policy', rules: [{ id: 'quality', expression: 'context.quality >= 0.9', severity: 'blocker' }] },
                    { kind: 'ai', prompt: 'AI approval', reviewer: { providerId: 'reviewer' } }
                ]
            },
            next: 'write'
        }),
        node('write', 'memory_write', { memoryWrite: { scope: 'workspace', storeId: 'main', candidatesFrom: 'memoryCandidates', onEmpty: 'fail' }, next: 'end' }),
        node('end', 'end')
    ]);
    const approval = {
        id: approvedCandidate.id,
        revision: approvedCandidate.revision,
        scope: 'workspace',
        storeId: 'main',
        graphId: candidate.id,
        nodeId: 'write',
        candidateDigest: flowStudioMemoryCandidateDigest(approvedCandidate, 'workspace'),
        approvedAt: '1900-01-01T00:00:00.000Z',
        approvedBy: 'spoofed-host'
    };
    let reviewerCalls = 0;
    let receivedApproval;
    let receivedCandidate;
    const request = {
        graph: candidate,
        input: { ready: true, quality: 1, memoryCandidates: [approvedCandidate] },
        runnerAdapters: { reviewer: async () => { reviewerCalls += 1; return { output: { approved: true } }; } },
        memoryAdapter: {
            loadContext: async () => ({ pack: {} }),
            writeCandidate: async args => {
                receivedApproval = args.approval;
                receivedCandidate = args.candidate;
                return { candidateId: args.candidate.id, revision: args.candidate.revision, scope: args.candidate.scope, storeId: args.config.storeId, status: 'written' };
            }
        }
    };
    const suspended = await runFlowStudioGraph(request);
    assert.equal(suspended.waiting?.detail?.pendingHumanPath, 'root.0');
    const firstCheckpoint = suspended.checkpoints.find(item => item.id === suspended.waiting?.checkpointId);
    assert.ok(firstCheckpoint);

    const afterFirstHuman = await runFlowStudioGraph({
        ...request,
        resume: { checkpoint: firstCheckpoint, gate: { decisionId: 'continue', memoryApprovals: [approval] } }
    });
    assert.equal(afterFirstHuman.status, 'waiting', afterFirstHuman.error);
    assert.equal(afterFirstHuman.waiting?.detail?.pendingHumanPath, 'root.1');
    const secondCheckpoint = afterFirstHuman.checkpoints.find(item => item.id === afterFirstHuman.waiting?.checkpointId);
    assert.ok(secondCheckpoint?.metadata?.compositeGate?.humanResults?.['root.0']);

    const completed = await runFlowStudioGraph({
        ...request,
        resume: { checkpoint: secondCheckpoint, gate: { decisionId: 'continue' } }
    });
    assert.equal(completed.status, 'completed', completed.error);
    assert.equal(reviewerCalls, 3, 'AI, deterministic, and policy criteria are reevaluated on every resume');
    assert.equal(receivedApproval.graphId, candidate.id);
    assert.equal(receivedApproval.nodeId, 'write');
    assert.equal(receivedApproval.storeId, 'main');
    assert.equal(receivedApproval.approvedBy, 'human-gate');
    assert.notEqual(receivedApproval.approvedAt, approval.approvedAt);
    assert.equal(receivedCandidate.approvedBy, 'human-gate');
    assert.notEqual(receivedCandidate.approvedAt, approvedCandidate.approvedAt);
});

test('policy gates expose score, blockers, and warnings as structured observability', async () => {
    const candidate = graph('policy-observability', 'policy', [
        node('policy', 'gate', {
            gate: { kind: 'policy', rules: [
                { id: 'must-pass', expression: 'context.approved === true', message: 'Approval missing', severity: 'blocker' },
                { id: 'quality', expression: 'context.quality > 0.8', message: 'Quality is low', severity: 'warning' }
            ] },
            next: 'end'
        }),
        node('end', 'end')
    ]);
    const failed = await runFlowStudioGraph({ graph: candidate, input: { approved: false, quality: 0.5 } });
    assert.equal(failed.status, 'failed');
    const event = failed.events.find(item => item.kind === 'run.failed');
    assert.ok(event);
    const passed = await runFlowStudioGraph({ graph: candidate, input: { approved: true, quality: 0.5 } });
    assert.equal(passed.status, 'completed', passed.error);
    const resolved = passed.events.find(item => item.kind === 'gate.resolved');
    assert.equal(resolved.detail.score, 0.5);
    assert.deepEqual(resolved.detail.blockers, []);
    assert.deepEqual(resolved.detail.warnings, ['Quality is low']);
});

test('an event wait rejects mismatched signals and resumes on the exact event and correlation key', async () => {
    const candidate = graph('event-wait', 'wait-for-job', [
        node('wait-for-job', 'wait', {
            wait: { kind: 'event', eventName: 'job.completed', correlationKey: 'job-42' },
            next: 'after'
        }),
        node('after', 'transform', {
            condition: '({ resumed: true })',
            next: 'end'
        }),
        node('end', 'end')
    ]);
    assertValid(candidate);

    const suspended = await runFlowStudioGraph({ graph: candidate });
    assert.equal(suspended.status, 'waiting');
    const checkpoint = suspended.checkpoints.find(item => item.reason === 'wait');
    assert.ok(checkpoint, 'the wait node must persist a resumable checkpoint');

    const wrongEvent = await runFlowStudioGraph({
        graph: candidate,
        resume: {
            checkpoint,
            signal: { eventName: 'job.failed', correlationKey: 'job-42' }
        }
    });
    assert.equal(wrongEvent.status, 'waiting');
    assert.equal(entered(wrongEvent, 'after'), 0);
    assert.notEqual(wrongEvent.waiting?.checkpointId, checkpoint.id);
    const wrongEventCheckpoint = wrongEvent.checkpoints.find(item => item.id === wrongEvent.waiting?.checkpointId);
    assert.ok(wrongEventCheckpoint);
    assert.deepEqual(wrongEventCheckpoint.context, checkpoint.context, 'a rejected signal must not pollute the persisted context');

    const wrongCorrelation = await runFlowStudioGraph({
        graph: candidate,
        resume: {
            checkpoint: wrongEventCheckpoint,
            signal: { eventName: 'job.completed', correlationKey: 'job-99' }
        }
    });
    assert.equal(wrongCorrelation.status, 'waiting');
    assert.equal(entered(wrongCorrelation, 'after'), 0);
    assert.notEqual(wrongCorrelation.waiting?.checkpointId, wrongEventCheckpoint.id);
    const wrongCorrelationCheckpoint = wrongCorrelation.checkpoints.find(item => item.id === wrongCorrelation.waiting?.checkpointId);
    assert.ok(wrongCorrelationCheckpoint);

    const resumed = await runFlowStudioGraph({
        graph: candidate,
        resume: {
            checkpoint: wrongCorrelationCheckpoint,
            signal: { eventName: 'job.completed', correlationKey: 'job-42', payload: { ok: true } }
        }
    });
    assert.equal(resumed.status, 'completed', resumed.error);
    assert.equal(entered(resumed, 'after'), 1);
    assert.equal(resumed.finalContext.resumed, true);
    assert.ok(resumed.events.some(event => event.kind === 'wait.resolved' && event.nodeId === 'wait-for-job'));
});

test('an event arriving after an expired fail timeout cannot bypass the timeout policy', async () => {
    const candidate = graph('event-timeout-precedence', 'wait', [
        node('wait', 'wait', {
            wait: { kind: 'event', eventName: 'job.completed', correlationKey: 'job-42', timeoutMs: 60_000, onTimeout: 'fail' },
            next: 'after'
        }),
        node('after', 'transform', { condition: '({ resumed: true })', next: 'end' }),
        node('end', 'end')
    ]);
    const suspended = await runFlowStudioGraph({ graph: candidate });
    const checkpoint = suspended.checkpoints.find(item => item.reason === 'wait');
    assert.ok(checkpoint);
    assert.equal(suspended.waiting?.detail?.interaction?.onTimeout, 'fail');
    assert.ok(Number.isFinite(Date.parse(suspended.waiting?.detail?.interaction?.dueAt)));
    checkpoint.metadata.dueAt = new Date(Date.now() - 1_000).toISOString();

    const expired = await runFlowStudioGraph({
        graph: candidate,
        resume: { checkpoint, signal: { eventName: 'job.completed', correlationKey: 'job-42' } }
    });
    assert.equal(expired.status, 'failed');
    assert.match(expired.error || '', /excedeu o prazo|timeout/i);
    assert.equal(entered(expired, 'after'), 0);
});

test('replay reuses a completed idempotent effect instead of executing it again', async () => {
    let executions = 0;
    const candidate = graph('effect-replay', 'side-effect', [
        node('side-effect', 'action', {
            tools: [{
                id: 'write-once',
                name: 'Write once',
                command: 'write-once',
                effect: 'write',
                idempotencyKey: 'stable-effect-key',
                requiredPermissions: ['tool:write']
            }],
            next: 'end'
        }),
        node('end', 'end')
    ], {
        permissions: { allow: ['tool:write'] }
    });
    assertValid(candidate);

    const toolAdapters = {
        'write-once': async () => {
            executions += 1;
            return { output: { persisted: true } };
        }
    };
    const first = await runFlowStudioGraph({ graph: candidate, toolAdapters });
    assert.equal(first.status, 'completed', first.error);
    assert.equal(executions, 1);
    assert.equal(first.effects.length, 1);
    assert.equal(first.effects[0].status, 'completed');

    const completedAction = first.checkpoints.find(item => item.nodeId === 'side-effect' && item.reason === 'node-complete');
    assert.ok(completedAction, 'the completed action must have a checkpoint');
    const replayCheckpoint = {
        ...completedAction,
        id: `${completedAction.id}-replay`,
        nextNodeId: 'side-effect',
        reason: 'manual',
        context: {},
        visited: []
    };
    const replayed = await runFlowStudioGraph({
        graph: candidate,
        toolAdapters,
        effects: first.effects,
        resume: { checkpoint: replayCheckpoint, forkRun: true }
    });

    assert.equal(replayed.status, 'completed', replayed.error);
    assert.equal(executions, 1, 'the adapter must not run again during replay');
    assert.equal(replayed.effects.length, 1, 'replay must not append a duplicate effect record');
    assert.equal(replayed.finalContext.persisted, true);
    assert.ok(replayed.events.some(event => event.kind === 'effect.skipped'));
});

test('effect receipts are written ahead and an uncertain started effect fails closed', async () => {
    const candidate = graph('effect-write-ahead', 'action', [
        node('action', 'action', {
            tools: [{ id: 'side-effect', name: 'Side effect', command: 'side-effect', effect: 'command', requiredPermissions: ['tool:command'], idempotencyKey: 'stable-key' }],
            next: 'end'
        }),
        node('end', 'end')
    ], { permissions: { allow: ['tool:command'] } });
    const receipts = [];
    const first = await runFlowStudioGraph({
        graph: candidate,
        onEffect: async effect => { receipts.push(effect.status); },
        toolAdapters: { 'side-effect': async () => {
            assert.deepEqual(receipts, ['started']);
            return { output: { done: true } };
        } }
    });
    assert.equal(first.status, 'completed', first.error);
    assert.deepEqual(receipts, ['started', 'completed']);

    let repeated = false;
    const uncertain = structuredClone(first.effects[0]);
    uncertain.status = 'started';
    delete uncertain.finishedAt;
    const replay = await runFlowStudioGraph({
        graph: candidate,
        effects: [uncertain],
        toolAdapters: { 'side-effect': async () => { repeated = true; return { output: {} }; } }
    });
    assert.equal(replay.status, 'failed');
    assert.match(replay.error || '', /receipt iniciado sem conclusão/i);
    assert.equal(repeated, false);
});

test('an agent can request only its declared tools and the engine executes them through the audited adapter', async () => {
    const candidate = graph('agent-tool-calling', 'agent', [
        node('agent', 'agent', {
            prompt: 'Use the lookup tool.',
            provider: { providerId: 'test' },
            tools: [{ id: 'lookup', name: 'Lookup', command: 'lookup', effect: 'read', requiredPermissions: ['tool:read'], idempotencyKey: 'lookup-once' }],
            outputs: { answer: 'flow.answer' },
            next: 'end'
        }),
        node('end', 'end')
    ], { permissions: { allow: ['tool:read'] } });
    let calls = 0;
    const result = await runFlowStudioGraph({
        graph: candidate,
        runnerAdapters: { test: async () => ({ output: { answer: 'planned' }, toolCalls: [{ toolId: 'lookup', args: ['safe'] }] }) },
        toolAdapters: { lookup: async args => { calls += 1; assert.deepEqual(args.tool.args, ['safe']); return { output: { lookedUp: true } }; } }
    });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(calls, 1);
    assert.equal(result.finalContext.flow.answer, 'planned');
    assert.equal(result.finalContext.lookedUp, true);
    assert.equal(result.effects[0].status, 'completed');
});

test('an agent tool call fails closed when the tool was not declared on that node', async () => {
    const candidate = graph('agent-tool-denied', 'agent', [
        node('agent', 'agent', { prompt: 'Try tool.', provider: { providerId: 'test' }, next: 'end' }),
        node('end', 'end')
    ]);
    const result = await runFlowStudioGraph({ graph: candidate, runnerAdapters: { test: async () => ({ toolCalls: [{ toolId: 'undeclared' }] }) } });
    assert.equal(result.status, 'failed');
    assert.match(result.error || '', /não declarada/i);
});

test('runner invocation obeys an explicit deny permission before calling the adapter', async () => {
    const candidate = graph('runner-permission-denied', 'agent', [
        node('agent', 'agent', { prompt: 'Do not run.', provider: { providerId: 'test' }, next: 'end' }),
        node('end', 'end')
    ], { permissions: { deny: ['runner:invoke'] } });
    let calls = 0;
    const result = await runFlowStudioGraph({ graph: candidate, runnerAdapters: { test: async () => { calls += 1; return { output: {} }; } } });
    assert.equal(result.status, 'failed');
    assert.match(result.error || '', /runner:invoke/);
    assert.equal(calls, 0);
});

test('runner and tool adapters fail closed unless simulationMode is explicitly enabled', async t => {
    await t.test('runner adapter', async () => {
        const candidate = graph('runner-adapter-required', 'agent', [
            node('agent', 'agent', {
                prompt: 'Return a result.',
                provider: { providerId: 'missing-provider' },
                next: 'end'
            }),
            node('end', 'end')
        ]);
        assertValid(candidate);

        const production = await runFlowStudioGraph({ graph: candidate });
        assert.equal(production.status, 'failed');
        assert.match(production.error || '', /Nenhum adapter real foi configurado/i);

        const preview = await runFlowStudioGraph({ graph: candidate, simulationMode: true });
        assert.equal(preview.status, 'completed', preview.error);
        assert.equal(preview.finalContext.provider, 'missing-provider');
    });

    await t.test('tool adapter', async () => {
        const candidate = graph('tool-adapter-required', 'action', [
            node('action', 'action', {
                tools: [{
                    id: 'missing-tool',
                    name: 'Missing tool',
                    command: 'missing-tool',
                    effect: 'read',
                    requiredPermissions: ['tool:read']
                }],
                next: 'end'
            }),
            node('end', 'end')
        ], {
            permissions: { allow: ['tool:read'] }
        });
        assertValid(candidate);

        const production = await runFlowStudioGraph({ graph: candidate });
        assert.equal(production.status, 'failed');
        assert.match(production.error || '', /Nenhum adapter real foi configurado para a ferramenta/i);

        const preview = await runFlowStudioGraph({ graph: candidate, simulationMode: true });
        assert.equal(preview.status, 'completed', preview.error);
        assert.equal(preview.finalContext.tool.simulated, true);
    });
});

test('validation rejects malformed syntax in every executable expression field', async t => {
    const cases = [
        {
            name: 'node condition',
            expectedPath: 'nodes/0/condition',
            candidate: graph('invalid-node-expression', 'router', [
                node('router', 'router', { condition: 'context.ready && (', next: 'end' }),
                node('end', 'end')
            ])
        },
        {
            name: 'edge guard',
            expectedPath: 'edges/0/guard',
            candidate: graph('invalid-edge-expression', 'router', [
                node('router', 'router'),
                node('end', 'end')
            ], {
                edges: [{ id: 'invalid-guard', from: 'router', to: 'end', guard: 'context.ready && (' }]
            })
        },
        {
            name: 'deterministic gate expression',
            expectedPath: 'nodes/0/gate/expression',
            candidate: graph('invalid-gate-expression', 'gate', [
                node('gate', 'gate', {
                    gate: { kind: 'deterministic', expression: 'context.approved && (' },
                    gateDecisions: [
                        { id: 'continue', label: 'Continue', decision: 'continue', toNodeId: 'end' },
                        { id: 'fail', label: 'Fail', decision: 'fail' }
                    ]
                }),
                node('end', 'end')
            ])
        },
        {
            name: 'policy rule expression',
            expectedPath: 'nodes/0/gate/rules/0/expression',
            candidate: graph('invalid-policy-expression', 'gate', [
                node('gate', 'gate', {
                    gate: {
                        kind: 'policy',
                        rules: [{ id: 'must-pass', expression: 'context.score > (' }]
                    },
                    gateDecisions: [
                        { id: 'continue', label: 'Continue', decision: 'continue', toNodeId: 'end' },
                        { id: 'fail', label: 'Fail', decision: 'fail' }
                    ]
                }),
                node('end', 'end')
            ])
        },
        {
            name: 'loop condition',
            expectedPath: 'nodes/0/loop/condition',
            candidate: graph('invalid-loop-expression', 'loop', [
                node('loop', 'loop', {
                    loop: { bodyStart: 'body', condition: 'iteration < (', maxIterations: 2 },
                    next: 'end'
                }),
                node('body', 'transform', { condition: '({})', next: 'loop' }),
                node('end', 'end')
            ])
        },
        {
            name: 'loop break expression',
            expectedPath: 'nodes/0/loop/breakWhen',
            candidate: graph('invalid-loop-break-expression', 'loop', [
                node('loop', 'loop', {
                    loop: { bodyStart: 'body', condition: 'true', breakWhen: 'context.done && (', maxIterations: 2 },
                    next: 'end'
                }),
                node('body', 'transform', { condition: '({ done: true })', next: 'loop' }),
                node('end', 'end')
            ])
        },
        {
            name: 'custom state reducer expression',
            expectedPath: 'state/namespaces/work/reducer/expression',
            candidate: graph('invalid-reducer-expression', 'end', [node('end', 'end')], {
                state: {
                    namespaces: {
                        work: { reducer: { kind: 'custom', expression: 'values.reduce((' } }
                    }
                }
            })
        }
    ];

    for (const item of cases) {
        await t.test(item.name, () => {
            const validation = validateFlowStudioGraph(item.candidate);
            const issue = validation.errors.find(error => error.code === 'expression.syntax' && error.path === item.expectedPath);
            assert.ok(issue, `expected expression.syntax at ${item.expectedPath}; received ${JSON.stringify(validation.errors)}`);
            assert.equal(validation.valid, false);
        });
    }
});

test('expression sandbox blocks host constructor escapes through intrinsics and computed properties', async () => {
    const directlyForbidden = [
        `({ leaked: Math.constructor.constructor('return process.platform')() })`,
        `({ leaked: Array['constructor']['constructor']('return process.platform')() })`,
        `({ leaked: String['prototype']['constructor']('return process.platform')() })`,
        `({ leaked: JSON['constructor']['constructor']('return process.platform')() })`
    ];
    for (const [index, expression] of directlyForbidden.entries()) {
        const candidate = graph(`sandbox-direct-${index}`, 'escape', [
            node('escape', 'transform', { condition: expression, next: 'end' }),
            node('end', 'end')
        ]);
        const validation = validateFlowStudioGraph(candidate);
        assert.equal(validation.valid, false);
        assert.ok(validation.errors.some(issue => /runtime|prototype|proibido/i.test(issue.message)));
    }

    const computedEscapes = [
        `({ leaked: Math['con' + 'structor']['con' + 'structor']('return pro' + 'cess.platform')() })`,
        `({ leaked: Array[['con', 'structor'].join('')][['con', 'structor'].join('')]('return pro' + 'cess.platform')() })`,
        `({ leaked: String[['con', 'structor'].join('')][['con', 'structor'].join('')]('return pro' + 'cess.platform')() })`,
        `({ leaked: JSON[['con', 'structor'].join('')][['con', 'structor'].join('')]('return pro' + 'cess.platform')() })`,
        `({ leaked: context.value[['con', 'structor'].join('')][['con', 'structor'].join('')]('return pro' + 'cess.platform')() })`
    ];
    for (const [index, expression] of computedEscapes.entries()) {
        const candidate = graph(`sandbox-computed-${index}`, 'escape', [
            node('escape', 'transform', { condition: expression, next: 'end' }),
            node('end', 'end')
        ]);
        assertValid(candidate);
        const result = await runFlowStudioGraph({ graph: candidate, input: { value: { safe: true } } });
        assert.equal(result.status, 'failed');
        assert.match(result.error || '', /code generation|strings disallowed|runtime|proibido/i);
        assert.equal(result.finalContext.leaked, undefined);
    }
});

test('validation rejects prototype-polluting state paths', () => {
    const candidate = graph('poisoned-output-path', 'input', [
        node('input', 'input', {
            outputs: { value: '__proto__.flowStudioPolluted' },
            next: 'end'
        }),
        node('end', 'end')
    ]);

    const validation = validateFlowStudioGraph(candidate);
    const outputPathIssue = validation.errors.find(issue => issue.path.includes('/outputs'));
    assert.equal(validation.valid, false, `unsafe path was accepted: ${JSON.stringify(validation)}`);
    assert.ok(outputPathIssue, `expected an output path error; received ${JSON.stringify(validation.errors)}`);
});

test('runtime never mutates Object.prototype when an unsafe mapping reaches execution', async () => {
    delete Object.prototype.flowStudioPolluted;
    const candidate = graph('runtime-poison-defense', 'input', [
        node('input', 'input', {
            outputs: { value: '__proto__.flowStudioPolluted' },
            next: 'end'
        }),
        node('end', 'end')
    ]);

    let result;
    let rejected;
    try {
        result = await runFlowStudioGraph({ graph: candidate, input: { value: 'owned' } });
    } catch (error) {
        rejected = error;
    } finally {
        const polluted = Object.prototype.flowStudioPolluted;
        delete Object.prototype.flowStudioPolluted;
        assert.equal(polluted, undefined, 'unsafe mapping polluted Object.prototype');
    }

    assert.ok(rejected || result?.status === 'failed', 'unsafe mapping must be rejected by validation or runtime');
});

test('a simple isolated inline subgraph maps parent input and child output', async () => {
    const child = graph('child-graph', 'calculate', [
        node('calculate', 'transform', {
            condition: '({ answer: Number(context.value) + 1 })',
            next: 'end'
        }),
        node('end', 'end')
    ]);
    const candidate = graph('parent-graph', 'child', [
        node('child', 'subgraph', {
            subgraph: {
                inline: child,
                input: { parentValue: 'value' },
                output: { answer: 'result.answer' },
                isolated: true
            },
            next: 'end'
        }),
        node('end', 'end')
    ]);
    assertValid(child);
    assertValid(candidate);

    const result = await runFlowStudioGraph({ graph: candidate, input: { parentValue: 41, untouched: true } });

    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.finalContext.result.answer, 42);
    assert.equal(result.finalContext.parentValue, 41);
    assert.equal(result.finalContext.untouched, true);
    assert.ok(result.events.some(event => event.nodeId === 'child' && event.detail?.childNodeId === 'calculate'));
});

test('an isolated subgraph without mappings cannot read or leak parent state', async () => {
    const child = graph('isolated-child', 'inspect', [
        node('inspect', 'transform', { condition: '({ sawSecret: context.secret, childOnly: true })', next: 'end' }),
        node('end', 'end')
    ]);
    const candidate = graph('isolated-parent', 'child', [
        node('child', 'subgraph', { subgraph: { inline: child, isolated: true }, next: 'end' }),
        node('end', 'end')
    ]);
    assertValid(candidate);
    const result = await runFlowStudioGraph({ graph: candidate, input: { secret: 'parent-only' } });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.finalContext.secret, 'parent-only');
    assert.equal(result.finalContext.sawSecret, undefined);
    assert.equal(result.finalContext.childOnly, undefined);
});

test('global maxSteps counts every inline and nested subgraph visit in the parent ledger', async () => {
    const leaf = graph('step-leaf', 'work', [
        node('work', 'transform', { condition: '({ leaf: true })', next: 'end' }),
        node('end', 'end')
    ]);
    const middle = graph('step-middle', 'inner', [
        node('inner', 'subgraph', { subgraph: { inline: leaf }, next: 'end' }),
        node('end', 'end')
    ]);
    const candidate = graph('step-parent', 'outer', [
        node('outer', 'subgraph', { subgraph: { inline: middle }, next: 'end' }),
        node('end', 'end')
    ], { budget: { maxSteps: 5 } });
    const result = await runFlowStudioGraph({ graph: candidate });
    assert.equal(result.status, 'failed');
    assert.match(result.error || '', /excedeu 5 passos/i);
    assert.ok(result.visited.includes('outer::inner::work'));
    assert.ok(result.visited.includes('outer::inner::end'));
    assert.equal(entered(result, 'end'), 0, 'the parent end node would be the forbidden sixth visit');
    const checkpoint = result.checkpoints[result.checkpoints.length - 1];
    assert.equal(checkpoint.metadata.globalStepCount, 5);
});

test('Subgraph propagates normalized Gate and Wait interaction envelopes with the child node identity', async () => {
    const child = graph('interaction-child', 'approval', [
        node('approval', 'gate', {
            gate: { kind: 'human', prompt: 'Approve child work?', requireEvidence: false },
            gateDecisions: [{ id: 'approve', label: 'Approve', decision: 'continue', toNodeId: 'wait' }]
        }),
        node('wait', 'wait', { wait: { kind: 'event', eventName: 'child.completed', correlationKey: 'child-42' }, next: 'write' }),
        node('write', 'memory_write', { memoryWrite: { scope: 'agent', scopeId: 'child-agent', storeId: 'child-store', candidatesFrom: 'memoryCandidates' }, next: 'end' }),
        node('end', 'end')
    ]);
    const candidate = graph('interaction-parent', 'child', [
        node('child', 'subgraph', { subgraph: { inline: child }, next: 'end' }),
        node('end', 'end')
    ]);
    const gated = await runFlowStudioGraph({ graph: candidate });
    assert.equal(gated.status, 'waiting', gated.error);
    assert.equal(gated.waiting?.nodeId, 'approval');
    assert.equal(gated.waiting?.detail?.interaction?.type, 'gate');
    assert.equal(gated.waiting?.detail?.interaction?.graphId, 'interaction-child');
    assert.equal(gated.waiting?.detail?.interaction?.label, 'Approve child work?');
    assert.equal(gated.waiting?.detail?.interaction?.decisions?.[0]?.id, 'approve');
    assert.deepEqual(gated.waiting?.detail?.interaction?.memoryWriteTargets, [
        { nodeId: 'write', label: 'write', scope: 'agent', scopeId: 'child-agent', storeId: 'child-store' }
    ]);
    const gateCheckpoint = gated.checkpoints.find(item => item.id === gated.waiting?.checkpointId);

    const waiting = await runFlowStudioGraph({ graph: candidate, resume: { checkpoint: gateCheckpoint, gate: { decisionId: 'approve' } } });
    assert.equal(waiting.status, 'waiting', waiting.error);
    assert.equal(waiting.waiting?.nodeId, 'wait');
    assert.equal(waiting.waiting?.detail?.interaction?.type, 'wait');
    assert.equal(waiting.waiting?.detail?.interaction?.graphId, 'interaction-child');
    assert.equal(waiting.waiting?.detail?.interaction?.eventName, 'child.completed');
    assert.equal(waiting.waiting?.detail?.interaction?.correlationKey, 'child-42');
    assert.deepEqual(waiting.waiting?.detail?.interaction?.memoryWriteTargets, [
        { nodeId: 'write', label: 'write', scope: 'agent', scopeId: 'child-agent', storeId: 'child-store' }
    ]);
});

test('temporal Wait interactions expose their deadline instead of asking for an event signal', async t => {
    await t.test('duration', async () => {
        const started = Date.now();
        const candidate = graph('duration-interaction', 'wait', [
            node('wait', 'wait', { wait: { kind: 'duration', durationMs: 5_000 }, next: 'end' }),
            node('end', 'end')
        ]);
        const result = await runFlowStudioGraph({ graph: candidate });
        const interaction = result.waiting?.detail?.interaction;
        assert.equal(result.status, 'waiting');
        assert.equal(interaction?.kind, 'duration');
        assert.equal(interaction?.durationMs, 5_000);
        assert.equal(interaction?.eventName, undefined);
        assert.ok(Date.parse(interaction?.dueAt) >= started + 4_900);
    });

    await t.test('until', async () => {
        const until = new Date(Date.now() + 60_000).toISOString();
        const candidate = graph('until-interaction', 'wait', [
            node('wait', 'wait', { wait: { kind: 'until', until }, next: 'end' }),
            node('end', 'end')
        ]);
        const result = await runFlowStudioGraph({ graph: candidate });
        const interaction = result.waiting?.detail?.interaction;
        assert.equal(result.status, 'waiting');
        assert.equal(interaction?.kind, 'until');
        assert.equal(interaction?.until, until);
        assert.equal(interaction?.dueAt, until);
        assert.equal(interaction?.eventName, undefined);
    });

    await t.test('invalid until is rejected before execution', () => {
        const candidate = graph('invalid-until', 'wait', [
            node('wait', 'wait', { wait: { kind: 'until', until: 'not-a-date' }, next: 'end' }),
            node('end', 'end')
        ]);
        const validation = validateFlowStudioGraph(candidate);
        assert.equal(validation.valid, false);
        assert.ok(validation.errors.some(issue => issue.code === 'wait.until'));
    });
});

test('Gate decisions require an explicit action in the GraphSpec contract', () => {
    const candidate = graph('decision-action-required', 'gate', [
        node('gate', 'gate', {
            gate: { kind: 'human', prompt: 'Choose' },
            gateDecisions: [{ id: 'ambiguous', label: 'Looks like continue', toNodeId: 'end' }]
        }),
        node('end', 'end')
    ]);
    const validation = validateFlowStudioGraph(candidate);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some(issue => /decision/i.test(issue.path) || /decision/i.test(issue.message)));
});

test('a resumed Subgraph rebases parent remaining budgets into the child cumulative coordinate', async () => {
    const child = graph('budget-coordinate-child', 'approval', [
        node('approval', 'gate', {
            gate: { kind: 'human', prompt: 'Continue the child?' },
            gateDecisions: [{ id: 'continue', label: 'Continue', decision: 'continue', toNodeId: 'end' }]
        }),
        node('end', 'end')
    ], { budget: { maxDurationMs: 2_000, maxCostUsd: 20, maxInputTokens: 2_000, maxOutputTokens: 2_000 } });
    const candidate = graph('budget-coordinate-parent', 'child', [
        node('child', 'subgraph', { subgraph: { inline: child }, next: 'end' }),
        node('end', 'end')
    ], { budget: { maxDurationMs: 1_500, maxCostUsd: 10, maxInputTokens: 1_000, maxOutputTokens: 1_000 } });

    const suspended = await runFlowStudioGraph({ graph: candidate });
    const parentCheckpoint = suspended.checkpoints.find(item => item.id === suspended.waiting?.checkpointId);
    assert.ok(parentCheckpoint);
    const childCheckpoint = parentCheckpoint.metadata.subgraphCheckpoint;
    assert.ok(childCheckpoint);
    Object.assign(parentCheckpoint.usage, { durationMs: 900, costUsd: 9, inputTokens: 900, outputTokens: 900 });
    Object.assign(childCheckpoint.usage, { durationMs: 800, costUsd: 4, inputTokens: 400, outputTokens: 400 });

    const resumed = await runFlowStudioGraph({
        graph: candidate,
        resume: { checkpoint: parentCheckpoint, gate: { decisionId: 'continue' } }
    });
    assert.equal(resumed.status, 'completed', resumed.error);
    assert.ok(resumed.usage.durationMs >= 900 && resumed.usage.durationMs < 1_500);
    assert.equal(resumed.usage.costUsd, 9);
    assert.equal(resumed.usage.inputTokens, 900);
    assert.equal(resumed.usage.outputTokens, 900);
});

test('Subgraph keeps a stable logical digest and preserves a nested Wait across Gate and signal resumes', async () => {
    const child = graph('resumable-budget-child', 'approval', [
        node('approval', 'gate', {
            gate: { kind: 'human', prompt: 'Approve the bounded child?' },
            gateDecisions: [{ id: 'approve', label: 'Approve', decision: 'continue', toNodeId: 'wait' }]
        }),
        node('wait', 'wait', { wait: { kind: 'event', eventName: 'child.ready', correlationKey: 'bounded-42' }, next: 'done' }),
        node('done', 'transform', { condition: '({ childCompleted: true })', next: 'end' }),
        node('end', 'end')
    ], { budget: { maxDurationMs: 5_000 } });
    const candidate = graph('resumable-budget-parent', 'prepare', [
        node('prepare', 'agent', { prompt: 'prepare', runner: { providerId: 'delay' }, next: 'child' }),
        node('child', 'subgraph', { subgraph: { inline: child }, next: 'end' }),
        node('end', 'end')
    ], { budget: { maxDurationMs: 1_500 } });
    const runnerAdapters = {
        delay: async () => {
            await new Promise(resolve => setTimeout(resolve, 35));
            return { output: { prepared: true } };
        }
    };
    const run = resume => runFlowStudioGraph({ graph: candidate, runnerAdapters, ...(resume ? { resume } : {}) });
    const boundaryCheckpoint = result => result.checkpoints.find(item => item.id === result.waiting?.checkpointId);

    const gated = await run();
    assert.equal(gated.status, 'waiting', gated.error);
    const gateBoundary = boundaryCheckpoint(gated);
    const childGateCheckpoint = gateBoundary?.metadata?.subgraphCheckpoint;
    assert.equal(childGateCheckpoint?.reason, 'gate');

    const waiting = await run({ checkpoint: gateBoundary, gate: { decisionId: 'approve' } });
    assert.equal(waiting.status, 'waiting', waiting.error);
    assert.equal(waiting.waiting?.nodeId, 'wait');
    const waitBoundary = boundaryCheckpoint(waiting);
    const childWaitCheckpoint = waitBoundary?.metadata?.subgraphCheckpoint;
    assert.equal(childWaitCheckpoint?.reason, 'wait');
    assert.equal(childWaitCheckpoint?.graphDigest, childGateCheckpoint?.graphDigest, 'the logical child digest must ignore its shrinking runtime budget');
    await assert.rejects(
        () => runFlowStudioGraph({ graph: child, resume: { checkpoint: childWaitCheckpoint, signal: { eventName: 'child.ready', correlationKey: 'bounded-42' } } }),
        /Checkpoint incompatível/,
        'a nested checkpoint must remain bound to its parent restriction chain'
    );

    const stillWaiting = await run({
        checkpoint: waitBoundary,
        signal: { eventName: 'child.ready', correlationKey: 'wrong-correlation' }
    });
    assert.equal(stillWaiting.status, 'waiting', stillWaiting.error);
    const preservedBoundary = boundaryCheckpoint(stillWaiting);
    const preservedChildWait = preservedBoundary?.metadata?.subgraphCheckpoint;
    assert.notEqual(preservedChildWait?.id, childWaitCheckpoint?.id, 'a re-suspended child must advance its authoritative checkpoint');
    assert.equal(preservedChildWait?.graphDigest, childWaitCheckpoint?.graphDigest);
    assert.deepEqual(preservedChildWait?.context, childWaitCheckpoint?.context);
    assert.ok(preservedChildWait?.usage?.durationMs >= childWaitCheckpoint?.usage?.durationMs);

    const completed = await run({
        checkpoint: preservedBoundary,
        signal: { eventName: 'child.ready', correlationKey: 'bounded-42', payload: { ok: true } }
    });
    assert.equal(completed.status, 'completed', completed.error);
    assert.equal(completed.finalContext.childCompleted, true);
    assert.equal(entered(completed, 'end'), 1);
});

test('a Subgraph Gate then Wait resumes inside Fork and Loop without restarting child work', async t => {
    const childGraph = suffix => graph(`structured-subgraph-child-${suffix}`, 'prepare', [
        node('prepare', 'agent', { prompt: 'Prepare once', runner: { providerId: 'test' }, next: 'approval' }),
        node('approval', 'gate', {
            gate: { kind: 'human', prompt: 'Approve child?' },
            gateDecisions: [{ id: 'approve', label: 'Approve', decision: 'continue', toNodeId: 'event' }]
        }),
        node('event', 'wait', { wait: { kind: 'event', eventName: `child.${suffix}.ready`, correlationKey: suffix }, next: 'done' }),
        node('done', 'transform', { condition: `({ ${suffix}Completed: true })`, next: 'end' }),
        node('end', 'end')
    ]);
    const cases = [
        {
            name: 'Fork', suffix: 'fork',
            parent: child => graph('subgraph-inside-fork', 'fork', [
                node('fork', 'fork', { fork: { branches: ['child', 'sibling'], join: 'join', maxConcurrency: 2 } }),
                node('child', 'subgraph', { subgraph: { inline: child }, next: 'join' }),
                node('sibling', 'transform', { condition: '({ siblingCompleted: true })', next: 'join' }),
                node('join', 'join', { join: { strategy: 'all' }, next: 'end' }),
                node('end', 'end')
            ])
        },
        {
            name: 'Loop', suffix: 'loop',
            parent: child => graph('subgraph-inside-loop', 'loop', [
                node('loop', 'loop', { loop: { bodyStart: 'child', condition: 'iteration < 1', maxIterations: 1 }, next: 'end' }),
                node('child', 'subgraph', { subgraph: { inline: child }, next: 'loop' }),
                node('end', 'end')
            ])
        }
    ];

    for (const spec of cases) await t.test(spec.name, async () => {
        const candidate = spec.parent(childGraph(spec.suffix));
        let childCalls = 0;
        const request = resume => runFlowStudioGraph({
            graph: candidate,
            runnerAdapters: { test: async () => { childCalls += 1; return { output: { prepared: true } }; } },
            ...(resume ? { resume } : {})
        });
        const waitingCheckpoint = result => result.checkpoints.find(item => item.id === result.waiting?.checkpointId);

        const gated = await request();
        assert.equal(gated.status, 'waiting', gated.error);
        assert.equal(gated.waiting?.kind, 'gate');
        const gateCheckpoint = waitingCheckpoint(gated);
        assert.ok(gateCheckpoint);

        const waiting = await request({ checkpoint: gateCheckpoint, gate: { decisionId: 'approve' } });
        assert.equal(waiting.status, 'waiting', waiting.error);
        assert.equal(waiting.waiting?.kind, 'wait');
        const waitCheckpoint = waitingCheckpoint(waiting);
        assert.ok(waitCheckpoint);

        const completed = await request({ checkpoint: waitCheckpoint, signal: { eventName: `child.${spec.suffix}.ready`, correlationKey: spec.suffix } });
        assert.equal(completed.status, 'completed', completed.error);
        assert.equal(completed.finalContext[`${spec.suffix}Completed`], true);
        assert.equal(childCalls, 1, 'child work before the Gate must not restart across structured resumes');
    });
});

test('a resumed top-level Subgraph does not leak its child checkpoint into a later Subgraph', async () => {
    const first = graph('sequential-child-a', 'approval', [
        node('approval', 'gate', {
            gate: { kind: 'human', prompt: 'Continue to child B?' },
            gateDecisions: [{ id: 'approve', label: 'Approve', decision: 'continue', toNodeId: 'end' }]
        }),
        node('end', 'end')
    ]);
    const second = graph('sequential-child-b', 'work', [
        node('work', 'transform', { condition: '({ secondChildCompleted: true })', next: 'end' }),
        node('end', 'end')
    ]);
    const candidate = graph('sequential-subgraphs', 'first', [
        node('first', 'subgraph', { subgraph: { inline: first }, next: 'second' }),
        node('second', 'subgraph', { subgraph: { inline: second }, next: 'end' }),
        node('end', 'end')
    ]);

    const gated = await runFlowStudioGraph({ graph: candidate });
    const checkpoint = gated.checkpoints.find(item => item.id === gated.waiting?.checkpointId);
    assert.ok(checkpoint);
    const completed = await runFlowStudioGraph({ graph: candidate, resume: { checkpoint, gate: { decisionId: 'approve' } } });
    assert.equal(completed.status, 'completed', completed.error);
    assert.equal(completed.finalContext.secondChildCompleted, true);
});

test('a top-level Subgraph resume boundary is consumed once when a cycle revisits the same node', async () => {
    const child = graph('cyclic-child', 'prepare', [
        node('prepare', 'agent', { prompt: 'Prepare this visit', runner: { providerId: 'cycle-runner' }, next: 'approval' }),
        node('approval', 'gate', {
            gate: { kind: 'human', prompt: 'Approve this visit?' },
            gateDecisions: [{ id: 'approve', label: 'Approve', decision: 'continue', toNodeId: 'increment' }]
        }),
        node('increment', 'transform', { condition: '({ visits: (context.visits || 0) + 1 })', next: 'end' }),
        node('end', 'end')
    ]);
    const candidate = graph('cyclic-subgraph-resume', 'child', [
        node('child', 'subgraph', { subgraph: { inline: child } }),
        node('route', 'router', { condition: 'context.visits < 2' }),
        node('end', 'end')
    ], {
        edges: [
            { id: 'child-to-route', from: 'child', to: 'route' },
            { id: 'route-to-child', from: 'route', to: 'child', guard: 'context.visits < 2' },
            { id: 'route-to-end', from: 'route', to: 'end', guard: 'context.visits >= 2' }
        ]
    });
    assertValid(candidate);
    let agentCalls = 0;
    const request = resume => runFlowStudioGraph({
        graph: candidate,
        resume,
        runnerAdapters: {
            'cycle-runner': async () => {
                agentCalls += 1;
                return { output: { prepared: true } };
            }
        }
    });

    const first = await request();
    assert.equal(first.status, 'waiting', first.error);
    assert.equal(first.waiting?.nodeId, 'approval');
    assert.equal(agentCalls, 1);
    const firstCheckpoint = first.checkpoints.find(item => item.id === first.waiting?.checkpointId);
    assert.ok(firstCheckpoint);

    const second = await request({ checkpoint: firstCheckpoint, gate: { decisionId: 'approve' } });
    assert.equal(second.status, 'waiting', second.error);
    assert.equal(second.waiting?.nodeId, 'approval');
    assert.equal(second.finalContext.visits, 1);
    assert.equal(agentCalls, 2, 'the second visit must start fresh instead of reusing the first approval');
    const secondCheckpoint = second.checkpoints.find(item => item.id === second.waiting?.checkpointId);
    assert.ok(secondCheckpoint);

    const completed = await request({ checkpoint: secondCheckpoint, gate: { decisionId: 'approve' } });
    assert.equal(completed.status, 'completed', completed.error);
    assert.equal(completed.finalContext.visits, 2);
    assert.equal(agentCalls, 2);
});

test('resuming a waiting Subgraph adds only usage and artifacts produced after its checkpoint', async () => {
    const child = graph('waiting-child', 'before', [
        node('before', 'agent', { prompt: 'before', runner: { providerId: 'child-runner' }, next: 'wait' }),
        node('wait', 'wait', { wait: { kind: 'event', eventName: 'continue-child' }, next: 'after' }),
        node('after', 'agent', { prompt: 'after', runner: { providerId: 'child-runner' }, next: 'end' }),
        node('end', 'end')
    ]);
    const candidate = graph('waiting-parent', 'child', [
        node('child', 'subgraph', { subgraph: { inline: child }, next: 'end' }),
        node('end', 'end')
    ]);
    const adapter = async ({ node }) => ({
        output: { [node.id]: true },
        usage: { costUsd: node.id === 'before' ? 0.4 : 0.5 },
        artifacts: [{ id: `artifact-${node.id}`, nodeId: node.id, kind: 'text', name: node.id, payload: node.id }]
    });
    const first = await runFlowStudioGraph({ graph: candidate, runnerAdapters: { 'child-runner': adapter } });
    assert.equal(first.status, 'waiting');
    assert.equal(first.usage.costUsd, 0.4);
    const checkpoint = first.checkpoints.find(item => item.id === first.waiting?.checkpointId);
    const resumed = await runFlowStudioGraph({
        graph: candidate,
        runnerAdapters: { 'child-runner': adapter },
        resume: { checkpoint, signal: { eventName: 'continue-child' } }
    });
    assert.equal(resumed.status, 'completed', resumed.error);
    assert.equal(resumed.usage.costUsd, 0.9);
    assert.deepEqual(resumed.artifacts.map(item => item.id).sort(), ['artifact-after', 'artifact-before']);
});

test('node and graph cost budgets independently stop an over-budget agent', async t => {
    const adapter = async () => ({
        output: { answer: 'expensive' },
        usage: { inputTokens: 100, outputTokens: 25, costUsd: 1 }
    });

    await t.test('node budget', async () => {
        const candidate = graph('node-budget', 'agent', [
            node('agent', 'agent', {
                prompt: 'Work.',
                provider: { providerId: 'budget-provider' },
                budget: { maxCostUsd: 0.5 },
                next: 'end'
            }),
            node('end', 'end')
        ], {
            budget: { maxCostUsd: 10 }
        });
        assertValid(candidate);

        const result = await runFlowStudioGraph({
            graph: candidate,
            providerAdapters: { 'budget-provider': adapter }
        });
        assert.equal(result.status, 'failed');
        assert.match(result.error || '', /Nó "agent" excedeu custo/i);
        assert.equal(result.usage.costUsd, 1);
        assert.equal(entered(result, 'end'), 0);
    });

    await t.test('graph budget', async () => {
        const candidate = graph('graph-budget', 'agent', [
            node('agent', 'agent', {
                prompt: 'Work.',
                provider: { providerId: 'budget-provider' },
                next: 'end'
            }),
            node('end', 'end')
        ], {
            budget: { maxCostUsd: 0.5 }
        });
        assertValid(candidate);

        const result = await runFlowStudioGraph({
            graph: candidate,
            providerAdapters: { 'budget-provider': adapter }
        });
        assert.equal(result.status, 'failed');
        assert.match(result.error || '', /execução excedeu o orçamento/i);
        assert.equal(result.usage.costUsd, 1);
        assert.equal(entered(result, 'end'), 0);
    });
});

test('a runner session returned by an agent is reused on the next loop iteration', async () => {
    const candidate = graph('runner-session-loop', 'loop', [
        node('loop', 'loop', { loop: { bodyStart: 'agent', condition: 'iteration < 2', maxIterations: 2 }, next: 'end' }),
        node('agent', 'agent', { prompt: 'Continue the same task.', runner: { providerId: 'session-runner' }, next: 'loop' }),
        node('end', 'end')
    ]);
    const received = [];
    const result = await runFlowStudioGraph({
        graph: candidate,
        runnerAdapters: {
            'session-runner': async ({ runner }) => {
                received.push(runner.sessionId);
                return { output: { iterationComplete: true }, sessionId: runner.sessionId || 'session-123' };
            }
        }
    });
    assert.equal(result.status, 'completed', result.error);
    assert.deepEqual(received, [undefined, 'session-123']);
    const finalCheckpoint = result.checkpoints[result.checkpoints.length - 1];
    assert.deepEqual(Object.values(finalCheckpoint.metadata.runnerSessions.agent), ['session-123']);
});

test('fallback sessions stay bound to the runner that created them', async () => {
    const candidate = graph('fallback-session-loop', 'loop', [
        node('loop', 'loop', { loop: { bodyStart: 'agent', condition: 'iteration < 2', maxIterations: 2 }, next: 'end' }),
        node('agent', 'agent', { prompt: 'continue', runner: { providerId: 'primary', fallbacks: [{ providerId: 'fallback' }] }, next: 'loop' }),
        node('end', 'end')
    ]);
    const primarySessions = [];
    const fallbackSessions = [];
    const result = await runFlowStudioGraph({
        graph: candidate,
        runnerAdapters: {
            primary: async ({ runner }) => { primarySessions.push(runner.sessionId); throw new Error('primary unavailable'); },
            fallback: async ({ runner }) => { fallbackSessions.push(runner.sessionId); return { output: {}, sessionId: runner.sessionId || 'fallback-session' }; }
        }
    });
    assert.equal(result.status, 'completed', result.error);
    assert.deepEqual(primarySessions, [undefined, undefined]);
    assert.deepEqual(fallbackSessions, [undefined, 'fallback-session']);
});

test('model profile defaults are materialized into the per-node runner binding', async () => {
    const candidate = graph('profile-defaults', 'agent', [
        node('agent', 'agent', { prompt: 'work', runner: { providerId: 'provider', profileId: 'profile' }, next: 'end' }),
        node('end', 'end')
    ], { modelProfiles: [{ id: 'profile', name: 'Profile', providerId: 'provider', runnerId: 'runner', modelId: 'provider/model', reasonDefault: 'high', serviceTierDefault: 'fast' }] });
    let received;
    const result = await runFlowStudioGraph({
        graph: candidate,
        runnerAdapters: { runner: async args => { received = args.runner; return { output: {} }; } }
    });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(received.runnerId, 'runner');
    assert.equal(received.modelId, 'provider/model');
    assert.equal(received.reasoningEffort, 'high');
    assert.equal(received.serviceTier, 'fast');
});

test('fork validation detects writes made deeper inside different branches', () => {
    const candidate = graph('deep-branch-conflict', 'fork', [
        node('fork', 'fork', { fork: { branches: ['a-start', 'b-start'], join: 'join' } }),
        node('a-start', 'transform', { condition: '({})', next: 'a-write' }),
        node('a-write', 'transform', { condition: '({ value: 1 })', outputs: { value: 'shared.a' }, next: 'join' }),
        node('b-start', 'transform', { condition: '({})', next: 'b-write' }),
        node('b-write', 'transform', { condition: '({ value: 2 })', outputs: { value: 'shared.b' }, next: 'join' }),
        node('join', 'join', { join: { strategy: 'all' }, next: 'end' }),
        node('end', 'end')
    ], { edges: [{ from: 'a-write', to: 'join' }, { from: 'b-write', to: 'join' }] });
    const validation = validateFlowStudioGraph(candidate);
    assert.ok(validation.warnings.some(issue => issue.code === 'state.concurrent-write'), JSON.stringify(validation, null, 2));
});

test('join any ignores a waiting branch once cancelRemaining reaches its threshold', async () => {
    const candidate = graph('fork-any-wait', 'fork', [
        node('fork', 'fork', { fork: { branches: ['wait', 'fast'], join: 'join', maxConcurrency: 2 } }),
        node('wait', 'wait', { wait: { kind: 'event', eventName: 'never' }, next: 'join' }),
        node('fast', 'transform', { condition: '({ winner: "fast" })', next: 'join' }),
        node('join', 'join', { join: { strategy: 'any', cancelRemaining: true }, next: 'end' }),
        node('end', 'end')
    ], { edges: [{ from: 'wait', to: 'join' }, { from: 'fast', to: 'join' }] });
    assertValid(candidate);
    const result = await runFlowStudioGraph({ graph: candidate });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.finalContext.winner, 'fast');
});

test('a wait inside nested forks resumes the exact nested continuation without rerunning siblings', async () => {
    const candidate = graph('nested-fork-wait', 'outer-fork', [
        node('outer-fork', 'fork', { fork: { branches: ['inner-fork', 'outer-sibling'], join: 'outer-join', maxConcurrency: 2 } }),
        node('outer-sibling', 'transform', { condition: '({ outerSibling: true })', next: 'outer-join' }),
        node('inner-fork', 'fork', { fork: { branches: ['wait', 'inner-sibling'], join: 'inner-join', maxConcurrency: 2 } }),
        node('wait', 'wait', { wait: { kind: 'event', eventName: 'continue', correlationKey: 'nested' }, next: 'after-wait' }),
        node('after-wait', 'transform', { condition: '({ nestedResumed: true })', next: 'inner-join' }),
        node('inner-sibling', 'agent', { prompt: 'count', runner: { providerId: 'counter' }, next: 'inner-join' }),
        node('inner-join', 'join', { join: { strategy: 'all' }, next: 'outer-join' }),
        node('outer-join', 'join', { join: { strategy: 'all' }, next: 'end' }),
        node('end', 'end')
    ], { edges: [
        { from: 'outer-sibling', to: 'outer-join' }, { from: 'after-wait', to: 'inner-join' },
        { from: 'inner-sibling', to: 'inner-join' }, { from: 'inner-join', to: 'outer-join' }
    ] });
    assertValid(candidate);
    let siblingCalls = 0;
    const adapters = { counter: async () => { siblingCalls += 1; return { output: { innerSibling: true } }; } };
    const suspended = await runFlowStudioGraph({ graph: candidate, runnerAdapters: adapters });
    assert.equal(suspended.status, 'waiting');
    const checkpoint = suspended.checkpoints.find(item => item.id === suspended.waiting?.checkpointId);
    const resumed = await runFlowStudioGraph({
        graph: candidate,
        runnerAdapters: adapters,
        resume: { checkpoint, signal: { eventName: 'continue', correlationKey: 'nested' } }
    });
    assert.equal(resumed.status, 'completed', resumed.error);
    assert.equal(resumed.finalContext.nestedResumed, true);
    assert.equal(resumed.finalContext.innerSibling, true);
    assert.equal(resumed.finalContext.outerSibling, true);
    assert.equal(siblingCalls, 1);
});

test('Action respects maxParallelism and cumulative node cost', async () => {
    const candidate = graph('action-budget', 'tools', [
        node('tools', 'action', {
            tools: [
                { id: 'one', name: 'one', command: 'one', effect: 'read' },
                { id: 'two', name: 'two', command: 'two', effect: 'read' }
            ],
            budget: { maxParallelism: 1, maxCostUsd: 1 },
            next: 'end'
        }),
        node('end', 'end')
    ], { permissions: { allow: ['tool:read'] } });
    assertValid(candidate);
    let active = 0;
    let maxActive = 0;
    const result = await runFlowStudioGraph({
        graph: candidate,
        toolAdapters: { '*': async ({ tool }) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setTimeout(resolve, 8));
            active -= 1;
            return { output: { [tool.id]: true }, usage: { costUsd: 0.6 } };
        } }
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error || '', /Nó "tools" excedeu custo/i);
    assert.equal(maxActive, 1);
    assert.equal(result.usage.costUsd, 1.2);
});

test('node budgets accumulate across loop visits', async () => {
    const candidate = graph('loop-node-budget', 'loop', [
        node('loop', 'loop', { loop: { bodyStart: 'agent', condition: 'iteration < 2', maxIterations: 2 }, next: 'end' }),
        node('agent', 'agent', { prompt: 'work', runner: { providerId: 'costly' }, budget: { maxCostUsd: 1 }, next: 'loop' }),
        node('end', 'end')
    ]);
    const result = await runFlowStudioGraph({
        graph: candidate,
        runnerAdapters: { costly: async () => ({ output: {}, usage: { costUsd: 0.6 } }) }
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error || '', /Nó "agent" excedeu custo/i);
    assert.equal(result.usage.costUsd, 1.2);
});

test('a Wait inside a Loop preserves the iteration continuation across multiple resumes', async () => {
    const candidate = graph('loop-wait-resume', 'loop', [
        node('loop', 'loop', { loop: { bodyStart: 'increment', condition: 'iteration < 2', maxIterations: 2 }, next: 'end' }),
        node('increment', 'transform', { condition: '({ count: (context.count || 0) + 1 })', next: 'wait' }),
        node('wait', 'wait', { wait: { kind: 'event', eventName: 'tick' }, next: 'loop' }),
        node('end', 'end')
    ]);
    const first = await runFlowStudioGraph({ graph: candidate });
    assert.equal(first.status, 'waiting');
    const firstCheckpoint = first.checkpoints.find(item => item.id === first.waiting?.checkpointId);
    const second = await runFlowStudioGraph({ graph: candidate, resume: { checkpoint: firstCheckpoint, signal: { eventName: 'tick' } } });
    assert.equal(second.status, 'waiting');
    const secondCheckpoint = second.checkpoints.find(item => item.id === second.waiting?.checkpointId);
    const third = await runFlowStudioGraph({ graph: candidate, resume: { checkpoint: secondCheckpoint, signal: { eventName: 'tick' } } });
    assert.equal(third.status, 'completed', third.error);
    assert.equal(third.finalContext.count, 2);
});

test('a composite Gate inside a Loop preserves multiple human approvals and their memory receipt', async () => {
    const memoryCandidate = { id: 'loop-memory', revision: 1, status: 'candidate', value: { decision: 'persist' } };
    const candidate = graph('loop-composite-gate', 'loop', [
        node('loop', 'loop', { loop: { bodyStart: 'gate', condition: 'iteration < 1', maxIterations: 1 }, next: 'end' }),
        node('gate', 'gate', {
            gate: { kind: 'composite', combine: 'all', children: [
                { kind: 'human', prompt: 'Owner approval' },
                { kind: 'human', prompt: 'Reviewer approval' },
                { kind: 'deterministic', expression: 'context.ready === true' }
            ] },
            next: 'write'
        }),
        node('write', 'memory_write', { memoryWrite: { scope: 'workspace', storeId: 'loop-store', candidatesFrom: 'memoryCandidates', onEmpty: 'fail' }, next: 'loop' }),
        node('end', 'end')
    ]);
    const approval = {
        id: memoryCandidate.id,
        revision: memoryCandidate.revision,
        scope: 'workspace',
        storeId: 'loop-store',
        graphId: candidate.id,
        nodeId: 'write',
        candidateDigest: flowStudioMemoryCandidateDigest(memoryCandidate, 'workspace')
    };
    let writes = 0;
    const base = {
        graph: candidate,
        input: { ready: true, memoryCandidates: [memoryCandidate] },
        memoryAdapter: {
            loadContext: async () => ({ pack: {} }),
            writeCandidate: async args => {
                writes += 1;
                assert.equal(args.approval.nodeId, 'write');
                assert.equal(args.approval.approvedBy, 'human-gate');
                return { candidateId: args.candidate.id, revision: args.candidate.revision, scope: args.candidate.scope, storeId: args.config.storeId, status: 'written' };
            }
        }
    };
    const first = await runFlowStudioGraph(base);
    assert.equal(first.status, 'waiting', first.error);
    assert.equal(first.waiting?.detail?.pendingHumanPath, 'root.0');
    const firstCheckpoint = first.checkpoints.find(item => item.id === first.waiting?.checkpointId);
    assert.ok(firstCheckpoint?.metadata?.loopState);

    const second = await runFlowStudioGraph({ ...base, resume: { checkpoint: firstCheckpoint, gate: { decisionId: 'continue', memoryApprovals: [approval] } } });
    assert.equal(second.status, 'waiting', second.error);
    assert.equal(second.waiting?.detail?.pendingHumanPath, 'root.1');
    const secondCheckpoint = second.checkpoints.find(item => item.id === second.waiting?.checkpointId);
    assert.ok(secondCheckpoint?.metadata?.loopState?.checkpoint?.metadata?.compositeGate?.humanResults?.['root.0']);

    const completed = await runFlowStudioGraph({ ...base, resume: { checkpoint: secondCheckpoint, gate: { decisionId: 'continue' } } });
    assert.equal(completed.status, 'completed', completed.error);
    assert.equal(writes, 1);
    assert.equal(completed.finalContext.memory.writes['loop-memory'].status, 'written');
});

test('manual validation applies the complete schema and recursively validates nested semantics', () => {
    const invalidEnums = graph('invalid-enums', 'join', [
        node('join', 'join', { join: { strategy: 'not-a-strategy' }, next: 'end' }),
        node('end', 'end')
    ]);
    assert.equal(validateFlowStudioGraph(invalidEnums).valid, false);

    const invalidChild = graph('invalid-child', 'missing', [node('end', 'end')]);
    const parent = graph('invalid-parent', 'child', [
        node('child', 'subgraph', { subgraph: { inline: invalidChild }, next: 'end' }),
        node('end', 'end')
    ]);
    const validation = validateFlowStudioGraph(parent);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some(issue => issue.path.includes('subgraph/inline') && issue.code === 'graph.start.unknown'));
});

test('global maxDurationMs bounds a slow adapter instead of waiting for it to finish', async () => {
    const candidate = graph('hard-duration', 'agent', [
        node('agent', 'agent', { prompt: 'slow', runner: { providerId: 'slow' }, next: 'end' }),
        node('end', 'end')
    ], { budget: { maxDurationMs: 20 } });
    const started = Date.now();
    const result = await runFlowStudioGraph({
        graph: candidate,
        runnerAdapters: { slow: async () => { await new Promise(resolve => setTimeout(resolve, 150)); return { output: {} }; } }
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error || '', /Timeout|limite de duração/i);
    assert.ok(Date.now() - started < 100, `elapsed=${Date.now() - started}`);
});

test('maxDurationMs accumulates active execution across Gate resumes without charging human wait time', async () => {
    const candidate = graph('active-duration-across-resume', 'first', [
        node('first', 'agent', { prompt: 'first segment', runner: { providerId: 'timed' }, next: 'approval' }),
        node('approval', 'gate', {
            gate: { kind: 'human', prompt: 'Continue?' },
            gateDecisions: [{ id: 'continue', label: 'Continue', decision: 'continue', toNodeId: 'second' }]
        }),
        node('second', 'agent', { prompt: 'second segment', runner: { providerId: 'timed' }, next: 'end' }),
        node('end', 'end')
    ], { budget: { maxDurationMs: 60, maxSteps: 10 } });
    let calls = 0;
    const timed = async () => {
        calls += 1;
        await new Promise(resolve => setTimeout(resolve, 35));
        return { output: { [`segment${calls}`]: true } };
    };

    const suspended = await runFlowStudioGraph({ graph: candidate, runnerAdapters: { timed } });
    assert.equal(suspended.status, 'waiting', suspended.error);
    const checkpoint = suspended.checkpoints.find(item => item.id === suspended.waiting?.checkpointId);
    assert.ok(checkpoint);
    assert.ok(checkpoint.usage.durationMs >= 30, `first active segment=${checkpoint.usage.durationMs}ms`);

    await new Promise(resolve => setTimeout(resolve, 180));
    const resumed = await runFlowStudioGraph({
        graph: candidate,
        runnerAdapters: { timed },
        resume: { checkpoint, gate: { decisionId: 'continue' } }
    });
    assert.equal(resumed.status, 'failed');
    assert.match(resumed.error || '', /Timeout|limite de duração/i);
    assert.equal(calls, 2, 'the second segment must start and exhaust only the remaining active budget');
    assert.ok(resumed.usage.durationMs >= 60, `accumulated active duration=${resumed.usage.durationMs}ms`);
    assert.ok(resumed.usage.durationMs < 170, `human wait leaked into active duration: ${resumed.usage.durationMs}ms`);
});

test('unresolved Wait and Gate resumes persist successor checkpoints and cumulative active duration', async () => {
    const scenarios = [
        {
            label: 'Wait',
            candidate: graph('resuspend-duration-wait', 'wait', [
                node('wait', 'wait', { wait: { kind: 'event', eventName: 'ready', timeoutMs: 60_000, onTimeout: 'fail' }, next: 'end' }),
                node('end', 'end')
            ], { budget: { maxDurationMs: 50 } }),
            resume: checkpoint => ({ checkpoint, signal: { eventName: 'not-ready' } })
        },
        {
            label: 'Gate',
            candidate: graph('resuspend-duration-gate', 'gate', [
                node('gate', 'gate', {
                    gate: { kind: 'human', prompt: 'Continue?' },
                    gateDecisions: [{ id: 'continue', label: 'Continue', decision: 'continue', toNodeId: 'end' }]
                }),
                node('end', 'end')
            ], { budget: { maxDurationMs: 50 } }),
            resume: checkpoint => ({ checkpoint })
        }
    ];
    const burnActiveResumeTime = event => {
        if (event.kind !== 'run.resumed') return;
        const until = Date.now() + 30;
        while (Date.now() < until) { /* intentional synchronous host work */ }
    };

    for (const scenario of scenarios) {
        const initial = await runFlowStudioGraph({ graph: scenario.candidate });
        assert.equal(initial.status, 'waiting', `${scenario.label}: ${initial.error || ''}`);
        const source = initial.checkpoints.find(item => item.id === initial.waiting?.checkpointId);
        assert.ok(source, `${scenario.label}: missing initial checkpoint`);

        const resuspended = await runFlowStudioGraph({
            graph: scenario.candidate,
            resume: scenario.resume(source),
            onEvent: burnActiveResumeTime
        });
        assert.equal(resuspended.status, 'waiting', `${scenario.label}: ${resuspended.error || ''}`);
        assert.notEqual(resuspended.waiting?.checkpointId, source.id, `${scenario.label}: checkpoint must advance`);
        const successor = resuspended.checkpoints.find(item => item.id === resuspended.waiting?.checkpointId);
        assert.ok(successor, `${scenario.label}: missing successor checkpoint`);
        assert.ok(successor.usage.durationMs > source.usage.durationMs, `${scenario.label}: active duration did not advance`);
        assert.deepEqual(successor.context, source.context, `${scenario.label}: context changed while unresolved`);
        assert.equal(successor.metadata.dueAt, source.metadata.dueAt, `${scenario.label}: deadline changed while unresolved`);

        const exhausted = await runFlowStudioGraph({
            graph: scenario.candidate,
            resume: scenario.resume(successor),
            onEvent: burnActiveResumeTime
        });
        assert.equal(exhausted.status, 'failed', `${scenario.label}: repeated polling bypassed maxDurationMs`);
        assert.match(exhausted.error || '', /limite de duração/i, scenario.label);
    }
});

test('runtime fails closed on output, context, artifact, event, and checkpoint growth limits', async t => {
    await t.test('node output bytes', async () => {
        const candidate = graph('limit-output', 'agent', [node('agent', 'agent', { prompt: 'large', runner: { providerId: 'large' }, next: 'end' }), node('end', 'end')]);
        const result = await runFlowStudioGraph({ graph: candidate, runnerAdapters: { large: async () => ({ output: { value: 'x'.repeat(FLOW_STUDIO_MAX_NODE_OUTPUT_BYTES + 1) } }) } });
        assert.equal(result.status, 'failed');
        assert.match(result.error || '', /Saída.*excedeu/i);
    });

    await t.test('context bytes', async () => {
        const candidate = graph('limit-context', 'end', [node('end', 'end')]);
        const result = await runFlowStudioGraph({ graph: candidate, input: { value: 'x'.repeat(FLOW_STUDIO_MAX_CONTEXT_BYTES + 1) } });
        assert.equal(result.status, 'failed');
        assert.match(result.error || '', /Contexto.*excedeu/i);
    });

    await t.test('oversized failure context produces an explicit non-replayable checkpoint', async () => {
        const candidate = graph('limit-failure-checkpoint-context', 'approval', [
            node('approval', 'gate', {
                gate: { kind: 'human', prompt: 'Continue?' },
                gateDecisions: [{ id: 'continue', label: 'Continue', decision: 'continue', toNodeId: 'end' }]
            }),
            node('end', 'end')
        ]);
        const suspended = await runFlowStudioGraph({
            graph: candidate,
            input: { existing: 'x'.repeat(FLOW_STUDIO_MAX_CONTEXT_BYTES - 4_096) }
        });
        assert.equal(suspended.status, 'waiting', suspended.error);
        const resumable = suspended.checkpoints.find(item => item.id === suspended.waiting?.checkpointId);
        assert.ok(resumable);
        const result = await runFlowStudioGraph({
            graph: candidate,
            resume: {
                checkpoint: resumable,
                gate: { decisionId: 'continue' },
                signal: { oversized: 'y'.repeat(8_192) }
            }
        });
        assert.equal(result.status, 'failed');
        assert.match(result.error || '', /Contexto.*excedeu/i);
        const failure = result.checkpoints.find(item => item.reason === 'failure' && item.metadata.replayable === false);
        assert.ok(failure, 'the terminal failure receipt must retain a checkpoint');
        assert.equal(Object.keys(failure.context).length, 0);
        assert.equal(failure.metadata.replayable, false);
        assert.match(failure.metadata.replayBlockedReason || '', /contexto excedeu.*snapshot foi omitido.*início/i);
        await assert.rejects(
            runFlowStudioGraph({ graph: candidate, resume: { checkpoint: failure } }),
            /contexto excedeu.*snapshot foi omitido/i
        );
    });

    await t.test('artifact bytes', async () => {
        const candidate = graph('limit-artifact', 'agent', [node('agent', 'agent', { prompt: 'artifact', runner: { providerId: 'artifact' }, next: 'end' }), node('end', 'end')]);
        const result = await runFlowStudioGraph({ graph: candidate, runnerAdapters: { artifact: async () => ({
            output: {}, artifacts: [{ id: 'huge', nodeId: 'agent', kind: 'text', name: 'huge.txt', payload: 'x'.repeat(FLOW_STUDIO_MAX_ARTIFACT_BYTES + 1) }]
        }) } });
        assert.equal(result.status, 'failed');
        assert.match(result.error || '', /Artefato.*excedeu/i);
    });

    await t.test('event count', async () => {
        const candidate = graph('limit-events', 'agent', [node('agent', 'agent', { prompt: 'events', runner: { providerId: 'events' }, next: 'end' }), node('end', 'end')]);
        const result = await runFlowStudioGraph({ graph: candidate, runnerAdapters: { events: async args => {
            for (let index = 0; index <= FLOW_STUDIO_MAX_EVENTS; index += 1) args.onEvent({ kind: 'runner.progress', message: 'x' });
            return { output: {} };
        } } });
        assert.equal(result.status, 'failed');
        assert.match(result.error || '', /limite de eventos/i);
        assert.ok(result.events.length <= FLOW_STUDIO_MAX_EVENTS);
    });

    await t.test('checkpoint count', async () => {
        const iterations = FLOW_STUDIO_MAX_CHECKPOINTS + 10;
        const candidate = graph('limit-checkpoints', 'loop', [
            node('loop', 'loop', { loop: { bodyStart: 'step', condition: `iteration < ${iterations}`, maxIterations: iterations }, budget: { maxSteps: iterations + 10 }, next: 'end' }),
            node('step', 'transform', { condition: '({})', budget: { maxSteps: iterations + 10 }, next: 'loop' }),
            node('end', 'end')
        ], { budget: { maxSteps: iterations + 20 } });
        const result = await runFlowStudioGraph({ graph: candidate, maxSteps: iterations + 20 });
        assert.equal(result.status, 'failed');
        assert.match(result.error || '', /limite de checkpoints/i);
        assert.equal(result.checkpoints.length, FLOW_STUDIO_MAX_CHECKPOINTS);
    });
});

test('adapter rejection is handled and retry delay cannot exceed the global deadline', async () => {
    const candidate = graph('retry-deadline', 'agent', [
        node('agent', 'agent', { prompt: 'fail', runner: { providerId: 'rejecting' }, retries: 1, retryDelayMs: 200, next: 'end' }),
        node('end', 'end')
    ], { budget: { maxDurationMs: 20 } });
    const started = Date.now();
    const result = await runFlowStudioGraph({
        graph: candidate,
        runnerAdapters: { rejecting: async () => { throw new Error('adapter rejected'); } }
    });
    assert.equal(result.status, 'failed');
    assert.ok(Date.now() - started < 100, `elapsed=${Date.now() - started}`);
});

test('branch and loop interior checkpoints are explicitly non-replayable', async () => {
    const forkGraph = graph('safe-checkpoints', 'fork', [
        node('fork', 'fork', { fork: { branches: ['a', 'b'], join: 'join' } }),
        node('a', 'transform', { condition: '({ a: true })', next: 'join' }),
        node('b', 'transform', { condition: '({ b: true })', next: 'join' }),
        node('join', 'join', { join: { strategy: 'all' }, next: 'end' }),
        node('end', 'end')
    ], { edges: [{ from: 'a', to: 'join' }, { from: 'b', to: 'join' }] });
    const original = await runFlowStudioGraph({ graph: forkGraph });
    const interior = original.checkpoints.find(item => item.nodeId === 'a');
    assert.equal(interior.metadata.replayable, false);
    await assert.rejects(() => runFlowStudioGraph({ graph: forkGraph, resume: { checkpoint: interior, forkRun: true } }), /checkpoint interno|snapshot global/i);
    const boundary = original.checkpoints.find(item => item.nodeId === 'fork');
    assert.notEqual(boundary.metadata?.replayable, false);
});

test('checkpoint resume rejects a silently modified graph with the same id and schema version', async () => {
    const originalGraph = graph('digest-guard', 'start', [
        node('start', 'transform', { condition: '({ value: 1 })', next: 'end' }),
        node('end', 'end')
    ]);
    const original = await runFlowStudioGraph({ graph: originalGraph });
    const checkpoint = original.checkpoints.find(item => item.nodeId === 'start');
    const modified = structuredClone(originalGraph);
    modified.nodes[0].condition = '({ value: 999 })';
    await assert.rejects(() => runFlowStudioGraph({ graph: modified, resume: { checkpoint, forkRun: true } }), /Checkpoint incompatível/i);
});

test('graph maxParallelism is shared across nested Forks', async () => {
    const candidate = graph('nested-global-parallelism', 'outer', [
        node('outer', 'fork', { fork: { branches: ['inner-a', 'inner-b'], join: 'outer-join', maxConcurrency: 2 } }),
        node('inner-a', 'fork', { fork: { branches: ['a1', 'a2'], join: 'join-a', maxConcurrency: 2 } }),
        node('inner-b', 'fork', { fork: { branches: ['b1', 'b2'], join: 'join-b', maxConcurrency: 2 } }),
        ...['a1', 'a2', 'b1', 'b2'].map(id => node(id, 'agent', { prompt: id, runner: { providerId: 'worker' }, next: id.startsWith('a') ? 'join-a' : 'join-b' })),
        node('join-a', 'join', { join: { strategy: 'all' }, next: 'outer-join' }),
        node('join-b', 'join', { join: { strategy: 'all' }, next: 'outer-join' }),
        node('outer-join', 'join', { join: { strategy: 'all' }, next: 'end' }),
        node('end', 'end')
    ], {
        edges: [
            { from: 'a1', to: 'join-a' }, { from: 'a2', to: 'join-a' },
            { from: 'b1', to: 'join-b' }, { from: 'b2', to: 'join-b' },
            { from: 'join-a', to: 'outer-join' }, { from: 'join-b', to: 'outer-join' }
        ],
        budget: { maxParallelism: 2 }
    });
    assertValid(candidate);
    let active = 0;
    let maxActive = 0;
    const result = await runFlowStudioGraph({
        graph: candidate,
        runnerAdapters: { worker: async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setTimeout(resolve, 12));
            active -= 1;
            return { output: {} };
        } }
    });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(maxActive, 2);
});

test('cancelRemaining removes queued nested work before its adapter can start', async () => {
    const candidate = graph('cancel-queued-nested', 'outer', [
        node('outer', 'fork', { fork: { branches: ['fast', 'inner'], join: 'outer-join', maxConcurrency: 2 } }),
        node('fast', 'agent', { prompt: 'fast', runner: { providerId: 'worker' }, outputs: { winner: 'winner' }, next: 'outer-join' }),
        node('inner', 'fork', { fork: { branches: ['slow1', 'slow2'], join: 'inner-join', maxConcurrency: 2 } }),
        node('slow1', 'agent', { prompt: 'slow1', runner: { providerId: 'worker' }, next: 'inner-join' }),
        node('slow2', 'agent', { prompt: 'slow2', runner: { providerId: 'worker' }, next: 'inner-join' }),
        node('inner-join', 'join', { join: { strategy: 'all' }, next: 'outer-join' }),
        node('outer-join', 'join', { join: { strategy: 'any', cancelRemaining: true }, next: 'end' }),
        node('end', 'end')
    ], {
        edges: [
            { from: 'fast', to: 'outer-join' }, { from: 'slow1', to: 'inner-join' },
            { from: 'slow2', to: 'inner-join' }, { from: 'inner-join', to: 'outer-join' }
        ],
        budget: { maxParallelism: 2 }
    });
    const calls = [];
    const result = await runFlowStudioGraph({
        graph: candidate,
        runnerAdapters: { worker: ({ node, signal }) => new Promise((resolve, reject) => {
            calls.push(node.id);
            const timer = setTimeout(() => resolve({ output: { winner: node.id } }), node.id === 'fast' ? 8 : 100);
            signal?.addEventListener('abort', () => { clearTimeout(timer); const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }, { once: true });
        }) }
    });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.finalContext.winner, 'fast');
    assert.ok(calls.includes('fast'));
    assert.ok(calls.includes('slow1') || calls.includes('slow2'));
    assert.equal(calls.includes('slow1') && calls.includes('slow2'), false, `queued sibling unexpectedly started: ${calls.join(',')}`);
});

test('RAG and tool cwd reject a workspace junction that resolves outside allowed roots', async t => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-studio-scope-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-studio-outside-'));
    const link = path.join(workspace, 'escape');
    t.after(async () => {
        await fs.rm(workspace, { recursive: true, force: true });
        await fs.rm(outside, { recursive: true, force: true });
    });
    await fs.writeFile(path.join(outside, 'secret.md'), 'outside-secret');
    try {
        await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        if (error && ['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip(`symlink unavailable: ${error.code}`);
        throw error;
    }

    let toolCalled = false;
    const toolGraph = graph('tool-junction', 'action', [
        node('action', 'action', { tools: [{ id: 'tool', name: 'tool', command: 'tool', cwd: 'escape', effect: 'command', requiredPermissions: ['tool:command'], idempotencyKey: 'tool' }], next: 'end' }),
        node('end', 'end')
    ], { permissions: { allow: ['tool:command'], fileRoots: ['.'] } });
    const toolResult = await runFlowStudioGraph({ graph: toolGraph, workspaceRoot: workspace, toolAdapters: { tool: async () => { toolCalled = true; return { output: {} }; } } });
    assert.equal(toolResult.status, 'failed');
    assert.match(toolResult.error || '', /cwd fora das raízes permitidas/i);
    assert.equal(toolCalled, false);

    let runnerCalled = false;
    const ragGraph = graph('rag-junction', 'agent', [
        node('agent', 'agent', { prompt: 'read', rag: { filePath: 'escape/secret.md' }, runner: { providerId: 'runner' }, next: 'end' }),
        node('end', 'end')
    ], { permissions: { fileRoots: ['.'] } });
    const ragResult = await runFlowStudioGraph({ graph: ragGraph, workspaceRoot: workspace, runnerAdapters: { runner: async () => { runnerCalled = true; return { output: {} }; } } });
    assert.equal(ragResult.status, 'failed');
    assert.match(ragResult.error || '', /RAG filePath fora das raízes permitidas/i);
    assert.equal(runnerCalled, false);
});

test('Context is a native adapter-backed block and fails closed when required', async () => {
    const candidate = graph('native-context', 'context', [
        node('context', 'context', { context: { query: 'architecture', scopes: ['workspace'], statePaths: ['request.id'], outputPath: 'knowledge.pack', required: true }, permissions: { allow: ['memory:read'] }, next: 'end' }),
        node('end', 'end')
    ]);
    assertValid(candidate);
    let calls = 0;
    const loaded = await runFlowStudioGraph({
        graph: candidate,
        input: { request: { id: 7 } },
        memoryAdapter: {
            loadContext: async args => {
                calls += 1;
                assert.equal(args.config.query, 'architecture');
                return { pack: { summary: 'workspace context', sections: [{ title: 'request', content: args.context.request, provenance: 'state:request.id' }], provenance: [{ kind: 'state', ref: 'request.id' }] } };
            },
            writeCandidate: async () => { throw new Error('not used'); }
        }
    });
    assert.equal(loaded.status, 'completed', loaded.error);
    assert.equal(calls, 1);
    assert.equal(loaded.finalContext.knowledge.pack.summary, 'workspace context');
    const unavailable = await runFlowStudioGraph({ graph: candidate });
    assert.equal(unavailable.status, 'failed');
    assert.match(unavailable.error || '', /MemoryAdapter/i);

    const empty = await runFlowStudioGraph({ graph: candidate, memoryAdapter: { loadContext: async () => ({ pack: {} }), writeCandidate: async () => { throw new Error('not used'); } } });
    assert.equal(empty.status, 'failed');
    assert.match(empty.error || '', /não encontrou conteúdo/i);
});

test('Command is a native block with write-ahead receipts and ambiguous effects fail closed', async () => {
    const candidate = graph('native-command', 'cmd', [
        node('cmd', 'command', { command: { command: 'safe-tool', args: ['run'], effect: 'command', idempotencyKey: 'command-once', requiredPermissions: ['tool:command'] }, next: 'end' }),
        node('end', 'end')
    ], { permissions: { allow: ['tool:command'], commandPatterns: ['safe-tool*'] } });
    assertValid(candidate);
    let calls = 0;
    const first = await runFlowStudioGraph({ graph: candidate, toolAdapters: { '*': async () => { calls += 1; throw new Error('lost acknowledgement'); } } });
    assert.equal(first.status, 'failed');
    assert.equal(first.effects[0].status, 'uncertain');
    const second = await runFlowStudioGraph({ graph: candidate, effects: first.effects, toolAdapters: { '*': async () => { calls += 1; return { output: {} }; } } });
    assert.equal(second.status, 'failed');
    assert.match(second.error || '', /ambíguo|Reconcilie/i);
    assert.equal(calls, 1);
});

test('node permissions and scopes can narrow but never broaden graph ceilings', async () => {
    const candidate = graph('permission-lattice', 'cmd', [
        node('cmd', 'command', {
            command: { command: 'unsafe-tool', effect: 'command', idempotencyKey: 'unsafe', requiredPermissions: ['tool:command'] },
            permissions: { allow: ['*'], commandPatterns: ['*'] },
            next: 'end'
        }),
        node('end', 'end')
    ], { permissions: { allow: ['tool:command'], commandPatterns: ['safe-tool*'] } });
    assertValid(candidate);
    let called = false;
    const result = await runFlowStudioGraph({ graph: candidate, toolAdapters: { '*': async () => { called = true; return { output: {} }; } } });
    assert.equal(result.status, 'failed');
    assert.match(result.error || '', /allowlist/i);
    assert.equal(called, false);
});

test('subgraphs inherit parent scopes and fail closed on disjoint scope intersections', async () => {
    const child = command => graph(`child-${command}`, 'tool', [
        node('tool', 'action', { tools: [{ id: 'child-tool', name: 'Child tool', command, effect: 'read', requiredPermissions: ['tool:read'] }], next: 'end' }),
        node('end', 'end')
    ], { permissions: { allow: ['tool:read'], ...(command === 'python' ? { commandPatterns: ['python*'] } : {}) } });
    const parent = inline => graph('permission-parent', 'child', [
        node('child', 'subgraph', { subgraph: { inline }, next: 'end' }),
        node('end', 'end')
    ], { permissions: { allow: ['tool:read'], commandPatterns: ['node*'] } });

    const inherited = parent(child('node'));
    assertValid(inherited);
    let calls = 0;
    const allowed = await runFlowStudioGraph({ graph: inherited, toolAdapters: { '*': async () => { calls += 1; return { output: { ok: true } }; } } });
    assert.equal(allowed.status, 'completed', allowed.error);
    assert.equal(calls, 1);

    const disjoint = parent(child('python'));
    assertValid(disjoint);
    const denied = await runFlowStudioGraph({ graph: disjoint, toolAdapters: { '*': async () => { calls += 1; return { output: {} }; } } });
    assert.equal(denied.status, 'failed');
    assert.match(denied.error || '', /allowlist/i);
    assert.equal(calls, 1);
});

test('network host wildcards are enforced and intersected with exact child hosts', async () => {
    const tool = node('fetch', 'action', {
        tools: [{ id: 'fetch', name: 'Fetch', command: 'fetch', args: ['https://api.example.com/data'], effect: 'network', requiredPermissions: ['tool:network'] }],
        next: 'end'
    });
    const direct = graph('network-wildcard-direct', 'fetch', [tool, node('end', 'end')], {
        permissions: { allow: ['tool:network'], networkHosts: ['*.example.com'] }
    });
    let calls = 0;
    const adapter = { fetch: async () => { calls += 1; return { output: { ok: true } }; } };
    const directResult = await runFlowStudioGraph({ graph: direct, toolAdapters: adapter });
    assert.equal(directResult.status, 'completed', directResult.error);

    const child = graph('network-wildcard-child', 'fetch', [tool, node('end', 'end')], {
        permissions: { allow: ['tool:network'], networkHosts: ['api.example.com'] }
    });
    const parent = graph('network-wildcard-parent', 'child', [
        node('child', 'subgraph', { subgraph: { inline: child }, next: 'end' }),
        node('end', 'end')
    ], { permissions: { allow: ['tool:network'], networkHosts: ['*.example.com'] } });
    const nestedResult = await runFlowStudioGraph({ graph: parent, toolAdapters: adapter });
    assert.equal(nestedResult.status, 'completed', nestedResult.error);
    assert.equal(calls, 2);
});

test('relative fileRoot intersections use workspaceRoot and reject a child junction escaping its parent root', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-studio-root-base-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-studio-root-outside-'));
    const parentRoot = path.join(workspace, 'parent');
    const nestedRoot = path.join(parentRoot, 'nested');
    const linkOut = path.join(parentRoot, 'link-out');
    await fs.mkdir(nestedRoot, { recursive: true });
    await fs.symlink(outside, linkOut, process.platform === 'win32' ? 'junction' : 'dir');
    const makeGraph = childRoot => {
        const child = graph(`root-child-${path.basename(childRoot)}`, 'tool', [
            node('tool', 'action', { tools: [{ id: 'read', name: 'Read', command: 'read', cwd: childRoot, effect: 'read', requiredPermissions: ['tool:read'] }], next: 'end' }),
            node('end', 'end')
        ], { permissions: { allow: ['tool:read'], fileRoots: [childRoot] } });
        return graph(`root-parent-${path.basename(childRoot)}`, 'child', [
            node('child', 'subgraph', { permissions: { allow: ['tool:read'], fileRoots: [childRoot] }, subgraph: { inline: child }, next: 'end' }),
            node('end', 'end')
        ], { permissions: { allow: ['tool:read'], fileRoots: ['parent'] } });
    };
    try {
        let calls = 0;
        const adapter = { read: async () => { calls += 1; return { output: {} }; } };
        const legal = await runFlowStudioGraph({ graph: makeGraph('parent/nested'), workspaceRoot: workspace, toolAdapters: adapter });
        assert.equal(legal.status, 'completed', legal.error);
        assert.equal(calls, 1);

        const escaped = await runFlowStudioGraph({ graph: makeGraph('parent/link-out'), workspaceRoot: workspace, toolAdapters: adapter });
        assert.equal(escaped.status, 'failed');
        assert.equal(calls, 1, 'the adapter must never receive an escaped cwd');
    } finally {
        await fs.rm(workspace, { recursive: true, force: true });
        await fs.rm(outside, { recursive: true, force: true });
    }
});

test('Memory Write persists only candidate revisions backed by explicit approval receipts', async () => {
    const candidate = graph('native-memory-write', 'write', [
        node('write', 'memory_write', { memoryWrite: { scope: 'workspace', candidatesFrom: 'memoryCandidates', policy: 'approved-only', outputPath: 'memory.writes' }, permissions: { allow: ['memory:write'] }, next: 'end' }),
        node('end', 'end')
    ]);
    assertValid(candidate);
    const written = [];
    const approvedCandidate = { id: 'approved', status: 'candidate', revision: 2, value: { fact: 'keep' } };
    const result = await runFlowStudioGraph({
        graph: candidate,
        input: { memoryCandidates: [
            approvedCandidate,
            { id: 'pending', status: 'candidate', revision: 1, value: { fact: 'never' } },
            { id: 'rejected', status: 'rejected', revision: 1, value: { fact: 'never' } }
        ] },
        memoryApprovals: [{ id: approvedCandidate.id, revision: approvedCandidate.revision, scope: 'workspace', graphId: candidate.id, nodeId: 'write', candidateDigest: flowStudioMemoryCandidateDigest(approvedCandidate, 'workspace') }],
        memoryAdapter: {
            loadContext: async () => ({ pack: {} }),
            writeCandidate: async args => {
                written.push(args.candidate.id);
                return { candidateId: args.candidate.id, revision: args.candidate.revision, scope: args.candidate.scope, status: 'written', digest: 'memory-digest', writtenAt: '2026-01-01T00:00:01Z' };
            }
        }
    });
    assert.equal(result.status, 'completed', result.error);
    assert.deepEqual(written, ['approved']);
    assert.equal(result.finalContext.memory.writes.approved.status, 'written');
    assert.equal(result.effects.length, 1);
    assert.equal(result.effects[0].status, 'completed');
});

test('a human memory approval preserves its provenance through a Wait checkpoint and resume', async () => {
    const memoryCandidate = { id: 'provenance-memory', revision: 1, status: 'candidate', value: { fact: 'approved by a person' } };
    const candidate = graph('memory-approval-provenance', 'gate', [
        node('gate', 'gate', { gate: { kind: 'human', prompt: 'Approve memory?' }, next: 'wait' }),
        node('wait', 'wait', { wait: { kind: 'event', eventName: 'continue' }, next: 'write' }),
        node('write', 'memory_write', { memoryWrite: { scope: 'workspace', storeId: 'main', candidatesFrom: 'memoryCandidates', onEmpty: 'fail' }, next: 'end' }),
        node('end', 'end')
    ]);
    const evidence = { id: 'human-review', nodeId: 'gate', kind: 'evidence', name: 'Human review', payload: { reviewer: 'owner' } };
    const approval = {
        id: memoryCandidate.id,
        revision: memoryCandidate.revision,
        scope: 'workspace',
        storeId: 'main',
        graphId: candidate.id,
        nodeId: 'write',
        candidateDigest: flowStudioMemoryCandidateDigest(memoryCandidate, 'workspace'),
        evidence: [evidence]
    };
    let received;
    const base = {
        graph: candidate,
        input: { memoryCandidates: [memoryCandidate] },
        memoryAdapter: {
            loadContext: async () => ({ pack: {} }),
            writeCandidate: async args => {
                received = args.approval;
                return { candidateId: args.candidate.id, revision: args.candidate.revision, scope: args.candidate.scope, storeId: args.config.storeId, status: 'written' };
            }
        }
    };
    const gated = await runFlowStudioGraph(base);
    const gateCheckpoint = gated.checkpoints.find(item => item.id === gated.waiting?.checkpointId);
    assert.ok(gateCheckpoint);
    const waiting = await runFlowStudioGraph({ ...base, resume: { checkpoint: gateCheckpoint, gate: { decisionId: 'continue', memoryApprovals: [approval] } } });
    assert.equal(waiting.status, 'waiting', waiting.error);
    const waitCheckpoint = waiting.checkpoints.find(item => item.id === waiting.waiting?.checkpointId);
    const persisted = waitCheckpoint?.metadata?.memoryApprovals?.[0];
    assert.equal(persisted.approvedBy, 'human-gate');
    assert.ok(persisted.approvedAt);
    assert.deepEqual(persisted.evidence, [evidence]);

    const completed = await runFlowStudioGraph({ ...base, resume: { checkpoint: waitCheckpoint, signal: { eventName: 'continue' } } });
    assert.equal(completed.status, 'completed', completed.error);
    assert.equal(received.approvedBy, 'human-gate');
    assert.equal(received.approvedAt, persisted.approvedAt);
    assert.deepEqual(received.evidence, [evidence]);
});

test('Playbook uses the host adapter and propagates rich result data exactly once', async () => {
    const candidate = graph('native-playbook', 'playbook', [
        node('playbook', 'playbook', { prompt: 'Run QA', playbook: { playbookId: 'qa', parameters: { strict: true }, idempotencyKey: 'playbook-qa' }, permissions: { allow: ['playbook:run'] }, next: 'end' }),
        node('end', 'end')
    ]);
    assertValid(candidate);
    let calls = 0;
    const result = await runFlowStudioGraph({
        graph: candidate,
        playbookAdapters: {
            qa: async args => {
                calls += 1;
                assert.equal(args.config.parameters.strict, true);
                return { ok: true, message: 'approved', value: { score: 98 }, signals: { quality: 'high' }, issues: [], diagnostics: [{ rule: 'qa' }], artifacts: [{ id: 'qa-artifact', nodeId: args.node.id, kind: 'evidence', name: 'qa.json', payload: { score: 98 } }], usage: { inputTokens: 10, outputTokens: 4 } };
            }
        }
    });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(calls, 1);
    assert.equal(result.finalContext.playbook.value.score, 98);
    assert.equal(result.finalContext.playbook.signals.quality, 'high');
    assert.equal(result.artifacts.filter(item => item.id === 'qa-artifact').length, 1);
});

test('an isolated inline Playbook receives parameters but returns only mapped output', async () => {
    const child = graph('inline-playbook-child', 'read', [
        node('read', 'transform', { condition: '({ result: context._flowStudio.playbook.parameters.strict, hidden: "child" })', next: 'end' }),
        node('end', 'end')
    ]);
    const candidate = graph('inline-playbook-parent', 'playbook', [
        node('playbook', 'playbook', { playbook: { playbookId: 'inline-qa', inline: child, parameters: { strict: true }, output: { result: 'qa.strict' }, isolated: true }, next: 'end' }),
        node('end', 'end')
    ]);
    assertValid(candidate);
    const result = await runFlowStudioGraph({ graph: candidate, input: { parentOnly: true } });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.finalContext.qa.strict, true);
    assert.equal(result.finalContext.hidden, undefined);
    assert.equal(result.finalContext.parentOnly, true);
});

test('Dynamic Parallel injects itemVariable, bounds concurrency, and preserves input order', async () => {
    const candidate = graph('native-dynamic', 'fanout', [
        node('fanout', 'dynamic_parallel', {
            dynamicParallel: {
                itemsFrom: 'tasks', itemVariable: 'task', concurrency: 2, maxItems: 4,
                failurePolicy: 'best_effort', joinStrategy: 'collect', outputPath: 'fanout.result',
                worker: node('worker', 'agent', { prompt: 'work', runner: { providerId: 'worker' } })
            },
            next: 'end'
        }),
        node('end', 'end')
    ], { budget: { maxParallelism: 2 } });
    assertValid(candidate);
    let active = 0;
    let maxActive = 0;
    const result = await runFlowStudioGraph({
        graph: candidate,
        input: { tasks: ['a', 'b', 'c', 'd'] },
        runnerAdapters: { worker: async args => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setTimeout(resolve, args.context.task === 'a' ? 20 : 5));
            active -= 1;
            return { output: { handled: args.context.task } };
        } }
    });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(maxActive, 2);
    assert.deepEqual(result.finalContext.fanout.result.results.map(item => item.output.handled), ['a', 'b', 'c', 'd']);
    assert.deepEqual(result.events.filter(event => event.kind === 'parallel.item.completed').map(event => event.detail.index).sort(), [0, 1, 2, 3]);
});

test('Dynamic Parallel enforces maxItems before reserving any worker', async () => {
    const candidate = graph('dynamic-cap', 'fanout', [
        node('fanout', 'dynamic_parallel', { dynamicParallel: { itemsFrom: 'tasks', maxItems: 2, worker: node('worker', 'agent', { prompt: 'work', runner: { providerId: 'worker' } }) }, next: 'end' }),
        node('end', 'end')
    ]);
    assertValid(candidate);
    let calls = 0;
    const result = await runFlowStudioGraph({ graph: candidate, input: { tasks: [1, 2, 3] }, runnerAdapters: { worker: async () => { calls += 1; return { output: {} }; } } });
    assert.equal(result.status, 'failed');
    assert.match(result.error || '', /acima do limite 2/i);
    assert.equal(calls, 0);
});

test('Dynamic Parallel charges embedded usage to the parent node budget', async () => {
    const candidate = graph('dynamic-parent-budget', 'fanout', [
        node('fanout', 'dynamic_parallel', {
            budget: { maxCostUsd: 0.5 },
            dynamicParallel: { itemsFrom: 'tasks', maxItems: 4, concurrency: 2, failurePolicy: 'fail_fast', worker: node('worker', 'agent', { prompt: 'work', runner: { providerId: 'worker' } }) },
            next: 'end'
        }),
        node('end', 'end')
    ]);
    assertValid(candidate);
    const result = await runFlowStudioGraph({
        graph: candidate,
        input: { tasks: ['a', 'b'] },
        providerAdapters: { worker: async () => ({ output: {}, usage: { costUsd: 0.3 } }) }
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error || '', /fanout.*custo/i);
});

test('Dynamic Parallel gives all embedded workers one cumulative parent-node deadline', async () => {
    const candidate = graph('dynamic-parent-deadline', 'fanout', [
        node('fanout', 'dynamic_parallel', {
            budget: { maxDurationMs: 300 },
            dynamicParallel: { itemsFrom: 'tasks', maxItems: 2, concurrency: 1, failurePolicy: 'best_effort', worker: node('worker', 'agent', { prompt: 'work', runner: { providerId: 'worker' } }) },
            next: 'end'
        }),
        node('end', 'end')
    ]);
    let calls = 0;
    let aborted = false;
    const result = await runFlowStudioGraph({
        graph: candidate,
        input: { tasks: ['first', 'second'] },
        runnerAdapters: { worker: args => new Promise((resolve, reject) => {
            calls += 1;
            const timer = setTimeout(() => resolve({ output: { done: args.context.item } }), 200);
            args.signal.addEventListener('abort', () => {
                clearTimeout(timer);
                aborted = true;
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            }, { once: true });
        }) }
    });
    assert.equal(result.status, 'failed');
    assert.equal(calls, 2);
    assert.equal(aborted, true, 'the second worker must inherit the remaining parent deadline');
    assert.match(result.error || '', /Timeout|duração/i);
});

test('Tournament comparisons share one cumulative parent-node deadline', async () => {
    const candidate = graph('tournament-parent-deadline', 'tournament', [
        node('tournament', 'tournament', {
            budget: { maxDurationMs: 300 },
            tournament: {
                candidatesFrom: 'candidates', strategy: 'bracket', criteria: ['quality'], winnerCount: 1, maxComparisons: 2,
                judge: node('judge', 'agent', { prompt: 'judge', runner: { providerId: 'judge' } })
            },
            next: 'end'
        }),
        node('end', 'end')
    ]);
    let calls = 0;
    let aborted = false;
    const result = await runFlowStudioGraph({
        graph: candidate,
        input: { candidates: ['A', 'B', 'C'] },
        runnerAdapters: { judge: args => new Promise((resolve, reject) => {
            calls += 1;
            const timer = setTimeout(() => resolve({ output: { winnerIds: [args.context.tournament.candidates[0].id] } }), 200);
            args.signal.addEventListener('abort', () => {
                clearTimeout(timer);
                aborted = true;
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            }, { once: true });
        }) }
    });
    assert.equal(result.status, 'failed');
    assert.equal(calls, 2);
    assert.equal(aborted, true, 'the second comparison must inherit the remaining parent deadline');
    assert.match(result.error || '', /Timeout|duração/i);
});

test('Tournament executes single round, bracket, and round robin as real strategies', async t => {
    for (const [strategy, expectedCalls, expectedWinner] of [['single_round', 1, 'A'], ['bracket', 3, 'A'], ['round_robin', 6, 'A']]) {
        await t.test(strategy, async () => {
            const candidate = graph(`tournament-${strategy}`, 'tournament', [
                node('tournament', 'tournament', {
                    tournament: {
                        candidatesFrom: 'candidates', strategy, criteria: ['quality'], winnerCount: 1, maxComparisons: 10, tieBreaker: 'first_candidate', outputPath: 'selection', blind: false,
                        judge: node('judge', 'agent', { prompt: 'judge', runner: { providerId: 'judge' } })
                    },
                    next: 'end'
                }),
                node('end', 'end')
            ]);
            assertValid(candidate);
            let calls = 0;
            const result = await runFlowStudioGraph({ graph: candidate, input: { candidates: ['A', 'B', 'C', 'D'] }, runnerAdapters: { judge: async args => {
                calls += 1;
                const rows = args.context.tournament.candidates;
                return { output: { winnerIds: [rows[0].id], scores: Object.fromEntries(rows.map((row, index) => [row.id, rows.length - index])), reason: 'deterministic' } };
            } } });
            assert.equal(result.status, 'completed', result.error);
            assert.equal(calls, expectedCalls);
            assert.equal(result.finalContext.selection.winners[0].value, expectedWinner);
            assert.equal(result.finalContext.selection.comparisonCount, expectedCalls);
        });
    }
});

test('Tournament rejects invented winner ids instead of fabricating a winner', async () => {
    const candidate = graph('tournament-invalid-output', 'tournament', [
        node('tournament', 'tournament', { tournament: { candidatesFrom: 'candidates', criteria: ['quality'], winnerCount: 1, maxComparisons: 1, judge: node('judge', 'agent', { prompt: 'judge', runner: { providerId: 'judge' } }) }, next: 'end' }),
        node('end', 'end')
    ]);
    assertValid(candidate);
    const result = await runFlowStudioGraph({ graph: candidate, input: { candidates: ['A', 'B'] }, runnerAdapters: { judge: async () => ({ output: { winnerIds: ['invented'] } }) } });
    assert.equal(result.status, 'failed');
    assert.match(result.error || '', /desconhecidos/i);
});

test('the generated template validates against its own current contract', () => {
    const template = createFlowStudioTemplate('Template self-check');
    assertValid(template);
    assert.ok(template.runners.some(runner => runner.id === 'cybervinci' && runner.kind === 'cybervinci'));
    assert.ok(template.modelProfiles.some(profile => profile.id === 'cybervinci/default' && profile.runnerId === 'cybervinci'));
    const planner = template.nodes.find(item => item.id === 'planejador');
    assert.ok(planner.provider.fallbacks.some(binding => binding.runnerId === 'cybervinci'));
});

test('runner invocation is denied when the GraphSpec did not declare it', async () => {
    const candidate = {
        version: FLOW_STUDIO_SCHEMA_VERSION,
        id: 'undeclared-runner', name: 'undeclared-runner', start: 'agent',
        nodes: [node('agent', 'agent', { prompt: 'run', runner: { providerId: 'test' }, next: 'end' }), node('end', 'end')], edges: []
    };
    let called = false;
    const result = await runFlowStudioGraph({ graph: candidate, runnerAdapters: { test: async () => { called = true; return { output: {} }; } } });
    assert.equal(result.status, 'failed');
    assert.match(result.error || '', /runner:invoke.*não declarada/i);
    assert.equal(called, false);
});

test('the internal _flowStudio namespace cannot be injected through input or graph paths', async () => {
    const candidate = graph('reserved-state', 'end', [node('end', 'end')]);
    await assert.rejects(() => runFlowStudioGraph({ graph: candidate, input: { _flowStudio: { sessions: { agent: { fake: 'attacker' } } } } }), /namespace interno/i);

    for (const invalid of [
        graph('reserved-output', 'transform', [node('transform', 'transform', { condition: '({x: 1})', outputs: { x: '_flowStudio.x' }, next: 'end' }), node('end', 'end')]),
        graph('reserved-context', 'context', [node('context', 'context', { context: { statePaths: ['_flowStudio.sessions'] }, next: 'end' }), node('end', 'end')]),
        graph('reserved-dynamic', 'parallel', [node('parallel', 'dynamic_parallel', { dynamicParallel: { itemsFrom: '[1]', maxItems: 1, itemVariable: '_flowStudio', worker: node('worker', 'transform', { condition: '({})' }) }, next: 'end' }), node('end', 'end')])
    ]) assert.equal(validateFlowStudioGraph(invalid).valid, false);
});

test('permission approvals are scoped to the exact node tool and input', async () => {
    const candidate = graph('scoped-approval', 'action', [
        node('action', 'action', { tools: [
            { id: 'one', name: 'one', command: 'one', effect: 'command', idempotencyKey: 'one' },
            { id: 'two', name: 'two', command: 'two', effect: 'command', idempotencyKey: 'two' }
        ], next: 'end' }), node('end', 'end')
    ], { permissions: { requireApproval: ['tool:command'], commandPatterns: ['*'] } });
    const approved = [];
    const result = await runFlowStudioGraph({
        graph: candidate,
        onGate: async request => { approved.push(request.payload.tool.id); return { decisionId: 'continue' }; },
        toolAdapters: { '*': async () => ({ output: {} }) }
    });
    assert.equal(result.status, 'completed', result.error);
    assert.deepEqual(approved.sort(), ['one', 'two']);
});

test('parallel effects preflight duplicate keys and await aborted siblings before terminal state', async () => {
    const duplicate = graph('duplicate-effects', 'action', [
        node('action', 'action', { tools: [
            { id: 'a', name: 'a', command: 'a', effect: 'command', idempotencyKey: 'same' },
            { id: 'b', name: 'b', command: 'b', effect: 'command', idempotencyKey: 'same' }
        ], next: 'end' }), node('end', 'end')
    ], { permissions: { allow: ['tool:command'], commandPatterns: ['*'] } });
    let calls = 0;
    const preflight = await runFlowStudioGraph({ graph: duplicate, toolAdapters: { '*': async () => { calls += 1; return { output: {} }; } } });
    assert.equal(preflight.status, 'failed');
    assert.match(preflight.error || '', /duplicada.*Nenhum efeito/i);
    assert.equal(calls, 0);
    assert.equal(preflight.effects.length, 0);

    const structured = graph('structured-effects', 'action', [
        node('action', 'action', { tools: [
            { id: 'fail', name: 'fail', command: 'fail', effect: 'command', idempotencyKey: 'fail' },
            { id: 'slow', name: 'slow', command: 'slow', effect: 'command', idempotencyKey: 'slow' }
        ], next: 'end' }), node('end', 'end')
    ], { permissions: { allow: ['tool:command'], commandPatterns: ['*'] } });
    let slowSettled = false;
    const terminal = await runFlowStudioGraph({ graph: structured, toolAdapters: {
        fail: async () => { await new Promise(resolve => setTimeout(resolve, 5)); throw new Error('boom'); },
        slow: async () => { await new Promise(resolve => setTimeout(resolve, 35)); slowSettled = true; return { output: {} }; }
    } });
    assert.equal(terminal.status, 'failed');
    assert.equal(slowSettled, true);
    assert.equal(terminal.effects.every(effect => effect.status !== 'started'), true);
});

test('agent-proposed idempotency keys cannot change the declared effect identity', async () => {
    const candidate = graph('model-idempotency', 'agent', [
        node('agent', 'agent', { prompt: 'call', runner: { providerId: 'test' }, tools: [{ id: 'lookup', name: 'lookup', command: 'lookup', effect: 'read', idempotencyKey: 'declared' }], next: 'end' }),
        node('end', 'end')
    ]);
    let toolCalls = 0;
    let suggested = 'model-key-one';
    const launch = effects => runFlowStudioGraph({
        graph: candidate, effects,
        runnerAdapters: { test: async () => ({ output: {}, toolCalls: [{ toolId: 'lookup', args: ['same'], idempotencyKey: suggested }] }) },
        toolAdapters: { lookup: async () => { toolCalls += 1; return { output: { ok: true } }; } }
    });
    const first = await launch(undefined);
    suggested = 'model-key-two';
    const replay = await launch(first.effects);
    assert.equal(first.status, 'completed', first.error);
    assert.equal(replay.status, 'completed', replay.error);
    assert.equal(toolCalls, 1);
});

test('blind Tournament recursively removes identity and exposes only a minimal graph to its judge', async () => {
    const candidate = graph('blind-tournament', 'tournament', [
        node('tournament', 'tournament', { tournament: { candidatesFrom: 'candidates', criteria: ['quality'], winnerCount: 1, maxComparisons: 1, blind: true, judge: node('judge', 'agent', { prompt: 'judge', runner: { providerId: 'judge' } }) }, next: 'end' }),
        node('secret-agent', 'agent', { prompt: 'should never be visible', runner: { providerId: 'secret' } }),
        node('end', 'end')
    ]);
    const result = await runFlowStudioGraph({ graph: candidate, input: { candidates: [
        { text: 'A', metadata: { provider: 'expensive', author: 'alice' } },
        { text: 'B', metadata: { model: 'cheap', author: 'bob' } }
    ] }, runnerAdapters: { judge: async args => {
        assert.equal(args.graph.nodes.length, 1);
        assert.equal(args.graph.nodes[0].id.includes('judge'), true);
        assert.equal(JSON.stringify(args.input).includes('alice'), false);
        assert.equal(JSON.stringify(args.context).includes('expensive'), false);
        const rows = args.context.tournament.candidates;
        return { output: { winnerIds: [rows[0].id], scores: { [rows[0].id]: 1, [rows[1].id]: 0 } } };
    } } });
    assert.equal(result.status, 'completed', result.error);
});

test('strictWrites covers every specialized output path', () => {
    const strict = nodes => graph(`strict-${nodes[0].type}`, nodes[0].id, [...nodes, node('end', 'end')], { state: { strictWrites: true, namespaces: { allowed: { initial: {} } } } });
    const invalidGraphs = [
        strict([node('context', 'context', { context: { query: 'q', outputPath: 'forbidden.pack' }, next: 'end' })]),
        strict([node('memory', 'memory_write', { memoryWrite: { scope: 'workspace', candidatesFrom: 'allowed.items', outputPath: 'forbidden.writes' }, next: 'end' })]),
        strict([node('playbook', 'playbook', { playbook: { playbookId: 'p', idempotencyKey: 'p', output: { value: 'forbidden.value' } }, next: 'end' })]),
        strict([node('dynamic', 'dynamic_parallel', { dynamicParallel: { itemsFrom: '[1]', maxItems: 1, itemVariable: 'allowed.item', outputPath: 'forbidden.results', worker: node('worker', 'transform', { condition: '({})' }) }, next: 'end' })]),
        strict([node('tournament', 'tournament', { tournament: { candidatesFrom: '[1,2]', criteria: ['q'], maxComparisons: 1, outputPath: 'forbidden.result', judge: node('judge', 'agent', { prompt: 'j', runner: { providerId: 'j' } }) }, next: 'end' })])
    ];
    for (const candidate of invalidGraphs) assert.equal(validateFlowStudioGraph(candidate).errors.some(issue => issue.code.includes('namespace')), true);
});

test('Tournament rejects an insufficient comparison budget before invoking any judge', async () => {
    const candidate = graph('tournament-preflight', 'tournament', [
        node('tournament', 'tournament', { tournament: { candidatesFrom: 'candidates', strategy: 'bracket', criteria: ['q'], winnerCount: 2, maxComparisons: 2, judge: node('judge', 'agent', { prompt: 'j', runner: { providerId: 'judge' } }) }, next: 'end' }), node('end', 'end')
    ]);
    let calls = 0;
    const result = await runFlowStudioGraph({ graph: candidate, input: { candidates: [1, 2, 3, 4, 5, 6, 7] }, runnerAdapters: { judge: async () => { calls += 1; return { output: {} }; } } });
    assert.equal(result.status, 'failed');
    assert.match(result.error || '', /Nenhum juiz foi chamado/i);
    assert.equal(calls, 0);
});

test('nested runner fallbacks execute recursively up to the bounded depth', async () => {
    const candidate = graph('nested-fallback', 'agent', [
        node('agent', 'agent', { prompt: 'run', runner: { providerId: 'primary', fallbacks: [{ providerId: 'secondary', fallbacks: [{ providerId: 'tertiary' }] }] }, next: 'end' }), node('end', 'end')
    ]);
    const calls = [];
    const result = await runFlowStudioGraph({ graph: candidate, runnerAdapters: {
        primary: async () => { calls.push('primary'); throw new Error('no'); },
        secondary: async () => { calls.push('secondary'); throw new Error('no'); },
        tertiary: async () => { calls.push('tertiary'); return { output: { ok: true } }; }
    } });
    assert.equal(result.status, 'completed', result.error);
    assert.deepEqual(calls, ['primary', 'secondary', 'tertiary']);
});

test('AI gate reviewers honor recursive fallbacks, profile defaults, retries, sessions, and adapter events', async () => {
    const candidate = graph('ai-gate-fallback-session', 'loop', [
        node('loop', 'loop', { loop: { bodyStart: 'gate', condition: 'iteration < 2', maxIterations: 2 }, next: 'end' }),
        node('gate', 'gate', {
            retries: 1,
            retryDelayMs: 1,
            gate: {
                kind: 'ai',
                prompt: 'review',
                reviewer: { providerId: 'primary', fallbacks: [{ providerId: 'fallback-provider', profileId: 'review-profile' }] }
            },
            next: 'loop'
        }),
        node('end', 'end')
    ], {
        modelProfiles: [{
            id: 'review-profile', name: 'Review profile', providerId: 'fallback-provider', runnerId: 'fallback-runner', modelId: 'review/model',
            reasonDefault: 'high', serviceTierDefault: 'fast'
        }]
    });
    let primaryCalls = 0;
    const fallbackSessions = [];
    const forwarded = [];
    const result = await runFlowStudioGraph({
        graph: candidate,
        runnerAdapters: {
            primary: async () => { primaryCalls += 1; throw new Error('primary unavailable'); },
            'fallback-runner': async args => {
                fallbackSessions.push(args.runner.sessionId);
                assert.equal(args.runner.modelId, 'review/model');
                assert.equal(args.runner.reasoningEffort, 'high');
                assert.equal(args.runner.serviceTier, 'fast');
                assert.equal(args.model.id, 'review-profile');
                args.onEvent({ kind: 'runner.progress', message: 'reviewing' });
                return { output: { approved: true }, sessionId: args.runner.sessionId || 'review-session' };
            }
        },
        onEvent: event => forwarded.push(event)
    });
    assert.equal(result.status, 'completed', result.error);
    assert.equal(primaryCalls, 4, 'the primary reviewer gets one retry on each gate visit');
    assert.deepEqual(fallbackSessions, [undefined, 'review-session']);
    assert.equal(result.events.filter(event => event.kind === 'node.requeued' && event.nodeId === 'gate').length, 4);
    assert.equal(forwarded.filter(event => event.kind === 'runner.progress' && event.nodeId === 'gate').length, 2);
});

test('memory approvals are bound to candidate content, not only id and revision', async () => {
    const candidate = graph('memory-content-binding', 'memory', [
        node('memory', 'memory_write', { memoryWrite: { scope: 'workspace', candidatesFrom: 'candidates', onEmpty: 'fail' }, next: 'end' }), node('end', 'end')
    ]);
    const approved = { id: 'decision', revision: 1, status: 'approved', value: { text: 'original' } };
    const mutated = { ...approved, value: { text: 'mutated' } };
    let writes = 0;
    const result = await runFlowStudioGraph({
        graph: candidate, input: { candidates: [mutated] },
        memoryApprovals: [{ id: approved.id, revision: approved.revision, scope: 'workspace', graphId: candidate.id, nodeId: 'memory', candidateDigest: flowStudioMemoryCandidateDigest(approved, 'workspace') }],
        memoryAdapter: { loadContext: async () => ({ pack: {} }), writeCandidate: async () => { writes += 1; throw new Error('must not run'); } }
    });
    assert.equal(result.status, 'failed');
    assert.match(result.error || '', /não encontrou candidatos aprovados/i);
    assert.equal(writes, 0);
});

test('memory approval receipts cannot be reused across nodes, stores, agent scopes, or graphs', async t => {
    const memoryCandidate = { id: 'scoped-memory', revision: 1, status: 'candidate', value: { fact: 'only once' } };
    const makeGraph = ({ id = 'memory-target-binding', start = 'write-b', storeId = 'store-b', scopeId = 'agent-b' } = {}) => graph(id, start, [
        node('write-a', 'memory_write', { memoryWrite: { scope: 'agent', scopeId: 'agent-a', storeId: 'store-a', candidatesFrom: 'candidates', onEmpty: 'fail' }, next: 'end' }),
        node('write-b', 'memory_write', { memoryWrite: { scope: 'agent', scopeId, storeId, candidatesFrom: 'candidates', onEmpty: 'fail' }, next: 'end' }),
        node('end', 'end')
    ]);
    const cases = [
        { name: 'node', approval: { graphId: 'memory-target-binding', nodeId: 'write-a', scopeId: 'agent-b', storeId: 'store-b' } },
        { name: 'store', approval: { graphId: 'memory-target-binding', nodeId: 'write-b', scopeId: 'agent-b', storeId: 'store-a' } },
        { name: 'agent scope', approval: { graphId: 'memory-target-binding', nodeId: 'write-b', scopeId: 'agent-a', storeId: 'store-b' } },
        { name: 'graph', approval: { graphId: 'different-graph', nodeId: 'write-b', scopeId: 'agent-b', storeId: 'store-b' } }
    ];
    for (const spec of cases) await t.test(spec.name, async () => {
        const candidate = makeGraph();
        let writes = 0;
        const result = await runFlowStudioGraph({
            graph: candidate,
            input: { candidates: [memoryCandidate] },
            memoryApprovals: [{
                id: memoryCandidate.id,
                revision: memoryCandidate.revision,
                scope: 'agent',
                candidateDigest: flowStudioMemoryCandidateDigest(memoryCandidate, 'agent'),
                ...spec.approval
            }],
            memoryAdapter: {
                loadContext: async () => ({ pack: {} }),
                writeCandidate: async () => { writes += 1; throw new Error('receipt must not be reusable'); }
            }
        });
        assert.equal(result.status, 'failed');
        assert.match(result.error || '', /não encontrou candidatos aprovados/i);
        assert.equal(writes, 0);
    });
});

test('AI gate timeout aborts the reviewer adapter before the run becomes terminal', async () => {
    const candidate = graph('ai-gate-abort', 'gate', [
        node('gate', 'gate', { gate: { kind: 'ai', prompt: 'review', timeoutMs: 20, onTimeout: 'fail', reviewer: { providerId: 'reviewer', fallbacks: [{ providerId: 'must-not-run' }] } }, gateDecisions: [{ id: 'continue', label: 'continue', decision: 'continue', toNodeId: 'end' }] }),
        node('end', 'end')
    ]);
    let aborted = false;
    let fallbackCalls = 0;
    const result = await runFlowStudioGraph({ graph: candidate, runnerAdapters: {
        reviewer: async args => new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve({ output: { approved: true } }), 500);
            args.signal.addEventListener('abort', () => { clearTimeout(timer); aborted = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
        }),
        'must-not-run': async () => { fallbackCalls += 1; return { output: { approved: true } }; }
    } });
    assert.equal(result.status, 'failed');
    assert.equal(aborted, true);
    assert.equal(fallbackCalls, 0, 'a fallback cannot start after the gate deadline has aborted the chain');
    assert.match(result.error || '', /excedeu|bloqueou|recusado/i);
});

test('fileRoots rejects explicit path arguments outside the configured roots', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-studio-args-root-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-studio-args-outside-'));
    try {
        const candidate = graph('path-argument-scope', 'action', [
            node('action', 'action', { tools: [{ id: 'read', name: 'read', command: 'read', args: [path.join(outside, 'secret.txt')], effect: 'read', idempotencyKey: 'read' }], next: 'end' }), node('end', 'end')
        ], { permissions: { allow: ['tool:read'], commandPatterns: ['read*'], fileRoots: ['.'] } });
        let called = false;
        const result = await runFlowStudioGraph({ graph: candidate, workspaceRoot: workspace, toolAdapters: { read: async () => { called = true; return { output: {} }; } } });
        assert.equal(result.status, 'failed');
        assert.match(result.error || '', /Argumento de path fora/i);
        assert.equal(called, false);
    } finally {
        await fs.rm(workspace, { recursive: true, force: true });
        await fs.rm(outside, { recursive: true, force: true });
    }
});
