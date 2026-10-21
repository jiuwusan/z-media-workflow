import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorkflowDatabase } from '../src/storage/database.js';
import { CleanupRepository } from '../src/storage/cleanup-repository.js';
import { QbittorrentService } from '../src/service/qbittorrent.js';
const hash='a'.repeat(40);

test('terminal cleanup writes enforce retention without opening history',()=>{
  const db=openWorkflowDatabase(':memory:'),history=new CleanupRepository(db);
  const old=history.begin({},'http://qbt/');old.status='completed';history.save(old);
  db.connection.prepare('UPDATE cleanup_runs SET updated_at=? WHERE id=?').run(0,old.id);
  const unresolved=history.begin({},'http://qbt/');unresolved.status='interrupted';history.save(unresolved);
  db.connection.prepare('UPDATE cleanup_runs SET updated_at=? WHERE id=?').run(0,unresolved.id);
  const next=history.begin({},'http://qbt/');next.status='preview';history.save(next);
  assert.equal(db.connection.prepare('SELECT count(*) AS n FROM cleanup_runs WHERE id=?').get(old.id).n,0);
  assert.equal(history.get(unresolved.id).status,'interrupted');db.close();
});
test('cleanup previews persist targets and failed intent persistence prevents deletion',async t=>{
  const db=openWorkflowDatabase(':memory:');t.after(()=>db.close());const history=new CleanupRepository(db);let deletes=0;
  const service=new QbittorrentService({qbtUrl:'http://qbt/',qbtKey:'secret'},async(route,options)=>{
    if(route==='torrents/delete'){deletes++;return '';}
    return [{hash,name:'Movie',state:'missingFiles'}];
  });service.history=history;service.sourceUrl='http://qbt/';
  const preview=await service.cleanupMissingFiles({dryRun:true});assert.equal(history.get(preview.id).items[0].hash,hash);
  db.connection.exec("CREATE TRIGGER fail_item BEFORE INSERT ON cleanup_items BEGIN SELECT RAISE(ABORT,'disk full'); END");
  await assert.rejects(service.cleanupMissingFiles({dryRun:false}));assert.equal(deletes,0);
  assert.equal(history.list().total,2);
});
test('startup cleanup reconciliation only observes old targets and never replays deletion',async t=>{
  const db=openWorkflowDatabase(':memory:');t.after(()=>db.close());const history=new CleanupRepository(db);
  const run=history.begin({dryRun:false,deleteFiles:true,source:'页面'},'http://qbt/');
  run.items=[{hash,name:'Movie',status:'prepared'}];history.save(run);
  let reads=0;
  await history.recover({torrent:async()=>{reads++;const e=Error('missing');e.status=404;throw e;}},'http://qbt/');
  const recovered=history.get(run.id);assert.equal(reads,1);assert.equal(recovered.items[0].status,'absent');assert.equal(recovered.items[0].filesDeleted,undefined);
  const other=history.begin({dryRun:false,deleteFiles:true},'http://old/');other.items=[{hash,status:'prepared'}];history.save(other);
  await history.recover({torrent:async()=>{throw Error('must not query a changed server');}},'http://new/');
  assert.equal(history.get(other.id).status,'interrupted');assert.equal(history.get(other.id).items[0].status,'prepared');
});
