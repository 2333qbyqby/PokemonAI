import {readFile} from 'node:fs/promises';
import path from 'node:path';
import type {FormatId, TeamMemberInput} from '@pokemonai/engine';

export interface RuntimeConfig {
  readonly id: string;
  readonly username: string;
  readonly formatId: FormatId;
  readonly format: string;
  readonly showdown: string;
  readonly authentication: string;
  readonly control: string;
  readonly controlToken: string;
  readonly teamPool: string;
  readonly teamIndex: string;
  readonly status: string;
  readonly logs: string;
  readonly projectRoot: string;
  readonly maxConcurrentBattles: number;
  readonly seed: number;
}

interface TeamRecord {
  readonly id: string;
  readonly pool: string;
  readonly packed: string;
  readonly roster?: readonly {
    readonly species_name?: string;
    readonly species: string;
    readonly moves: readonly string[];
    readonly item?: string;
    readonly ability?: string;
  }[];
  readonly validation_status?: string;
}

export interface RuntimeTeam {
  readonly id: string;
  readonly packed: string;
  readonly profile: readonly TeamMemberInput[];
}

function projectRootFrom(configPath: string): string {
  if (process.env.POKEMONAI_PROJECT_ROOT) return path.resolve(process.env.POKEMONAI_PROJECT_ROOT);
  let current = path.dirname(path.resolve(configPath));
  while (path.basename(current).toLowerCase() !== 'var' && path.dirname(current) !== current) current = path.dirname(current);
  return path.basename(current).toLowerCase() === 'var' ? path.dirname(current) : process.cwd();
}

export async function loadRuntimeConfig(configPath: string): Promise<RuntimeConfig> {
  const raw = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  const root = projectRootFrom(configPath);
  const formatId = String(raw.formatId ?? raw.id) as FormatId;
  const required = (key: string): string => {
    const value = String(raw[key] ?? '').trim();
    if (!value) throw new Error(`Runtime config is missing ${key}`);
    return value;
  };
  return {
    id: required('id'),
    username: required('username'),
    formatId,
    format: required('format'),
    showdown: required('showdown'),
    authentication: String(raw.authentication ?? process.env.POKEMONAI_AUTH_URL ?? 'https://play.pokemonshowdown.com/action.php?'),
    control: String(raw.control ?? process.env.POKEMONAI_CONTROL_URL ?? ''),
    controlToken: String(raw.controlToken ?? process.env.POKEMONAI_CONTROL_TOKEN ?? ''),
    teamPool: required('teamPool'),
    teamIndex: String(raw.teamIndex ?? path.join(root, 'var', 'generated', 'team-library', 'index.json')),
    status: String(raw.status ?? path.join(root, 'var', 'run', 'status', `${required('id')}.json`)),
    logs: String(raw.logs ?? path.join(root, 'var', 'logs', 'agents', 'agent-runtime')),
    projectRoot: root,
    maxConcurrentBattles: Number(raw.maxConcurrentBattles ?? 1),
    seed: Number((raw.options as Record<string, unknown> | undefined)?.seed ?? 0),
  };
}

export async function loadTeams(config: RuntimeConfig): Promise<readonly RuntimeTeam[]> {
  const data = JSON.parse(await readFile(config.teamIndex, 'utf8')) as {readonly teams?: readonly TeamRecord[]};
  const teams = (data.teams ?? []).filter(team =>
    team.pool === config.teamPool && !team.validation_status?.startsWith('invalid')
  );
  if (!teams.length) throw new Error(`Team pool is empty: ${config.teamPool}`);
  return teams.map(team => ({
    id: team.id,
    packed: team.packed,
    profile: (team.roster ?? []).map(member => ({
      species: member.species_name ?? member.species,
      moves: member.moves,
      ...(member.item ? {item: member.item} : {}),
      ...(member.ability ? {ability: member.ability} : {}),
    })),
  }));
}
