import { AcceptanceCriterionSchema, type AcceptanceCriterion, type AcceptanceCoverage } from '@adw/contracts';
export interface TestObservation {
    title: string;
    status: 'passed' | 'failed' | 'not_verified';
    reason?: string;
}
export function linkAcceptance(criteria: readonly AcceptanceCriterion[], observations: readonly TestObservation[], acceptance?: readonly string[]): {
    coverage: AcceptanceCoverage[];
    ready: boolean;
    warnings: string[];
} {
    const parsed = criteria.map(criterion => AcceptanceCriterionSchema.parse(criterion));
    if (new Set(parsed.map(criterion => criterion.id)).size !== parsed.length)
        throw new Error('Duplicate acceptance IDs');
    if (new Set(observations.map(test => test.title)).size !== observations.length)
        throw new Error('Duplicate observed test titles');
    const tests = new Map(observations.map(test => [test.title, test]));
    const warnings: string[] = [];
    const coverage: AcceptanceCoverage[] = parsed.map(criterion => {
        if (acceptance&&criterion.required&&criterion.acceptanceIndex===undefined||criterion.acceptanceIndex !== undefined && (!acceptance || criterion.acceptanceIndex >= acceptance.length || !criterion.required))
            throw new Error('Acceptance mapping differs from locked spec');
        const outcomes = criterion.tests.map(title => tests.get(title));
        const status = outcomes.some(test => test?.status === 'failed') ? 'failed' : !outcomes.length || outcomes.some(test => !test || test.status === 'not_verified') ? 'not_verified' : 'passed';
        const reason = status === 'passed' ? undefined : status === 'not_verified' ? 'Missing/unexecuted mapped scenario' : 'Mapped scenario failed';
        if (reason)
            warnings.push(`${criterion.id}: ${reason}${criterion.required ? ' (required)' : ' (optional)'}`);
        return { ...criterion, status, notVerified: status !== 'passed', ...(reason ? { reason } : {}) };
    });
    if (!coverage.length) {
        coverage.push({ id: 'web.acceptance_map_missing', required: true, status: 'not_verified', notVerified: true, tests: [], reason: 'Missing acceptance map' });
        warnings.push('Missing acceptance map: required web coverage is not verified');
    }
    return { coverage, ready: coverage.every(criterion => !criterion.required || criterion.status === 'passed'), warnings };
}
export const isVerificationTestPath = (path: string): boolean => /(^|\/)(__tests__|tests?|e2e|specs?)(\/|$)|\.(test|spec)\.[^/]+$|(^|\/)(acceptanceMap\.json|playwright\.config\.[^/]+)$/i.test(path);
export function listChangedTestPaths(diff: string): string[] {
    const paths = new Set<string>();
    for (const line of diff.split('\n'))
        if (line.startsWith('+++ ') || line.startsWith('--- ')) {
            let path = line.slice(4);
            if (path === '/dev/null')
                continue;
            if (path.startsWith('"')) {
                try {
                    path = JSON.parse(path);
                }
                catch {
                    continue;
                }
            }
            path = path.replace(/^[ab]\//, '');
            if (isVerificationTestPath(path))
                paths.add(path);
        }
    return [...paths];
}
