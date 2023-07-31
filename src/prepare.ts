import fs from 'fs/promises';
import path from 'path';

const modules = path.resolve('node_modules');
const destination = path.join(modules, 'playwright-core', 'lib', 'server', 'chromium', 'crNetworkManager.js');
const buffer = await fs.readFile(destination);
await fs.writeFile(destination, buffer.toString().replace(/cacheDisabled: true/g, 'cacheDisabled: false'));
