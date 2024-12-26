import { readFile, writeFile } from 'fs-extra';
import path from 'path';

const filepath = path.resolve('node_modules', 'playwright-core', 'lib', 'server', 'chromium', 'crNetworkManager.js');
const file = await readFile(filepath, { encoding: 'utf-8' });
await writeFile(filepath, file.replace(/cacheDisabled: true/g, 'cacheDisabled: false'));
