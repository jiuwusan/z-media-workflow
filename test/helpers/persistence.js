import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openWorkflowDatabase } from '../../src/storage/database.js';
import { WorkflowRepository } from '../../src/storage/workflow-repository.js';
export const scope = { jellyfinUrl: 'http://jellyfin/', qbtUrl: 'http://qbt/' };
export function persistenceFixture(t, limits = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'workflow-store-')), filename = path.join(dir, 'workflow.sqlite');
  const database = openWorkflowDatabase(filename);
  const repository = new WorkflowRepository(database, { maxJobs: 10, maxQueue: 5, jobTtlMs: 60000, ...limits });
  t.after(() => { database.close(); rmSync(dir, { recursive: true, force: true }); });
  return { filename, database, repository };
}
