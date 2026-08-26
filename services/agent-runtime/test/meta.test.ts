import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, utimes} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {loadMeta} from '../src/meta.js';

async function writeSnapshot(root: string, publishedAt: string, sourceUpdatedAt: string, species: string) {
  const directory = path.join(root, 'var', 'meta');
  const current = path.join(directory, 'current.json');
  await mkdir(directory, {recursive: true});
  await writeFile(current, JSON.stringify({
    schema: 'pokemonai-meta',
    source: 'munchstats',
    publishedAt,
    formats: {
      'champions-ranked-singles': {
        sourceUpdatedAt,
        speciesProfiles: {[species.toLowerCase()]: {
          species, usage: {probability: 0.1, rank: 1}, moves: [], items: [], abilities: [], natures: [],
          statSpreads: [], speedDistribution: [], teammates: [], counters: [],
        }},
      },
    },
  }), 'utf8');
  const changed = new Date(Date.now() + 2_000);
  await utimes(current, changed, changed);
}

test('new battles load a newly published date while existing evidence remains pinned', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pokemonai-meta-'));
  await writeSnapshot(root, '2026-08-24T10:00:00Z', '2026-07', 'Garchomp');
  const firstBattle = await loadMeta(root, 'champions-ranked-singles');

  await writeSnapshot(root, '2026-09-24T10:00:00Z', '2026-08', 'Dragonite');
  const nextBattle = await loadMeta(root, 'champions-ranked-singles');

  assert.equal(firstBattle.sourceUpdatedAt, '2026-07');
  assert.ok(firstBattle.speciesProfiles.garchomp);
  assert.equal(nextBattle.sourceUpdatedAt, '2026-08');
  assert.ok(nextBattle.speciesProfiles.dragonite);
});
