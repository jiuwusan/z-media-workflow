import path from 'node:path';
import { openWorkflowDatabase } from '../../src/storage/database.js';
import { ApplicationRepository } from '../../src/storage/application-repository.js';
import { DEFAULT_CONFIG,runtimeConfig } from '../../src/config/index.js';
import { digest } from '../../src/util/credentials.js';
const stores=new Map();
export function testStore(filename){const key=path.resolve(filename);if(!stores.has(key))stores.set(key,new ApplicationRepository(openWorkflowDatabase(path.join(path.dirname(key),'workflow.sqlite'))));return stores.get(key);}
export function writeTestConfig(filename,input){const store=testStore(filename),document={...DEFAULT_CONFIG,...input};if(store.initialized)store.updateConfig(document);else store.initialize(document,digest('test-key'));}
export function readTestConfig(filename){return testStore(filename).readConfig().document;}
export function loadTestConfig(filename){return runtimeConfig(testStore(filename),path.dirname(path.resolve(filename)));}
export function closeTestDatabases(root){for(const [key,store]of stores)if(key.startsWith(path.resolve(root)+path.sep)){store.database.close();stores.delete(key);}}
