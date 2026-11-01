import { writeSync } from 'node:fs';
import { runPilot } from './e2e-pilot.js';
const controller = new AbortController(), cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
    const result = await runPilot({ web: true, signal: controller.signal, forceWebRed: process.env.ADW_DEMO_RED_WEB === '1', browserExecutable: process.env.ADW_CHROMIUM_EXECUTABLE });
    writeSync(1, JSON.stringify(result, null, 2) + '\n');
    process.exitCode = result.state === 'ready_for_human_review' && result.review?.status === 'approved' ? 0 : 1;
}
catch (error) {
    writeSync(2, String(error) + '\n');
    process.exitCode = 1;
}
finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
}
