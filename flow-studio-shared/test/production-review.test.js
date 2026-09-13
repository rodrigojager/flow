'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateProductionReview } = require('../lib');

// Synthetic policy fixtures only: these are not receipts from real reviewers.
function fixture() {
    const manifest = {
        assetId: 'asset-a',
        revision: 2,
        scopeHash: 'a'.repeat(64),
        rubricHash: 'b'.repeat(64),
        referenceHash: 'c'.repeat(64),
        manifestHash: 'd'.repeat(64),
        requiredRequirements: ['shape', 'materials'],
        requiredEvidence: ['front', 'detail'],
        producerInvocationId: 'producer-run'
    };
    const reviewers = ['artistic', 'technical'].map(role => ({
        role,
        invocationId: `${role}-run`,
        sessionId: `${role}-session`,
        attachmentsDigest: 'e'.repeat(64),
        manifestHash: manifest.manifestHash,
        evidenceIds: [...manifest.requiredEvidence],
        output: {
            assetId: manifest.assetId,
            revision: manifest.revision,
            scopeHash: manifest.scopeHash,
            rubricHash: manifest.rubricHash,
            referenceHash: manifest.referenceHash,
            manifestHash: manifest.manifestHash,
            status: 'PASS',
            criteria: Array.from({ length: 10 }, (_, index) => ({
                id: `C${index + 1}`,
                score: 10,
                justification: `Criterion ${index + 1} supported by the attached views.`,
                evidenceIds: ['front', 'detail']
            })),
            total: 100,
            coveredRequirements: [...manifest.requiredRequirements],
            inspectedEvidence: [...manifest.requiredEvidence],
            open_findings: [],
            unverified: [],
            improvements: [],
            resolvedFindingIds: []
        }
    }));
    return {
        manifest,
        producerSessionId: 'producer-session',
        reviewers,
        visualProbePassed: true,
        verifiedVisualReceipts: reviewers.map(({ output, ...binding }) => ({ ...structuredClone(binding), verified: true }))
    };
}

function finding(id = 'F1') {
    return { id, criterionId: 'C1', justification: 'The silhouette needs correction.', evidenceIds: ['front'] };
}

function syncReceipt(input, index) {
    const { output, ...binding } = input.reviewers[index];
    input.verifiedVisualReceipts[index] = { ...structuredClone(binding), verified: true };
}

function reviewCase(name, change, verdict = 'WAIT', reason) {
    test(name, () => {
        const input = fixture();
        change(input);
        const before = structuredClone(input);
        const actual = validateProductionReview(input);
        assert.equal(actual.verdict, verdict, JSON.stringify(actual.reasons));
        assert.deepEqual(input, before, 'validation must not mutate input');
        assert.deepEqual(validateProductionReview(input), actual, 'validation must be deterministic');
        if (verdict === 'ACCEPT') assert.deepEqual(actual.reasons, []);
        else assert.ok(actual.reasons.length > 0);
        if (reason) assert.ok(actual.reasons.some(item => item.includes(reason)), JSON.stringify(actual.reasons));
    });
}

test('exports the validator from the built shared entrypoint and accepts two complete reviews', () => {
    assert.equal(typeof validateProductionReview, 'function');
    assert.deepEqual(validateProductionReview(fixture()), { verdict: 'ACCEPT', reasons: [] });
});

reviewCase('set and criterion ordering does not affect acceptance', input => {
    input.manifest.requiredRequirements.reverse();
    input.manifest.requiredEvidence.reverse();
    input.reviewers.reverse();
    for (const reviewer of input.reviewers) {
        reviewer.output.criteria.reverse();
        reviewer.output.coveredRequirements.reverse();
        reviewer.output.inspectedEvidence.reverse();
        reviewer.output.criteria[0].evidenceIds.reverse();
        reviewer.evidenceIds.reverse();
    }
    input.verifiedVisualReceipts[0].evidenceIds.reverse();
}, 'ACCEPT');

reviewCase('criteria can cite nonempty subsets of the inspected evidence', input => {
    input.reviewers[0].output.criteria[0].evidenceIds = ['front'];
}, 'ACCEPT');

reviewCase('does not guess semantic caveats from justification text', input => {
    input.reviewers[0].output.criteria[0].justification = 'Not verified visually; needs improvement. BLOCKED?';
}, 'ACCEPT');

for (const [index, role] of ['artistic', 'technical'].entries()) {
    reviewCase(`${role}: 99 is not accepted even when status is PASS`, input => {
        input.reviewers[index].output.criteria[0].score = 9;
        input.reviewers[index].output.total = 99;
    }, 'REVISE', 'every criterion must score 10');

    reviewCase(`${role}: a consistent fractional score requires revision`, input => {
        input.reviewers[index].output.criteria[0].score = 9.5;
        input.reviewers[index].output.total = 99.5;
    }, 'REVISE');

    reviewCase(`${role}: a score just below ten must not round up to acceptance`, input => {
        input.reviewers[index].output.criteria[0].score = 9.999999999999998;
        input.reviewers[index].output.total = input.reviewers[index].output.criteria.reduce((sum, item) => sum + item.score, 0);
        assert.equal(input.reviewers[index].output.total, 100);
    }, 'REVISE');

    reviewCase(`${role}: REVISE overrides an otherwise clean 100`, input => {
        input.reviewers[index].output.status = 'REVISE';
    }, 'REVISE', 'reviewer requests revision');

    reviewCase(`${role}: BLOCKED waits`, input => {
        input.reviewers[index].output.status = 'BLOCKED';
    }, 'WAIT', 'reviewer is BLOCKED');

    for (const field of ['open_findings', 'unverified', 'improvements']) {
        reviewCase(`${role}: PASS with ${field} requires revision`, input => {
            input.reviewers[index].output[field] = [finding()];
        }, 'REVISE', `${field}: contains outstanding issues`);
    }
}

reviewCase('WAIT takes precedence over REVISE, retaining both diagnostics', input => {
    input.reviewers[0].output.status = 'REVISE';
    input.reviewers[1].output.status = 'BLOCKED';
}, 'WAIT', 'reviewer requests revision');

reviewCase('malformed partial REVISE output waits instead of triggering an automatic retry', input => {
    input.reviewers[0].output = { status: 'REVISE' };
});

for (const value of [undefined, null, true, 1, 'PASS', [], new Date(0)]) {
    test(`malformed root ${String(value)} waits without throwing`, () => {
        assert.equal(validateProductionReview(value).verdict, 'WAIT');
    });
    reviewCase(`malformed output ${String(value)} waits without throwing`, input => {
        input.reviewers[0].output = value;
    });
}

for (const field of Object.keys(fixture())) {
    reviewCase(`missing required host field ${field} waits`, input => { delete input[field]; });
    reviewCase(`null host field ${field} waits`, input => { input[field] = null; });
}
for (const field of Object.keys(fixture().manifest)) {
    reviewCase(`missing manifest field ${field} waits`, input => { delete input.manifest[field]; });
    reviewCase(`null manifest field ${field} waits`, input => { input.manifest[field] = null; });
}
for (const field of Object.keys(fixture().reviewers[0].output)) {
    reviewCase(`missing output field ${field} waits`, input => { delete input.reviewers[0].output[field]; });
    reviewCase(`null output field ${field} waits`, input => { input.reviewers[0].output[field] = null; });
}
for (const field of Object.keys(fixture().reviewers[0])) {
    reviewCase(`missing trusted assignment field ${field} waits`, input => { delete input.reviewers[0][field]; });
    reviewCase(`null trusted assignment field ${field} waits`, input => { input.reviewers[0][field] = null; });
}
for (const field of Object.keys(fixture().verifiedVisualReceipts[0])) {
    reviewCase(`missing receipt field ${field} waits`, input => { delete input.verifiedVisualReceipts[0][field]; });
    reviewCase(`null receipt field ${field} waits`, input => { input.verifiedVisualReceipts[0][field] = null; });
}

for (const field of ['scopeHash', 'rubricHash', 'referenceHash', 'manifestHash']) {
    reviewCase(`old output ${field} waits`, input => { input.reviewers[0].output[field] = 'f'.repeat(64); });
    for (const value of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), `${'a'.repeat(64)}\n`, 123]) {
        reviewCase(`manifest ${field} rejects non-lowercase-SHA256 value ${JSON.stringify(value)}`, input => {
            input.manifest[field] = value;
            for (const reviewer of input.reviewers) reviewer.output[field] = value;
        });
    }
}
for (const value of [0, -1, 1.5, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    reviewCase(`invalid revision ${String(value)} waits even when reviewers echo it`, input => {
        input.manifest.revision = value;
        for (const reviewer of input.reviewers) reviewer.output.revision = value;
    });
}
reviewCase('stale output revision waits', input => { input.reviewers[0].output.revision = 1; });
reviewCase('wrong output asset waits', input => { input.reviewers[1].output.assetId = 'asset-b'; });
reviewCase('blank manifest asset waits', input => { input.manifest.assetId = ' '; });
reviewCase('extra manifest fields are not silently ignored', input => { input.manifest.unknown = true; });
reviewCase('extra host fields are not silently ignored', input => { input.forceAccept = true; });

for (const count of [0, 1, 3]) {
    reviewCase(`${count} reviewer assignments waits`, input => {
        input.reviewers = Array.from({ length: count }, (_, index) => structuredClone(input.reviewers[index % 2]));
    });
    reviewCase(`${count} visual receipts waits`, input => {
        input.verifiedVisualReceipts = Array.from({ length: count }, (_, index) => structuredClone(input.verifiedVisualReceipts[index % 2]));
    });
}
for (const field of ['role', 'invocationId', 'sessionId']) {
    reviewCase(`duplicate reviewer ${field} waits even with matching receipts`, input => {
        input.reviewers[1][field] = input.reviewers[0][field];
        syncReceipt(input, 1);
    }, 'WAIT', field === 'role' ? 'duplicate reviewer role' : 'must be distinct');
}
reviewCase('unknown reviewer role waits', input => { input.reviewers[0].role = 'judge'; });
reviewCase('producer invocation cannot judge its own output', input => {
    input.reviewers[0].invocationId = input.manifest.producerInvocationId;
    syncReceipt(input, 0);
}, 'WAIT', 'must differ from producer invocation');
reviewCase('a new invocation in the producer session cannot judge its own output', input => {
    input.reviewers[0].sessionId = input.producerSessionId;
    syncReceipt(input, 0);
}, 'WAIT', 'must differ from producer session');
for (const field of ['invocationId', 'sessionId']) {
    reviewCase(`blank trusted ${field} waits`, input => { input.reviewers[0][field] = ' \n'; });
}

for (const value of [false, 'true', 1, undefined]) {
    reviewCase(`visual probe assertion ${String(value)} cannot grant acceptance`, input => { input.visualProbePassed = value; });
    reviewCase(`receipt verification ${String(value)} cannot grant acceptance`, input => { input.verifiedVisualReceipts[1].verified = value; });
}
for (const field of ['invocationId', 'sessionId', 'attachmentsDigest', 'manifestHash']) {
    reviewCase(`receipt ${field} must match its assignment`, input => {
        input.verifiedVisualReceipts[0][field] = field.endsWith('Id') ? 'different-id' : 'f'.repeat(64);
    });
}
reviewCase('duplicate receipt roles wait', input => { input.verifiedVisualReceipts[1] = structuredClone(input.verifiedVisualReceipts[0]); });
reviewCase('old trusted assignment manifest waits', input => {
    input.reviewers[0].manifestHash = 'f'.repeat(64);
    syncReceipt(input, 0);
});
reviewCase('matching per-reviewer receipts cannot hide differing attachment digests', input => {
    input.reviewers[1].attachmentsDigest = 'f'.repeat(64);
    syncReceipt(input, 1);
}, 'WAIT', 'same frozen attachments');
reviewCase('a malformed attachment digest waits even if both assignments and receipts echo it', input => {
    for (let index = 0; index < 2; index++) {
        input.reviewers[index].attachmentsDigest = 'E'.repeat(64);
        syncReceipt(input, index);
    }
});

for (const field of ['role', 'invocationId', 'sessionId', 'attachmentsDigest', 'visualProbePassed', 'verifiedVisualReceipts', 'verified', 'approved', 'unresolvedByRole']) {
    reviewCase(`output cannot smuggle trusted field ${field}`, input => { input.reviewers[0].output[field] = true; });
}
reviewCase('model-authored probe success cannot replace host probe failure', input => {
    input.visualProbePassed = false;
    input.reviewers[0].output.visualProbePassed = true;
});

const setTargets = [
    ['manifest.requiredRequirements', input => [input.manifest, 'requiredRequirements']],
    ['manifest.requiredEvidence', input => [input.manifest, 'requiredEvidence']],
    ['coveredRequirements', input => [input.reviewers[0].output, 'coveredRequirements']],
    ['inspectedEvidence', input => [input.reviewers[0].output, 'inspectedEvidence']],
    ['assignment.evidenceIds', input => [input.reviewers[0], 'evidenceIds']],
    ['receipt.evidenceIds', input => [input.verifiedVisualReceipts[0], 'evidenceIds']],
    ['criterion.evidenceIds', input => [input.reviewers[0].output.criteria[0], 'evidenceIds']]
];
for (const [name, target] of setTargets) {
    for (const [label, value] of [['empty', []], ['null', null], ['missing', undefined], ['not array', 'front'], ['blank ID', [' ']], ['nonstring ID', [1]], ['sparse', new Array(2)]]) {
        reviewCase(`${name} rejects ${label}`, input => {
            const [object, key] = target(input);
            object[key] = value;
        });
    }
    reviewCase(`${name} rejects duplicate IDs`, input => {
        const [object, key] = target(input);
        object[key] = [object[key][0], object[key][0]];
    });
    if (!name.startsWith('manifest.')) {
        reviewCase(`${name} rejects unknown IDs`, input => {
            const [object, key] = target(input);
            object[key][0] = 'unknown';
        });
        if (!name.startsWith('criterion.')) {
            reviewCase(`${name} rejects partial coverage`, input => {
                const [object, key] = target(input);
                object[key].pop();
            });
        }
        reviewCase(`${name} rejects extra evidence or scope`, input => {
            const [object, key] = target(input);
            object[key].push('extra');
        });
    }
}

for (const value of [[], new Array(10), 'C1..C10', {}, [null]]) {
    reviewCase(`malformed criteria ${JSON.stringify(value)} wait`, input => { input.reviewers[0].output.criteria = value; });
}
reviewCase('nine criteria wait', input => { input.reviewers[0].output.criteria.pop(); });
reviewCase('eleven criteria wait', input => { input.reviewers[0].output.criteria.push(structuredClone(input.reviewers[0].output.criteria[0])); });
reviewCase('duplicate criterion IDs wait even with ten scores totaling 100', input => { input.reviewers[0].output.criteria[9].id = 'C1'; });
for (const value of ['C0', 'C11', 'c1', 1, null]) {
    reviewCase(`invalid criterion ID ${String(value)} waits`, input => { input.reviewers[0].output.criteria[0].id = value; });
}
for (const field of ['id', 'score', 'justification', 'evidenceIds']) {
    reviewCase(`missing criterion ${field} waits`, input => { delete input.reviewers[0].output.criteria[0][field]; });
}
reviewCase('unexpected criterion field waits', input => { input.reviewers[0].output.criteria[0].approved = true; });
for (const value of ['10', null, undefined, NaN, Infinity, -Infinity, -1, 10.1, true]) {
    reviewCase(`invalid score ${String(value)} waits`, input => { input.reviewers[0].output.criteria[0].score = value; });
}
for (const value of ['100', null, undefined, NaN, Infinity, -1, 101, 99, true]) {
    reviewCase(`invalid or inconsistent total ${String(value)} waits`, input => { input.reviewers[0].output.total = value; });
}
reviewCase('fabricated total 100 cannot hide a score of 9', input => { input.reviewers[0].output.criteria[0].score = 9; }, 'WAIT', 'recomputed score sum');
reviewCase('zero scores with a consistent total revise rather than wait', input => {
    for (const criterion of input.reviewers[0].output.criteria) criterion.score = 0;
    input.reviewers[0].output.total = 0;
}, 'REVISE');
for (const value of ['', ' \n ', null, 123]) {
    reviewCase(`invalid justification ${JSON.stringify(value)} waits`, input => { input.reviewers[0].output.criteria[0].justification = value; });
}
for (const value of ['pass', 'ACCEPT', '', 100, {}, undefined]) {
    reviewCase(`invalid status ${JSON.stringify(value)} waits`, input => { input.reviewers[0].output.status = value; });
}

for (const field of ['open_findings', 'unverified', 'improvements']) {
    for (const [label, value] of [['object', {}], ['string', 'none'], ['sparse', new Array(1)], ['null item', [null]], ['text item', ['no issues']], ['empty item', [{}]]]) {
        reviewCase(`${field}: malformed ${label} waits`, input => { input.reviewers[0].output[field] = value; });
    }
    for (const key of Object.keys(finding())) {
        reviewCase(`${field}: missing structured finding ${key} waits`, input => {
            const issue = finding();
            delete issue[key];
            input.reviewers[0].output[field] = [issue];
        });
    }
    for (const [key, value] of [['id', ' '], ['criterionId', 'C11'], ['justification', ' '], ['evidenceIds', ['unknown']], ['evidenceIds', ['front', 'front']], ['evidenceIds', null], ['extra', true]]) {
        reviewCase(`${field}: invalid finding ${key}=${JSON.stringify(value)} waits`, input => {
            input.reviewers[0].output[field] = [{ ...finding(), [key]: value }];
        });
    }
    reviewCase(`${field}: duplicate finding IDs wait`, input => {
        input.reviewers[0].output[field] = [finding(), finding()];
    });
}
reviewCase('unverified may describe an issue with no available evidence', input => {
    input.reviewers[0].output.unverified = [{ ...finding(), evidenceIds: [] }];
}, 'REVISE');
for (const field of ['open_findings', 'improvements']) {
    reviewCase(`${field} findings require evidence`, input => {
        input.reviewers[0].output[field] = [{ ...finding(), evidenceIds: [] }];
    });
}
reviewCase('finding IDs must be unique across issue arrays', input => {
    input.reviewers[0].output.open_findings = [finding()];
    input.reviewers[0].output.improvements = [finding()];
});

reviewCase('both reviewers resolve their own historical IDs without cross-role resolution', input => {
    input.unresolvedByRole = { artistic: ['A1', 'A2'], technical: ['T1'] };
    input.reviewers[0].output.resolvedFindingIds = ['A2', 'A1'];
    input.reviewers[1].output.resolvedFindingIds = ['T1'];
}, 'ACCEPT');
reviewCase('one role may have history while the other has none', input => {
    input.unresolvedByRole = { technical: ['T1'] };
    input.reviewers[1].output.resolvedFindingIds = ['T1'];
}, 'ACCEPT');
reviewCase('identical IDs in different role histories are independently resolved', input => {
    input.unresolvedByRole = { artistic: ['F1'], technical: ['F1'] };
    for (const reviewer of input.reviewers) reviewer.output.resolvedFindingIds = ['F1'];
}, 'ACCEPT');
reviewCase('explicit empty histories are valid', input => {
    input.unresolvedByRole = { artistic: [], technical: [] };
}, 'ACCEPT');
for (const [index, role] of ['artistic', 'technical'].entries()) {
    reviewCase(`${role}: dropping historical findings does not erase them`, input => {
        input.unresolvedByRole = { [role]: ['old-finding'] };
    }, 'REVISE', 'historical findings remain unresolved');
    reviewCase(`${role}: partial historical resolution requires revision`, input => {
        input.unresolvedByRole = { [role]: ['F1', 'F2'] };
        input.reviewers[index].output.resolvedFindingIds = ['F1'];
    }, 'REVISE');
    reviewCase(`${role}: unresolved historical findings may remain explicitly open`, input => {
        input.unresolvedByRole = { [role]: ['F1'] };
        input.reviewers[index].output.open_findings = [finding()];
    }, 'REVISE');
    reviewCase(`${role}: reviewer dropout cannot reuse a previous approval`, input => {
        input.unresolvedByRole = { [role]: ['F1'] };
        input.reviewers.splice(index, 1);
    });
}
reviewCase('a reviewer cannot resolve the other role history', input => {
    input.unresolvedByRole = { technical: ['T1'] };
    input.reviewers[0].output.resolvedFindingIds = ['T1'];
}, 'WAIT', "outside this role's host history");
reviewCase('invented resolutions with omitted history wait', input => { input.reviewers[0].output.resolvedFindingIds = ['invented']; });
for (const field of ['open_findings', 'unverified', 'improvements']) {
    reviewCase(`a finding cannot be resolved while present in ${field}`, input => {
        input.unresolvedByRole = { artistic: ['F1'] };
        input.reviewers[0].output.resolvedFindingIds = ['F1'];
        input.reviewers[0].output[field] = [finding()];
    }, 'WAIT', 'both resolved and outstanding');
}
for (const value of [null, undefined, [], 'none', { other: [] }, { artistic: null }, { artistic: undefined }, { technical: ['F1', 'F1'] }, { artistic: [''] }]) {
    reviewCase(`malformed host history ${JSON.stringify(value)} waits`, input => { input.unresolvedByRole = value; });
}
for (const value of [{}, 'none', ['F1', 'F1'], [''], [1], new Array(1)]) {
    reviewCase(`malformed resolved IDs ${JSON.stringify(value)} wait`, input => { input.reviewers[0].output.resolvedFindingIds = value; });
}

test('host history survives revisions and a missing reviewer until explicitly resolved', () => {
    const first = fixture();
    first.reviewers[0].output.open_findings = [finding('A-old')];
    assert.equal(validateProductionReview(first).verdict, 'REVISE');

    const next = fixture();
    next.unresolvedByRole = { artistic: ['A-old'] };
    next.manifest.revision = 3;
    next.manifest.manifestHash = '1'.repeat(64);
    for (let index = 0; index < 2; index++) {
        next.reviewers[index].manifestHash = next.manifest.manifestHash;
        next.reviewers[index].output.revision = next.manifest.revision;
        next.reviewers[index].output.manifestHash = next.manifest.manifestHash;
        syncReceipt(next, index);
    }
    assert.equal(validateProductionReview(next).verdict, 'REVISE');
    const dropout = structuredClone(next);
    dropout.reviewers[0].output = null;
    assert.equal(validateProductionReview(dropout).verdict, 'WAIT');
    assert.deepEqual(dropout.unresolvedByRole, { artistic: ['A-old'] });
    next.reviewers[0].output.resolvedFindingIds = ['A-old'];
    assert.deepEqual(validateProductionReview(next), { verdict: 'ACCEPT', reasons: [] });
});

test('frozen inputs and null-prototype parsed records are supported without mutation', () => {
    const input = fixture();
    input.reviewers[0].output = Object.assign(Object.create(null), input.reviewers[0].output);
    function freeze(value) {
        if (value && typeof value === 'object') {
            for (const child of Object.values(value)) freeze(child);
            Object.freeze(value);
        }
    }
    freeze(input);
    assert.deepEqual(validateProductionReview(input), { verdict: 'ACCEPT', reasons: [] });
});

test('inherited output fields cannot satisfy the strict schema', () => {
    const input = fixture();
    input.reviewers[0].output = Object.create(input.reviewers[0].output);
    assert.equal(validateProductionReview(input).verdict, 'WAIT');
});
