import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGamePlan,
  buildTeamProfile,
  getFormatPack,
  RobustSearchPolicy,
  type DecisionContext,
  type LegalSideAction,
  type OpponentModel,
  type PolicyPrior,
  type TurnSimulator,
} from '../src/index.js';

const action = (id: string, tags: string[] = ['move']): LegalSideAction => ({
  id,
  commands: [{kind: 'move', slot: 1}],
  showdown: 'move 1',
  tags,
});

const actions = [action('a'), action('b'), action('c')];
const format = getFormatPack('champions-ranked-singles');
const observation = {
  battleId: 'search-fixture',
  formatId: format.id,
  perspective: 'p1' as const,
  turn: 1,
  requestId: 1,
  forceSwitch: false,
  teamPreview: false,
  pseudoWeather: [],
  sides: {
    p1: {id: 'p1' as const, pokemon: [], sideConditions: {}, teraUsed: false},
    p2: {id: 'p2' as const, pokemon: [], sideConditions: {}, teraUsed: false},
  },
  historyHash: 'public',
};

const prior: PolicyPrior = {
  async evaluate(_context, candidates) {
    return candidates.map((candidate, index) => ({
      action: candidate,
      score: 1 - index * 0.01,
      prior: 1 / candidates.length,
      breakdown: {
        survival: 0, damage: 0, knockout: 0, speed: 0, resources: 0,
        position: 0, information: 0, winCondition: 0, risk: 0, formatSpecific: 0,
      },
      reasonCodes: [],
    }));
  },
};

const model: OpponentModel = {
  async distribution(_context, candidates) {
    return new Map(candidates.map((candidate, index) => [candidate.id, index === 2 ? 0.8 : 0.1]));
  },
};

const simulator: TurnSimulator = {
  async simulate(_particle, ownAction, opponentAction) {
    const responseVariance = opponentAction.id === 'a' ? -1 : opponentAction.id === 'c' ? 1 : 0;
    return {value: (ownAction.id === 'a' ? 0.01 : 0) + responseVariance, terminal: false, nextState: opponentAction.id};
  },
};

function context(seed: number): DecisionContext {
  const teamProfile = buildTeamProfile([{species: 'Pikachu', moves: ['Thunderbolt']}], format);
  return {
    observation,
    events: [],
    legalActions: actions,
    belief: {hypotheses: [], speedIntervals: {}, revealedResources: {}, unknownTailMass: 1, effectiveSampleSize: 1, recovered: false},
    particles: [{particleId: 'one', hypothesisId: 'tail', weight: 1, seed: 7}],
    teamProfile,
    gamePlan: buildGamePlan(teamProfile, observation),
    format: {...format, searchProfile: {...format.searchProfile, opponentActionLimit: 2}},
    metaSourceUpdatedAt: '2026-08',
    metaPublishedAt: '2026-08-24T10:00:00Z',
    seed,
    deadlineMs: performance.now() + 10_000,
  };
}

test('search ranks opponent responses before truncation and adds a worst-response sample', async () => {
  const result = await new RobustSearchPolicy(prior, model, {async actions() { return actions; }}, simulator).decide(context(9));
  assert.ok(result.trace.reasonCodes.includes('opponent-worst-response'));
  assert.ok(result.trace.search.every(item => item.sampleCount === 3));
});

test('overlapping confidence intervals use a reproducible seeded tiebreak', async () => {
  const policy = new RobustSearchPolicy(prior, model, {async actions() { return actions; }}, simulator);
  const first = await policy.decide(context(41));
  const second = await policy.decide(context(41));
  assert.equal(first.action.id, second.action.id);
  assert.ok(first.trace.reasonCodes.includes('seeded-confidence-tiebreak'));
});

test('search selectively extends the top two actions when more than forty percent of the budget remains', async () => {
  const deepSimulator: TurnSimulator = {
    ...simulator,
    async simulateContinuation() {
      return {value: 0.5, terminal: false, expandedNodes: 4};
    },
  };
  const result = await new RobustSearchPolicy(
    prior, model, {async actions() { return actions; }}, deepSimulator
  ).decide(context(17));
  assert.equal(result.trace.search.filter(item => item.completedDepth === 2).length, 2);
  assert.ok(result.trace.reasonCodes.includes('selective-second-turn'));
});
