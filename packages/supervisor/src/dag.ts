export interface PlanNode {
    id: string;
    dependsOn: string[];
    instruction: string;
    agentHint?: string;
}
export type NodeStatus = 'pending' | 'running' | 'passed';
export interface ScheduledNode extends PlanNode {
    status: NodeStatus;
}
export function validateDag(input: readonly PlanNode[]): ScheduledNode[] {
    if (!input.length || input.length > 100)
        throw new Error('DAG requires 1..100 nodes');
    const ids = new Set<string>();
    for (const node of input) {
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(node.id) || ids.has(node.id))
            throw new Error('Invalid or duplicate node ID');
        if (!node.instruction.trim() || node.instruction.length > 64000 || !Array.isArray(node.dependsOn) || new Set(node.dependsOn).size !== node.dependsOn.length)
            throw new Error('Invalid DAG node');
        ids.add(node.id);
    }
    for (const node of input)
        for (const dep of node.dependsOn)
            if (!ids.has(dep) || dep === node.id)
                throw new Error('Unknown or self dependency');
    const nodes = input.map(node => ({ ...node, dependsOn: [...node.dependsOn], status: 'pending' as const }));
    const done = new Set<string>();
    while (done.size < nodes.length) {
        const next = nodes.find(node => !done.has(node.id) && node.dependsOn.every(dep => done.has(dep)));
        if (!next)
            throw new Error('Cyclic DAG');
        done.add(next.id);
    }
    return nodes;
}
export function readyNodes(nodes: readonly ScheduledNode[]): ScheduledNode[] {
    if (nodes.some(node => node.status === 'running'))
        return [];
    const done = new Set(nodes.filter(node => node.status === 'passed').map(node => node.id));
    return nodes.filter(node => node.status === 'pending' && node.dependsOn.every(dep => done.has(dep)));
}
