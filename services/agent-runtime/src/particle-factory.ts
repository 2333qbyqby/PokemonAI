import {createRequire} from 'node:module';
import path from 'node:path';
import {
  getFormatPack,
  type BattleObservation,
  type BeliefState,
  type PublicSideState,
  type SideId,
  type TeamHypothesis,
  type WorldParticle,
} from '@pokemonai/engine';
import type {RuntimeConfig, RuntimeTeam} from './config.js';

interface TeamSet {
  name?: string;
  species: string;
  item?: string;
  ability?: string;
  moves: string[];
  nature?: string;
  evs?: Record<string, number>;
  level?: number;
}

interface PokemonLike {
  species: {name: string; id: string};
  hp: number;
  maxhp: number;
  status: string;
  fainted: boolean;
  boosts: Record<string, number>;
  item: string;
  ability: string;
}

interface SideLike {
  pokemon: PokemonLike[];
  pokemonLeft: number;
}

interface BattleLike {
  p1: SideLike;
  p2: SideLike;
  turn: number;
  field: {weather: string; terrain: string};
  makeChoices(p1: string, p2: string): void;
  toJSON(): unknown;
}

interface ShowdownModule {
  Battle: new(options: unknown) => BattleLike;
  Teams: {unpack(value: string): TeamSet[] | null};
  TeamValidator: new(format: string) => {validateTeam(team: TeamSet[]): string[] | null};
  Dex: {
    forFormat(format: string): {
      species: {getMovePool(species: string): Set<string>};
    };
  };
}

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

function conditionRatio(condition?: string): number {
  if (!condition || condition.endsWith(' fnt')) return condition?.endsWith(' fnt') ? 0 : 1;
  const values = condition.split(' ')[0]!.split('/').map(Number);
  const hp = values[0] ?? Number.NaN;
  const max = values[1] ?? Number.NaN;
  return Number.isFinite(hp) && Number.isFinite(max) && max > 0 ? hp / max : 1;
}

function teamChoice(team: readonly TeamSet[], side: PublicSideState, bringSize: number, activeSlots: number): string {
  const desired = [
    ...side.pokemon.filter(pokemon => pokemon.active && !pokemon.fainted),
    ...side.pokemon.filter(pokemon => !pokemon.active && pokemon.revealedMoves.length > 0 && !pokemon.fainted),
    ...side.pokemon.filter(pokemon => !pokemon.fainted),
  ];
  const used = new Set<number>();
  const order: number[] = [];
  for (const pokemon of desired) {
    const index = team.findIndex((set, candidate) => !used.has(candidate) && normalize(set.species) === normalize(pokemon.species));
    if (index >= 0) {
      used.add(index);
      order.push(index + 1);
    }
  }
  for (let index = 0; index < team.length; index += 1) {
    if (!used.has(index)) order.push(index + 1);
  }
  const selected = order.slice(0, Math.min(bringSize, team.length));
  if (selected.length < activeSlots) throw new Error('Particle team does not contain enough active Pokemon');
  return `team ${selected.join('')}`;
}

function syncSide(side: SideLike, visible: PublicSideState): void {
  const matched = new Set<number>();
  for (const pokemon of visible.pokemon) {
    const index = side.pokemon.findIndex((candidate, position) =>
      !matched.has(position) && normalize(candidate.species.name || candidate.species.id) === normalize(pokemon.species)
    );
    if (index < 0) continue;
    matched.add(index);
    const target = side.pokemon[index]!;
    const ratio = conditionRatio(pokemon.condition);
    target.hp = Math.max(0, Math.min(target.maxhp, Math.round(target.maxhp * ratio)));
    target.fainted = pokemon.fainted || target.hp === 0;
    target.status = pokemon.status ?? (pokemon.condition?.split(' ')[1] ?? '');
    target.boosts = {...target.boosts, ...pokemon.boosts};
    if (pokemon.itemConsumed) target.item = '';
    else if (pokemon.revealedItem) target.item = normalize(pokemon.revealedItem);
    if (pokemon.revealedAbility) target.ability = normalize(pokemon.revealedAbility);
  }
  side.pokemonLeft = side.pokemon.filter(pokemon => !pokemon.fainted).length;
}

export class ShowdownParticleFactory {
  private readonly showdown: ShowdownModule;
  private readonly ownTeam: TeamSet[];
  private readonly learnsets: ReturnType<ShowdownModule['Dex']['forFormat']>['species'];
  private readonly validator: InstanceType<ShowdownModule['TeamValidator']>;

  constructor(private readonly config: RuntimeConfig, team: RuntimeTeam) {
    const require = createRequire(import.meta.url);
    this.showdown = require(path.join(config.projectRoot, 'vendor', 'pokemon-showdown', 'dist', 'sim', 'index.js')) as ShowdownModule;
    this.ownTeam = this.showdown.Teams.unpack(team.packed) ?? [];
    const showdownFormat = getFormatPack(config.formatId).baseShowdownFormat;
    this.learnsets = this.showdown.Dex.forFormat(showdownFormat).species;
    this.validator = new this.showdown.TeamValidator(showdownFormat);
  }

  materialize(
    particles: readonly WorldParticle[],
    belief: BeliefState,
    observation: BattleObservation,
  ): WorldParticle[] {
    const pack = getFormatPack(this.config.formatId);
    const hypotheses = new Map(belief.hypotheses.map(item => [item.id, item]));
    return particles.map(particle => {
      try {
        const hypothesis = hypotheses.get(particle.hypothesisId);
        if (!hypothesis) return particle;
        const opponentTeam = this.hypothesisTeam(hypothesis);
        if (!this.ownTeam.length || !opponentTeam.length) return particle;
        if (hypothesis.sets.some(set => set.source === 'munchstats') && this.validator.validateTeam(opponentTeam)) return particle;
        const ownSide = observation.sides[observation.perspective];
        const opponentId: SideId = observation.perspective === 'p1' ? 'p2' : 'p1';
        const opponentSide = observation.sides[opponentId];
        const p1Team = observation.perspective === 'p1' ? this.ownTeam : opponentTeam;
        const p2Team = observation.perspective === 'p2' ? this.ownTeam : opponentTeam;
        const battle = new this.showdown.Battle({
          formatid: pack.baseShowdownFormat,
          seed: [
            particle.seed >>> 0,
            (particle.seed ^ 0x9e3779b9) >>> 0,
            (particle.seed ^ 0x85ebca6b) >>> 0,
            (particle.seed ^ 0xc2b2ae35) >>> 0,
          ],
          p1: {name: 'Particle P1', team: p1Team},
          p2: {name: 'Particle P2', team: p2Team},
        });
        const p1Choice = teamChoice(p1Team, observation.sides.p1, pack.bringSize, pack.activeSlots);
        const p2Choice = teamChoice(p2Team, observation.sides.p2, pack.bringSize, pack.activeSlots);
        if (!observation.teamPreview) {
          battle.makeChoices(p1Choice, p2Choice);
          syncSide(battle.p1, observation.sides.p1);
          syncSide(battle.p2, observation.sides.p2);
          battle.turn = Math.max(1, observation.turn);
          battle.field.weather = normalize(observation.weather ?? '');
          battle.field.terrain = normalize(observation.terrain ?? '');
        }
        return {...particle, simulatorState: JSON.stringify(battle.toJSON())};
      } catch {
        return particle;
      }
    });
  }

  private hypothesisTeam(hypothesis: TeamHypothesis): TeamSet[] {
    const statNames = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
    return hypothesis.sets.map(set => {
      let legalMoves: string[] = [];
      let fallbackMoves: string[] = [];
      try {
        const movePool = this.learnsets.getMovePool(normalize(set.species));
        legalMoves = set.moves.filter(move => movePool.has(normalize(move))).slice(0, 4);
        fallbackMoves = [...movePool].slice(0, 4);
      } catch {
        legalMoves = [];
      }
      return {
        name: set.species,
        species: set.species,
        ...(set.item ? {item: set.item} : {}),
        ...(set.ability ? {ability: set.ability} : {}),
        ...(set.nature ? {nature: set.nature} : {}),
        ...(set.statPoints ? {evs: Object.fromEntries(statNames.map((name, index) => [name, set.statPoints?.[index] ?? 0]))} : {}),
        moves: legalMoves.length ? legalMoves : fallbackMoves.length ? fallbackMoves : ['struggle'],
        level: 50,
      };
    });
  }
}
