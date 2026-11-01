import { writeSync } from 'node:fs';
import { runPilot } from './e2e-pilot.js';
const controller = new AbortController(), cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
    const result = await runPilot({ signal: controller.signal });
    writeSync(1, JSON.stringify(result, null, 2) + '\n');
    process.exitCode = result.state === 'ready_for_human_review' ? 0 : 1;
}
catch (error) {
    writeSync(2, String(error) + '\n');
    process.exitCode = 1;
}
finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
}
