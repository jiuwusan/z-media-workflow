import test from 'node:test';
import assert from 'node:assert/strict';
import {openWorkflowDatabase} from '../src/storage/database.js';
import {ApplicationRepository} from '../src/storage/application-repository.js';
import {CleanupSettingsStore} from '../src/util/cleanup-settings.js';
function fixture(t){const db=openWorkflowDatabase(':memory:');t.after(()=>db.close());const repo=new ApplicationRepository(db);repo.initialize({ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'test-password',PORT:3000,torrentCleanup:{deleteFiles:false}},'key');return {db,repo,store:new CleanupSettingsStore(repo)};}
test('cleanup settings preserve files by default and survive a new store instance',t=>{const {repo,store}=fixture(t);assert.equal(store.get().deleteFiles,false);store.set({deleteFiles:true});assert.equal(new CleanupSettingsStore(repo).get().deleteFiles,true);store.set({deleteFiles:false});assert.equal(new CleanupSettingsStore(repo).get().deleteFiles,false);});
test('invalid cleanup settings cannot change active settings',t=>{const {store}=fixture(t);for(const value of [null,{}, {deleteFiles:'true'}])assert.throws(()=>store.set(value));assert.equal(store.get().deleteFiles,false);});
test('business updates retain unrelated pending configuration and credentials',t=>{const {repo,store}=fixture(t);repo.updateConfig({DEEPSEEK_MODEL:'pending-model'});store.set({deleteFiles:true});assert.equal(repo.readConfig().document.DEEPSEEK_MODEL,'pending-model');assert.equal(repo.credential().username,'admin');assert.equal(repo.readConfig().document.PORT,3000);});
test('audit failure rolls back cleanup settings atomically',t=>{const {db,store}=fixture(t);db.connection.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON configuration_audit BEGIN SELECT RAISE(ABORT,'disk full'); END");assert.throws(()=>store.set({deleteFiles:true}));assert.equal(store.get().deleteFiles,false);});
test('cleanup changes increment the shared revision and audit their field',t=>{const {repo,store}=fixture(t);const before=repo.readConfig().revision;store.set({deleteFiles:true});assert.notEqual(repo.readConfig().revision,before);assert.equal(repo.audit.list().items[0].changes[0].field,'torrentCleanup');});
