import assert from 'node:assert/strict';
import test from 'node:test';
import {MetaOpponentModel, type DecisionContext, type LegalSideAction} from '../src/index.js';

test('meta opponent model uses the active species move profile', async () => {
  const thunderbolt: LegalSideAction = {
    id: 'thunderbolt', showdown: 'move 1', commands: [{kind: 'move', slot: 1}],
    tags: ['move', 'move-id:thunderbolt', 'meta-move:zapdos:thunderbolt'],
  };
  const protect: LegalSideAction = {
    id: 'protect', showdown: 'move 2', commands: [{kind: 'move', slot: 2}],
    tags: ['move', 'move-id:protect', 'meta-move:zapdos:protect'],
  };
  const model = new MetaOpponentModel({
    publishedAt: '2026-08-24T10:00:00Z', sourceUpdatedAt: '2026-08-23T23:09:00Z',
    speciesProfiles: {zapdos: {
      species: 'Zapdos', usage: {probability: 0.2, rank: 1},
      moves: [{name: 'Thunderbolt', probability: 0.8}, {name: 'Protect', probability: 0.2}],
      items: [], abilities: [], natures: [], statSpreads: [], speedDistribution: [], teammates: [], counters: [],
    }},
  });
  const distribution = await model.distribution({} as DecisionContext, [thunderbolt, protect]);
  assert.ok((distribution.get('thunderbolt') ?? 0) > (distribution.get('protect') ?? 0));
});
