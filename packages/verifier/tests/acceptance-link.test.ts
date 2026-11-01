import { expect, it } from 'vitest';
import { linkAcceptance, listChangedTestPaths } from '../src/acceptance-link.js';
it('links observed scenarios to exact locked acceptance indices', () => {
    const linked = linkAcceptance([{ id: 'ui', acceptanceIndex: 0, required: true, tests: ['click'] }], [{ title: 'click', status: 'passed' }], ['Exact UI acceptance']);
    expect(linked.ready).toBe(true);
    expect(linked.coverage[0]).toMatchObject({ id: 'ui', status: 'passed', notVerified: false });
});
it('blocks missing maps, missing/unexecuted scenarios and required failures', () => {
    expect(linkAcceptance([], []).ready).toBe(false);
    for (const observations of [[], [{ title: 'click', status: 'not_verified' as const }], [{ title: 'click', status: 'failed' as const }]])
        expect(linkAcceptance([{ id: 'ui', required: true, tests: ['click'] }], observations).ready).toBe(false);
    expect(linkAcceptance([{ id: 'ui', required: true, tests: [] }], []).coverage[0]?.status).toBe('not_verified');
});
it('keeps optional failures visible as notVerified warnings without certifying the criterion', () => {
    const linked = linkAcceptance([{ id: 'optional', required: false, tests: ['click'] }], [{ title: 'click', status: 'failed' }]);
    expect(linked.ready).toBe(true);
    expect(linked.coverage[0]).toMatchObject({ status: 'failed', notVerified: true });
    expect(linked.warnings[0]).toContain('optional');
});
it('rejects duplicate IDs/titles, invalid spec indices and downgrades of locked criteria', () => {
    const criterion = { id: 'ui', required: true, tests: ['click'] };
    expect(() => linkAcceptance([criterion, criterion], [])).toThrow('Duplicate');
    expect(() => linkAcceptance([criterion], [{ title: 'click', status: 'passed' }, { title: 'click', status: 'failed' }])).toThrow('Duplicate');
    expect(() => linkAcceptance([{ ...criterion, acceptanceIndex: 1 }], [], ['one'])).toThrow('locked');
    expect(() => linkAcceptance([{ ...criterion, acceptanceIndex: 0, required: false }], [], ['one'])).toThrow('locked');
});
it('prioritizes a known failure even when another mapped scenario is missing', () => {
    const linked = linkAcceptance([{ id: 'ui', required: true, tests: ['failed', 'missing'] }], [{ title: 'failed', status: 'failed' }]);
    expect(linked.coverage[0]?.status).toBe('failed');
});
it('highlights changed/deleted tests, browser scenarios and acceptance maps for review UI', () => {
    const diff = '--- a/src/a.test.ts\n+++ /dev/null\n--- /dev/null\n+++ b/e2e/smoke.scenario.json\n+++ b/acceptanceMap.json\n+++ b/src/app.ts\n+++ "b/tests/tab\\tname.spec.ts"';
    expect(listChangedTestPaths(diff)).toEqual(['src/a.test.ts', 'e2e/smoke.scenario.json', 'acceptanceMap.json', 'tests/tab\tname.spec.ts']);
});
