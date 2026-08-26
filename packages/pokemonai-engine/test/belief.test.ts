import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BeliefEngine,
  ObservationReducer,
  type MetaEvidence,
  type SpeciesMetaProfile,
} from '../src/index.js';

const profile = (species: string, moves: string[], speeds: number[]): SpeciesMetaProfile => ({
  species,
  usage: {probability: 0.2, rank: 1},
  moves: moves.map((name, index) => ({name, probability: 1 - index * 0.1})),
  items: [{name: 'Focus Sash', probability: 1}],
  abilities: [{name: 'Rough Skin', probability: 1}],
  natures: [{name: 'Jolly', probability: 1}],
  statSpreads: [{values: [0, 32, 0, 0, 0, 32], nature: 'Jolly', probability: 1}],
  speedDistribution: speeds.map(value => ({value, probability: 1 / speeds.length, basis: 'source-joint'})),
  teammates: [],
  counters: [],
});

const meta: MetaEvidence = {
  publishedAt: '2026-08-24T10:00:00Z',
  sourceUpdatedAt: '2026-08-23T23:09:00Z',
  speciesProfiles: {
    garchomp: profile('Garchomp', ['Earthquake', 'Protect', 'Dragon Claw', 'Rock Slide'], [154, 169]),
    zapdos: profile('Zapdos', ['Thunderbolt', 'Tailwind', 'Heat Wave', 'Protect'], [120, 150]),
  },
};

function observation(extra: readonly string[] = []) {
  const reducer = new ObservationReducer('battle-test', 'champions-ranked-doubles', 'p1');
  for (const line of [
    '|poke|p1|Pikachu, L50', '|poke|p2|Garchomp, L50', '|poke|p2|Zapdos, L50',
    '|switch|p2a: Chomp|Garchomp, L50|100/100', '|switch|p2b: Zap|Zapdos, L50|100/100',
    ...extra,
  ]) reducer.ingest(line);
  return reducer.snapshot(1, false, false);
}

test('belief builds deterministic species-specific factorized hypotheses with an unknown tail', () => {
  const engine = new BeliefEngine();
  const value = engine.initialize(observation(), meta);
  assert.equal(value.hypotheses.length, 17);
  assert.ok(value.unknownTailMass >= 0.1);
  const known = value.hypotheses.find(item => !item.unknownTail)!;
  const garchomp = known.sets.find(set => set.species === 'Garchomp')!;
  assert.ok(garchomp.moves.includes('Earthquake'));
  assert.ok(!garchomp.moves.includes('Thunderbolt'));
  assert.deepEqual(value.speedIntervals.Garchomp, {min: 154, max: 169});
  assert.deepEqual(engine.particles(value, 32, 42), engine.particles(value, 32, 42));
});

test('belief regenerates factorized hypotheses after public evidence invalidates every sampled set', () => {
  const engine = new BeliefEngine();
  const current = observation(['|move|p2a: Chomp|Earthquake|p1a: Pikachu']);
  const previous = {
    ...engine.initialize(current, meta),
    hypotheses: [{
      id: 'invalid', archetype: 'fixture', probability: 1, unknownTail: false,
      sets: [{id: 'invalid-set', species: 'Dragonite', moves: ['Roost'], probability: 1, source: 'fixture'}],
    }],
  };
  const updated = engine.update(previous, current, [], meta);
  assert.equal(updated.recovered, true);
  assert.ok(updated.hypotheses.some(item => item.sets.some(set => set.species === 'Garchomp')));
});

test('belief prefers a matching complete MunchStats team while preserving the unknown tail', () => {
  const reducer = new ObservationReducer('battle-team-corpus', 'champions-ranked-doubles', 'p1');
  const roster = ['Garchomp', 'Zapdos', 'Incineroar', 'Rillaboom', 'Urshifu', 'Flutter Mane'];
  for (const species of roster) reducer.ingest(`|poke|p2|${species}, L50`);
  const teamMeta: MetaEvidence = {
    ...meta,
    teamSourceUpdatedAt: '2026-08-24T12:00:00Z',
    teamRecords: [{
      id: 'vgcpastes:test', name: 'Fixture', formatId: 'champions-ranked-doubles',
      sourceKind: 'vgcpastes', sourceLabel: 'MunchStats', observedAt: '2026-08-24',
      completeness: 'full-set', roster, validationStatus: 'prevalidated',
      sets: roster.map(species => ({species, moves: ['Protect']})),
    }],
  };
  const value = new BeliefEngine().initialize(reducer.snapshot(1, false, true), teamMeta);
  assert.ok(value.hypotheses.some(item => item.id === 'team-corpus:vgcpastes:test'));
  assert.ok(value.unknownTailMass >= 0.1);
});
