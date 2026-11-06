import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'acorn';
const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
const files = ['src', 'scripts', 'test', 'web/src'].flatMap(walk).filter(f => /\.(?:js|mjs)$/.test(f));
for (const file of files) parse(readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
console.log('Syntax lint passed:', files.length, 'JavaScript modules (Vue templates checked by Vite build)');
