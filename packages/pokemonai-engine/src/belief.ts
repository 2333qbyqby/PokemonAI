import {hashString, SeededRandom} from './random.js';
import type {
  BattleEvent,
  BattleObservation,
  BeliefState,
  SetCandidate,
  SpeciesMetaProfile,
  StatSpread,
  TeamMetaRecord,
  TeamHypothesis,
  WeightedOption,
  WorldParticle,
} from './types.js';

export interface MetaEvidence {
  readonly publishedAt: string;
  readonly sourceUpdatedAt: string;
  readonly teamSourceUpdatedAt?: string;
  readonly speciesProfiles: Readonly<Record<string, SpeciesMetaProfile>>;
  readonly teamRecords?: readonly TeamMetaRecord[];
}

const MIN_UNKNOWN_TAIL = 0.1;
const FACTORIZED_HYPOTHESES = 16;
const normalizeId = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const teamSpeciesId = (value: string) => normalizeId(value).replace(/mega(?:x|y)?$/, '');

function normalized(hypotheses: readonly TeamHypothesis[]): TeamHypothesis[] {
  const total = hypotheses.reduce((sum, item) => sum + item.probability, 0);
  if (total <= 0) return [];
  return hypotheses.map(item => ({...item, probability: item.probability / total}));
}

function effectiveSampleSize(hypotheses: readonly TeamHypothesis[]): number {
  const denominator = hypotheses.reduce((sum, item) => sum + item.probability ** 2, 0);
  return denominator ? 1 / denominator : 0;
}

function unknownTailMass(hypotheses: readonly TeamHypothesis[]): number {
  const mass = hypotheses.filter(item => item.unknownTail).reduce((sum, item) => sum + item.probability, 0);
  return hypotheses.some(item => !item.unknownTail) ? Math.max(MIN_UNKNOWN_TAIL, mass) : mass;
}

function opponentSide(observation: BattleObservation) {
  return observation.perspective === 'p1' ? observation.sides.p2 : observation.sides.p1;
}

export function speciesProfile(meta: MetaEvidence, species: string): SpeciesMetaProfile | undefined {
  return meta.speciesProfiles[normalizeId(species)];
}

function weightedChoice<T extends {readonly probability: number}>(
  values: readonly T[],
  random: SeededRandom,
): T | undefined {
  const total = values.reduce((sum, item) => sum + Math.max(0, item.probability), 0);
  if (total <= 0) return undefined;
  let roll = random.next() * total;
  for (const item of values) {
    roll -= Math.max(0, item.probability);
    if (roll <= 0) return item;
  }
  return values[values.length - 1];
}

function sampleMoves(
  profile: SpeciesMetaProfile | undefined,
  revealed: readonly string[],
  random: SeededRandom,
): string[] {
  const selected = [...new Map(revealed.map(move => [normalizeId(move), move])).values()].slice(0, 4);
  const selectedIds = new Set(selected.map(normalizeId));
  const candidates = (profile?.moves ?? [])
    .filter(move => !selectedIds.has(normalizeId(move.name)) && move.probability > 0)
    .map(move => ({
      move,
      score: -Math.log(Math.max(Number.EPSILON, random.next())) / Math.max(0.001, move.probability),
    }))
    .sort((left, right) => left.score - right.score || left.move.name.localeCompare(right.move.name));
  for (const candidate of candidates) {
    if (selected.length >= 4) break;
    selected.push(candidate.move.name);
  }
  return selected;
}

function sampledName(values: readonly WeightedOption[], random: SeededRandom): string | undefined {
  return weightedChoice(values, random)?.name;
}

function sampledUnusedName(
  values: readonly WeightedOption[],
  usedNames: ReadonlySet<string>,
  random: SeededRandom,
): string | undefined {
  return weightedChoice(
    values.filter(value => !usedNames.has(normalizeId(value.name))),
    random,
  )?.name;
}

function sampledSpread(values: readonly StatSpread[], random: SeededRandom): StatSpread | undefined {
  return weightedChoice(values, random);
}

function makeCandidate(
  pokemon: ReturnType<typeof opponentSide>['pokemon'][number],
  profile: SpeciesMetaProfile | undefined,
  random: SeededRandom,
  hypothesisIndex: number,
  usedItems: Set<string>,
): SetCandidate {
  if (!profile) {
    if (pokemon.revealedItem) usedItems.add(normalizeId(pokemon.revealedItem));
    return {
      id: `unknown:${hypothesisIndex}:${normalizeId(pokemon.species)}`,
      species: pokemon.species,
      moves: pokemon.revealedMoves,
      ...(pokemon.revealedItem ? {item: pokemon.revealedItem} : {}),
      ...(pokemon.revealedAbility ? {ability: pokemon.revealedAbility} : {}),
      probability: 1,
      source: 'unknown-tail',
      unknownTail: true,
    };
  }
  const spread = sampledSpread(profile.statSpreads, random);
  const nature = spread?.nature ?? sampledName(profile.natures, random);
  const speed = weightedChoice(profile.speedDistribution, random)?.value;
  const item = pokemon.revealedItem ?? sampledUnusedName(profile.items, usedItems, random);
  if (item) usedItems.add(normalizeId(item));
  const ability = pokemon.revealedAbility ?? sampledName(profile.abilities, random);
  return {
    id: `munchstats:${hypothesisIndex}:${normalizeId(profile.species)}`,
    species: profile.species,
    moves: sampleMoves(profile, pokemon.revealedMoves, random),
    ...(item ? {item} : {}),
    ...(ability ? {ability} : {}),
    ...(pokemon.teraType ? {teraType: pokemon.teraType} : {}),
    ...(nature ? {nature} : {}),
    ...(spread ? {statPoints: spread.values} : {}),
    ...(speed === undefined ? {} : {speed}),
    probability: 1,
    source: 'munchstats',
  };
}

function makeUnknownHypothesis(observation: BattleObservation): TeamHypothesis {
  const sets = opponentSide(observation).pokemon.map((pokemon, index) => ({
    id: `tail:${index}:${normalizeId(pokemon.species)}`,
    species: pokemon.species,
    moves: pokemon.revealedMoves,
    ...(pokemon.revealedItem ? {item: pokemon.revealedItem} : {}),
    ...(pokemon.revealedAbility ? {ability: pokemon.revealedAbility} : {}),
    ...(pokemon.teraType ? {teraType: pokemon.teraType} : {}),
    probability: 1,
    source: 'unknown-tail',
    unknownTail: true,
  }));
  return {
    id: `unknown:${observation.historyHash}`,
    sets,
    archetype: 'unknown-tail',
    probability: MIN_UNKNOWN_TAIL,
    unknownTail: true,
  };
}

function factorizedHypotheses(observation: BattleObservation, meta: MetaEvidence): TeamHypothesis[] {
  const opponent = opponentSide(observation);
  const hasEvidence = opponent.pokemon.some(pokemon => speciesProfile(meta, pokemon.species));
  if (!hasEvidence) return [makeUnknownHypothesis(observation)];
  const random = new SeededRandom(hashString(
    `${meta.sourceUpdatedAt}:${meta.teamSourceUpdatedAt ?? ''}:${observation.historyHash}`,
  ));
  const probability = (1 - MIN_UNKNOWN_TAIL) / FACTORIZED_HYPOTHESES;
  const hypotheses = Array.from({length: FACTORIZED_HYPOTHESES}, (_, index) => {
    const usedItems = new Set<string>();
    const sets = opponent.pokemon.map(pokemon => makeCandidate(
      pokemon,
      speciesProfile(meta, pokemon.species),
      random,
      index,
      usedItems,
    ));
    return {
      id: `factorized:${observation.historyHash}:${index}`,
      sets,
      archetype: 'factorized-meta',
      probability,
      unknownTail: sets.some(set => set.unknownTail),
    } satisfies TeamHypothesis;
  });
  return [...hypotheses, makeUnknownHypothesis(observation)];
}

function corpusHypotheses(observation: BattleObservation, meta: MetaEvidence): TeamHypothesis[] {
  const opponent = opponentSide(observation);
  if (opponent.pokemon.length !== 6) return [];
  const observedRoster = opponent.pokemon.map(pokemon => teamSpeciesId(pokemon.species)).sort().join(',');
  const matches = (meta.teamRecords ?? [])
    .filter(team => (
      team.completeness === 'full-set' && team.sets.length === 6 &&
      ['valid', 'prevalidated'].includes(team.validationStatus) &&
      team.roster.map(teamSpeciesId).sort().join(',') === observedRoster
    ))
    .slice(0, 12);
  if (!matches.length) return [];
  const weights = matches.map(team => Math.max(1, team.usage?.battles ?? 1));
  const total = weights.reduce((sum, value) => sum + value, 0);
  return matches.map((team, index) => ({
    id: `team-corpus:${team.id}`,
    sets: team.sets.map((set, setIndex) => ({
      id: `team-corpus:${team.id}:${setIndex}`,
      species: set.species,
      moves: set.moves,
      ...(set.item ? {item: set.item} : {}),
      ...(set.ability ? {ability: set.ability} : {}),
      ...(set.teraType ? {teraType: set.teraType} : {}),
      ...(set.nature ? {nature: set.nature} : {}),
      ...(set.statPoints ? {statPoints: set.statPoints} : {}),
      probability: 1,
      source: 'munchstats-team',
    })),
    archetype: 'observed-team',
    probability: weights[index]! / total,
    unknownTail: false,
  }));
}

function initialHypotheses(observation: BattleObservation, meta: MetaEvidence): TeamHypothesis[] {
  const factorized = factorizedHypotheses(observation, meta);
  const corpus = corpusHypotheses(observation, meta);
  if (!corpus.length) return factorized;
  const knownFactorized = factorized.filter(item => !item.unknownTail);
  const unknown = factorized.find(item => item.unknownTail) ?? makeUnknownHypothesis(observation);
  const corpusMass = knownFactorized.length ? 0.55 : 0.9;
  const factorizedMass = knownFactorized.length ? 0.35 : 0;
  return [
    ...corpus.map(item => ({...item, probability: item.probability * corpusMass})),
    ...knownFactorized.map(item => ({...item, probability: item.probability / 0.9 * factorizedMass})),
    {...unknown, probability: MIN_UNKNOWN_TAIL},
  ];
}

function revealedMatches(candidate: SetCandidate, species: string, moves: readonly string[], item?: string, ability?: string, teraType?: string): boolean {
  if (teamSpeciesId(candidate.species) !== teamSpeciesId(species)) return false;
  if (candidate.unknownTail) return true;
  if (moves.some(move => !candidate.moves.some(value => normalizeId(value) === normalizeId(move)))) return false;
  if (item && candidate.item && normalizeId(candidate.item) !== normalizeId(item)) return false;
  if (ability && candidate.ability && normalizeId(candidate.ability) !== normalizeId(ability)) return false;
  if (teraType && candidate.teraType && normalizeId(candidate.teraType) !== normalizeId(teraType)) return false;
  return true;
}

function hardFilter(hypothesis: TeamHypothesis, observation: BattleObservation): boolean {
  const opponent = opponentSide(observation);
  return opponent.pokemon.every(pokemon => hypothesis.sets.some(candidate => revealedMatches(
    candidate,
    pokemon.species,
    pokemon.revealedMoves,
    pokemon.revealedItem,
    pokemon.revealedAbility,
    pokemon.teraType,
  )));
}

function eventSpecies(observation: BattleObservation, ident: string): string {
  for (const side of Object.values(observation.sides)) {
    const pokemon = side.pokemon.find(value => value.ident === ident || value.ident.endsWith(`: ${ident}`));
    if (pokemon) return pokemon.species;
  }
  return ident.includes(':') ? ident.slice(ident.indexOf(':') + 1).trim() : ident;
}

function likelihood(hypothesis: TeamHypothesis, events: readonly BattleEvent[], observation: BattleObservation): number {
  let value = 1;
  for (const event of events) {
    if (event.type === 'speed-order') {
      const fasterSpecies = eventSpecies(observation, event.faster);
      const slowerSpecies = eventSpecies(observation, event.slower);
      const faster = hypothesis.sets.find(set => teamSpeciesId(fasterSpecies) === teamSpeciesId(set.species));
      const slower = hypothesis.sets.find(set => teamSpeciesId(slowerSpecies) === teamSpeciesId(set.species));
      if (faster?.speed !== undefined && slower?.speed !== undefined) value *= faster.speed >= slower.speed ? 0.9 : 0.1;
    } else if (event.type === 'damage') {
      const species = eventSpecies(observation, event.target);
      const candidate = hypothesis.sets.find(set => teamSpeciesId(set.species) === teamSpeciesId(species));
      if (!candidate || candidate.unknownTail) continue;
      const item = normalizeId(candidate.item ?? '');
      const after = Number.parseInt(event.condition.split('/')[0] ?? '', 10);
      const before = Number.parseInt(event.previousCondition?.split('/')[0] ?? '', 10);
      const maximum = Number.parseInt(event.condition.split('/')[1] ?? '', 10);
      const survivedAtOne = Number.isFinite(before) && Number.isFinite(maximum) && before === maximum && after === 1;
      if (survivedAtOne) value *= item === 'focussash' ? 2 : 0.5;
      const defensiveItem = ['assaultvest', 'eviolite'].includes(item);
      if (event.fractionLost !== undefined && event.fractionLost < 0.35) value *= defensiveItem ? 1.2 : 0.95;
      if (event.fractionLost !== undefined && event.fractionLost > 0.7) value *= defensiveItem ? 0.8 : 1.05;
    }
  }
  return value;
}

export class BeliefEngine {
  initialize(observation: BattleObservation, meta: MetaEvidence): BeliefState {
    const hypotheses = normalized(initialHypotheses(observation, meta));
    const speedIntervals = Object.fromEntries(opponentSide(observation).pokemon.flatMap(pokemon => {
      const values = speciesProfile(meta, pokemon.species)?.speedDistribution.map(item => item.value) ?? [];
      return values.length ? [[pokemon.species, {min: Math.min(...values), max: Math.max(...values)}]] : [];
    }));
    return {
      hypotheses,
      speedIntervals,
      revealedResources: {},
      unknownTailMass: unknownTailMass(hypotheses),
      effectiveSampleSize: effectiveSampleSize(hypotheses),
      recovered: false,
    };
  }

  update(previous: BeliefState, observation: BattleObservation, events: readonly BattleEvent[], meta: MetaEvidence): BeliefState {
    let hypotheses = previous.hypotheses
      .filter(item => hardFilter(item, observation))
      .map(item => ({...item, probability: item.probability * likelihood(item, events, observation)}));
    const hasEvidence = opponentSide(observation).pokemon.some(pokemon => speciesProfile(meta, pokemon.species));
    let recovered = false;
    if (!hypotheses.length || hypotheses.every(item => item.probability <= 0) || (hasEvidence && !hypotheses.some(item => !item.unknownTail))) {
      hypotheses = this.initialize(observation, meta).hypotheses.slice();
      recovered = true;
    }
    hypotheses = normalized(hypotheses);
    const revealedResources: Record<string, readonly string[]> = {...previous.revealedResources};
    for (const pokemon of opponentSide(observation).pokemon) {
      revealedResources[pokemon.species] = [
        ...pokemon.revealedMoves,
        ...(pokemon.revealedItem ? [`item:${pokemon.revealedItem}`] : []),
        ...(pokemon.revealedAbility ? [`ability:${pokemon.revealedAbility}`] : []),
        ...(pokemon.teraType ? [`tera:${pokemon.teraType}`] : []),
      ];
    }
    return {
      hypotheses,
      speedIntervals: previous.speedIntervals,
      revealedResources,
      unknownTailMass: unknownTailMass(hypotheses),
      effectiveSampleSize: effectiveSampleSize(hypotheses),
      recovered,
    };
  }

  particles(belief: BeliefState, count: number, seed: number): WorldParticle[] {
    const random = new SeededRandom(seed);
    const cumulative: Array<{item: TeamHypothesis; threshold: number}> = [];
    let total = 0;
    for (const item of belief.hypotheses) {
      total += item.probability;
      cumulative.push({item, threshold: total});
    }
    if (!cumulative.length) return [];
    return Array.from({length: Math.max(1, count)}, (_, index) => {
      const roll = (index + random.next()) / Math.max(1, count);
      const selected = cumulative.find(item => roll <= item.threshold)?.item ?? cumulative[cumulative.length - 1]!.item;
      return {
        particleId: `${seed.toString(16)}:${index}`,
        hypothesisId: selected.id,
        weight: 1 / Math.max(1, count),
        seed: (seed + Math.imul(index + 1, 2654435761)) >>> 0,
      };
    });
  }
}
