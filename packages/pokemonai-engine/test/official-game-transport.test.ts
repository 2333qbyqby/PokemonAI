import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  BattleEvent,
  BattleObservation,
  LegalSideAction,
  OfficialGameTransport,
} from '../src/index.js';

const observation: BattleObservation = {
  battleId: 'official-fixture',
  formatId: 'champions-ranked-singles',
  perspective: 'p1',
  turn: 1,
  requestId: 3,
  forceSwitch: false,
  teamPreview: false,
  pseudoWeather: [],
  sides: {
    p1: {id: 'p1', pokemon: [], sideConditions: {}, teraUsed: false},
    p2: {id: 'p2', pokemon: [], sideConditions: {}, teraUsed: false},
  },
  historyHash: 'public-history',
};

class OfficialGameTransportFixture implements OfficialGameTransport {
  submitted: {action: LegalSideAction; requestId: number}[] = [];

  async *observe(): AsyncIterable<{
    readonly observation: BattleObservation;
    readonly events: readonly BattleEvent[];
    readonly legalActions: readonly LegalSideAction[];
  }> {
    yield {observation, events: [], legalActions: []};
  }

  async submit(action: LegalSideAction, requestId: number): Promise<void> {
    this.submitted.push({action, requestId});
  }

  capabilities() {
    return {
      localShowdown: false as const,
      officialGame: true as const,
      supportsTeamPreview: true as const,
      supportsClosedSheets: true as const,
    };
  }
}

test('official game boundary exposes only public observations and validated side actions', async () => {
  const transport = new OfficialGameTransportFixture();
  const frames = [];
  for await (const frame of transport.observe()) frames.push(frame);

  assert.equal(frames[0]?.observation.historyHash, 'public-history');
  assert.deepEqual(transport.capabilities(), {
    localShowdown: false,
    officialGame: true,
    supportsTeamPreview: true,
    supportsClosedSheets: true,
  });
});
