import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepseekService } from '../src/service/deepseek.js';

const identity = { name: 'Dune', year: 2021 };
const candidates = [
  { candidateId: 'new', Name: '沙丘', ProductionYear: 2021, ProviderIds: { Tmdb: '438631' }, Overview: '沙丘的新电影版本' },
  { candidateId: 'old', Name: '沙丘', ProductionYear: 1984, ProviderIds: { Tmdb: '841' } }
];
function service(decision, inspect = () => {}) {
  return new DeepseekService({ deepseekModel: 'mock' }, async (route, options) => {
    inspect(JSON.parse(options.json.messages[1].content));
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] };
  });
}
test('AI selects an existing alternate-language candidate using source and year', async () => {
  const decision = { candidateId: 'new', confidence: 'high', reason: '名称为别名且2021年匹配' };
  const ai = service(decision, data => {
    assert.equal(data.source, 'Dune.2021.2160p'); assert.equal(data.type, 'Movie');
    assert.deepEqual(data.identity, identity); assert.equal(data.candidates[0].Name, '沙丘');
    assert.ok(data.candidates.every(c => c.ProductionYear === 2021));
  });
  assert.deepEqual(await ai.chooseCandidate('Dune.2021.2160p', 'Movie', identity, candidates), decision);
});
test('AI cannot fabricate a candidate or choose a conflicting year', async () => {
  for (const id of ['forged', 'old']) {
    await assert.rejects(service({ candidateId: id, confidence: 'high', reason: 'guess' }).chooseCandidate('Dune.2021', 'Movie', identity, candidates), /候选/);
  }
});
test('no compatible candidates requires no AI request; uncertain decisions remain uncertain', async () => {
  const ai = new DeepseekService({}, async () => { throw new Error('must not request'); });
  assert.equal((await ai.chooseCandidate('Dune.2021', 'Movie', identity, [candidates[1]])).candidateId, null);
  const uncertain = { candidateId: null, confidence: 'low', reason: '年份未知，无法区分同名作品' };
  assert.deepEqual(await service(uncertain).chooseCandidate('Dune', 'Movie', { name: 'Dune', year: null }, candidates), uncertain);
});
test('malformed and incomplete AI decisions cannot be applied', async () => {
  for (const decision of [{ candidateId: 'new' }, { candidateId: 'new', confidence: 'maybe', reason: 'x' }, { candidateId: null, confidence: 'high', reason: 'x' }]) {
    await assert.rejects(service(decision).chooseCandidate('Dune.2021', 'Movie', identity, candidates), /候选/);
  }
  const ai = new DeepseekService({}, async () => ({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }));
  await assert.rejects(ai.chooseCandidate('Dune', 'Movie', identity, candidates), /未完成/);
});

const seriesIdentity = { name: 'Example', year: 2024 };
const seriesCandidate = { candidateId: 'series', Name: '示例剧', ProductionYear: 2020, ProviderIds: { Tvdb: '123' } };
const laterSeason = { candidateId: 'series', confidence: 'high', reason: '2024年第二季对应2020年首播节目', season: 2, yearRelation: 'later_season' };
test('AI can confirm a later season against an earlier series premiere year', async () => {
  const ai = service(laterSeason, data => assert.equal(data.candidates[0].ProductionYear, 2020));
  assert.deepEqual(await ai.chooseCandidate('Example.S02.2024', 'Series', seriesIdentity, [seriesCandidate]), laterSeason);
});
test('series year exceptions require a confirmed later season and never allow future premieres', async () => {
  for (const value of [{ ...laterSeason, season: 1 }, { ...laterSeason, season: null }, { ...laterSeason, yearRelation: 'unknown' }, { candidateId: 'series', confidence: 'high', reason: 'same name' }]) {
    await assert.rejects(service(value).chooseCandidate('Example.2024', 'Series', seriesIdentity, [seriesCandidate]), /候选/);
  }
  const ai = new DeepseekService({}, async () => { throw new Error('must not request'); });
  assert.equal((await ai.chooseCandidate('Example.S02.2024', 'Series', seriesIdentity, [{ ...seriesCandidate, ProductionYear: 2025 }])).candidateId, null);
});
