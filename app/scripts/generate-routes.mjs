// Regenerates src/routeTree.gen.ts outside of Vite (the plugin does the same on dev/build).
import { Generator, getConfig } from '@tanstack/router-generator';

const root = process.cwd();
const config = getConfig({ target: 'react', autoCodeSplitting: true, routeFileIgnorePattern: '__tests__' }, root);
await new Generator({ config, root }).run();
console.log('routes generated');
