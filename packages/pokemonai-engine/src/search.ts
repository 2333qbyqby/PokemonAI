import {SeededRandom} from './random.js';
import {HeuristicPolicy} from './policy.js';
import type {MetaEvidence} from './belief.js';
import type {
  ActionEvaluation,
  DecisionContext,
  DecisionTrace,
  LegalSideAction,
  OpponentModel,
  PolicyPrior,
  SearchEvaluation,
  SearchPolicy,
  WorldParticle,
} from './types.js';

export interface TurnSimulationResult {
  readonly value: number;
  readonly terminal: boolean;
  readonly nextState?: string;
  readonly expandedNodes?: number;
}

export interface TurnSimulator {
  simulate(particle: WorldParticle, ownAction: LegalSideAction, opponentAction: LegalSideAction, context: DecisionContext): Promise<TurnSimulationResult>;
  simulateContinuation?(state: string, context: DecisionContext): Promise<TurnSimulationResult>;
}

export interface OpponentActionProvider {
  actions(context: DecisionContext): Promise<readonly LegalSideAction[]>;
}

type OpponentChoice = {command: LegalSideAction['commands'][number]; tags: string[]};

export class UniformOpponentModel implements OpponentModel {
  async distribution(_context: DecisionContext, actions: readonly LegalSideAction[]): Promise<ReadonlyMap<string, number>> {
    const probability = actions.length ? 1 / actions.length : 0;
    return new Map(actions.map(action => [action.id, probability]));
  }
}

const normalizeId = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

function inferredMoveTarget(move: string, activeIndex: number, activeSlots: number): {target?: number} {
  if (activeSlots === 1) return {};
  const id = normalizeId(move);
  const noTarget = new Set([
    'protect', 'detect', 'spikyshield', 'kingsshield', 'banefulbunker', 'silktrap',
    'tailwind', 'trickroom', 'followme', 'ragepowder', 'lifedew',
    'recover', 'roost', 'slackoff', 'synthesis', 'softboiled', 'rest',
    'swordsdance', 'nastyplot', 'calmmind', 'dragondance', 'quiverdance', 'bulkup', 'shellsmash',
    'rockslide', 'earthquake', 'dazzlinggleam', 'heatwave', 'surf', 'muddywater',
    'snarl', 'icywind', 'electroweb', 'hypervoice', 'discharge', 'blizzard',
    'eruption', 'waterspout', 'matchagotcha',
  ]);
  if (noTarget.has(id)) return {};
  if (id === 'helpinghand') return {target: activeIndex === 0 ? -2 : -1};
  return {target: 1};
}

export class MetaOpponentModel implements OpponentModel {
  constructor(private readonly meta: MetaEvidence) {}

  async distribution(_context: DecisionContext, actions: readonly LegalSideAction[]): Promise<ReadonlyMap<string, number>> {
    const weights = actions.map(action => {
      const evidence = action.tags.flatMap(tag => {
        if (!tag.startsWith('meta-move:')) return [];
        const [, species, move] = tag.split(':');
        const profile = species ? this.meta.speciesProfiles[species] : undefined;
        const probability = profile?.moves.find(item => normalizeId(item.name) === move)?.probability;
        return probability === undefined ? [] : [probability];
      });
      if (evidence.length) return evidence.reduce((weight, probability) => weight * Math.max(0.01, probability), 1);
      return action.tags.includes('switch') ? 0.2 : 1;
    });
    const total = weights.reduce((sum, value) => sum + value, 0) || 1;
    return new Map(actions.map((action, index) => [action.id, (weights[index] ?? 0) / total]));
  }
}

class BeliefOpponentActions implements OpponentActionProvider {
  async actions(context: DecisionContext): Promise<readonly LegalSideAction[]> {
    if (context.observation.teamPreview) return context.legalActions;
    const opponentId = context.observation.perspective === 'p1' ? 'p2' : 'p1';
    const side = context.observation.sides[opponentId];
    const active = side.pokemon.filter(pokemon => pokemon.active && !pokemon.fainted);
    const reserves = side.pokemon.filter(pokemon => !pokemon.active && !pokemon.fainted);
    const top = [...context.belief.hypotheses].sort((a, b) => b.probability - a.probability)[0];
    const slots = active.map((pokemon, activeIndex) => {
      const set = top?.sets.find(candidate => candidate.species.toLowerCase() === pokemon.species.toLowerCase());
      const moves = [...new Set([...pokemon.revealedMoves, ...(set?.moves ?? [])])].slice(0, 4);
      const speciesId = normalizeId(pokemon.species);
      return [
        ...(moves.length ? moves : ['unknown']).map((move, index) => ({
          command: {
            kind: 'move' as const,
            slot: index + 1,
            ...inferredMoveTarget(move, activeIndex, context.format.activeSlots),
          },
          tags: ['move', `move-id:${normalizeId(move)}`, `meta-move:${speciesId}:${normalizeId(move)}`],
        })),
        ...reserves.map(reserve => ({
          command: {kind: 'switch' as const, slot: side.pokemon.indexOf(reserve) + 1},
          tags: ['switch'],
        })),
      ];
    });
    if (!slots.length) return context.legalActions;
    const rows = slots.reduce<OpponentChoice[][]>(
      (current, choices) => current.flatMap(row => choices.map(choice => [...row, choice])),
      [[]],
    );
    return rows
      .filter(choices => {
        const switches = choices.map(choice => choice.command).filter(command => command.kind === 'switch').map(command => command.slot);
        return switches.length === new Set(switches).size;
      })
      .map(choices => {
        const commands = choices.map(choice => choice.command);
        const showdown = commands.map(command => {
          if (command.kind === 'switch') return `switch ${command.slot}`;
          if (command.kind === 'pass') return 'pass';
          return `move ${command.slot}${command.target === undefined ? '' : ` ${command.target}`}`;
        }).join(', ');
        return {
          id: `opponent:${showdown}`,
          commands,
          showdown,
          tags: [...new Set(choices.flatMap(choice => choice.tags))],
        };
      });
  }
}

class HeuristicTurnSimulator implements TurnSimulator {
  async simulate(particle: WorldParticle, ownAction: LegalSideAction, opponentAction: LegalSideAction): Promise<TurnSimulationResult> {
    const ownPressure = ownAction.tags.includes('move') ? 0.25 : ownAction.tags.includes('team-preview') ? 0.2 : 0.05;
    const opponentPressure = opponentAction.tags.includes('move') ? 0.25 : 0.05;
    const variance = ((particle.seed ^ ownAction.id.length ^ opponentAction.id.length) % 101) / 1000;
    return {value: ownPressure - opponentPressure + variance, terminal: false};
  }
}

function confidence(values: readonly number[]): readonly [number, number] {
  if (!values.length) return [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length === 1) return [mean, mean];
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const half = 1.96 * Math.sqrt(variance / values.length);
  return [mean - half, mean + half];
}

function lowerTail(values: readonly number[], fraction = 0.25): number {
  if (!values.length) return Number.NEGATIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  const count = Math.max(1, Math.ceil(sorted.length * fraction));
  return sorted.slice(0, count).reduce((sum, value) => sum + value, 0) / count;
}

function responseThreat(action: LegalSideAction): number {
  const moveCount = action.commands.filter(command => command.kind === 'move').length;
  const switchCount = action.commands.filter(command => command.kind === 'switch').length;
  return moveCount * 2 + Number(action.tags.includes('speed-control')) +
    Number(action.tags.includes('setup')) + Number(action.tags.includes('priority')) - switchCount * 0.25;
}

function evenlySample<T>(values: readonly T[], count: number): T[] {
  if (values.length <= count) return [...values];
  return Array.from({length: count}, (_, index) => values[Math.floor(index * values.length / count)]!);
}

function summarizeBelief(context: DecisionContext) {
  const archetypes = new Map<string, number>();
  for (const item of context.belief.hypotheses) archetypes.set(item.archetype, (archetypes.get(item.archetype) ?? 0) + item.probability);
  return {
    hypothesisCount: context.belief.hypotheses.length,
    unknownTailMass: context.belief.unknownTailMass,
    effectiveSampleSize: context.belief.effectiveSampleSize,
    topArchetypes: [...archetypes].map(([name, probability]) => ({name, probability})).sort((a, b) => b.probability - a.probability).slice(0, 3),
    recovered: context.belief.recovered,
  };
}

export class RobustSearchPolicy implements SearchPolicy {
  constructor(
    private readonly prior: PolicyPrior = new HeuristicPolicy(),
    private readonly opponentModel: OpponentModel = new UniformOpponentModel(),
    private readonly opponentActions: OpponentActionProvider = new BeliefOpponentActions(),
    private readonly simulator: TurnSimulator = new HeuristicTurnSimulator(),
  ) {}

  async decide(context: DecisionContext): Promise<{readonly action: LegalSideAction; readonly trace: DecisionTrace}> {
    const started = performance.now();
    if (!context.legalActions.length) throw new Error('No legal actions are available');
    const evaluated = await this.prior.evaluate(context, context.legalActions);
    const own = evaluated.slice(0, context.format.searchProfile.ownActionLimit);
    const allOpponents = await this.opponentActions.actions(context);
    const fullDistribution = await this.opponentModel.distribution(context, allOpponents);
    const opponents = [...allOpponents]
      .sort((a, b) => (fullDistribution.get(b.id) ?? 0) - (fullDistribution.get(a.id) ?? 0) || a.id.localeCompare(b.id))
      .slice(0, context.format.searchProfile.opponentActionLimit);
    const worstResponse = allOpponents
      .filter(action => !opponents.some(selected => selected.id === action.id))
      .sort((a, b) => responseThreat(b) - responseThreat(a) || a.id.localeCompare(b.id))[0];
    if (worstResponse) opponents.push(worstResponse);
    const selectedMass = opponents.reduce((sum, action) => sum + (fullDistribution.get(action.id) ?? 0), 0);
    const distribution = new Map(opponents.map(action => [
      action.id,
      selectedMass ? (fullDistribution.get(action.id) ?? 0) / selectedMass : 1 / Math.max(1, opponents.length),
    ]));
    const search: SearchEvaluation[] = [];
    const reasons: string[] = [];
    if (worstResponse) reasons.push('opponent-worst-response');
    const showdownParticles = context.particles.filter(particle => Boolean(particle.simulatorState)).length;
    reasons.push(showdownParticles ? `showdown-particles:${showdownParticles}` : 'heuristic-particles');
    let fallback: DecisionTrace['fallback'];
    let expandedNodes = 0;
    const leafStates = new Map<string, Array<{state: string; weight: number; responseId: string}>>();

    try {
      for (const candidate of own) {
        if (performance.now() >= context.deadlineMs - context.format.searchProfile.returnReserveMs) break;
        const samples: number[] = [];
        const responseMeans = new Map<string, number[]>();
        let expected = 0;
        let mass = 0;
        const jobs: Array<{particle: WorldParticle; response: LegalSideAction}> = [];
        for (const particle of context.particles.slice(0, context.format.searchProfile.maxParticles)) {
          for (const response of opponents) {
            if (expandedNodes + jobs.length >= context.format.searchProfile.maxNodes) break;
            jobs.push({particle, response});
          }
        }
        const batchSize = Math.max(1, context.format.searchProfile.maxWorkers);
        for (let offset = 0; offset < jobs.length; offset += batchSize) {
          if (performance.now() >= context.deadlineMs - context.format.searchProfile.returnReserveMs) break;
          const batch = jobs.slice(offset, offset + batchSize);
          const results = await Promise.allSettled(batch.map(job =>
            this.simulator.simulate(job.particle, candidate.action, job.response, context)
          ));
          expandedNodes += batch.length;
          for (let index = 0; index < results.length; index += 1) {
            const result = results[index]!;
            const job = batch[index]!;
            if (result.status === 'rejected') {
              if (!reasons.includes('particle-simulation-rejected')) reasons.push('particle-simulation-rejected');
              continue;
            }
            const value = candidate.score + result.value.value;
            const probability = distribution.get(job.response.id) ?? 0;
            samples.push(value);
            if (!result.value.terminal && result.value.nextState) {
              const leaves = leafStates.get(candidate.action.id) ?? [];
              leaves.push({
                state: result.value.nextState,
                weight: job.particle.weight * probability,
                responseId: job.response.id,
              });
              leafStates.set(candidate.action.id, leaves);
            }
            const values = responseMeans.get(job.response.id) ?? [];
            values.push(value);
            responseMeans.set(job.response.id, values);
            expected += value * job.particle.weight * probability;
            mass += job.particle.weight * probability;
          }
        }
        if (!samples.length) break;
        expected /= Math.max(mass, Number.EPSILON);
        const tail = lowerTail(samples);
        const responseValues = [...responseMeans.values()].map(values => values.reduce((sum, value) => sum + value, 0) / values.length);
        const worst = Math.min(...responseValues);
        const riskWeight = context.gamePlan.riskPosture === 'protect-lead' ? 0.5 : context.gamePlan.riskPosture === 'seek-variance' ? 0.15 : 0.3;
        const worstWeight = context.gamePlan.riskPosture === 'protect-lead' ? 0.25 : 0.15;
        search.push({
          action: candidate.action,
          expectedValue: expected,
          lowerTailValue: tail,
          worstResponseValue: worst,
          adjustedValue: expected * (1 - riskWeight - worstWeight) + tail * riskWeight + worst * worstWeight,
          sampleCount: samples.length,
          confidence95: confidence(samples),
          completedDepth: 1,
        });
      }

      const continuation = this.simulator.simulateContinuation?.bind(this.simulator);
      const remainingMs = context.deadlineMs - context.format.searchProfile.returnReserveMs - performance.now();
      if (continuation && remainingMs > context.format.searchProfile.decisionBudgetMs * context.format.searchProfile.secondTurnBudgetRatio) {
        const top = [...search].sort((a, b) => b.adjustedValue - a.adjustedValue).slice(0, 2);
        for (const current of top) {
          const leaves = evenlySample(leafStates.get(current.action.id) ?? [], 16);
          if (!leaves.length) continue;
          const values: number[] = [];
          const responseMeans = new Map<string, number[]>();
          let expected = 0;
          let mass = 0;
          const priorScore = evaluated.find(item => item.action.id === current.action.id)?.score ?? 0;
          const batchSize = Math.max(1, context.format.searchProfile.maxWorkers);
          for (let offset = 0; offset < leaves.length; offset += batchSize) {
            if (performance.now() >= context.deadlineMs - context.format.searchProfile.returnReserveMs) break;
            const continuationSlots = Math.floor((context.format.searchProfile.maxNodes - expandedNodes) / 16);
            if (continuationSlots <= 0) break;
            const batch = leaves.slice(offset, offset + Math.min(batchSize, continuationSlots));
            const results = await Promise.allSettled(batch.map(leaf => continuation(leaf.state, context)));
            for (let index = 0; index < results.length; index += 1) {
              const result = results[index]!;
              const leaf = batch[index]!;
              if (result.status === 'rejected') continue;
              expandedNodes += result.value.expandedNodes ?? 1;
              const value = priorScore + result.value.value;
              values.push(value);
              const responseValues = responseMeans.get(leaf.responseId) ?? [];
              responseValues.push(value);
              responseMeans.set(leaf.responseId, responseValues);
              expected += value * leaf.weight;
              mass += leaf.weight;
            }
          }
          if (!values.length) continue;
          expected /= Math.max(mass, Number.EPSILON);
          const tail = lowerTail(values);
          const responses = [...responseMeans.values()].map(items => items.reduce((sum, value) => sum + value, 0) / items.length);
          const worst = Math.min(...responses);
          const riskWeight = context.gamePlan.riskPosture === 'protect-lead' ? 0.5 : context.gamePlan.riskPosture === 'seek-variance' ? 0.15 : 0.3;
          const worstWeight = context.gamePlan.riskPosture === 'protect-lead' ? 0.25 : 0.15;
          const updated: SearchEvaluation = {
            ...current,
            expectedValue: expected,
            lowerTailValue: tail,
            worstResponseValue: worst,
            adjustedValue: expected * (1 - riskWeight - worstWeight) + tail * riskWeight + worst * worstWeight,
            sampleCount: current.sampleCount + values.length,
            confidence95: confidence(values),
            completedDepth: 2,
          };
          search.splice(search.indexOf(current), 1, updated);
        }
        if (search.some(item => item.completedDepth === 2)) reasons.push('selective-second-turn');
      }
    } catch {
      reasons.push('search-failed');
    }

    let selected: LegalSideAction;
    if (!search.length) {
      selected = evaluated[0]?.action ?? context.legalActions[0]!;
      fallback = evaluated.length ? 'heuristic' : 'highest-legal';
      reasons.push('search-timeout-fallback');
    } else {
      search.sort((a, b) => b.adjustedValue - a.adjustedValue || a.action.id.localeCompare(b.action.id));
      const top = search[0]!;
      const tied = search.filter(item =>
        item.confidence95[0] <= top.confidence95[1] && item.confidence95[1] >= top.confidence95[0]
      );
      if (tied.length > 1) {
        const random = new SeededRandom(context.seed);
        selected = tied[Math.floor(random.next() * tied.length)]!.action;
        reasons.push('seeded-confidence-tiebreak');
      } else selected = top.action;
    }
    if (context.belief.recovered) reasons.push('belief-recovery');
    const trace: DecisionTrace = {
      battleId: context.observation.battleId,
      turn: context.observation.turn,
      formatId: context.format.id,
      metaSourceUpdatedAt: context.metaSourceUpdatedAt,
      metaPublishedAt: context.metaPublishedAt,
      observationHash: context.observation.historyHash,
      seed: context.seed,
      candidates: evaluated,
      belief: summarizeBelief(context),
      search,
      selectedActionId: selected.id,
      ...(fallback ? {fallback} : {}),
      reasonCodes: reasons,
      elapsedMs: performance.now() - started,
    };
    return {action: selected, trace};
  }
}

export type {ActionEvaluation};
