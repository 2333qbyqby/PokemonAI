import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import type {MetaEvidence, SpeciesMetaProfile, TeamMetaRecord} from '@pokemonai/engine';

interface RuntimeMetaFile {
  readonly schema?: string;
  readonly source?: string;
  readonly publishedAt?: string | null;
  readonly formats?: Readonly<Record<string, {
    readonly sourceUpdatedAt?: string;
    readonly teamSourceUpdatedAt?: string;
    readonly speciesProfiles?: Readonly<Record<string, SpeciesMetaProfile>>;
    readonly teams?: readonly TeamMetaRecord[];
  }>>;
}

interface CachedMeta {
  readonly path: string;
  readonly modifiedAt: number;
  readonly size: number;
  readonly value: RuntimeMetaFile;
}

let cached: CachedMeta | undefined;

const emptyMeta = (): MetaEvidence => ({
  publishedAt: '', sourceUpdatedAt: '', teamSourceUpdatedAt: '', speciesProfiles: {}, teamRecords: [],
});

export async function loadMeta(projectRoot: string, formatId: string): Promise<MetaEvidence> {
  const current = path.join(projectRoot, 'var', 'meta', 'current.json');
  try {
    const details = await stat(current);
    let value: RuntimeMetaFile;
    if (cached?.path === current && cached.modifiedAt === details.mtimeMs && cached.size === details.size) {
      value = cached.value;
    } else {
      value = JSON.parse(await readFile(current, 'utf8')) as RuntimeMetaFile;
      if (value.schema !== 'pokemonai-meta' || value.source !== 'munchstats') return emptyMeta();
      cached = {path: current, modifiedAt: details.mtimeMs, size: details.size, value};
    }
    const format = value.formats?.[formatId];
    if (!format?.sourceUpdatedAt || !format.speciesProfiles) return emptyMeta();
    return {
      publishedAt: value.publishedAt ?? '',
      sourceUpdatedAt: format.sourceUpdatedAt,
      teamSourceUpdatedAt: format.teamSourceUpdatedAt ?? '',
      speciesProfiles: format.speciesProfiles,
      teamRecords: format.teams ?? [],
    };
  } catch {
    return emptyMeta();
  }
}
