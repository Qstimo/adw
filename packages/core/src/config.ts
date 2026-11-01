import { readFileSync } from 'node:fs';
import { AdwConfigSchema, type AdwConfig } from '@adw/contracts';
export function loadConfig(filePath: string): AdwConfig {
 return AdwConfigSchema.parse(JSON.parse(readFileSync(filePath, 'utf8')));
}
