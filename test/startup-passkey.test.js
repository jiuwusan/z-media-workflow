import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SetupService } from '../src/service/setup.js';
import { RecoveryService } from '../src/service/recovery.js';
import { digest } from '../src/util/credentials.js';

const input={ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'first-password',QBT_API_KEY:'mock-qbt',JELLYFIN_API_KEY:'mock-jelly',DEEPSEEK_API_KEY:'mock-deep',cursor:{mode:'skip'}};
const context=setup=>({request:{body:input},cookies:{get:()=>setup.nonce,set:()=>{}},get:()=>setup.nonce});
function fixture(t,close=()=>{}){
  const dir=mkdtempSync(path.join(tmpdir(),'startup-passkey-')),messages=[];
  t.mock.method(console,'log',value=>messages.push(JSON.parse(value)));
  t.after(()=>{close();rmSync(dir,{recursive:true,force:true});});
  return {dir,messages,file:path.join(dir,'passkey')};
}

test('startup publishes one fresh passkey before setup and initialization uses that same key',t=>{
  let setup;const {dir,messages,file}=fixture(t,()=>setup?.close());setup=new SetupService(dir);
  const key=readFileSync(file,'utf8').trim();assert.match(key,/^v1:[a-f0-9]{64}$/);
  assert.deepEqual(messages.filter(m=>m.event==='recovery.passkey.generated').map(m=>m.passkey),[key]);
  const config=setup.complete(context(setup));
  assert.equal(setup.store.credential().passkeyDigest,digest(key));
  assert.equal(new RecoveryService(setup.store).verify(key,'first').username,'admin');
  assert.equal(readFileSync(file,'utf8').trim(),key);assert.equal(messages.length,1);
  assert.equal(JSON.stringify(config).includes(key),false);
});

test('every restart replaces the key and invalidates old recovery tokens without resetting settings or bans',t=>{
  let setup;const {dir,file,messages}=fixture(t,()=>setup?.close());setup=new SetupService(dir);
  setup.complete(context(setup));
  const oldKey=readFileSync(file,'utf8').trim(),oldToken=new RecoveryService(setup.store).verify(oldKey,'first').token;
  setup.store.attempt('recovery','limited');const before=setup.store.readConfig();setup.close();
  setup=new SetupService(dir);
  const key=readFileSync(file,'utf8').trim(),recovery=new RecoveryService(setup.store);
  assert.notEqual(key,oldKey);assert.equal(setup.initialized,true);
  assert.throws(()=>recovery.verify(oldKey,'old'),e=>e.status===401);
  assert.throws(()=>recovery.reset(oldToken,'next-password','next-password','old'),e=>e.status===401);
  assert.equal(recovery.verify(key,'new').username,'admin');assert.deepEqual(setup.store.readConfig(),before);
  assert.equal(setup.database.connection.prepare("SELECT count FROM auth_attempts WHERE namespace='recovery' AND ip='limited'").get().count,1);
  assert.equal(messages.filter(m=>m.event==='recovery.passkey.generated').length,2);
  setup.close();unlinkSync(file);setup=new SetupService(dir);
  assert.equal(setup.initialized,true);assert.notEqual(readFileSync(file,'utf8').trim(),key);
});

test('an old malformed file is replaced, and unwritable passkey storage prevents startup without logging a key',t=>{
  const {dir,file,messages}=fixture(t);writeFileSync(file,'obsolete');
  const setup=new SetupService(dir);assert.match(readFileSync(file,'utf8'),/^v1:[a-f0-9]{64}\n$/);setup.close();
  unlinkSync(file);mkdirSync(file);messages.length=0;
  assert.throws(()=>new SetupService(dir),/passkey/);assert.equal(messages.length,0);
});
