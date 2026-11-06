import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
function check(files) {
 const root=mkdtempSync(join(tmpdir(),'architecture-'));
 try { for(const [name,content] of Object.entries(files)){const f=join(root,name);mkdirSync(dirname(f),{recursive:true});writeFileSync(f,content)}
 return spawnSync(process.execPath,['scripts/check-architecture.mjs',root],{encoding:'utf8'});
 } finally {rmSync(root,{recursive:true,force:true})}
}
test('architecture ignores comment imports and accepts pure modules',()=>{const r=check({'domain/a.js':"// import '../service/b.js';\nexport const a=1;"});assert.equal(r.status,0,r.stderr)});
test('architecture rejects upward imports',()=>{const r=check({'domain/a.js':"import '../service/b.js';",'service/b.js':'export const b=1;'});assert.notEqual(r.status,0);assert.match(r.stderr,/domain/)});
test('architecture rejects cycles',()=>{const r=check({'domain/a.js':"import './b.js';",'domain/b.js':"import './a.js';"});assert.notEqual(r.status,0);assert.match(r.stderr,/cycle/i)});

test('architecture rejects framework context in services',()=>{const r=check({'service/a.js':"export const a = context => context.cookies.get('session');"});assert.notEqual(r.status,0);assert.match(r.stderr,/HTTP context/)});
