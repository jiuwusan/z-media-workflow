import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorkflowDatabase } from '../src/storage/database.js';
import { CursorRepository, parseCursorSnapshot } from '../src/storage/cursor-repository.js';
import { WorkflowRepository } from '../src/storage/workflow-repository.js';
import { WorkflowService } from '../src/service/workflow.js';
import { recoverRunningActions } from '../src/service/workflow-recovery.js';

test('recovery rollback retains verified intent protection when the final save succeeds',async()=>{
  const db=openWorkflowDatabase(':memory:'),cursor=new CursorRepository(db,'http://jelly/');
  const item={Id:'m',LibraryId:'lib',Type:'Movie',DateCreated:'2020-01-01'};cursor.track([item]);
  const entry={itemId:'m',status:'failed',phase:'verified',intent:{kind:'jellyfin.apply',target:{itemId:'m',libraryId:'lib',type:'Movie'},expected:{Name:'After',ProviderIds:{Tmdb:'1'}}}};
  const job={id:'job',input:{},sourceScope:{jellyfinUrl:'http://jelly/'},discoveryComplete:true,items:[entry]};let saved;
  const repository={database:db,runningActions:()=>[{id:'action',jobId:'job',kind:'run',payload:{}}],get:()=>job,save:value=>{if(value.items[0].phase==='completed')throw Error('save failed');saved=structuredClone(value);}};
  await recoverRunningActions({repository,sourceScope:job.sourceScope,services:{mediaLibrary:{ensureItem:async()=>({...item,Name:'After',ProviderIds:{Tmdb:'1'}}),markIdentified:(value,options)=>cursor.confirm(value,options)}}});
  assert.equal(cursor.needsIdentification(item),true);assert.equal(saved.items[0].phase,'verified');assert.equal(saved.items[0].status,'failed');db.close();
});
test('manual snapshot preserves all cursor fields and invalid input never overwrites data', () => {
  const db=openWorkflowDatabase(':memory:'), repo=new CursorRepository(db,'http://jelly/');
  const scope=JSON.stringify(['http://jelly/','lib','Movie']);
  repo.importSnapshot(parseCursorSnapshot(JSON.stringify({version:1,libraries:{[scope]:{date:'2020-01-01T00:00:00.000Z',ids:['old','old'],pending:['failed'],undated:['nodate']}}})));
  const make=(Id,DateCreated)=>({Id,DateCreated,LibraryId:'lib',Type:'Movie'});
  assert.equal(repo.needsIdentification(make('old','2020-01-01')),false);
  assert.equal(repo.needsIdentification(make('new','2020-01-01')),true);
  assert.equal(repo.needsIdentification(make('failed','2019-01-01')),true);
  assert.equal(repo.needsIdentification(make('nodate')),false);
  assert.throws(()=>parseCursorSnapshot({version:1,libraries:{bad:{date:null,ids:[],pending:[],undated:[]}}}));
  assert.throws(()=>parseCursorSnapshot({version:2,libraries:{}}));
  const b=new CursorRepository(db,'http://jelly/'); assert.equal(b.needsIdentification(make('old','2020-01-01')),false);
  db.close();
});
test('cursor advance and consumer completion share a rollback boundary', () => {
  const db=openWorkflowDatabase(':memory:'), repo=new CursorRepository(db,'http://jelly/');
  const item={Id:'new',LibraryId:'lib',Type:'Movie',DateCreated:'2021-01-01'};
  repo.track([item]);
  assert.throws(()=>db.transaction(()=>{repo.confirm(item);throw Error('save task failed');}));
  assert.equal(repo.needsIdentification(item),true);
  repo.confirm(item); assert.equal(repo.needsIdentification(item),false);
  const recovered={...item,Id:'recovered'};
  assert.throws(()=>repo.confirm(recovered));
  repo.confirm(recovered,{verified:true}); assert.equal(repo.needsIdentification(recovered),false);
  db.close();
});

test('failed workflow completion rolls back its cursor, then startup reconciles both without another apply',async()=>{
  const db=openWorkflowDatabase(':memory:'),cursor=new CursorRepository(db,'http://jelly/'),repo=new WorkflowRepository(db);
  let item={Id:'m',Type:'Movie',Name:'Before',LibraryId:'lib',Path:'/movies/a.mkv',DateCreated:'2020-01-01'},writes=0;
  const candidate={Name:'After',ProductionYear:2020,ProviderIds:{Tmdb:'1'}};
  const services={mediaLibrary:{ensureItem:async()=>item,unidentified:async()=>({items:[item],total:1}),track:async list=>cursor.track(list),markIdentified:(value,options)=>cursor.confirm(value,options)},deepseek:{identify:async()=>({name:'After',year:2020})},jellyfin:{search:async()=>[candidate],apply:async()=>{writes++;item={...item,...candidate};},refreshItem:async()=>{}}};
  const save=repo.save.bind(repo);repo.save=(job,options)=>{if(job.items[0]?.status==='completed')throw Error('completion disk full');return save(job,options);};
  const wf=new WorkflowService({jellyfinUrl:'http://jelly/'},services,{repository:repo}),job=wf.enqueue({});await wf.close();
  assert.ok(wf.storageError);assert.equal(cursor.needsIdentification(item),true);assert.equal(repo.get(job.id).items[0].phase,'verified');
  repo.save=save;const recovered=new WorkflowService({jellyfinUrl:'http://jelly/'},services,{repository:repo});await recovered.startPromise;
  assert.equal(recovered.get(job.id).status,'completed');assert.equal(cursor.needsIdentification(item),false);assert.equal(writes,1);await recovered.close();db.close();
});
