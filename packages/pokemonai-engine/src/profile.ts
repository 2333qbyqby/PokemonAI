import type {BattleObservation, FormatPack, GamePlan, SpeciesMetaProfile, TeamProfile, TeamRole} from './types.js';

export interface TeamMemberInput {
  readonly species: string;
  readonly moves: readonly string[];
  readonly item?: string;
  readonly ability?: string;
  readonly baseSpeed?: number;
}

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const intersects = (moves: Set<string>, candidates: readonly string[]) => candidates.some(move => moves.has(move));

export function buildTeamProfile(team: readonly TeamMemberInput[], format: FormatPack): TeamProfile {
  const members: TeamRole[] = team.map(member => {
    const moves = new Set(member.moves.map(normalize));
    const roles: string[] = [];
    if (intersects(moves, ['tailwind', 'trickroom', 'icywind', 'electroweb'])) roles.push('speed-control');
    if (intersects(moves, ['followme', 'ragepowder'])) roles.push('redirection');
    if (intersects(moves, ['fakeout', 'encore', 'taunt', 'spore', 'thunderwave'])) roles.push('disruption');
    if (intersects(moves, ['stealthrock', 'spikes', 'toxicspikes'])) roles.push('hazard-setter');
    if (intersects(moves, ['rapidspin', 'defog', 'mortalspin'])) roles.push('hazard-control');
    if (intersects(moves, ['recover', 'roost', 'slackoff', 'synthesis', 'wish'])) roles.push('sustain');
    if (intersects(moves, ['protect', 'detect', 'spikyshield'])) roles.push('protect');
    if (intersects(moves, ['swordsdance', 'nastyplot', 'calmmind', 'dragondance', 'quiverdance'])) roles.push('setup');
    if (intersects(moves, ['uturn', 'voltswitch', 'flipturn', 'partingshot'])) roles.push('pivot');
    if (!roles.length) roles.push('attacker');
    const speed = member.baseSpeed ?? 80;
    return {
      species: member.species,
      roles,
      speedTier: speed >= 105 ? 'fast' : speed <= 60 ? 'slow' : 'mid',
      offensivePressure: Math.min(1, 0.35 + Number(roles.includes('setup')) * 0.25 + Number(roles.includes('attacker')) * 0.25),
      defensiveValue: Math.min(1, 0.3 + Number(roles.includes('sustain')) * 0.35 + Number(roles.includes('redirection')) * 0.2),
    };
  });
  const roles = members.flatMap(member => member.roles);
  const archetypes: string[] = [];
  if (roles.includes('hazard-setter')) archetypes.push('hazard-balance');
  if (roles.includes('redirection') && roles.includes('setup')) archetypes.push('setup-offense');
  if (roles.includes('speed-control') && members.filter(member => member.speedTier === 'slow').length >= 3) archetypes.push('trick-room');
  if (!archetypes.length) archetypes.push(format.gameType === 'doubles' ? 'doubles-balance' : 'singles-balance');
  return {
    archetypes,
    members,
    speedControl: members.filter(member => member.roles.includes('speed-control')).map(member => member.species),
    boardTools: members.filter(member => member.roles.some(role => ['redirection', 'disruption', 'pivot', 'hazard-control'].includes(role))).map(member => member.species),
    winConditions: members.filter(member => member.roles.includes('setup') || member.offensivePressure >= 0.6).map(member => member.species),
  };
}

function associationScore(
  species: string,
  teammates: readonly string[],
  metaProfiles: Readonly<Record<string, SpeciesMetaProfile>>,
): number {
  const meta = metaProfiles[normalize(species)];
  if (!meta) return 0;
  return teammates.reduce((score, teammate) => {
    const association = meta.teammates.find(item => normalize(item.species) === normalize(teammate));
    if (!association) return score;
    return score + (association.probability ?? (association.rank ? 0.1 / association.rank : 0));
  }, 0);
}

export function buildGamePlan(
  profile: TeamProfile,
  observation: BattleObservation,
  metaProfiles: Readonly<Record<string, SpeciesMetaProfile>> = {},
): GamePlan {
  const opponent = observation.perspective === 'p1' ? observation.sides.p2 : observation.sides.p1;
  const opponentSpecies = opponent.pokemon.filter(pokemon => !pokemon.fainted).map(pokemon => pokemon.species);
  const threats = [...opponentSpecies].sort((left, right) => {
    const leftMeta = metaProfiles[normalize(left)];
    const rightMeta = metaProfiles[normalize(right)];
    const leftScore = (leftMeta?.usage.probability ?? 0) + associationScore(left, opponentSpecies, metaProfiles) * 0.1;
    const rightScore = (rightMeta?.usage.probability ?? 0) + associationScore(right, opponentSpecies, metaProfiles) * 0.1;
    return rightScore - leftScore;
  }).slice(0, 3);
  const leadPool = [...profile.speedControl, ...profile.boardTools, ...profile.winConditions]
    .filter((value, index, all) => all.indexOf(value) === index);
  const ownSpecies = profile.members.map(member => member.species);
  const preferredLead = leadPool
    .map((species, index) => ({species, index, synergy: associationScore(species, ownSpecies, metaProfiles)}))
    .sort((left, right) => right.synergy - left.synergy || left.index - right.index)
    .slice(0, 2)
    .map(item => item.species);
  const own = observation.sides[observation.perspective];
  const ownAlive = own.pokemon.filter(pokemon => !pokemon.fainted).length;
  const opponentAlive = opponent.pokemon.filter(pokemon => !pokemon.fainted).length;
  const riskPosture = ownAlive > opponentAlive ? 'protect-lead' : ownAlive < opponentAlive ? 'seek-variance' : 'balanced';
  return {
    preferredLead,
    threats,
    preserve: profile.winConditions.slice(0, 2),
    winConditions: profile.winConditions,
    riskPosture,
  };
}
