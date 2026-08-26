import {createRequire} from 'node:module';
import path from 'node:path';
import type {BattleObservation, LegalSideAction, ShowdownRequest, TeamMemberInput} from '@pokemonai/engine';

interface MoveData {
  readonly basePower: number;
  readonly category: 'Physical' | 'Special' | 'Status';
  readonly priority: number;
  readonly accuracy: number | true;
  readonly type: string;
  readonly target: string;
}

interface DexLike {
  readonly moves: {get(id: string): MoveData};
  readonly species: {get(name: string): {types: readonly string[]; baseStats: {spe: number}}};
  getEffectiveness(moveType: string, target: string): number;
  getImmunity(moveType: string, target: string): boolean;
}

export class ShowdownData {
  private readonly dex: DexLike;

  constructor(projectRoot: string) {
    const require = createRequire(import.meta.url);
    const showdown = require(path.join(projectRoot, 'vendor', 'pokemon-showdown', 'dist', 'sim', 'index.js')) as {Dex: DexLike};
    this.dex = showdown.Dex;
  }

  enrichRequest(request: ShowdownRequest): ShowdownRequest {
    return {
      ...request,
      ...(request.active ? {active: request.active.map(active => active ? {
        ...active,
        moves: active.moves.map(move => {
          const data = this.dex.moves.get(move.id);
          return {...move, basePower: data.basePower, category: data.category, priority: data.priority, accuracy: data.accuracy};
        }),
      } : null)} : {}),
    };
  }

  enrichTeamProfile(team: readonly TeamMemberInput[]): readonly TeamMemberInput[] {
    return team.map(member => ({
      ...member,
      baseSpeed: this.dex.species.get(member.species).baseStats.spe,
    }));
  }

  annotateActions(request: ShowdownRequest, observation: BattleObservation, actions: readonly LegalSideAction[]): LegalSideAction[] {
    const own = observation.sides[observation.perspective].pokemon.filter(pokemon => pokemon.active);
    const opponentId = observation.perspective === 'p1' ? 'p2' : 'p1';
    const opponents = observation.sides[opponentId].pokemon.filter(pokemon => pokemon.active);
    return actions.map(action => {
      let damagePressure = 0;
      let accuracyRisk = 0;
      let superEffectiveHits = 0;
      let immuneHits = 0;
      const targets: number[] = [];
      action.commands.forEach((command, activeIndex) => {
        if (command.kind !== 'move') return;
        const requestMove = request.active?.[activeIndex]?.moves[command.slot - 1];
        if (!requestMove) return;
        const move = this.dex.moves.get(requestMove.id);
        if (move.category === 'Status' || move.basePower <= 0) return;
        const targetIndexes = this.targetIndexes(command.target, move.target, opponents.length);
        const ownTypes = this.dex.species.get(own[activeIndex]?.species ?? '').types;
        const stab = ownTypes.includes(move.type) ? 1.5 : 1;
        const accuracy = move.accuracy === true ? 1 : move.accuracy / 100;
        accuracyRisk += 1 - accuracy;
        for (const targetIndex of targetIndexes) {
          const target = opponents[targetIndex];
          if (!target) continue;
          targets.push(targetIndex);
          const immune = !this.dex.getImmunity(move.type, target.species);
          const effectiveness = immune ? -8 : this.dex.getEffectiveness(move.type, target.species);
          if (immune) immuneHits += 1;
          else if (effectiveness > 0) superEffectiveHits += 1;
          const spread = targetIndexes.length > 1 ? 0.75 : 1;
          damagePressure += (move.basePower / 100) * stab * (immune ? 0 : 2 ** effectiveness) * accuracy * spread;
        }
      });
      const focusFire = targets.length >= 2 && new Set(targets).size === 1;
      return {
        ...action,
        tactical: {damagePressure, accuracyRisk, superEffectiveHits, immuneHits, focusFire},
        tags: [...new Set([...action.tags, ...(focusFire ? ['focus-fire'] : [])])],
      };
    });
  }

  private targetIndexes(target: number | undefined, moveTarget: string, opponentCount: number): number[] {
    if (target && target > 0) return [target - 1];
    if (['allAdjacentFoes', 'allAdjacent'].includes(moveTarget)) return Array.from({length: opponentCount}, (_, index) => index);
    return opponentCount ? [0] : [];
  }
}
