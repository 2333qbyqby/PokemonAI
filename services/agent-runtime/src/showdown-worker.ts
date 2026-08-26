import {parentPort, workerData} from 'node:worker_threads';
import {createRequire} from 'node:module';
import {
  enumerateLegalActions,
  getFormatPack,
  type FormatId,
  type LegalSideAction,
  type ShowdownRequest,
} from '@pokemonai/engine';

interface Task {
  readonly id: number;
  readonly mode: 'turn' | 'continuation';
  readonly state: string;
  readonly perspective: 'p1' | 'p2';
  readonly ownAction?: string;
  readonly opponentAction?: string;
  readonly formatId?: FormatId;
}

const require = createRequire(import.meta.url);
const {Battle, Dex} = require(workerData.showdownModule) as {
  Battle: {fromJSON(value: string): BattleLike};
  Dex: {moves: {get(id: string): {basePower: number; priority: number; category: string}}};
};

interface PokemonLike {
  readonly hp: number;
  readonly maxhp: number;
  readonly fainted: boolean;
  readonly boosts: Readonly<Record<string, number>>;
}

interface SideLike {
  readonly pokemon: readonly PokemonLike[];
  readonly activeRequest?: ShowdownRequest | null;
}

function actionScore(action: LegalSideAction, request?: ShowdownRequest | null): number {
  return action.commands.reduce((total, command, activeIndex) => {
    if (command.kind === 'switch') return total + 0.08;
    if (command.kind !== 'move') return total;
    const moveId = request?.active?.[activeIndex]?.moves[command.slot - 1]?.id ?? '';
    const move = Dex.moves.get(moveId);
    if (move.category === 'Status') {
      const utility = ['protect', 'detect', 'tailwind', 'trickroom', 'followme', 'ragepowder'].includes(moveId) ? 0.45 : 0.18;
      return total + utility;
    }
    return total + move.basePower / 100 + Math.max(0, move.priority) * 0.15;
  }, 0);
}

function candidateActions(side: SideLike, formatId: FormatId, limit: number): Array<LegalSideAction | undefined> {
  const request = side.activeRequest;
  if (!request || request.wait) return [undefined];
  return enumerateLegalActions(request, getFormatPack(formatId))
    .sort((a, b) => actionScore(b, request) - actionScore(a, request) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

function chooseIfRequested(battle: BattleLike, side: 'p1' | 'p2', action?: LegalSideAction): void {
  if (!action) return;
  if (!battle.choose(side, action.showdown)) throw new Error(`Rejected continuation action: ${action.showdown}`);
}

function continuation(task: Task): {value: number; terminal: boolean; expandedNodes: number} {
  if (!task.formatId) throw new Error('Continuation task is missing a Format Pack');
  const root = Battle.fromJSON(task.state);
  if (root.ended) {
    const own = task.perspective === 'p1' ? root.p1 : root.p2;
    const opponent = task.perspective === 'p1' ? root.p2 : root.p1;
    return {value: sideValue(own) - sideValue(opponent), terminal: true, expandedNodes: 0};
  }
  const opponentId = task.perspective === 'p1' ? 'p2' : 'p1';
  const ownActions = candidateActions(task.perspective === 'p1' ? root.p1 : root.p2, task.formatId, 4);
  const opponentActions = candidateActions(opponentId === 'p1' ? root.p1 : root.p2, task.formatId, 4);
  let best = Number.NEGATIVE_INFINITY;
  let nodes = 0;
  for (const ownAction of ownActions) {
    const responses: number[] = [];
    for (const opponentAction of opponentActions) {
      const battle = Battle.fromJSON(task.state);
      chooseIfRequested(battle, task.perspective, ownAction);
      chooseIfRequested(battle, opponentId, opponentAction);
      const own = task.perspective === 'p1' ? battle.p1 : battle.p2;
      const opponent = task.perspective === 'p1' ? battle.p2 : battle.p1;
      responses.push(sideValue(own) - sideValue(opponent));
      nodes += 1;
    }
    const mean = responses.reduce((sum, value) => sum + value, 0) / Math.max(1, responses.length);
    best = Math.max(best, mean * 0.7 + Math.min(...responses) * 0.3);
  }
  return {value: best, terminal: false, expandedNodes: nodes};
}

interface BattleLike {
  readonly p1: SideLike;
  readonly p2: SideLike;
  readonly ended: boolean;
  readonly winner?: string;
  choose(side: 'p1' | 'p2', action: string): boolean;
  toJSON(): unknown;
}

function sideValue(side: SideLike): number {
  return side.pokemon.reduce((total, pokemon) => {
    const hp = pokemon.maxhp ? pokemon.hp / pokemon.maxhp : 0;
    const boosts = Object.values(pokemon.boosts).reduce((sum, value) => sum + Math.max(-1, Math.min(1, value / 6)), 0);
    return total + hp + boosts * 0.04 - Number(pokemon.fainted) * 0.4;
  }, 0);
}

parentPort?.on('message', (task: Task) => {
  try {
    if (task.mode === 'continuation') {
      parentPort?.postMessage({id: task.id, ...continuation(task)});
      return;
    }
    const battle = Battle.fromJSON(task.state);
    const opponent = task.perspective === 'p1' ? 'p2' : 'p1';
    if (!task.ownAction || !battle.choose(task.perspective, task.ownAction)) throw new Error(`Rejected own action: ${task.ownAction}`);
    if (!task.opponentAction || !battle.choose(opponent, task.opponentAction)) throw new Error(`Rejected opponent action: ${task.opponentAction}`);
    const ownSide = task.perspective === 'p1' ? battle.p1 : battle.p2;
    const opponentSide = task.perspective === 'p1' ? battle.p2 : battle.p1;
    parentPort?.postMessage({id: task.id, value: sideValue(ownSide) - sideValue(opponentSide), terminal: battle.ended, nextState: JSON.stringify(battle.toJSON())});
  } catch (error) {
    parentPort?.postMessage({id: task.id, error: error instanceof Error ? error.message : String(error)});
  }
});
