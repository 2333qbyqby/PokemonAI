/* eslint-disable @stylistic/max-len, @stylistic/member-delimiter-style, no-restricted-syntax, no-restricted-globals, @typescript-eslint/no-misused-promises */
import { Dex, toID, type ID } from './battle-dex';
import { BattleLog } from './battle-log';
import { TeamEditor, type TeamEditorState } from './battle-team-editor';
import { Teams } from './battle-teams';
import { PS, PSRoom, type RoomID, type RoomOptions, type Team } from './client-main';
import { PSPanelWrapper, PSRoomPanel } from './panels';
import { PokemonAIConfig, type PokemonAIFormat } from './pokemonai-config';
import { pokemonAISetupStore, selectPokemonAILocalTeam } from './pokemonai';
import {
	openPokemonAILocalTeamEditor, pokemonAILocalTeamStore,
	type PokemonAILocalTeamRecord, type PokemonAITeamWorkspaceView,
} from './pokemonai/teams';
import { PokemonAILocalTeamCarousel, type PokemonAILocalTeamCarouselItem } from './pokemonai/team-carousel';
import { focusPokemonAIReturnTarget, type PokemonAIReturnTarget } from './pokemonai/navigation';

type CatalogCompleteness = 'full-set' | 'roster-only';
type CatalogValidation = 'valid' | 'prevalidated' | 'roster-only' | 'invalid';

interface CatalogPokemonSet {
	species: string;
	moves: string[];
	item?: string;
	ability?: string;
	nature?: string;
	statPoints?: number[];
	teraType?: string;
}

interface CatalogTeamSummary {
	id: string;
	formatId: string;
	name: string;
	roster: { species: string; displayName: string }[];
	completeness: CatalogCompleteness;
	validationStatus: CatalogValidation;
	observedAt: string;
	sourceLabel: string;
	player?: string;
	event?: string;
	placing?: string;
	usage?: {
		battles: number; wins: number; losses: number; winRate: number; avgRating: number; maxRating: number,
	};
}

interface CatalogTeamDetail extends CatalogTeamSummary {
	sets: CatalogPokemonSet[];
	packedTeam?: string;
	paste?: string;
	sourceUrl?: string;
}

interface CatalogResponse {
	schema: 'pokemonai-team-catalog';
	source: 'munchstats';
	publishedAt: string | null;
	total: number;
	nextCursor: string | null;
	teams: CatalogTeamSummary[];
}

interface CatalogExport {
	schema: 'pokemonai-team-catalog';
	publishedAt?: string | null;
	teams: CatalogTeamDetail[];
}

function supportedFormatForTeam(formatId: string): PokemonAIFormat | undefined {
	const normalized = PS.teams.teambuilderFormat(formatId);
	return PokemonAIConfig.formats.find(format => PS.teams.teambuilderFormat(format.showdownFormat) === normalized);
}

function localFormatForApp(formatId: string): string {
	const format = PokemonAIConfig.formats.find(item => item.id === formatId) || PokemonAIConfig.formats[0];
	return PS.teams.teambuilderFormat(format.showdownFormat);
}

function teamRoster(packedTeam: string) {
	try {
		return Teams.unpackSpeciesOnly(packedTeam).map(species => ({
			species: toID(species), displayName: Dex.species.get(species).name || species,
		}));
	} catch {
		return [];
	}
}

function structuralValidation(record: Pick<PokemonAILocalTeamRecord, 'kind' | 'formatId' | 'packedTeam'>) {
	const errors: string[] = [];
	let sets: Teams.PokemonSet[] = [];
	try {
		sets = Teams.unpack(record.packedTeam);
	} catch {
		errors.push('队伍数据无法读取。');
	}
	if (record.kind === 'team' && !sets.length) errors.push('队伍中还没有宝可梦。');
	if (record.kind === 'team' && sets.length > 6) errors.push('队伍不能超过六只宝可梦。');
	if (supportedFormatForTeam(record.formatId) && sets.length !== 6) errors.push('该规则要求完整的六只宝可梦。');
	sets.forEach((set, index) => {
		if (!set.species) errors.push(`第 ${index + 1} 个位置缺少宝可梦。`);
		if (set.moves.length > 4) errors.push(`${set.species || `第 ${index + 1} 只宝可梦`}的技能超过四个。`);
	});
	return { status: errors.length ? 'invalid' as const : 'valid' as const, errors };
}

function formatLabel(formatId: string) {
	return supportedFormatForTeam(formatId)?.label || BattleLog.formatName(formatId) || formatId;
}

function PokemonRoster(props: { roster: { species: string; displayName: string }[] }) {
	return <div class="pokemonai-sprite-roster">{props.roster.slice(0, 6).map((member, index) => <span
		class="pokemonai-sprite-member" key={`${member.species}-${index}`} title={member.displayName}
	>
		<span class="picon" style={Dex.getPokemonIcon(member.species)} aria-hidden></span>
		<small>{member.displayName}</small>
	</span>)}</div>;
}

class PokemonAITeamsPanel extends PSRoomPanel {
	static readonly id = 'pokemonai-teams';
	static readonly routes = ['ai-teams'];
	static readonly title = '阵容';
	static readonly location = 'left';

	view: PokemonAITeamWorkspaceView = 'catalog';
	formatId: string = PokemonAIConfig.defaultFormat;
	catalogCompleteness = 'all';
	catalogSort = 'recommended';
	catalogQuery = '';
	catalogTeams: CatalogTeamSummary[] = [];
	catalogPage = 1;
	readonly catalogPageSize = 20;
	catalogTotal = 0;
	catalogPublishedAt: string | null = null;
	catalogLoading = false;
	catalogError = '';
	catalogRequest = 0;
	fallbackCatalog: CatalogTeamDetail[] | null = null;
	fallbackPublishedAt: string | null = null;
	inspectedCatalog: CatalogTeamDetail | null = null;
	inspectedLocalId = '';
	detailLoading = false;
	copyingCatalog = false;
	copyName = '';
	copyNotes = '';
	creatingLocal = false;
	newLocalName = '';
	newLocalNotes = '';
	newLocalFormat: string = localFormatForApp(PokemonAIConfig.defaultFormat);
	localQuery = '';
	localFormat = 'all';
	showDeleted = false;
	lastDeletedId = '';
	searchTimer: number | null = null;
	unsubscribeLocal: (() => void) | null = null;
	detailElement: HTMLElement | null = null;
	catalogListElement: HTMLElement | null = null;

	override componentDidMount() {
		super.componentDidMount();
		this.unsubscribeLocal = pokemonAILocalTeamStore.subscribe(() => this.forceUpdate());
		window.addEventListener('pokemonai-team-workspace-navigation', this.handleWorkspaceNavigation as EventListener);
		this.applyNavigation(this.props.room.args || {});
		void this.loadCatalog(true);
	}

	override componentWillUnmount() {
		this.unsubscribeLocal?.();
		window.removeEventListener('pokemonai-team-workspace-navigation', this.handleWorkspaceNavigation as EventListener);
		if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
		super.componentWillUnmount();
	}

	handleWorkspaceNavigation = (event: CustomEvent) => {
		this.applyNavigation(event.detail || {});
		this.forceUpdate();
	};

	applyNavigation(args: Record<string, unknown> = {}) {
		if (args.view === 'local' || args.view === 'catalog') this.view = args.view;
		if (typeof args.formatId === 'string' && PokemonAIConfig.formats.some(format => format.id === args.formatId)) {
			this.formatId = args.formatId;
			this.newLocalFormat = localFormatForApp(args.formatId);
			if (this.view === 'local') this.localFormat = this.newLocalFormat;
		}
		if (typeof args.localTeamId === 'string' && pokemonAILocalTeamStore.get(args.localTeamId)) {
			this.inspectedLocalId = args.localTeamId;
			this.view = 'local';
		}
		if (typeof args.localQuery === 'string') this.localQuery = args.localQuery;
		if (typeof args.localFormat === 'string') this.localFormat = args.localFormat;
		if (typeof args.catalogQuery === 'string') this.catalogQuery = args.catalogQuery;
		if (typeof args.catalogCompleteness === 'string') this.catalogCompleteness = args.catalogCompleteness;
		if (typeof args.catalogSort === 'string') this.catalogSort = args.catalogSort;
		if (typeof args.catalogPage === 'number') this.catalogPage = Math.max(1, args.catalogPage);
	}

	editorReturnTarget(localTeamId: string): PokemonAIReturnTarget {
		return {
			roomid: 'ai-teams' as RoomID,
			args: {
				view: this.view, formatId: this.formatId, localTeamId,
				localQuery: this.localQuery, localFormat: this.localFormat,
				catalogQuery: this.catalogQuery, catalogCompleteness: this.catalogCompleteness,
				catalogSort: this.catalogSort, catalogPage: this.catalogPage,
			},
			focusSelector: localTeamId ? `[data-carousel-id="${CSS.escape(localTeamId)}"] button` : undefined,
			scrollTop: document.getElementById(`room-${this.props.room.id}`)?.scrollTop || 0,
			historyBack: true,
		};
	}

	setView = (event: MouseEvent) => {
		this.view = (event.currentTarget as HTMLButtonElement).value as PokemonAITeamWorkspaceView;
		this.copyingCatalog = false;
		this.creatingLocal = false;
		this.forceUpdate();
	};

	setCatalogFormat = (event: MouseEvent) => {
		this.formatId = (event.currentTarget as HTMLButtonElement).value;
		this.resetCatalogPage();
		void this.loadCatalog(true);
	};

	setCatalogCompleteness = (event: Event) => {
		this.catalogCompleteness = (event.currentTarget as HTMLSelectElement).value;
		this.resetCatalogPage();
		void this.loadCatalog(true);
	};

	setCatalogSort = (event: Event) => {
		this.catalogSort = (event.currentTarget as HTMLSelectElement).value;
		this.resetCatalogPage();
		void this.loadCatalog(true);
	};

	setCatalogQuery = (event: Event) => {
		this.catalogQuery = (event.currentTarget as HTMLInputElement).value;
		this.resetCatalogPage();
		this.forceUpdate();
		if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
		this.searchTimer = window.setTimeout(() => void this.loadCatalog(true), 250);
	};

	resetCatalogPage() {
		this.catalogPage = 1;
		this.inspectedCatalog = null;
		this.copyingCatalog = false;
	}

	async loadCatalog(reset: boolean, focusFirst = false) {
		const request = ++this.catalogRequest;
		this.catalogLoading = true;
		this.catalogError = '';
		if (reset) this.catalogPage = 1;
		this.forceUpdate();
		const params = new URLSearchParams({
			format_id: this.formatId,
			completeness: this.catalogCompleteness,
			query: this.catalogQuery,
			sort: this.catalogSort,
			limit: String(this.catalogPageSize),
			cursor: String((this.catalogPage - 1) * this.catalogPageSize),
		});
		try {
			const response = await fetch(`/api/team-catalog?${params}`, { cache: 'no-store' });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const value = await response.json() as CatalogResponse;
			if (value.schema !== 'pokemonai-team-catalog' || !Array.isArray(value.teams)) throw new Error('Invalid catalog');
			if (request !== this.catalogRequest) return;
			const publishedChanged = !!this.catalogPublishedAt && !!value.publishedAt && this.catalogPublishedAt !== value.publishedAt;
			this.catalogPublishedAt = value.publishedAt;
			if (publishedChanged) {
				this.resetCatalogPage();
				if (!reset) {
					void this.loadCatalog(true, focusFirst);
					return;
				}
			}
			this.catalogTeams = value.teams;
			this.catalogTotal = value.total;
			const pageCount = Math.max(1, Math.ceil(value.total / this.catalogPageSize));
			if (this.catalogPage > pageCount) {
				this.catalogPage = pageCount;
				void this.loadCatalog(false, focusFirst);
			}
		} catch {
			try {
				if (!this.fallbackCatalog) {
					const response = await fetch('/data/pokemonai-team-catalog.json', { cache: 'no-store' });
					if (!response.ok) throw new Error();
					const value = await response.json() as CatalogExport;
					if (value.schema !== 'pokemonai-team-catalog' || !Array.isArray(value.teams)) throw new Error();
					this.fallbackCatalog = value.teams;
					this.fallbackPublishedAt = value.publishedAt || null;
				}
				if (request !== this.catalogRequest) return;
				this.applyFallbackCatalog();
			} catch {
				if (request === this.catalogRequest) this.catalogError = '线上队伍暂时无法读取。';
			}
		} finally {
			if (request === this.catalogRequest) {
				this.catalogLoading = false;
				this.forceUpdate();
				if (focusFirst) setTimeout(() => {
					this.catalogListElement?.scrollIntoView({ block: 'start' });
					this.catalogListElement?.querySelector<HTMLButtonElement>('.pokemonai-library-card-main')?.focus();
				}, 0);
			}
		}
	}

	applyFallbackCatalog() {
		const publishedChanged = !!this.catalogPublishedAt && !!this.fallbackPublishedAt && this.catalogPublishedAt !== this.fallbackPublishedAt;
		this.catalogPublishedAt = this.fallbackPublishedAt;
		if (publishedChanged) this.resetCatalogPage();
		const query = this.catalogQuery.trim().toLowerCase();
		let teams = (this.fallbackCatalog || []).filter(team => team.formatId === this.formatId);
		if (this.catalogCompleteness !== 'all') {
			teams = teams.filter(team => team.completeness === this.catalogCompleteness);
		}
		if (query) {
			teams = teams.filter(team => [team.name, team.player, team.event, ...team.roster.map(member => member.displayName)]
				.filter(Boolean).join(' ').toLowerCase().includes(query));
		}
		teams.sort((a, b) => a.name.localeCompare(b.name));
		if (this.catalogSort !== 'battles') teams.sort((a, b) => b.observedAt.localeCompare(a.observedAt));
		if (this.catalogSort !== 'updated') teams.sort((a, b) => (b.usage?.battles || 0) - (a.usage?.battles || 0));
		if (this.catalogSort === 'recommended') {
			teams.sort((a, b) => Number(b.completeness === 'full-set') - Number(a.completeness === 'full-set'));
		}
		const pageCount = Math.max(1, Math.ceil(teams.length / this.catalogPageSize));
		if (this.catalogPage > pageCount) this.catalogPage = pageCount;
		const offset = (this.catalogPage - 1) * this.catalogPageSize;
		this.catalogTotal = teams.length;
		this.catalogTeams = teams.slice(offset, offset + this.catalogPageSize);
	}

	setCatalogPage = (event: MouseEvent) => {
		const pageCount = Math.max(1, Math.ceil(this.catalogTotal / this.catalogPageSize));
		const page = Math.min(pageCount, Math.max(1, Number((event.currentTarget as HTMLButtonElement).value)));
		if (!Number.isInteger(page) || page === this.catalogPage || this.catalogLoading) return;
		this.catalogPage = page;
		this.inspectedCatalog = null;
		this.copyingCatalog = false;
		void this.loadCatalog(false, true);
	};

	catalogPageItems() {
		const pageCount = Math.max(1, Math.ceil(this.catalogTotal / this.catalogPageSize));
		if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);
		const pages = new globalThis.Set([1, pageCount, this.catalogPage - 1, this.catalogPage, this.catalogPage + 1]);
		const ordered = Array.from(pages).filter(page => page >= 1 && page <= pageCount).sort((a, b) => a - b);
		const items: (number | string)[] = [];
		ordered.forEach((page, index) => {
			if (index && page - ordered[index - 1] > 1) items.push(`gap-${page}`);
			items.push(page);
		});
		return items;
	}

	inspectCatalog = async (event: MouseEvent) => {
		const id = (event.currentTarget as HTMLButtonElement).value;
		this.copyingCatalog = false;
		this.detailLoading = true;
		this.inspectedCatalog = null;
		this.forceUpdate();
		try {
			const response = await fetch(`/api/team-catalog/${encodeURIComponent(id)}`, { cache: 'no-store' });
			if (!response.ok) throw new Error();
			this.inspectedCatalog = await response.json() as CatalogTeamDetail;
		} catch {
			this.inspectedCatalog = this.fallbackCatalog?.find(team => team.id === id) || null;
			if (!this.inspectedCatalog) this.catalogError = '这支阵容的详情暂时无法读取。';
		} finally {
			this.detailLoading = false;
			this.forceUpdate();
			this.focusDetail();
		}
	};

	closeCatalogDetail = () => {
		const id = this.inspectedCatalog?.id;
		this.inspectedCatalog = null;
		this.copyingCatalog = false;
		this.forceUpdate();
		if (id) setTimeout(() => this.base?.querySelector<HTMLElement>(`[data-team-id="${CSS.escape(id)}"]`)?.focus(), 0);
	};

	focusDetail() {
		if (this.props.room.width < 900) setTimeout(() => this.detailElement?.focus(), 0);
	}

	startCatalogCopy = () => {
		if (!this.inspectedCatalog?.packedTeam || this.inspectedCatalog.completeness !== 'full-set') return;
		this.copyName = this.inspectedCatalog.name;
		this.copyNotes = '';
		this.copyingCatalog = true;
		this.forceUpdate();
		this.focusDetail();
	};

	confirmCatalogCopy = (event: Event) => {
		event.preventDefault();
		const team = this.inspectedCatalog;
		if (!team?.packedTeam || !this.copyName.trim()) return;
		const local = pokemonAILocalTeamStore.create({
			formatId: localFormatForApp(team.formatId),
			name: this.copyName,
			notes: this.copyNotes,
			packedTeam: team.packedTeam,
		});
		pokemonAILocalTeamStore.update(local.id, {
			validation: { status: 'valid', checkedAt: new Date().toISOString(), errors: [] },
		});
		this.view = 'local';
		this.inspectedLocalId = local.id;
		this.inspectedCatalog = null;
		this.copyingCatalog = false;
		this.localFormat = local.formatId;
		this.forceUpdate();
		this.focusDetail();
	};

	startNewLocal = () => {
		this.creatingLocal = true;
		this.newLocalName = '';
		this.newLocalNotes = '';
		this.forceUpdate();
		this.focusDetail();
	};

	changeNewLocalFormat = (event: Event) => {
		this.newLocalFormat = (event.currentTarget as HTMLButtonElement).value;
		this.forceUpdate();
	};

	createLocal = (event: Event) => {
		event.preventDefault();
		if (!this.newLocalName.trim() || !this.newLocalFormat) return;
		const record = pokemonAILocalTeamStore.create({
			formatId: this.newLocalFormat,
			name: this.newLocalName,
			notes: this.newLocalNotes,
			packedTeam: '',
		});
		this.creatingLocal = false;
		openPokemonAILocalTeamEditor(record.id, this.editorReturnTarget(record.id));
	};

	setLocalQuery = (event: Event) => {
		this.localQuery = (event.currentTarget as HTMLInputElement).value;
		this.normalizeLocalActive();
		this.forceUpdate();
	};

	setLocalFormat = (event: Event) => {
		this.localFormat = (event.currentTarget as HTMLSelectElement).value;
		this.normalizeLocalActive();
		this.forceUpdate();
	};

	toggleDeleted = () => {
		this.showDeleted = !this.showDeleted;
		this.normalizeLocalActive();
		this.forceUpdate();
	};

	setActiveLocal = (id: string) => {
		this.inspectedLocalId = id;
		this.creatingLocal = false;
		this.forceUpdate();
	};

	closeLocalDetail = () => {
		this.creatingLocal = false;
		this.forceUpdate();
	};

	editLocal = () => {
		if (this.inspectedLocalId) openPokemonAILocalTeamEditor(
			this.inspectedLocalId, this.editorReturnTarget(this.inspectedLocalId)
		);
	};

	duplicateLocal = () => {
		const copy = pokemonAILocalTeamStore.duplicate(this.inspectedLocalId);
		if (!copy) return;
		this.inspectedLocalId = copy.id;
		this.forceUpdate();
	};

	deleteLocal = () => {
		const teams = this.localTeams();
		const deletedIndex = teams.findIndex(team => team.id === this.inspectedLocalId);
		if (!pokemonAILocalTeamStore.softDelete(this.inspectedLocalId)) return;
		this.lastDeletedId = this.inspectedLocalId;
		const remaining = this.localTeams();
		this.inspectedLocalId = remaining[Math.min(Math.max(deletedIndex, 0), remaining.length - 1)]?.id || '';
		this.forceUpdate();
	};

	undoDelete = () => {
		if (!this.lastDeletedId || !pokemonAILocalTeamStore.restore(this.lastDeletedId)) return;
		this.inspectedLocalId = this.lastDeletedId;
		this.lastDeletedId = '';
		this.forceUpdate();
	};

	restoreLocal = () => {
		const teams = this.localTeams();
		const restoredIndex = teams.findIndex(team => team.id === this.inspectedLocalId);
		if (!pokemonAILocalTeamStore.restore(this.inspectedLocalId)) return;
		const remaining = this.localTeams();
		this.inspectedLocalId = remaining[Math.min(Math.max(restoredIndex, 0), remaining.length - 1)]?.id || '';
		this.forceUpdate();
	};

	purgeDeleted = async () => {
		if (!await PS.confirm('永久清空最近删除的队伍？此操作无法撤销。', { okButton: '永久清空', cancelButton: '取消' })) return;
		pokemonAILocalTeamStore.purgeDeleted();
		this.inspectedLocalId = '';
		this.forceUpdate();
	};

	selectLocalForBattle = () => {
		const record = pokemonAILocalTeamStore.get(this.inspectedLocalId);
		const format = record && supportedFormatForTeam(record.formatId);
		if (!record || !format || record.validation.status === 'invalid') return;
		selectPokemonAILocalTeam(format.id, record.id);
		this.forceUpdate();
	};

	exportLocal = () => {
		const record = pokemonAILocalTeamStore.get(this.inspectedLocalId);
		if (!record) return;
		const text = Teams.export(Teams.unpack(record.packedTeam));
		const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
		const link = document.createElement('a');
		link.href = url;
		link.download = `${record.name.replace(/[\\/:*?"<>|]/g, '_') || 'team'}.txt`;
		link.click();
		URL.revokeObjectURL(url);
	};

	renderCatalogCard(team: CatalogTeamSummary) {
		return <article class="pokemonai-library-card" key={team.id}>
			<button class="pokemonai-library-card-main" value={team.id} data-team-id={team.id} onClick={this.inspectCatalog}>
				<span class="pokemonai-library-title"><strong>{team.name}</strong><small>{team.sourceLabel}</small></span>
				<PokemonRoster roster={team.roster} />
				<span class="pokemonai-library-meta">
					<span class={`pokemonai-completeness ${team.completeness}`}>{team.completeness === 'full-set' ? '完整配置' : '仅阵容构成'}</span>
					{team.usage && <small>{team.usage.battles} 场 · 胜率 {Math.round(team.usage.winRate * 100)}%</small>}
				</span>
			</button>
		</article>;
	}

	renderCatalogPagination() {
		const pageCount = Math.max(1, Math.ceil(this.catalogTotal / this.catalogPageSize));
		if (pageCount <= 1) return null;
		const previousDisabled = this.catalogPage <= 1 || this.catalogLoading;
		const nextDisabled = this.catalogPage >= pageCount || this.catalogLoading;
		return <nav class="pokemonai-pagination" aria-label="线上队伍分页">
			<div class="pokemonai-pagination-desktop">
				<button class="button" value={this.catalogPage - 1} onClick={this.setCatalogPage} disabled={previousDisabled}>
					<i class="fa fa-chevron-left" aria-hidden></i> 上一页
				</button>
				<div class="pokemonai-page-numbers">{this.catalogPageItems().map((item, index) => typeof item === 'number' ? <button
					class={`button${item === this.catalogPage ? ' cur' : ''}`} value={item} onClick={this.setCatalogPage}
					disabled={this.catalogLoading} aria-current={item === this.catalogPage ? 'page' : undefined}
				>{item}</button> : <span key={`${item}-${index}`} aria-hidden>…</span>)}</div>
				<button class="button" value={this.catalogPage + 1} onClick={this.setCatalogPage} disabled={nextDisabled}>
					下一页 <i class="fa fa-chevron-right" aria-hidden></i>
				</button>
			</div>
			<div class="pokemonai-pagination-mobile">
				<button class="button icon" value={this.catalogPage - 1} onClick={this.setCatalogPage} disabled={previousDisabled} aria-label="上一页">
					<i class="fa fa-chevron-left" aria-hidden></i>
				</button>
				<span aria-live="polite">第 {this.catalogPage} / {pageCount} 页</span>
				<button class="button icon" value={this.catalogPage + 1} onClick={this.setCatalogPage} disabled={nextDisabled} aria-label="下一页">
					<i class="fa fa-chevron-right" aria-hidden></i>
				</button>
			</div>
		</nav>;
	}

	renderCatalogList() {
		return <section class="pokemonai-library-list" aria-label="线上队伍列表" aria-busy={this.catalogLoading} ref={element => { this.catalogListElement = element; }}>
			<div class="pokemonai-library-toolbar">
				<label class="pokemonai-search"><i class="fa fa-search" aria-hidden></i><input
					class="textbox" type="search" value={this.catalogQuery} onInput={this.setCatalogQuery}
					placeholder="搜索名称、宝可梦、选手或赛事" aria-label="搜索线上队伍"
				/></label>
				<select class="button" value={this.catalogCompleteness} onChange={this.setCatalogCompleteness} aria-label="配置完整度">
					<option value="all">全部阵容</option><option value="full-set">完整配置</option><option value="roster-only">仅阵容构成</option>
				</select>
				<select class="button" value={this.catalogSort} onChange={this.setCatalogSort} aria-label="排序">
					<option value="recommended">推荐排序</option><option value="updated">最近更新</option><option value="battles">对战场次</option>
				</select>
			</div>
			<div class="pokemonai-format-segments" role="group" aria-label="线上队伍格式">
				{PokemonAIConfig.formats.map(format => <button
					value={format.id} class={this.formatId === format.id ? 'cur' : ''} onClick={this.setCatalogFormat}
				>{format.label.replace('Champions ', '')}</button>)}
			</div>
			{this.catalogError && <p class="message-error">{this.catalogError}</p>}
			{!this.catalogTeams.length && !this.catalogLoading && !this.catalogError && <p class="pokemonai-empty-state">没有符合条件的线上队伍。</p>}
			<div class="pokemonai-library-cards">{this.catalogTeams.map(team => this.renderCatalogCard(team))}</div>
			{this.catalogLoading && <p class="pokemonai-loading"><i class="fa fa-refresh fa-spin" aria-hidden></i> 正在读取线上队伍…</p>}
			{this.renderCatalogPagination()}
		</section>;
	}

	renderCatalogDetail() {
		const team = this.inspectedCatalog;
		if (this.detailLoading) return <aside class="pokemonai-library-detail"><p class="pokemonai-loading">正在读取详情…</p></aside>;
		if (!team) return <aside class="pokemonai-library-detail pokemonai-detail-placeholder"><i class="fa fa-list-alt" aria-hidden></i><p>选择一支阵容查看详情。</p></aside>;
		if (this.copyingCatalog) return <aside class="pokemonai-library-detail" ref={element => { this.detailElement = element; }} tabIndex={-1}>
			<div class="pokemonai-detail-heading"><button class="button icon" onClick={() => { this.copyingCatalog = false; this.forceUpdate(); }} aria-label="返回阵容详情"><i class="fa fa-arrow-left" aria-hidden></i></button><div><h3>加入本地队伍</h3><p>{formatLabel(localFormatForApp(team.formatId))}</p></div></div>
			<PokemonRoster roster={team.roster} />
			<form class="pokemonai-copy-form" onSubmit={this.confirmCatalogCopy}>
				<label>本地名称<input class="textbox" value={this.copyName} maxLength={80} onInput={event => { this.copyName = (event.currentTarget as HTMLInputElement).value; this.forceUpdate(); }} /></label>
				<label>注释<textarea class="textbox" rows={5} maxLength={2000} value={this.copyNotes} onInput={event => { this.copyNotes = (event.currentTarget as HTMLTextAreaElement).value; this.forceUpdate(); }} /></label>
				<button class="button strong" type="submit" disabled={!this.copyName.trim()}><i class="fa fa-plus" aria-hidden></i> 确认加入</button>
			</form>
		</aside>;
		return <aside class="pokemonai-library-detail" ref={element => { this.detailElement = element; }} tabIndex={-1}>
			<div class="pokemonai-detail-heading"><button class="button icon" onClick={this.closeCatalogDetail} aria-label="返回阵容列表"><i class="fa fa-arrow-left" aria-hidden></i></button><div><h3>{team.name}</h3><p>{team.sourceLabel} · {formatLabel(localFormatForApp(team.formatId))}</p></div></div>
			<PokemonRoster roster={team.roster} />
			{team.usage && <dl class="pokemonai-team-metrics"><dt>对战</dt><dd>{team.usage.battles}</dd><dt>胜率</dt><dd>{Math.round(team.usage.winRate * 100)}%</dd><dt>平均分</dt><dd>{team.usage.avgRating || '—'}</dd></dl>}
			{team.completeness === 'roster-only' ? <p class="pokemonai-roster-only-state">该记录只有六只宝可梦的组合，没有完整配置。</p> : <div class="pokemonai-set-grid">{team.sets.map((set, index) => this.renderSet(set, index))}</div>}
			<div class="pokemonai-detail-actions">
				{team.packedTeam && ['valid', 'prevalidated'].includes(team.validationStatus) && <button class="button strong" onClick={this.startCatalogCopy}><i class="fa fa-plus" aria-hidden></i> 加入本地队伍</button>}
				{!!team.sourceUrl && <a class="button" href={team.sourceUrl} target="_blank"><i class="fa fa-external-link" aria-hidden></i> 查看来源</a>}
			</div>
		</aside>;
	}

	renderSet(set: CatalogPokemonSet | Teams.PokemonSet, index: number) {
		const catalogStats = (set as CatalogPokemonSet).statPoints;
		const localSet = set as Teams.PokemonSet;
		const stats = Array.isArray(catalogStats) ? catalogStats : ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].map(stat => Number(localSet.evs?.[stat as keyof Dex.StatsTable] || 0));
		const statLabels = ['HP', '攻击', '防御', '特攻', '特防', '速度'];
		return <section class="pokemonai-set-row" key={`${set.species}-${index}`}>
			<header><span class="picon" style={Dex.getPokemonIcon(set.species)} aria-hidden></span><div><strong>{Dex.species.get(set.species).name || set.species}</strong><small>{set.item || '无道具'}</small></div></header>
			<p>{[set.ability, set.nature && `${set.nature}性格`, set.teraType && `太晶 ${set.teraType}`].filter(Boolean).join(' · ') || '—'}</p>
			<p>{stats.map((value, stat) => value ? `${statLabels[stat]} ${value}` : '').filter(Boolean).join(' / ') || '未分配能力点'}</p>
			<ul>{set.moves.map(move => <li>{Dex.moves.get(move).name || move}</li>)}</ul>
		</section>;
	}

	localTeams() {
		const query = this.localQuery.trim().toLowerCase();
		return pokemonAILocalTeamStore.list({ includeDeleted: this.showDeleted, includeBoxes: true }).filter(team => {
			if (this.showDeleted ? !team.deletedAt : !!team.deletedAt) return false;
			if (this.localFormat !== 'all' && PS.teams.teambuilderFormat(team.formatId) !== PS.teams.teambuilderFormat(this.localFormat)) return false;
			if (!query) return true;
			return [team.name, team.notes, ...teamRoster(team.packedTeam).map(member => member.displayName)].join(' ').toLowerCase().includes(query);
		});
	}

	normalizeLocalActive(teams = this.localTeams()) {
		if (teams.some(team => team.id === this.inspectedLocalId)) return;
		const selectedIds = PokemonAIConfig.formats.map(format => pokemonAISetupStore.selection(format.id)?.localTeamId).filter(Boolean);
		this.inspectedLocalId = teams.find(team => selectedIds.includes(team.id))?.id || teams[0]?.id || '';
	}

	localCarouselItems(teams: PokemonAILocalTeamRecord[]): PokemonAILocalTeamCarouselItem[] {
		return teams.map(team => {
			const format = supportedFormatForTeam(team.formatId);
			const selected = format ? pokemonAISetupStore.selection(format.id) : null;
			return {
				id: team.id,
				name: team.name,
				formatLabel: `${formatLabel(team.formatId)}${team.kind === 'box' ? ' · 素材箱' : ''}`,
				notes: team.notes,
				validationStatus: team.validation.status,
				validationLabel: team.validation.status === 'valid' ? '可出战' : team.validation.status === 'invalid' ? '需要修改' : '待检查',
				roster: teamRoster(team.packedTeam),
				isBattleTeam: selected?.localTeamId === team.id,
			};
		});
	}

	renderLocalList() {
		const teams = this.localTeams();
		this.normalizeLocalActive(teams);
		const formats = Array.from(new globalThis.Set(pokemonAILocalTeamStore.list({ includeDeleted: true, includeBoxes: true }).map(team => team.formatId)));
		return <section class="pokemonai-library-list" aria-label="本地队伍列表">
			<div class="pokemonai-library-toolbar">
				<label class="pokemonai-search"><i class="fa fa-search" aria-hidden></i><input class="textbox" type="search" value={this.localQuery} onInput={this.setLocalQuery} placeholder="搜索名称、注释或宝可梦" aria-label="搜索本地队伍" /></label>
				<select class="button" value={this.localFormat} onChange={this.setLocalFormat} aria-label="本地队伍格式"><option value="all">全部格式</option>{formats.map(format => <option value={format}>{formatLabel(format)}</option>)}</select>
				<button class={`button${this.showDeleted ? ' cur' : ''}`} onClick={this.toggleDeleted}><i class="fa fa-trash" aria-hidden></i> 最近删除</button>
			</div>
			{this.lastDeletedId && <div class="pokemonai-inline-notice"><span>队伍已移入最近删除。</span><button class="button" onClick={this.undoDelete}>撤销</button></div>}
			{!this.showDeleted && <button class="button strong pokemonai-new-team" onClick={this.startNewLocal}><i class="fa fa-plus" aria-hidden></i> 新建本地队伍</button>}
			{this.showDeleted && !!teams.length && <button class="button pokemonai-purge-teams" onClick={this.purgeDeleted}><i class="fa fa-trash-o" aria-hidden></i> 永久清空</button>}
			{!teams.length && <p class="pokemonai-empty-state">{this.showDeleted ? '最近删除中没有队伍。' : '没有符合条件的本地队伍。'}</p>}
			{!!teams.length && <PokemonAILocalTeamCarousel
				items={this.localCarouselItems(teams)} activeId={this.inspectedLocalId || null}
				label={this.showDeleted ? '最近删除的本地队伍' : '本地队伍'} onActiveChange={this.setActiveLocal}
			/>}
		</section>;
	}

	renderNewLocal() {
		return <aside class="pokemonai-library-detail pokemonai-local-detail" ref={element => { this.detailElement = element; }} tabIndex={-1}>
			<div class="pokemonai-detail-heading"><button class="button icon" onClick={this.closeLocalDetail} aria-label="取消新建"><i class="fa fa-arrow-left" aria-hidden></i></button><div><h3>新建本地队伍</h3><p>创建后进入队伍编辑</p></div></div>
			<form class="pokemonai-copy-form" onSubmit={this.createLocal}>
				<label>队伍名称<input class="textbox" maxLength={80} value={this.newLocalName} onInput={event => { this.newLocalName = (event.currentTarget as HTMLInputElement).value; this.forceUpdate(); }} /></label>
				<label>格式<button name="format" value={this.newLocalFormat} data-selecttype="teambuilder" data-href="/formatdropdown" class="select button" onChange={this.changeNewLocalFormat}>{formatLabel(this.newLocalFormat)}</button></label>
				<label>注释<textarea class="textbox" rows={5} maxLength={2000} value={this.newLocalNotes} onInput={event => { this.newLocalNotes = (event.currentTarget as HTMLTextAreaElement).value; this.forceUpdate(); }} /></label>
				<button class="button strong" type="submit" disabled={!this.newLocalName.trim()}><i class="fa fa-arrow-right" aria-hidden></i> 创建并编辑</button>
			</form>
		</aside>;
	}

	renderLocalDetail() {
		if (this.creatingLocal) return this.renderNewLocal();
		const record = pokemonAILocalTeamStore.get(this.inspectedLocalId);
		if (!record) return null;
		const roster = teamRoster(record.packedTeam);
		const format = supportedFormatForTeam(record.formatId);
		const selected = format ? pokemonAISetupStore.selection(format.id) : null;
		let sets: Teams.PokemonSet[] = [];
		try {
			sets = Teams.unpack(record.packedTeam);
		} catch {}
		return <aside class="pokemonai-library-detail pokemonai-local-detail" ref={element => { this.detailElement = element; }} tabIndex={-1}>
			<div class="pokemonai-detail-heading"><div><h3>{record.name}</h3><p>{formatLabel(record.formatId)}{record.kind === 'box' ? ' · 素材箱' : ''}</p></div></div>
			<PokemonRoster roster={roster} />
			{record.notes && <p class="pokemonai-team-notes">{record.notes}</p>}
			{record.deletedAt ? <div class="pokemonai-detail-actions"><button class="button strong" onClick={this.restoreLocal}><i class="fa fa-undo" aria-hidden></i> 恢复队伍</button></div> : <>
				<div class="pokemonai-set-grid">{sets.map((set, index) => this.renderSet(set, index))}</div>
				{!sets.length && <p class="pokemonai-roster-only-state">队伍内容为空，可以进入编辑器添加宝可梦。</p>}
				<div class="pokemonai-detail-actions">
					{format && record.kind === 'team' && record.validation.status !== 'invalid' && <button class="button strong" onClick={this.selectLocalForBattle}><i class="fa fa-check" aria-hidden></i> {selected?.localTeamId === record.id ? '当前出战队伍' : '设为出战队伍'}</button>}
					<button class="button" onClick={this.editLocal}><i class="fa fa-pencil" aria-hidden></i> 编辑</button>
					<button class="button" onClick={this.duplicateLocal}><i class="fa fa-copy" aria-hidden></i> 复制</button>
					{record.packedTeam && <button class="button" onClick={this.exportLocal}><i class="fa fa-download" aria-hidden></i> 导出</button>}
					<button class="button danger" onClick={this.deleteLocal}><i class="fa fa-trash" aria-hidden></i> 删除</button>
				</div>
			</>}
		</aside>;
	}

	override render() {
		const hasDetail = this.view === 'catalog' && (!!this.inspectedCatalog || this.detailLoading);
		return <PSPanelWrapper room={this.props.room}><main class="pokemonai-workspace pokemonai-team-workspace">
			<header class="pokemonai-page-header"><div><h2>阵容</h2><p>{this.view === 'catalog' ? '线上队伍' : '本地队伍'}</p></div><a class="button" href="ai-battle"><i class="fa fa-play" aria-hidden></i> 对战准备</a></header>
			<div class="pokemonai-workspace-tabs" role="tablist" aria-label="阵容类型">
				<button role="tab" value="catalog" class={this.view === 'catalog' ? 'cur' : ''} aria-selected={this.view === 'catalog'} onClick={this.setView}><i class="fa fa-globe" aria-hidden></i> 线上队伍</button>
				<button role="tab" value="local" class={this.view === 'local' ? 'cur' : ''} aria-selected={this.view === 'local'} onClick={this.setView}><i class="fa fa-folder" aria-hidden></i> 本地队伍</button>
			</div>
			<div class={`pokemonai-library-layout${this.view === 'local' ? ' is-local' : ''}${hasDetail ? ' has-detail' : ''}`}>
				{this.view === 'catalog' ? this.renderCatalogList() : this.renderLocalList()}
				{this.view === 'catalog' ? this.renderCatalogDetail() : this.renderLocalDetail()}
			</div>
		</main></PSPanelWrapper>;
	}
}

class PokemonAILocalTeamEditorRoom extends PSRoom {
	dirty = false;
	constructor(options: RoomOptions) {
		super(options);
		const record = pokemonAILocalTeamStore.get(this.id.slice('aiteam-'.length));
		this.title = record?.name || '队伍编辑';
	}
	override interruptClose() {
		if (!this.dirty) return false;
		void PS.confirm('当前修改尚未保存，确定放弃修改并关闭吗？', {
			okButton: '放弃修改', cancelButton: '继续编辑',
		}).then(discard => {
			if (!discard) return;
			this.dirty = false;
			PS.leave(this.id);
		});
		return true;
	}
}

class PokemonAILocalTeamEditorPanel extends PSRoomPanel<PokemonAILocalTeamEditorRoom> {
	static readonly id = 'pokemonai-team-editor';
	static readonly routes = ['aiteam-*'];
	static readonly Model = PokemonAILocalTeamEditorRoom;
	static readonly title = '队伍编辑';
	static readonly location = 'left';

	recordId = this.props.room.id.slice('aiteam-'.length);
	record = pokemonAILocalTeamStore.get(this.recordId);
	draftTeam: Team | null = this.record ? {
		name: this.record.name,
		format: this.record.formatId as ID,
		folder: this.record.folder,
		packedTeam: this.record.packedTeam,
		iconCache: null,
		key: this.record.id,
		isBox: this.record.kind === 'box',
		teamid: this.record.showdownTeamId,
	} : null;
	draftNotes = this.record?.notes || '';
	editor: TeamEditorState | null = null;
	saveMessage = '';

	markDirty = () => {
		this.props.room.dirty = true;
		this.saveMessage = '';
		this.forceUpdate();
	};

	changeName = (event: Event) => {
		if (!this.draftTeam) return;
		this.draftTeam.name = (event.currentTarget as HTMLInputElement).value;
		this.markDirty();
	};

	changeNotes = (event: Event) => {
		this.draftNotes = (event.currentTarget as HTMLTextAreaElement).value;
		this.markDirty();
	};

	save() {
		if (!this.record || !this.draftTeam?.name.trim()) return null;
		const validation = structuralValidation({
			kind: this.record.kind, formatId: this.record.formatId, packedTeam: this.draftTeam.packedTeam,
		});
		const saved = pokemonAILocalTeamStore.update(this.record.id, {
			name: this.draftTeam.name,
			notes: this.draftNotes,
			packedTeam: this.draftTeam.packedTeam,
			validation: { ...validation, checkedAt: new Date().toISOString() },
		});
		if (!saved) return null;
		this.record = saved;
		this.props.room.dirty = false;
		this.props.room.title = saved.name;
		this.saveMessage = validation.errors.length ? '已保存，需要修改后才能出战。' : '已保存。';
		PS.update();
		this.forceUpdate();
		return saved;
	}

	saveOnly = () => this.save();
	returnTarget() {
		return (this.props.room.args?.returnTo as PokemonAIReturnTarget | undefined) || null;
	}
	returnFromEditor() {
		const target = this.returnTarget() || {
			roomid: 'ai-teams' as RoomID,
			args: {
				view: 'local', formatId: supportedFormatForTeam(this.record?.formatId || '')?.id || '',
				localTeamId: this.recordId,
			},
		};
		focusPokemonAIReturnTarget(target);
		if (target.historyBack) {
			const editorRoomid = this.props.room.id;
			setTimeout(() => PS.leave(editorRoomid), 50);
		} else {
			PS.leave(this.props.room.id);
		}
	}

	saveAndReturn = () => {
		const saved = this.save();
		if (!saved) return;
		this.returnFromEditor();
	};

	saveAndUse = () => {
		const saved = this.save();
		const format = saved && supportedFormatForTeam(saved.formatId);
		if (!saved || !format || saved.validation.status !== 'valid') return;
		selectPokemonAILocalTeam(format.id, saved.id);
		this.returnFromEditor();
	};

	back = async () => {
		if (this.props.room.dirty && !await PS.confirm('放弃尚未保存的修改？', { okButton: '放弃修改', cancelButton: '继续编辑' })) return;
		this.props.room.dirty = false;
		this.returnFromEditor();
	};

	validateWithShowdown = () => {
		if (!this.draftTeam?.packedTeam) return;
		this.props.room.send(`/utm ${this.draftTeam.packedTeam}`);
		this.props.room.send(`/vtm ${this.draftTeam.format}`);
	};

	override render() {
		if (!this.record || !this.draftTeam) return <PSPanelWrapper room={this.props.room}><main class="pokemonai-workspace"><p class="message-error">本地队伍不存在或已被删除。</p><button class="button" onClick={this.back}>返回本地队伍</button></main></PSPanelWrapper>;
		const validation = structuralValidation({ kind: this.record.kind, formatId: this.record.formatId, packedTeam: this.draftTeam.packedTeam });
		const format = supportedFormatForTeam(this.record.formatId);
		return <PSPanelWrapper room={this.props.room}><main class="pokemonai-team-editor-workspace">
			<header class="pokemonai-editor-header">
				<button class="button icon" onClick={this.back} aria-label="返回本地队伍"><i class="fa fa-arrow-left" aria-hidden></i></button>
				<div><h2>编辑队伍</h2><p>{formatLabel(this.record.formatId)}{this.props.room.dirty ? ' · 未保存' : ''}</p></div>
				<div class="pokemonai-editor-actions">
					<button class="button" onClick={this.validateWithShowdown} disabled={!this.draftTeam.packedTeam}><i class="fa fa-check-circle" aria-hidden></i> 校验</button>
					<button class="button" onClick={this.saveOnly} disabled={!this.draftTeam.name.trim()}><i class="fa fa-save" aria-hidden></i> 保存</button>
					<button class="button strong" onClick={this.saveAndReturn} disabled={!this.draftTeam.name.trim()}>保存并返回</button>
					{format && <button class="button strong" onClick={this.saveAndUse} disabled={!this.draftTeam.name.trim() || !!validation.errors.length}>保存并设为出战</button>}
				</div>
			</header>
			<section class="pokemonai-editor-metadata">
				<label>队伍名称<input class="textbox" maxLength={80} value={this.draftTeam.name} onInput={this.changeName} /></label>
				<label>注释<textarea class="textbox" maxLength={2000} rows={3} value={this.draftNotes} onInput={this.changeNotes} /></label>
				{this.saveMessage && <p class={validation.errors.length ? 'message-error' : 'message-success'}>{this.saveMessage}</p>}
			</section>
			<div class="pokemonai-editor-core"><TeamEditor
				team={this.draftTeam} onChange={this.markDirty} narrow={this.props.room.width < 700}
				editorRef={editor => { this.editor = editor; }}
			/></div>
		</main></PSPanelWrapper>;
	}
}

PS.addRoomType(PokemonAITeamsPanel, PokemonAILocalTeamEditorPanel);
