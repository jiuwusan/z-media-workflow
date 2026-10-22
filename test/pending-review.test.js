import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorkflowDatabase } from '../src/storage/database.js';
import { WorkflowRepository, sourceScope } from '../src/storage/workflow-repository.js';
import { WorkflowService } from '../src/service/workflow.js';
import { CursorRepository } from '../src/storage/cursor-repository.js';

function fixture(t){
  const db=openWorkflowDatabase(':memory:'),repository=new WorkflowRepository(db),scope=sourceScope({jellyfinUrl:'http://jelly/'});
  t.after(()=>db.close());
  const workflow=new WorkflowService({jellyfinUrl:scope.jellyfinUrl},{},{repository,autoStart:false});
  const seed=(items,server=scope.jellyfinUrl)=>{
    const job=repository.accept({input:{dryRun:true},sourceScope:{...scope,jellyfinUrl:server}}),action=repository.claimNext();
    job.status='needs_review';job.items=items.map(itemId=>({itemId,status:'needs_review',candidates:[]}));
    repository.save(job,{actionId:action.id,actionStatus:'completed'});return job;
  };
  return {db,repository,scope,workflow,seed};
}

test('pending review counts distinct server and media pairs across tasks and includes every media in a task',t=>{
  const {workflow,seed}=fixture(t);seed(['a','b']);seed(['a']);seed(['a'],'http://other/');
  assert.equal(workflow.summary().pendingReviewCount,3);
  assert.equal(workflow.summary().counts.needs_review,3);
});

test('skip closes duplicate reviews atomically, keeps history and leaves the cursor pending for a later scan',t=>{
  const {db,repository,workflow,seed}=fixture(t),a=seed(['a','b']),b=seed(['a']),other=seed(['a'],'http://other/');
  const cursor=new CursorRepository(db,'http://jelly/'),item={Id:'a',LibraryId:'lib',Type:'Movie',DateCreated:'2020-01-01'};cursor.track([item]);
  const updated=workflow.skip(a.id,'a');assert.equal(updated.items[0].status,'skipped');assert.equal(updated.status,'needs_review');
  assert.equal(repository.get(b.id).items[0].status,'skipped');assert.equal(repository.get(b.id).status,'completed');
  assert.equal(repository.get(other.id).items[0].status,'needs_review');assert.equal(workflow.summary().pendingReviewCount,2);
  assert.equal(cursor.needsIdentification(item),true);assert.ok(updated.items[0].skippedAt);assert.deepEqual(updated.items[0].candidates,[]);
  const later=seed(['a']);assert.equal(repository.get(later.id).items[0].status,'needs_review');
});

test('skip refuses active duplicate work, unresolved writes and other servers without partial changes',t=>{
  const {repository,workflow,seed}=fixture(t),a=seed(['a']),b=seed(['a']),other=seed(['a'],'http://other/');
  repository.enqueueAction(b.id,{kind:'search',payload:{itemId:'a',identity:{name:'A'}}});
  assert.throws(()=>workflow.skip(a.id,'a'),e=>e.status===409);assert.equal(repository.get(a.id).items[0].status,'needs_review');
  const action=repository.claimNext(),job=repository.get(b.id);job.status='needs_review';job.items[0].intent={kind:'jellyfin.apply'};job.items[0].phase='prepared';repository.save(job,{actionId:action.id,actionStatus:'completed'});
  assert.throws(()=>workflow.skip(a.id,'a'),e=>e.status===409);assert.equal(repository.get(a.id).items[0].status,'needs_review');
  assert.throws(()=>workflow.skip(other.id,'a'),e=>e.status===409);assert.throws(()=>workflow.skip(a.id,'missing'),e=>e.status===404);
});

test('skip failure rolls back every duplicate review',t=>{
  const {db,repository,workflow,seed}=fixture(t),a=seed(['a']),b=seed(['a']);
  db.connection.exec(`CREATE TRIGGER reject_skip BEFORE UPDATE ON workflow_jobs WHEN NEW.id='${b.id}' BEGIN SELECT RAISE(ABORT,'disk full'); END`);
  assert.throws(()=>workflow.skip(a.id,'a'),/disk full/);assert.equal(repository.get(a.id).items[0].status,'needs_review');
  assert.equal(repository.get(b.id).items[0].status,'needs_review');
});

test('skip leaves a failed sibling retryable and retry excludes the skipped media',t=>{
  const {repository,workflow,seed}=fixture(t),job=seed(['a']);
  job.items.push({itemId:'b',status:'failed',candidates:[]});repository.save(job);
  assert.equal(workflow.skip(job.id,'a').status,'failed');
  const retried=workflow.retry(job.id),action=repository.claimNext();
  assert.equal(action.jobId,retried.id);assert.deepEqual(action.payload.options.skipItemIds,['a']);
});
