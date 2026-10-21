import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SetupService } from '../src/service/setup.js';
import { AuthService } from '../src/service/auth.js';
import { RecoveryService } from '../src/service/recovery.js';
import { createApp } from '../src/app.js';
import { createServices } from '../src/service/index.js';
const input={ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'first-password',QBT_API_KEY:'mock-qbt',JELLYFIN_API_KEY:'mock-jelly',DEEPSEEK_API_KEY:'mock-deep',cursor:{mode:'skip'}};
test('production service assembly requires an initialized persistent configuration',()=>{
  assert.throws(()=>createServices({adminUsername:'admin',adminPassword:'test-password'}),e=>e.status===503);
});
function ctx(setup,body) {return {request:{body},cookies:{get:()=>setup.nonce,set:()=>{}},get:()=>setup.nonce};}
test('setup ignores invalid legacy files, initializes once and recovery invalidates old sessions', async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'app-init-'));
  writeFileSync(path.join(dir,'config.json'),'broken legacy');writeFileSync(path.join(dir,'media-cursors.json'),'broken legacy');
  const setup=new SetupService(dir);t.after(()=>{setup.close();rmSync(dir,{recursive:true,force:true});});
  assert.equal(setup.initialized,false);
  assert.throws(()=>setup.complete(ctx(setup,{...input,cursor:{mode:'import',data:'bad'}})));
  const config=setup.complete(ctx(setup,input));
  assert.equal(setup.initialized,true);assert.throws(()=>setup.complete(ctx(setup,input)),e=>e.status===409);
  const passkey=readFileSync(path.join(dir,'passkey'),'utf8').trim();
  const auth=new AuthService(config),session=await auth.login('admin','first-password','ip');
  const recovery=new RecoveryService(config.store);
  assert.throws(()=>recovery.verify('wrong','ip'),e=>e.status===401);
  const result=recovery.verify(passkey,'ip');assert.equal(result.username,'admin');
  recovery.reset(result.token,'new-password','new-password','ip');
  assert.equal(auth.session(session.id),undefined);
  await assert.rejects(auth.login('admin','first-password','ip'),e=>e.status===401);
  assert.ok(await auth.login('admin','new-password','ip'));
  assert.throws(()=>recovery.reset(result.token,'third-password','third-password','ip'),e=>e.status===401);
  assert.equal(readFileSync(path.join(dir,'config.json'),'utf8'),'broken legacy');
});

test('recovery HTTP requires a fresh nonce and initialized setup rejects requests before parsing',async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'app-recovery-http-')),setup=new SetupService(dir);
  t.after(()=>{setup.close();rmSync(dir,{recursive:true,force:true});});
  const config=setup.complete(ctx(setup,input)),auth=new AuthService(config),recovery=new RecoveryService(config.store);
  const server=createApp({config,setup,services:{auth,recovery,mediaLibrary:{}}}).listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;
  const denied=await fetch(base+'/api/auth/recovery/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({passkey:'wrong'})});assert.equal(denied.status,403);
  const context=await fetch(base+'/api/auth/recovery/context'),nonce=(await context.json()).data.csrfToken;
  const passkey=readFileSync(path.join(dir,'passkey'),'utf8').trim();
  const verified=await fetch(base+'/api/auth/recovery/verify',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':nonce,Cookie:context.headers.get('set-cookie').split(';')[0]},body:JSON.stringify({passkey})});
  assert.equal(verified.status,200);assert.equal((await verified.json()).data.username,'admin');
  const sealed=await fetch(base+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'});assert.equal(sealed.status,409);
});
