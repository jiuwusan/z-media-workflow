import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { parse } from 'acorn';
import { fileURLToPath } from 'node:url';
const root = process.argv[2] ? resolve(process.argv[2]) : resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(resolve(d, e.name)) : [resolve(d, e.name)]);
const compatibility = new Set(['media', 'torrent-naming', 'torrent-categories', 'config-file', 'cleanup-settings', 'media-cursor', 'runtime-address', 'http'].map(n => 'util/' + n + '.js'));
const allowed = { router: ['controller', 'middleware', 'util'], middleware: ['middleware', 'service', 'util'], controller: ['service', 'domain', 'config', 'util'], service: ['service', 'domain', 'storage', 'gateway', 'config', 'util'], gateway: ['gateway', 'domain', 'util'], storage: ['storage', 'domain', 'util'], domain: ['domain', 'util'], util: ['util'], config: ['config', 'storage', 'domain', 'util'] };
const graph = new Map();
const fail = (file, message) => { throw new Error(relative(root, file) + ': ' + message); };
function visit(node, fn) { if (!node || typeof node !== 'object') return; if (node.type) fn(node); for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(n => visit(n, fn)); else if (value && typeof value === 'object') visit(value, fn); }
for (const file of walk(root).filter(f => f.endsWith('.js'))) {
 const name = relative(root, file).replaceAll('\\', '/');
 if (compatibility.has(name)) continue;
 const layer = name.includes('/') ? name.split('/')[0] : 'bootstrap';
 if (layer !== 'bootstrap' && !allowed[layer]) fail(file, 'unclassified layer');
 const tree = parse(readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
 const edges = []; graph.set(file, edges);
 visit(tree, node => {
  if (['service', 'domain'].includes(layer) && ((node.type === 'Identifier' && ['ctx', 'req', 'res'].includes(node.name)) || (node.type === 'MemberExpression' && ['cookies', 'request', 'response'].includes(node.computed ? node.property.value : node.property.name)))) fail(file, 'HTTP context belongs to controller/middleware');
  if (node.type === 'ImportExpression' || (node.type === 'CallExpression' && node.callee.name === 'require')) fail(file, 'dynamic module loading is forbidden');
  if (['domain', 'service'].includes(layer) && node.type === 'CallExpression' && node.callee.name === 'fetch') fail(file, 'network I/O belongs to gateway');
  if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) || !node.source) return;
  const spec = node.source.value;
  if (['domain', 'service'].includes(layer) && /^(node:)?(fs|http|https|net|child_process)(\/|$)/.test(spec)) fail(file, 'I/O import belongs to storage/gateway');
  if (!spec.startsWith('.')) return;
  const target = resolve(dirname(file), spec), targetName = relative(root, target).replaceAll('\\', '/');
  if (!existsSync(target)) fail(file, 'unresolved import ' + spec);
  if (compatibility.has(targetName)) fail(file, 'runtime import of legacy compatibility path ' + spec);
  const targetLayer = targetName.includes('/') ? targetName.split('/')[0] : 'bootstrap';
  if (layer !== 'bootstrap' && !allowed[layer].includes(targetLayer)) fail(file, layer + ' -> ' + targetLayer);
  edges.push(target);
 });
}
const active = new Set(), done = new Set();
function check(file) { if (active.has(file)) fail(file, 'dependency cycle'); if (done.has(file)) return; active.add(file); for (const dep of graph.get(file) ?? []) check(dep); active.delete(file); done.add(file); }
for (const file of graph.keys()) check(file);
console.log('Architecture passed:', graph.size, 'runtime modules');
