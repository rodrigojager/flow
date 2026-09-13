/**
 * Pure, fail-closed review policy for one frozen asset revision. No agents, file
 * access, hashing, retries, or approvals are performed here. The host owns the
 * production/review loop and must preserve unresolved IDs across revisions.
 *
 * Trust boundary: only `output` is model-authored. All other inputs must come
 * from trusted host state, never from fields echoed by a model. Before invoking
 * reviewers AND immediately before committing an approval, the host must rehash
 * the actual asset, scope, rubric, references and evidence, verify the frozen
 * manifest and attachment digests, and invalidate stale reviews. Digest syntax
 * and equality here are NOT a cryptographic oracle or proof of file contents.
 *
 * The host must perform a real visual probe and externally verify delivery and
 * inspection receipts for both independent reviewer invocations/sessions. The
 * booleans below are host assertions about those checks, not checks themselves.
 * This policy cannot prove semantic honesty, actual visual understanding, or
 * the absence of caveats in prose. Issues must be reported in structured fields;
 * justification text is not classified with keyword/regex heuristics.
 */

export type ProductionReviewerRole = 'artistic' | 'technical';
export type ProductionReviewCriterionId = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6' | 'C7' | 'C8' | 'C9' | 'C10';
export type ProductionReviewStatus = 'PASS' | 'REVISE' | 'BLOCKED';
export type ProductionReviewVerdict = 'ACCEPT' | 'REVISE' | 'WAIT';

export interface FrozenProductionManifest {
    assetId: string;
    /** Positive safe integer identifying this immutable revision. */
    revision: number;
    scopeHash: string;
    rubricHash: string;
    referenceHash: string;
    manifestHash: string;
    /** Nonempty sets of opaque, nonblank IDs, with no duplicates. */
    requiredRequirements: string[];
    requiredEvidence: string[];
    producerInvocationId: string;
}

export interface ProductionReviewCriterion {
    id: ProductionReviewCriterionId;
    /** Finite number in [0, 10]; acceptance requires every score to equal 10. */
    score: number;
    justification: string;
    /** Nonempty subset of the manifest's required evidence. */
    evidenceIds: string[];
}

/** Shared structured issue schema for all three issue arrays. */
export interface ProductionReviewFinding {
    id: string;
    criterionId: ProductionReviewCriterionId;
    justification: string;
    /** Known evidence IDs; may be empty only in `unverified`. */
    evidenceIds: string[];
}

/** Exact model-output schema: all fields required, no additional properties. */
export interface ProductionReviewOutput {
    assetId: string;
    revision: number;
    scopeHash: string;
    rubricHash: string;
    referenceHash: string;
    manifestHash: string;
    status: ProductionReviewStatus;
    criteria: ProductionReviewCriterion[];
    /** Exact unrounded sum of scores in C1 through C10 order. */
    total: number;
    coveredRequirements: string[];
    inspectedEvidence: string[];
    open_findings: ProductionReviewFinding[];
    unverified: ProductionReviewFinding[];
    improvements: ProductionReviewFinding[];
    resolvedFindingIds: string[];
}

/** Trusted transport metadata kept outside the untrusted parsed model output. */
export interface TrustedProductionReviewerAssignment {
    role: ProductionReviewerRole;
    invocationId: string;
    sessionId: string;
    attachmentsDigest: string;
    manifestHash: string;
    evidenceIds: string[];
    output: unknown;
}

/** Host-verified receipt bound to the exact assignment and frozen attachments. */
export interface VerifiedProductionVisualReceipt extends Omit<TrustedProductionReviewerAssignment, 'output'> {
    verified: boolean;
}

export interface ProductionReviewInput {
    manifest: FrozenProductionManifest;
    /** Required separately because the manifest only records producer invocation. */
    producerSessionId: string;
    /** Exactly one artistic and one technical assignment. */
    reviewers: TrustedProductionReviewerAssignment[];
    visualProbePassed: boolean;
    /** Exactly one externally verified receipt per assignment; no opt-out. */
    verifiedVisualReceipts: VerifiedProductionVisualReceipt[];
    /**
     * Host-owned outstanding IDs per role, including issues from older revisions.
     * Each reviewer must resolve exactly its own outstanding set, not the other
     * role's IDs. Omitted roles/history assert there are no outstanding IDs.
     * Persist newly reported issues; never clear history just because an output
     * drops an ID or a reviewer fails to return. This validator does not mutate it.
     */
    unresolvedByRole?: Partial<Record<ProductionReviewerRole, string[]>>;
}

export interface ProductionReviewResult {
    verdict: ProductionReviewVerdict;
    /** Deterministic diagnostics with input paths; empty only on ACCEPT. */
    reasons: string[];
}

const ROLES: ProductionReviewerRole[] = ['artistic', 'technical'];
const CRITERIA: ProductionReviewCriterionId[] = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10'];
const HASH_FIELDS = ['scopeHash', 'rubricHash', 'referenceHash', 'manifestHash'] as const;
const REVISION_FIELDS = ['assetId', 'revision', ...HASH_FIELDS] as const;
const BINDING_FIELDS = ['role', 'invocationId', 'sessionId', 'attachmentsDigest', 'manifestHash', 'evidenceIds'] as const;
const ISSUE_FIELDS = ['open_findings', 'unverified', 'improvements'] as const;

/**
 * Validate plain data (including raw JSON-parsed output), without coercion or
 * mutation. Malformed/inconsistent input, BLOCKED, or missing host proof => WAIT;
 * valid incomplete reviews/issues/history/scores below 100 => REVISE; only two
 * clean PASS reviews at 100/100 => ACCEPT. WAIT takes precedence over REVISE.
 * Executable objects (getters/proxies) are outside this plain-data contract.
 */
export function validateProductionReview(input: ProductionReviewInput): ProductionReviewResult {
    const waiting: string[] = [];
    const revising: string[] = [];
    const result = (): ProductionReviewResult => ({
        verdict: waiting.length ? 'WAIT' : revising.length ? 'REVISE' : 'ACCEPT',
        reasons: [...waiting, ...revising]
    });
    const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
    const hash = (value: unknown): boolean => typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
    const criterionId = (value: unknown): value is ProductionReviewCriterionId => CRITERIA.includes(value as ProductionReviewCriterionId);

    function object(value: unknown, keys: readonly string[], path: string, optional: readonly string[] = []): Record<string, unknown> | undefined {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
            waiting.push(`${path}: expected a plain object`);
            return undefined;
        }
        if (keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key) && !optional.includes(key))) {
            waiting.push(`${path}: missing required fields or unexpected fields`);
            return undefined;
        }
        return value as Record<string, unknown>;
    }

    function ids(value: unknown, path: string, allowEmpty = false): string[] | undefined {
        if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
            || !Array.from(value).every(text) || new Set(value).size !== value.length) {
            waiting.push(`${path}: expected ${allowEmpty ? 'a' : 'a nonempty'} duplicate-free array of nonblank string IDs`);
            return undefined;
        }
        return value;
    }

    function sameSet(actual: string[] | undefined, expected: readonly string[], path: string): void {
        if (actual && (actual.length !== expected.length || actual.some(id => !expected.includes(id)))) {
            waiting.push(`${path}: must exactly match the frozen manifest set`);
        }
    }

    const root = object(input, ['manifest', 'producerSessionId', 'reviewers', 'visualProbePassed', 'verifiedVisualReceipts'], 'input', ['unresolvedByRole']);
    if (!root) return result();
    const manifest = object(root.manifest, [...REVISION_FIELDS, 'requiredRequirements', 'requiredEvidence', 'producerInvocationId'], 'manifest');
    if (!manifest) return result();
    for (const field of ['assetId', 'producerInvocationId']) {
        if (!text(manifest[field])) waiting.push(`manifest.${field}: expected a nonblank string`);
    }
    if (typeof manifest.revision !== 'number' || !Number.isSafeInteger(manifest.revision) || manifest.revision < 1) {
        waiting.push('manifest.revision: expected a positive safe integer');
    }
    for (const field of HASH_FIELDS) {
        if (!hash(manifest[field])) waiting.push(`manifest.${field}: expected lowercase SHA-256 hex`);
    }
    const requiredRequirements = ids(manifest.requiredRequirements, 'manifest.requiredRequirements');
    const requiredEvidence = ids(manifest.requiredEvidence, 'manifest.requiredEvidence');
    if (!requiredRequirements || !requiredEvidence || waiting.length) return result();
    const knownEvidence = new Set(requiredEvidence);

    function evidence(value: unknown, path: string, allowEmpty = false): string[] | undefined {
        const list = ids(value, path, allowEmpty);
        if (list?.some(id => !knownEvidence.has(id))) waiting.push(`${path}: contains evidence outside the frozen manifest`);
        return list;
    }

    if (!text(root.producerSessionId)) waiting.push('producerSessionId: expected a nonblank trusted producer session');
    if (root.visualProbePassed !== true) waiting.push('visualProbePassed: requires a successful external host probe');
    const history: Record<ProductionReviewerRole, string[]> = { artistic: [], technical: [] };
    if (Object.hasOwn(root, 'unresolvedByRole')) {
        const prior = object(root.unresolvedByRole, [], 'unresolvedByRole', ROLES);
        if (prior) {
            for (const role of ROLES) {
                if (Object.hasOwn(prior, role)) history[role] = ids(prior[role], `unresolvedByRole.${role}`, true) ?? [];
            }
        }
    }

    function binding(raw: unknown, path: string, extraField: 'output' | 'verified') {
        const value = object(raw, [...BINDING_FIELDS, extraField], path);
        if (!value) return undefined;
        const before = waiting.length;
        if (value.role !== 'artistic' && value.role !== 'technical') waiting.push(`${path}.role: expected artistic or technical`);
        for (const field of ['invocationId', 'sessionId']) {
            if (!text(value[field])) waiting.push(`${path}.${field}: expected a nonblank trusted ID`);
        }
        if (value.invocationId === manifest!.producerInvocationId) waiting.push(`${path}.invocationId: must differ from producer invocation`);
        if (value.sessionId === root!.producerSessionId) waiting.push(`${path}.sessionId: must differ from producer session`);
        for (const field of ['attachmentsDigest', 'manifestHash']) {
            if (!hash(value[field])) waiting.push(`${path}.${field}: expected lowercase SHA-256 hex`);
        }
        if (value.manifestHash !== manifest!.manifestHash) waiting.push(`${path}.manifestHash: stale or different manifest`);
        sameSet(ids(value.evidenceIds, `${path}.evidenceIds`), requiredEvidence!, `${path}.evidenceIds`);
        if (waiting.length !== before) return undefined;
        return value as Record<string, unknown> & Omit<TrustedProductionReviewerAssignment, 'output'>;
    }

    const receipts = new Map<ProductionReviewerRole, Omit<TrustedProductionReviewerAssignment, 'output'>>();
    if (!Array.isArray(root.verifiedVisualReceipts) || root.verifiedVisualReceipts.length !== 2) {
        waiting.push('verifiedVisualReceipts: expected exactly two host-verified receipts');
    } else {
        for (const [index, raw] of root.verifiedVisualReceipts.entries()) {
            const path = `verifiedVisualReceipts[${index}]`;
            const receipt = binding(raw, path, 'verified');
            if (!receipt) continue;
            if (receipt.verified !== true) waiting.push(`${path}.verified: requires real external host verification`);
            if (receipts.has(receipt.role)) waiting.push(`${path}.role: duplicate receipt role`);
            receipts.set(receipt.role, receipt);
        }
    }

    if (!Array.isArray(root.reviewers) || root.reviewers.length !== 2) {
        waiting.push('reviewers: expected exactly two trusted assignments');
        return result();
    }
    const roles = new Set<ProductionReviewerRole>();
    const invocations = new Set<string>();
    const sessions = new Set<string>();
    const attachmentDigests = new Set<string>();
    for (const [index, raw] of root.reviewers.entries()) {
        const path = `reviewers[${index}]`;
        const reviewer = binding(raw, path, 'output');
        if (!reviewer) continue;
        if (roles.has(reviewer.role)) waiting.push(`${path}.role: duplicate reviewer role`);
        if (invocations.has(reviewer.invocationId)) waiting.push(`${path}.invocationId: reviewer invocations must be distinct`);
        if (sessions.has(reviewer.sessionId)) waiting.push(`${path}.sessionId: reviewer sessions must be distinct`);
        roles.add(reviewer.role);
        invocations.add(reviewer.invocationId);
        sessions.add(reviewer.sessionId);
        attachmentDigests.add(reviewer.attachmentsDigest);
        const receipt = receipts.get(reviewer.role);
        if (!receipt || ['invocationId', 'sessionId', 'attachmentsDigest', 'manifestHash'].some(field =>
            receipt[field as keyof typeof receipt] !== reviewer[field])) {
            waiting.push(`${path}: missing matching host-verified visual receipt`);
        }

        const outputPath = `${path}.output`;
        const output = object(reviewer.output, [...REVISION_FIELDS, 'status', 'criteria', 'total', 'coveredRequirements', 'inspectedEvidence', ...ISSUE_FIELDS, 'resolvedFindingIds'], outputPath);
        if (!output) continue;
        for (const field of REVISION_FIELDS) {
            if (output[field] !== manifest[field]) waiting.push(`${outputPath}.${field}: must match the frozen manifest`);
        }
        if (!['PASS', 'REVISE', 'BLOCKED'].includes(output.status as string)) waiting.push(`${outputPath}.status: invalid status`);
        if (output.status === 'BLOCKED') waiting.push(`${outputPath}.status: reviewer is BLOCKED`);
        if (output.status === 'REVISE') revising.push(`${outputPath}.status: reviewer requests revision`);
        sameSet(ids(output.coveredRequirements, `${outputPath}.coveredRequirements`), requiredRequirements, `${outputPath}.coveredRequirements`);
        sameSet(ids(output.inspectedEvidence, `${outputPath}.inspectedEvidence`), requiredEvidence, `${outputPath}.inspectedEvidence`);

        const scores = new Map<ProductionReviewCriterionId, number>();
        if (!Array.isArray(output.criteria) || output.criteria.length !== 10) {
            waiting.push(`${outputPath}.criteria: expected exactly ten criteria C1 through C10`);
        } else {
            for (const [criterionIndex, rawCriterion] of output.criteria.entries()) {
                const criterionPath = `${outputPath}.criteria[${criterionIndex}]`;
                const criterion = object(rawCriterion, ['id', 'score', 'justification', 'evidenceIds'], criterionPath);
                if (!criterion) continue;
                if (!criterionId(criterion.id)) waiting.push(`${criterionPath}.id: expected C1 through C10`);
                if (typeof criterion.score !== 'number' || !Number.isFinite(criterion.score) || criterion.score < 0 || criterion.score > 10) {
                    waiting.push(`${criterionPath}.score: expected a finite number in [0, 10]`);
                } else if (criterionId(criterion.id)) {
                    if (scores.has(criterion.id)) waiting.push(`${criterionPath}.id: duplicate criterion`);
                    scores.set(criterion.id, criterion.score);
                }
                if (!text(criterion.justification)) waiting.push(`${criterionPath}.justification: expected nonblank text`);
                evidence(criterion.evidenceIds, `${criterionPath}.evidenceIds`);
            }
        }
        if (typeof output.total !== 'number' || !Number.isFinite(output.total) || output.total < 0 || output.total > 100) {
            waiting.push(`${outputPath}.total: expected a finite number in [0, 100]`);
        }
        if (scores.size === 10) {
            const total = CRITERIA.reduce((sum, id) => sum + scores.get(id)!, 0);
            if (output.total !== total) waiting.push(`${outputPath}.total: does not equal the recomputed score sum (${total})`);
            // Checking each score also prevents floating-point rounding up to 100.
            if (CRITERIA.some(id => scores.get(id) !== 10)) revising.push(`${outputPath}.criteria: every criterion must score 10 for acceptance`);
        }

        const findingIds = new Set<string>();
        for (const field of ISSUE_FIELDS) {
            const list = output[field];
            const issuePath = `${outputPath}.${field}`;
            if (!Array.isArray(list)) {
                waiting.push(`${issuePath}: expected an explicit array`);
                continue;
            }
            if (list.length) revising.push(`${issuePath}: contains outstanding issues`);
            for (const [findingIndex, rawFinding] of list.entries()) {
                const findingPath = `${issuePath}[${findingIndex}]`;
                const finding = object(rawFinding, ['id', 'criterionId', 'justification', 'evidenceIds'], findingPath);
                if (!finding) continue;
                if (!text(finding.id)) waiting.push(`${findingPath}.id: expected a nonblank finding ID`);
                else {
                    if (findingIds.has(finding.id)) waiting.push(`${findingPath}.id: duplicate finding across issue arrays`);
                    findingIds.add(finding.id);
                }
                if (!criterionId(finding.criterionId)) waiting.push(`${findingPath}.criterionId: expected C1 through C10`);
                if (!text(finding.justification)) waiting.push(`${findingPath}.justification: expected nonblank text`);
                evidence(finding.evidenceIds, `${findingPath}.evidenceIds`, field === 'unverified');
            }
        }
        const resolved = ids(output.resolvedFindingIds, `${outputPath}.resolvedFindingIds`, true);
        if (resolved) {
            const prior = history[reviewer.role];
            if (resolved.some(id => !prior.includes(id))) waiting.push(`${outputPath}.resolvedFindingIds: contains IDs outside this role's host history`);
            if (resolved.some(id => findingIds.has(id))) waiting.push(`${outputPath}.resolvedFindingIds: an ID cannot be both resolved and outstanding`);
            if (prior.some(id => !resolved.includes(id))) revising.push(`${outputPath}.resolvedFindingIds: historical findings remain unresolved for ${reviewer.role}`);
        }
    }
    if (roles.size !== 2) waiting.push('reviewers: both artistic and technical roles are required');
    if (receipts.size !== 2) waiting.push('verifiedVisualReceipts: both artistic and technical roles are required');
    if (attachmentDigests.size > 1) waiting.push('reviewers.attachmentsDigest: both reviewers must inspect the same frozen attachments');
    return result();
}
