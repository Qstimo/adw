import { expect, it } from 'vitest';
import { validateDag, readyNodes } from '../src/dag.js';
const node = (id: string, dependsOn: string[] = []) => ({ id, dependsOn, instruction: id });
it('schedules independent nodes serially and releases dependencies after passing', () => {
    const source = [node('a'), node('b'), node('c', ['a', 'b'])], nodes = validateDag(source);
    source[0]!.dependsOn.push('c');
    expect(readyNodes(nodes).map(node => node.id)).toEqual(['a', 'b']);
    nodes[0]!.status = 'running';
    expect(readyNodes(nodes)).toEqual([]);
    nodes[0]!.status = 'passed';
    expect(readyNodes(nodes).map(node => node.id)).toEqual(['b']);
    nodes[1]!.status = 'passed';
    expect(readyNodes(nodes).map(node => node.id)).toEqual(['c']);
});
it('rejects cycles, self/unknown/duplicate dependencies and duplicate IDs', () => {
    for (const input of [[], [node('a', ['b']), node('b', ['a'])], [node('a', ['a'])], [node('a', ['missing'])], [node('a'), node('a')], [node('a'), node('b', ['a', 'a'])]])
        expect(() => validateDag(input)).toThrow();
});
