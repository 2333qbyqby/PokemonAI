import assert from 'node:assert/strict';
import test from 'node:test';
import type {BattleObservation, BeliefState, PublicSideState} from '@pokemonai/engine';
import type {RuntimeConfig, RuntimeTeam} from '../src/config.js';
import {ShowdownParticleFactory} from '../src/particle-factory.js';

const species = ['Pikachu', 'Charizard', 'Blastoise', 'Venusaur', 'Snorlax', 'Gengar'];
const packed = 'Pikachu||lightball|static|thunderbolt,quickattack,protect,thunderwave|Timid||||||50|]Charizard||sitrusberry|blaze|flamethrower,airslash,protect,willowisp|Timid||||||50|]Blastoise||leftovers|torrent|surf,icebeam,protect,yawn|Bold||||||50|]Venusaur||blacksludge|overgrow|gigadrain,sludgebomb,protect,sleeppowder|Calm||||||50|]Snorlax||chestoberry|thickfat|bodyslam,crunch,rest,sleeptalk|Careful||||||50|]Gengar||focussash|cursedbody|shadowball,sludgebomb,protect,taunt|Timid||||||50|';

function side(id: 'p1' | 'p2'): PublicSideState {
  return {
    id, pokemon: species.map(name => ({
      ident: `${id}: ${name}`, species: name, active: false, fainted: false,
      revealedMoves: [], itemConsumed: false, boosts: {},
    })), sideConditions: {}, teraUsed: false,
  };
}

test('materializes private hypotheses as opaque Showdown states', () => {
  const config = {
    id: 'test', username: 'Test', formatId: 'champions-ou', format: 'gen9championsou',
    showdown: '', authentication: 'none', control: '', controlToken: '', teamPool: '', teamIndex: '', status: '', logs: '',
    projectRoot: process.cwd(), maxConcurrentBattles: 1, seed: 1,
  } satisfies RuntimeConfig;
  const team = {id: 'team', packed, profile: species.map(name => ({species: name, moves: ['tackle']}))} satisfies RuntimeTeam;
  const observation: BattleObservation = {
    battleId: 'battle-test', formatId: 'champions-ou', perspective: 'p1', turn: 0,
    requestId: 1, forceSwitch: false, teamPreview: true, pseudoWeather: [],
    sides: {p1: side('p1'), p2: side('p2')}, historyHash: 'visible',
  };
  const hypothesis = {
    id: 'team-hypothesis', archetype: 'balance', probability: 1, unknownTail: false,
    sets: species.map(name => ({id: name, species: name, moves: ['tackle'], probability: 1, source: 'fixture'})),
  };
  const belief: BeliefState = {
    hypotheses: [hypothesis], speedIntervals: {}, revealedResources: {}, unknownTailMass: 0,
    effectiveSampleSize: 1, recovered: false,
  };
  const [particle] = new ShowdownParticleFactory(config, team).materialize(
    [{particleId: 'one', hypothesisId: hypothesis.id, weight: 1, seed: 1}], belief, observation,
  );
  assert.ok(particle?.simulatorState);
  assert.equal(JSON.parse(particle.simulatorState ?? '{}').formatid, 'gen9championsou');
});
