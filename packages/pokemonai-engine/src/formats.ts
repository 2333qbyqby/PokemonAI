import type {FormatId, FormatPack, SearchProfile} from './types.js';

const commonSearch: SearchProfile = Object.freeze({
  decisionBudgetMs: 10_000,
  returnReserveMs: 500,
  maxNodes: 4_000,
  maxParticles: 64,
  maxWorkers: 8,
  ownActionLimit: 8,
  opponentActionLimit: 8,
  secondTurnBudgetRatio: 0.4,
});

export const FORMAT_PACKS: Readonly<Record<FormatId, FormatPack>> = Object.freeze({
  'champions-ranked-doubles': Object.freeze({
    id: 'champions-ranked-doubles',
    label: 'Champions 排位 64 双打',
    mechanics: 'champions',
    regulation: 'M-B',
    baseShowdownFormat: 'gen9championsvgc2026regmb',
    customRules: Object.freeze(['!Open Team Sheets']),
    gameType: 'doubles',
    rosterSize: 6,
    bringSize: 4,
    activeSlots: 2,
    teamPreview: true,
    openTeamSheets: false,
    levelRule: 'Adjust Level = 50',
    metaBindings: Object.freeze(['munchstats']),
    policyFamily: 'ranked-doubles',
    searchProfile: Object.freeze({...commonSearch, ownActionLimit: 6}),
  }),
  'champions-ranked-singles': Object.freeze({
    id: 'champions-ranked-singles',
    label: 'Champions 排位 63 单打',
    mechanics: 'champions',
    regulation: 'M-B',
    baseShowdownFormat: 'gen9championsbssregmb',
    customRules: Object.freeze([]),
    gameType: 'singles',
    rosterSize: 6,
    bringSize: 3,
    activeSlots: 1,
    teamPreview: true,
    openTeamSheets: false,
    levelRule: 'Adjust Level = 50',
    metaBindings: Object.freeze(['munchstats']),
    policyFamily: 'ranked-singles',
    searchProfile: commonSearch,
  }),
  'champions-ou': Object.freeze({
    id: 'champions-ou',
    label: 'Champions 66 OU 单打',
    mechanics: 'champions',
    regulation: 'OU',
    baseShowdownFormat: 'gen9championsou',
    customRules: Object.freeze([]),
    gameType: 'singles',
    rosterSize: 6,
    bringSize: 6,
    activeSlots: 1,
    teamPreview: true,
    openTeamSheets: false,
    levelRule: 'Adjust Level = 50',
    metaBindings: Object.freeze(['munchstats']),
    policyFamily: 'ou-singles',
    searchProfile: commonSearch,
  }),
});

export function getFormatPack(id: string): FormatPack {
  if (!(id in FORMAT_PACKS)) throw new Error(`Unknown format pack: ${id}`);
  return FORMAT_PACKS[id as FormatId];
}

export function showdownFormat(pack: FormatPack): string {
  if (!pack.customRules.length) return pack.baseShowdownFormat;
  return `${pack.baseShowdownFormat}@@@${pack.customRules.join(',')}`;
}
