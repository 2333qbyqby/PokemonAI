import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import path from 'node:path';
import {ShowdownWorkerPool} from '../src/worker-pool.js';
import type {DecisionContext, LegalSideAction} from '@pokemonai/engine';

const require = createRequire(import.meta.url);
const showdownModule = path.resolve('vendor/pokemon-showdown/dist/sim/index.js');
const {Battle, Teams} = require(showdownModule) as {
  Battle: {
    new(options: unknown): {toJSON(): unknown; makeChoices(p1: string, p2: string): void};
    fromJSON(value: string): {toJSON(): unknown; makeChoices(p1: string, p2: string): void};
  };
  Teams: {unpack(team: string): unknown};
};

const team = 'Pikachu||lightball|static|thunderbolt,quickattack,protect,thunderwave|Timid||||||50|]Charizard||sitrusberry|blaze|flamethrower,airslash,protect,willowisp|Timid||||||50|]Blastoise||leftovers|torrent|surf,icebeam,protect,yawn|Bold||||||50|]Venusaur||blacksludge|overgrow|gigadrain,sludgebomb,protect,sleeppowder|Calm||||||50|]Snorlax||chestoberry|thickfat|bodyslam,crunch,rest,sleeptalk|Careful||||||50|]Gengar||focussash|cursedbody|shadowball,sludgebomb,protect,taunt|Timid||||||50|';
const move: LegalSideAction = {id: 'move 1', showdown: 'move 1', commands: [{kind: 'move', slot: 1}], tags: ['move']};

function stableState(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) =>
    typeof item === 'string' ? item.replace(/\|t:\|\d+/g, '|t:|<clock>') : item
  ));
}

test('worker clone produces the same next state as direct Showdown simulation', async () => {
  const options = {
    formatid: 'gen9championsou',
    seed: [1, 2, 3, 4],
    p1: {name: 'P1', team: Teams.unpack(team)},
    p2: {name: 'P2', team: Teams.unpack(team)},
  };
  const battle = new Battle(options);
  battle.makeChoices('team 123456', 'team 123456');
  const serialized = JSON.stringify(battle.toJSON());
  const direct = Battle.fromJSON(serialized);
  direct.makeChoices('move 1', 'move 1');
  const pool = new ShowdownWorkerPool(showdownModule, 1);
  try {
    const result = await pool.simulate(
      {particleId: 'known', hypothesisId: 'known', weight: 1, seed: 1, simulatorState: serialized},
      move,
      move,
      {observation: {perspective: 'p1'}} as DecisionContext,
    );
    assert.deepEqual(stableState(JSON.parse(result.nextState ?? '{}')), stableState(direct.toJSON()));
    const continuation = await pool.simulateContinuation(result.nextState ?? '', {
      observation: {perspective: 'p1'},
      format: {id: 'champions-ou'},
    } as DecisionContext);
    assert.ok(Number.isFinite(continuation.value));
    assert.ok((continuation.expandedNodes ?? 0) > 0);
  } finally {
    await pool.close();
  }
});
