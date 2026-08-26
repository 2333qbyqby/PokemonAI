import preact from '../../js/lib/preact';
import { Dex } from '../battle-dex';

export interface PokemonAILocalTeamCarouselItem {
	id: string;
	name: string;
	formatLabel: string;
	notes: string;
	validationStatus: 'unchecked' | 'valid' | 'invalid';
	validationLabel: string;
	roster: Array<{ species: string; displayName: string }>;
	isBattleTeam: boolean;
}

export interface PokemonAILocalTeamCarouselProps {
	items: PokemonAILocalTeamCarouselItem[];
	activeId: string | null;
	label: string;
	onActiveChange: (id: string) => void;
}

export class PokemonAILocalTeamCarousel extends preact.Component<PokemonAILocalTeamCarouselProps> {
	track: HTMLDivElement | null = null;
	scrollTimer: number | null = null;

	override componentDidMount() {
		this.scrollToActive(false);
	}

	override componentDidUpdate(previous: PokemonAILocalTeamCarouselProps) {
		const previousIds = previous.items.map(item => item.id).join('|');
		const currentIds = this.props.items.map(item => item.id).join('|');
		if (previous.activeId !== this.props.activeId || previousIds !== currentIds) this.scrollToActive(false);
	}

	override componentWillUnmount() {
		if (this.scrollTimer !== null) window.clearTimeout(this.scrollTimer);
	}

	activeIndex() {
		const index = this.props.items.findIndex(item => item.id === this.props.activeId);
		return index < 0 ? 0 : index;
	}

	scrollToActive(smooth: boolean) {
		if (!this.track || !this.props.activeId) return;
		const card = this.track.querySelector<HTMLElement>(`[data-carousel-id="${CSS.escape(this.props.activeId)}"]`);
		if (!card) return;
		const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		card.scrollIntoView({ behavior: smooth && !reducedMotion ? 'smooth' : 'auto', block: 'nearest', inline: 'center' });
	}

	activate = (event: MouseEvent) => {
		const id = (event.currentTarget as HTMLButtonElement).value;
		if (!id || id === this.props.activeId) return;
		this.props.onActiveChange(id);
	};

	move(direction: -1 | 1) {
		if (!this.props.items.length) return;
		const nextIndex = Math.max(0, Math.min(this.props.items.length - 1, this.activeIndex() + direction));
		const next = this.props.items[nextIndex];
		if (!next || next.id === this.props.activeId) return;
		this.props.onActiveChange(next.id);
		window.setTimeout(() => this.scrollToActive(true), 0);
	}

	previous = () => this.move(-1);
	next = () => this.move(1);

	keydown = (event: KeyboardEvent) => {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		event.preventDefault();
		this.move(event.key === 'ArrowLeft' ? -1 : 1);
	};

	scrolled = () => {
		if (this.scrollTimer !== null) window.clearTimeout(this.scrollTimer);
		this.scrollTimer = window.setTimeout(() => {
			this.scrollTimer = null;
			if (!this.track) return;
			const center = this.track.getBoundingClientRect().left + this.track.clientWidth / 2;
			let closestId = '';
			let closestDistance = Number.POSITIVE_INFINITY;
			for (const card of this.track.querySelectorAll<HTMLElement>('[data-carousel-id]')) {
				const bounds = card.getBoundingClientRect();
				const distance = Math.abs(bounds.left + bounds.width / 2 - center);
				if (distance < closestDistance) {
					closestDistance = distance;
					closestId = card.dataset.carouselId || '';
				}
			}
			if (closestId && closestId !== this.props.activeId) this.props.onActiveChange(closestId);
		}, 120);
	};

	renderRoster(item: PokemonAILocalTeamCarouselItem) {
		return <span class="pokemonai-carousel-roster">{Array.from({ length: 6 }, (_, index) => {
			const member = item.roster[index];
			return <span class={`pokemonai-carousel-member${member ? '' : ' empty'}`} title={member?.displayName || ''} key={index}>
				{member && <><span class="picon" style={Dex.getPokemonIcon(member.species)} aria-hidden></span><small>{member.displayName}</small></>}
			</span>;
		})}</span>;
	}

	override render() {
		const items = this.props.items;
		if (!items.length) return null;
		const activeIndex = this.activeIndex();
		return <section class={`pokemonai-team-carousel count-${Math.min(items.length, 3)}`} aria-label={this.props.label}>
			<div class="pokemonai-carousel-status" aria-live="polite">{activeIndex + 1} / {items.length}</div>
			<div class="pokemonai-carousel-shell">
				<button class="button icon pokemonai-carousel-arrow previous" onClick={this.previous} disabled={activeIndex <= 0} aria-label="上一支队伍">
					<i class="fa fa-chevron-left" aria-hidden></i>
				</button>
				<div
					class="pokemonai-carousel-track" ref={element => { this.track = element; }} tabIndex={0}
					onKeyDown={this.keydown} onScroll={this.scrolled} aria-label={`${this.props.label}，使用左右方向键切换`}
				>
					{items.map(item => {
						const active = item.id === this.props.activeId;
						return <article class={`pokemonai-carousel-card${active ? ' active' : ''}`} data-carousel-id={item.id} key={item.id}>
							<button class="pokemonai-carousel-card-button" value={item.id} onClick={this.activate} aria-current={active ? 'true' : undefined}>
								<span class="pokemonai-carousel-title"><strong>{item.name}</strong><small>{item.formatLabel}</small></span>
								{this.renderRoster(item)}
								<span class="pokemonai-carousel-meta">
									<span class={`pokemonai-validation-status ${item.validationStatus}`}>{item.validationLabel}</span>
									{item.isBattleTeam && <span class="pokemonai-battle-team-badge"><i class="fa fa-check" aria-hidden></i> 出战</span>}
								</span>
								<small class="pokemonai-carousel-notes">{item.notes || '无注释'}</small>
							</button>
						</article>;
					})}
				</div>
				<button class="button icon pokemonai-carousel-arrow next" onClick={this.next} disabled={activeIndex >= items.length - 1} aria-label="下一支队伍">
					<i class="fa fa-chevron-right" aria-hidden></i>
				</button>
			</div>
		</section>;
	}
}
