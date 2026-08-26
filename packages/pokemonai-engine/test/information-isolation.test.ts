import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BeliefEngine,
  buildGamePlan,
  buildTeamProfile,
  enumerateLegalActions,
  getFormatPack,
  HeuristicPolicy,
  ObservationReducer,
  RobustSearchPolicy,
  type MetaEvidence,
  type ShowdownRequest,
} from '../src/index.js';

test('decision only depends on visible history, meta snapshot and battle seed', async () => {
  const reducer = new ObservationReducer('battle-hidden-world', 'champions-ranked-singles', 'p1');
  for (const line of ['|poke|p1|Pikachu, L50', '|poke|p2|Garchomp, L50', '|turn|1']) reducer.ingest(line);
  const observation = reducer.snapshot(1, false, false);
  const format = getFormatPack('champions-ranked-singles');
  const request: ShowdownRequest = {
    rqid: 1,
    active: [{moves: [
      {id: 'thunderbolt', move: 'Thunderbolt', target: 'normal', category: 'Special', basePower: 90},
      {id: 'protect', move: 'Protect', target: 'self', category: 'Status'},
    ]}],
    side: {pokemon: [{ident: 'p1a: Pikachu', details: 'Pikachu, L50', condition: '100/100', active: true}]},
  };
  const meta: MetaEvidence = {publishedAt: 'same-publish', sourceUpdatedAt: 'same-source-date', speciesProfiles: {}};
  const beliefEngine = new BeliefEngine();
  const belief = beliefEngine.initialize(observation, meta);
  const teamProfile = buildTeamProfile([{species: 'Pikachu', moves: ['Thunderbolt', 'Protect'], baseSpeed: 90}], format);
  const legalActions = enumerateLegalActions(request, format);
  const context = {
    observation,
    events: [],
    legalActions,
    belief,
    particles: beliefEngine.particles(belief, 8, 99),
    teamProfile,
    gamePlan: buildGamePlan(teamProfile, observation),
    format,
    metaSourceUpdatedAt: meta.sourceUpdatedAt,
    metaPublishedAt: meta.publishedAt,
    seed: 99,
    deadlineMs: performance.now() + 10_000,
  };
  const first = await new RobustSearchPolicy(new HeuristicPolicy()).decide(context);
  const second = await new RobustSearchPolicy(new HeuristicPolicy()).decide({...context, deadlineMs: performance.now() + 10_000});
  assert.equal(first.action.id, second.action.id);
  assert.deepEqual(first.trace.search.map(item => item.action.id), second.trace.search.map(item => item.action.id));
});
