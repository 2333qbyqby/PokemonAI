import { PS, type RoomID, type Team } from '../client-main';
import type { ID } from '../battle-dex';
import type { PokemonAIReturnTarget } from './navigation';

const LOCAL_TEAMS_KEY = 'pokemonai-local-teams';
const MIGRATION_KEY = 'pokemonai-team-migration-complete';
const LEGACY_TEAM_KEYS = ['showdown_teams', 'showdown_teams_local'] as const;

export type PokemonAILocalTeamValidationStatus = 'unchecked' | 'valid' | 'invalid';

export interface PokemonAILocalTeamRecord {
	id: string;
	kind: 'team' | 'box';
	formatId: string;
	name: string;
	notes: string;
	packedTeam: string;
	folder: string;
	position: number;
	showdownTeamId?: number;
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
	validation: {
		status: PokemonAILocalTeamValidationStatus;
		checkedAt: string | null;
		errors: string[];
	};
}

interface PokemonAILocalTeamDocument {
	schema: 'pokemonai-local-teams';
	teams: PokemonAILocalTeamRecord[];
}

type LocalTeamCreate = Pick<PokemonAILocalTeamRecord, 'formatId' | 'name' | 'packedTeam'> & Partial<Pick<
	PokemonAILocalTeamRecord, 'kind' | 'notes' | 'folder' | 'showdownTeamId'
>>;

type LocalTeamUpdate = Partial<Pick<
	PokemonAILocalTeamRecord, 'name' | 'notes' | 'packedTeam' | 'folder' | 'position' | 'validation'
>>;

function makeLocalTeamId() {
	if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
	const bytes = new Uint8Array(16);
	globalThis.crypto?.getRandomValues?.(bytes);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const value = Array.from(bytes, byte => (`0${byte.toString(16)}`).slice(-2)).join('');
	return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function now() {
	return new Date().toISOString();
}

function emptyValidation(): PokemonAILocalTeamRecord['validation'] {
	return { status: 'unchecked', checkedAt: null, errors: [] };
}

function normalizeRecord(value: unknown, position: number): PokemonAILocalTeamRecord | null {
	if (!value || typeof value !== 'object') return null;
	const record = value as Partial<PokemonAILocalTeamRecord>;
	if (!record.id || !record.formatId || typeof record.packedTeam !== 'string') return null;
	const createdAt = typeof record.createdAt === 'string' ? record.createdAt : now();
	const validation = record.validation;
	const status = validation?.status;
	return {
		id: record.id,
		kind: record.kind === 'box' ? 'box' : 'team',
		formatId: record.formatId,
		name: String(record.name || '未命名队伍').trim() || '未命名队伍',
		notes: typeof record.notes === 'string' ? record.notes : '',
		packedTeam: record.packedTeam.replace(/[\r\n]/g, '').trim(),
		folder: typeof record.folder === 'string' ? record.folder : '',
		position: Number.isInteger(record.position) ? Number(record.position) : position,
		showdownTeamId: Number.isInteger(record.showdownTeamId) ? Number(record.showdownTeamId) : undefined,
		createdAt,
		updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : createdAt,
		deletedAt: typeof record.deletedAt === 'string' ? record.deletedAt : null,
		validation: {
			status: status === 'valid' || status === 'invalid' ? status : 'unchecked',
			checkedAt: typeof validation?.checkedAt === 'string' ? validation.checkedAt : null,
			errors: Array.isArray(validation?.errors) ? validation.errors.map(String) : [],
		},
	};
}

export class PokemonAILocalTeamStore {
	private records: PokemonAILocalTeamRecord[] = [];
	private listeners = new Set<() => void>();
	private persistent = true;
	private bridgeSave: (() => void) | null = null;

	constructor() {
		this.loadOrMigrate();
		if (this.persistent) this.installPSBridge();
	}

	list(options: { includeDeleted?: boolean; includeBoxes?: boolean } = {}) {
		return this.records
			.filter(record => options.includeDeleted || !record.deletedAt)
			.filter(record => options.includeBoxes || record.kind === 'team')
			.sort((a, b) => a.position - b.position)
			.map(record => ({ ...record, validation: { ...record.validation, errors: [...record.validation.errors] } }));
	}

	get(id: string) {
		const record = this.records.find(team => team.id === id);
		return record ? { ...record, validation: { ...record.validation, errors: [...record.validation.errors] } } : null;
	}

	create(input: LocalTeamCreate) {
		const timestamp = now();
		const record: PokemonAILocalTeamRecord = {
			id: makeLocalTeamId(),
			kind: input.kind === 'box' ? 'box' : 'team',
			formatId: input.formatId,
			name: input.name.trim() || '未命名队伍',
			notes: input.notes || '',
			packedTeam: input.packedTeam.replace(/[\r\n]/g, '').trim(),
			folder: input.folder || '',
			position: this.records.filter(team => !team.deletedAt).length,
			showdownTeamId: input.showdownTeamId,
			createdAt: timestamp,
			updatedAt: timestamp,
			deletedAt: null,
			validation: emptyValidation(),
		};
		this.records.push(record);
		this.commit();
		return this.get(record.id)!;
	}

	update(id: string, changes: LocalTeamUpdate) {
		const record = this.records.find(team => team.id === id && !team.deletedAt);
		if (!record) return null;
		if (changes.name !== undefined) record.name = changes.name.trim() || '未命名队伍';
		if (changes.notes !== undefined) record.notes = changes.notes;
		if (changes.folder !== undefined) record.folder = changes.folder;
		if (changes.position !== undefined) record.position = changes.position;
		if (changes.packedTeam !== undefined) {
			record.packedTeam = changes.packedTeam.replace(/[\r\n]/g, '').trim();
			record.validation = changes.validation ? { ...changes.validation } : emptyValidation();
		} else if (changes.validation) {
			record.validation = { ...changes.validation, errors: [...changes.validation.errors] };
		}
		record.updatedAt = now();
		this.commit();
		return this.get(id);
	}

	duplicate(id: string, formatId?: string) {
		const source = this.records.find(team => team.id === id && !team.deletedAt);
		if (!source) return null;
		return this.create({
			formatId: formatId || source.formatId,
			name: `${source.name} 副本`,
			notes: source.notes,
			packedTeam: source.packedTeam,
			folder: source.folder,
		});
	}

	softDelete(id: string) {
		const record = this.records.find(team => team.id === id && !team.deletedAt);
		if (!record) return false;
		record.deletedAt = now();
		record.updatedAt = record.deletedAt;
		this.commit();
		return true;
	}

	restore(id: string) {
		const record = this.records.find(team => team.id === id && team.deletedAt);
		if (!record) return false;
		record.deletedAt = null;
		record.updatedAt = now();
		this.commit();
		return true;
	}

	purgeDeleted() {
		const before = this.records.length;
		this.records = this.records.filter(team => !team.deletedAt);
		if (this.records.length === before) return false;
		this.commit();
		return true;
	}

	subscribe(listener: () => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	reconcileFromPS() {
		if (!this.persistent) return;
		const activeIds = new Set<string>();
		const timestamp = now();
		for (const [position, team] of PS.teams.list.entries()) {
			let record = this.records.find(item => item.id === team.key);
			if (!record) {
				const id = makeLocalTeamId();
				delete PS.teams.byKey[team.key];
				team.key = id;
				PS.teams.byKey[id] = team;
				record = this.recordFromTeam(team, position, timestamp);
				this.records.push(record);
			} else {
				record.kind = team.isBox ? 'box' : 'team';
				record.formatId = team.format;
				record.name = team.name;
				record.packedTeam = team.packedTeam;
				record.folder = team.folder;
				record.position = position;
				record.showdownTeamId = team.teamid;
				record.deletedAt = null;
				record.updatedAt = timestamp;
			}
			activeIds.add(record.id);
		}
		for (const record of this.records) {
			if (!record.deletedAt && !activeIds.has(record.id)) record.deletedAt = timestamp;
		}
		this.persist();
		this.emit();
	}

	installPSBridge(externalSave?: () => void) {
		if (!this.persistent) return;
		if (externalSave) this.bridgeSave = externalSave;
		this.applyToPS();
		const save = () => {
			this.reconcileFromPS();
			if (this.bridgeSave) this.bridgeSave();
			else PS.teams.update('team');
		};
		PS.teams.save = save;
	}

	private loadOrMigrate() {
		const stored = this.readDocument();
		if (stored) {
			this.records = stored.teams;
			return;
		}
		const legacyTeams = [...PS.teams.list];
		for (const key of LEGACY_TEAM_KEYS) {
			const buffer = localStorage.getItem(key);
			if (!buffer) continue;
			for (const line of buffer.split('\n')) {
				const team = PS.teams.unpackLine(line);
				if (!team || legacyTeams.some(existing => this.sameTeam(existing, team))) continue;
				legacyTeams.push(team);
			}
		}
		const timestamp = now();
		const migrated = legacyTeams.map((team, position) => this.recordFromTeam(team, position, timestamp));
		const document: PokemonAILocalTeamDocument = { schema: 'pokemonai-local-teams', teams: migrated };
		try {
			localStorage.setItem(LOCAL_TEAMS_KEY, JSON.stringify(document));
			const verified = this.readDocument();
			if (!verified || JSON.stringify(verified) !== JSON.stringify(document)) throw new Error('Migration verification failed');
			this.records = verified.teams;
			localStorage.setItem(MIGRATION_KEY, timestamp);
			for (const key of LEGACY_TEAM_KEYS) localStorage.removeItem(key);
		} catch {
			this.records = migrated;
			this.persistent = false;
		}
	}

	private readDocument(): PokemonAILocalTeamDocument | null {
		try {
			const value = JSON.parse(localStorage.getItem(LOCAL_TEAMS_KEY) || 'null') as Partial<PokemonAILocalTeamDocument> | null;
			if (!value || value.schema !== 'pokemonai-local-teams' || !Array.isArray(value.teams)) return null;
			const teams = value.teams.map(normalizeRecord);
			if (teams.some(team => !team)) return null;
			return { schema: 'pokemonai-local-teams', teams: teams as PokemonAILocalTeamRecord[] };
		} catch {
			return null;
		}
	}

	private recordFromTeam(team: Team, position: number, timestamp: string): PokemonAILocalTeamRecord {
		return {
			id: makeLocalTeamId(),
			kind: team.isBox ? 'box' : 'team',
			formatId: team.format || 'gen9',
			name: team.name || '未命名队伍',
			notes: '',
			packedTeam: team.packedTeam,
			folder: team.folder || '',
			position,
			showdownTeamId: team.teamid,
			createdAt: timestamp,
			updatedAt: timestamp,
			deletedAt: null,
			validation: emptyValidation(),
		};
	}

	private sameTeam(left: Team, right: Team) {
		return left.name === right.name && left.format === right.format && left.folder === right.folder &&
			left.packedTeam === right.packedTeam && left.isBox === right.isBox && left.teamid === right.teamid;
	}

	private applyToPS() {
		const previous = PS.teams.byKey;
		const list: Team[] = [];
		const byKey: Record<string, Team | undefined> = {};
		for (const record of this.records.filter(team => !team.deletedAt).sort((a, b) => a.position - b.position)) {
			const team = previous[record.id] || {
				name: record.name, format: record.formatId as ID, folder: record.folder,
				packedTeam: record.packedTeam, iconCache: null, key: record.id, isBox: record.kind === 'box',
			};
			team.name = record.name;
			team.format = record.formatId as ID;
			team.folder = record.folder;
			if (team.packedTeam !== record.packedTeam) team.iconCache = null;
			team.packedTeam = record.packedTeam;
			team.key = record.id;
			team.isBox = record.kind === 'box';
			team.teamid = record.showdownTeamId;
			list.push(team);
			byKey[record.id] = team;
		}
		PS.teams.list = list;
		PS.teams.byKey = byKey;
		PS.teams.update('team');
	}

	private commit() {
		if (!this.persist()) return;
		this.applyToPS();
		this.emit();
	}

	private persist() {
		try {
			localStorage.setItem(LOCAL_TEAMS_KEY, JSON.stringify({
				schema: 'pokemonai-local-teams', teams: this.records,
			} satisfies PokemonAILocalTeamDocument));
			return true;
		} catch {
			return false;
		}
	}

	private emit() {
		for (const listener of this.listeners) listener();
	}
}

export const pokemonAILocalTeamStore = new PokemonAILocalTeamStore();

export type PokemonAITeamWorkspaceView = 'catalog' | 'local';

export function openPokemonAITeamWorkspace(
	view: PokemonAITeamWorkspaceView = 'catalog', formatId = '', localTeamId = ''
) {
	const roomid = 'ai-teams' as RoomID;
	const args = { view, formatId, localTeamId };
	if (PS.rooms[roomid]) PS.rooms[roomid].args = args;
	PS.join(roomid, { args });
	window.dispatchEvent(new CustomEvent('pokemonai-team-workspace-navigation', { detail: args }));
}

export function openPokemonAILocalTeamEditor(teamId: string, returnTo?: PokemonAIReturnTarget) {
	if (!teamId) return;
	const roomid = `aiteam-${teamId}` as RoomID;
	const args = returnTo ? { returnTo } : undefined;
	if (PS.rooms[roomid] && args) PS.rooms[roomid].args = args;
	PS.join(roomid, { args });
}

export function reinstallPokemonAILocalTeamBridge(externalSave?: () => void) {
	pokemonAILocalTeamStore.reconcileFromPS();
	pokemonAILocalTeamStore.installPSBridge(externalSave);
}
