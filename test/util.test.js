import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHttpClient } from '../src/util/http.js';
import { mapPath, containsPath, selectCandidate, mediaSource, validateIdentity, cleanMovieName, movieSearchNames } from '../src/util/media.js';

test('HTTP keeps Jellyfin base prefix and auth; refuses redirect to another host', async t => {
  const server = createServer((req, res) => {
    if (req.url.includes('redirect')) { res.writeHead(302, { location: 'https://example.com/' }); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ url: req.url, token: req.headers['x-emby-token'] }));
  }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r)); t.after(() => server.close());
  const http = createHttpClient({ baseUrl: `http://127.0.0.1:${server.address().port}/jellyfin/`, headers: { 'X-Emby-Token': 'secret' } });
  assert.deepEqual(await http('/Items', { query: { StartIndex: 0 } }), { url: '/jellyfin/Items?StartIndex=0', token: 'secret' });
  await assert.rejects(http('redirect'), /302/);
});

test('path mapping respects segments and supports Windows sources', () => {
  assert.equal(mapPath('D:\\downloads\\movies\\A.mkv', { from: 'D:\\downloads', to: '/MediasVol3' }), '/MediasVol3/movies/A.mkv');
  assert.equal(mapPath('/downloads2/A.mkv', { from: '/downloads', to: '/media' }), '/downloads2/A.mkv');
  assert.equal(containsPath('/media/movies', '/media/movies2/A.mkv'), false);
  assert.equal(containsPath('/media/movies', '/media/movies/A.mkv'), true);
});

test('candidate matching rejects ambiguous years and collapses same provider identity', () => {
  const candidates = [ { Name: 'Dune', ProductionYear: 1984, ProviderIds: { Tmdb: '1' } }, { Name: 'Dune', ProductionYear: 2021, ProviderIds: { Tmdb: '2' } } ];
  assert.equal(selectCandidate({ name: 'dune', year: null }, candidates), null);
  assert.equal(selectCandidate({ name: 'Dune', year: 2021 }, candidates).ProviderIds.Tmdb, '2');
  assert.equal(selectCandidate({ name: 'Dune', year: 2020 }, candidates), null);
  assert.equal(selectCandidate({ name: 'Dune', year: 2021 }, [candidates[1], { ...candidates[1] }]).ProviderIds.Tmdb, '2');
  assert.equal(selectCandidate({ name: 'Dune', year: 2021 }, [{ Name: 'Dune', ProductionYear: 2021 }]), null);
});

test('series source comes from folder and movie source comes from filename', () => {
  assert.equal(mediaSource({ Type: 'Series', Path: '/series/三体 (2023)' }), '三体 (2023)');
  assert.equal(mediaSource({ Type: 'Movie', Path: '/movies/Dune.2021.1080p.mkv' }), 'Dune.2021.1080p');
  assert.throws(() => validateIdentity({ name: '', year: 2020 }));
  assert.throws(() => validateIdentity({ name: 'Dune', year: '2021' }));
  assert.deepEqual(validateIdentity({ name: 'Dune', year: null }), { name: 'Dune', year: null });
});

test('movie spelling variants retain part identity and other title words', () => {
  assert.deepEqual(movieSearchNames('A Chinese Odyssey Part One: Pandora Box'), ['A Chinese Odyssey Part One: Pandora Box', 'A Chinese Odyssey Part I: Pandora Box', 'A Chinese Odyssey Part 1: Pandora Box']);
  assert.deepEqual(movieSearchNames('Example Part 2'), ['Example Part Two', 'Example Part 2', 'Example Part II']);
  for (const name of ['Rambo', 'The Departed', 'Example II', 'Example Part XI']) assert.deepEqual(movieSearchNames(name), [name]);
  assert.equal(cleanMovieName('Example PartIII Extended Edition'), 'Example Part III');
  assert.equal(cleanMovieName('The Final Cut'), 'The Final Cut');
});
