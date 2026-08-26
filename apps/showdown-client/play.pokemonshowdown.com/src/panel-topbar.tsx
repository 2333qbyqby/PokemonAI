/**
 * Topbar Panel
 *
 * Topbar view - handles the topbar and some generic popups.
 *
 * Also handles global drag-and-drop support.
 *
 * @author Guangcong Luo <guangcongluo@gmail.com>
 * @license AGPLv3
 */

import preact from "../js/lib/preact";
import {
	Config, NARROW_MODE_HEADER_WIDTH, PS, type PSRoom, type RoomID, VERTICAL_HEADER_WIDTH,
} from "./client-main";
import { PSView } from "./panels";
import type { Battle } from "./battle";
import { Dex } from "./battle-dex";
import { BattleLog } from "./battle-log"; // optional
import { PokemonAIApp } from "./pokemonai-app";
import { switchPokemonAIMode } from "./pokemonai";
import {
	closePokemonAILayer, getActivePlayerBattle, getPokemonAILayers, getPokemonAIOngoingBattles,
	isPokemonAIProductRoom, navigatePokemonAI, pokemonAINavSection, type PokemonAIReturnTarget,
} from "./pokemonai/navigation";

window.addEventListener('dragover', e => {
	// this prevents the bounce-back animation
	e.preventDefault();
});

export class PSHeader extends preact.Component {
	faviconNotifying = false;
	updateFavicon = () => {
		const notifying = Object.values(PS.rooms).some(room => room?.notifications.length);
		if (notifying === this.faviconNotifying) return;

		const favicon = document.querySelector<HTMLLinkElement>('#dynamic-favicon');
		if (!favicon) return;
		favicon.href = `${Dex.resourcePrefix}${notifying ? 'favicon-notify.ico' : 'favicon.ico'}`;
		this.faviconNotifying = notifying;
	};
	static toggleMute = (e: Event) => {
		PS.prefs.set('mute', !PS.prefs.mute);
		PS.update();
	};
	static handleDragEnter = (e: DragEvent) => {
		// console.log('dragenter ' + e.dataTransfer!.dropEffect);
		e.preventDefault();
		if (PS.dragging?.type !== 'room') return;
		/** the element being passed over */
		const target = e.currentTarget as HTMLAnchorElement;

		const draggingRoom = PS.dragging.roomid;
		if (draggingRoom === null) return;

		const draggedOverRoom = PS.router.extractRoomID(target.href);
		if (draggedOverRoom === null) return; // should never happen
		if (draggingRoom === draggedOverRoom) return;

		const leftIndex = PS.leftRoomList.indexOf(draggedOverRoom);
		if (leftIndex >= 0) {
			PS.dragOnto(PS.rooms[draggingRoom]!, 'left', leftIndex);
		} else {
			const rightIndex = PS.rightRoomList.indexOf(draggedOverRoom);
			if (rightIndex >= 0) {
				PS.dragOnto(PS.rooms[draggingRoom]!, 'right', rightIndex);
			} else {
				// eslint-disable-next-line no-useless-return
				return;
			}
		}

		// dropEffect !== 'none' prevents bounce-back animation in
		// Chrome/Safari/Opera
		// if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
	};
	static handleDragStart = (e: DragEvent) => {
		const roomid = PS.router.extractRoomID((e.currentTarget as HTMLAnchorElement).href);
		if (!roomid) return; // should never happen

		PS.dragging = { type: 'room', roomid };
	};
	static roomInfo(room: PSRoom) {
		const RoomType = PS.roomTypes[room.type];
		let icon = RoomType?.icon || <i class="fa fa-file-text-o" aria-hidden></i>;
		let title = room.title;
		switch (room.type) {
		case 'battle':
			const idChunks = room.id.split('-');
			let formatName;
			// TODO: relocate to room implementation
			if (idChunks.length <= 2) {
				if (idChunks[1] === 'uploadedreplay') formatName = 'Uploaded Replay';
			} else {
				formatName = window.BattleLog ? BattleLog.formatName(idChunks[1]) : idChunks[1];
			}
			if (!title) {
				const battle = (room as any).battle as Battle | undefined;
				const p1 = battle?.p1?.name || '';
				const p2 = battle?.p2?.name || '';
				if (p1 && p2) {
					title = `${p1} v. ${p2}`;
				} else if (p1 || p2) {
					title = `${p1}${p2}`;
				} else {
					title = `(empty room)`;
				}
			}
			icon = <i class="text">{formatName}</i>;
			break;
		case 'html':
		default:
			if (title.startsWith('[')) {
				let closeBracketIndex = title.indexOf(']');
				if (closeBracketIndex > 0) {
					icon = <i class="text">{title.slice(1, closeBracketIndex)}</i>;
					title = title.slice(closeBracketIndex + 1);
					break;
				}
			}
			break;
		}
		return { icon, title };
	}
	static renderRoomTab(id: RoomID, noAria?: boolean, includeMiniNotifications = true) {
		const room = PS.rooms[id];
		if (!room) return null;
		const closable = (id === '' || id === 'rooms' ? '' : ' closable');
		const cur = PS.isVisiblePanel(room) ? ' cur' : '';
		let notifying = room.isSubtleNotifying ? ' subtle-notifying' : '';
		let hoverTitle = '';
		let notifications = room.notifications;
		if (id === '' && includeMiniNotifications) {
			for (const roomid of PS.miniRoomList) {
				const miniNotifications = PS.rooms[roomid]?.notifications;
				if (miniNotifications?.length) notifications = [...notifications, ...miniNotifications];
			}
		}
		if (notifications.length) {
			notifying = ' notifying';
			for (const notif of notifications) {
				if (!notif.body) continue;
				hoverTitle += `${notif.title}\n${notif.body}\n`;
			}
		}
		let className = `roomtab button${notifying}${closable}${cur}`;

		let { icon, title: roomTitle } = PSHeader.roomInfo(room);
		if (room.type === 'rooms' && PS.leftPanelWidth !== null) roomTitle = '';
		if (room.type === 'battle') className += ' roomtab-battle';

		let closeButton = null;
		if (closable) {
			closeButton = <button class="closebutton" name="closeRoom" value={id} aria-label="Close">
				<i class="fa fa-times-circle" aria-hidden></i>
			</button>;
		}
		const aria: Record<string, string> = noAria ? {} : {
			"role": "tab", "id": `roomtab-${id}`, "aria-selected": cur ? "true" : "false",
		};
		if (id === 'rooms') aria['aria-label'] = "Join chat";
		return <li class={id === '' ? 'home-li' : ''} key={id}>
			<a
				class={className} href={`/${id}`} draggable={true} title={hoverTitle || undefined}
				onDragEnter={this.handleDragEnter} onDragStart={this.handleDragStart}
				{...aria}
			>
				{icon} {roomTitle}
			</a>
			{closeButton}
		</li>;
	}
	static notifyingMiniRoomTabs() {
		return PS.miniRoomList.filter(roomid => PS.rooms[roomid]?.notifications.length);
	}
	handleResize = () => {
		if (!this.base) return;

		if (PS.leftPanelWidth === null) {
			const width = document.documentElement.clientWidth;
			if (Config.pokemonaiApp) {
				const changed = PSView.narrowMode || PSView.verticalHeaderWidth !== 0;
				PSView.narrowMode = false;
				PSView.verticalHeaderWidth = 0;
				document.documentElement.style.width = 'auto';
				if (changed) {
					PSView.updateScrollSnap();
					PS.update();
				}
				return;
			}
			const oldNarrowMode = PSView.narrowMode;
			PSView.narrowMode = width <= 700;
			PSView.verticalHeaderWidth = PSView.narrowMode ? NARROW_MODE_HEADER_WIDTH : VERTICAL_HEADER_WIDTH;
			document.documentElement.style.width = PSView.useCSSScrollSnap() ?
				`${width + NARROW_MODE_HEADER_WIDTH}px` : 'auto';
			if (oldNarrowMode !== PSView.narrowMode) {
				PSView.updateScrollSnap();
				PS.update();
			}
			return;
		}
		if (PSView.narrowMode) {
			document.documentElement.style.width = 'auto';
			PSView.narrowMode = false;
			PSView.updateScrollSnap();
		}

		let userbarLeft = this.base.querySelector('div.userbar')?.getBoundingClientRect()?.left;
		if (userbarLeft) userbarLeft -= 5;
		const overflow = this.base.querySelector<HTMLElement>('.overflow');

		if (!overflow || !userbarLeft) return;

		const maintabbar = this.base.querySelector<HTMLElement>('div.maintabbar');
		if (maintabbar) {
			const userbarRight = window.innerWidth - userbarLeft;
			maintabbar.style.marginRight = `${userbarRight}px`;
			overflow.style.right = `${userbarRight}px`;
		}

		const roomTabs = this.base.querySelectorAll<HTMLElement>('div.maintabbar a.roomtab');
		const lastRoomTab = roomTabs[roomTabs.length - 1];
		if (lastRoomTab && lastRoomTab.getBoundingClientRect().right > userbarLeft - 3) {
			overflow.style.display = 'block';
		} else {
			overflow.style.display = 'none';
		}
	};
	override componentDidMount() {
		PS.user.subscribe(() => {
			this.forceUpdate();
		});
		window.addEventListener('resize', this.handleResize);
		this.handleResize();
		this.updateFavicon();
	}
	override componentDidUpdate() {
		this.handleResize();
		this.updateFavicon();
	}
	renderUser() {
		if (!PS.connection?.connected) {
			return <button class="button" disabled><em>离线</em></button>;
		}
		if (PS.user.initializing) {
			return <button class="button" disabled><em>连接中...</em></button>;
		}
		if (PokemonAIApp.isAI()) {
			return <span class="username">
				<span class="usernametext">
					{PS.user.named ? PokemonAIApp.displayTrainerName(PS.user.name) : '本地玩家'}
				</span>
			</span>;
		}
		if (!PS.user.named) {
			return <a class="button" href="login">设置昵称</a>;
		}
		const userColor = window.BattleLog && `color:${PS.user.away ? '#888' : BattleLog.usernameColor(PS.user.userid)}`;
		return <span class="username" style={userColor}>
			<span class="usernametext">{PS.user.name}</span>
		</span>;
	}
	switchMode = (ev: Event) => {
		const nextMode = PokemonAIApp.isAI() ? 'online' : 'ai';
		switchPokemonAIMode(nextMode, ev.currentTarget as HTMLElement);
	};
	renderModeBadge() {
		return <button class={`pokemonai-mode-badge mode-${PokemonAIApp.mode}`} onClick={this.switchMode}>
			<i class={`fa ${PokemonAIApp.isAI() ? 'fa-microchip' : 'fa-globe'}`} aria-hidden></i> {}
			{PokemonAIApp.profile.label}
		</button>;
	}
	openSection = (ev: MouseEvent) => {
		ev.preventDefault();
		const section = (ev.currentTarget as HTMLElement).dataset.section;
		if (section === 'home' || section === 'battle' || section === 'teams') void navigatePokemonAI(section);
	};
	openRoom = (ev: MouseEvent) => {
		ev.preventDefault();
		const roomid = (ev.currentTarget as HTMLElement).dataset.roomid as RoomID | undefined;
		if (roomid) PS.join(roomid);
	};
	openEnvironmentData = (ev: MouseEvent) => {
		ev.preventDefault();
		const source = PS.panel;
		const returnTo: PokemonAIReturnTarget = {
			roomid: (source?.id || '') as RoomID,
			args: source?.args || undefined,
		};
		const roomid = 'ai-meta' as RoomID;
		if (PS.rooms[roomid]) PS.rooms[roomid].args = { returnTo };
		PS.join(roomid, { args: { returnTo } });
	};
	leaveBattle = (ev: MouseEvent) => {
		getActivePlayerBattle()?.interruptClose(true, ev.currentTarget as HTMLElement);
	};
	mobileBack = () => {
		if (closePokemonAILayer(PS.room.id)) return;
		if (pokemonAINavSection() === 'home') return;
		if (pokemonAINavSection() === 'advanced' || PS.room.type === 'pokemonai-team-editor') {
			history.back();
			return;
		}
		void navigatePokemonAI('home');
	};
	chatNotificationCount() {
		return Object.values(PS.rooms).reduce((count, room) => {
			if (!room || room.type === 'battle') return count;
			return count + room.notifications.length;
		}, 0);
	}
	battleStatus(room: PSRoom) {
		const battleRoom = room as any;
		if (battleRoom.battle?.ended) return '已结束';
		if (battleRoom.side) {
			const state = battleRoom.notifications.some((notification: any) => notification.id === 'choice') ? '待操作' : '本人对战';
			return battleRoom.battle?.turn ? `第 ${battleRoom.battle.turn} 回合 · ${state}` : state;
		}
		return '观战';
	}
	renderOngoingMenu() {
		const rooms = getPokemonAIOngoingBattles();
		return <div class="pokemonai-nav-menu pokemonai-ongoing-menu">
			<strong>进行中</strong>
			{!rooms.length && <p>当前没有对战或观战。</p>}
			{rooms.map(room => {
				const info = PSHeader.roomInfo(room);
				return <button class="pokemonai-menu-room" data-roomid={room.id} onClick={this.openRoom} key={room.id}>
					<span>{info.title}</span><small>{this.battleStatus(room)}</small>
				</button>;
			})}
		</div>;
	}
	renderMoreMenu() {
		const chatCount = this.chatNotificationCount();
		const chats = Object.values(PS.rooms).filter((room): room is PSRoom => (
			!!room && room.type === 'chat' && !room.noURL && !isPokemonAIProductRoom(room)
		));
		return <div class="pokemonai-nav-menu pokemonai-more-menu">
			<a href="ai-meta" onClick={this.openEnvironmentData}><i class="fa fa-database" aria-hidden></i> 环境数据</a>
			<a href="rooms"><i class="fa fa-comments" aria-hidden></i> 消息与聊天室
				{!!chatCount && <span class="pokemonai-nav-count">{chatCount}</span>}
			</a>
			<a href="ladder"><i class="fa fa-list-ol" aria-hidden></i> 天梯</a>
			<a href="battles"><i class="fa fa-eye" aria-hidden></i> 观战列表</a>
			{PokemonAIApp.isOnline() && <a href="official-account">
				<i class="fa fa-key" aria-hidden></i> 账号授权
			</a>}
			<button data-href="options"><i class="fa fa-sliders" aria-hidden></i> 声音与显示</button>
			<a href="resources"><i class="fa fa-book" aria-hidden></i> 规则与资源</a>
			<a href="credits"><i class="fa fa-info-circle" aria-hidden></i> 关于</a>
			{!!chats.length && <div class="pokemonai-open-chat-list"><strong>已打开的聊天</strong>{chats.map(room => <button
				class="pokemonai-menu-room" data-roomid={room.id} onClick={this.openRoom} key={room.id}
			>
				<span>{PSHeader.roomInfo(room).title}</span>
				{!!room.notifications.length && <small>{room.notifications.length} 条未读</small>}
			</button>)}</div>}
		</div>;
	}
	renderBattleHeader(activeBattle: PSRoom, mobile = false) {
		const info = PSHeader.roomInfo(activeBattle);
		const status = this.battleStatus(activeBattle);
		return <header id="header" class={`pokemonai-battle-header${mobile ? ' is-mobile' : ''}`}>
			<div class="pokemonai-battle-heading">
				<i class="fa fa-gamepad" aria-hidden></i>
				<span><strong>{info.title}</strong><small>{PS.isOffline ? '连接中断' : status}</small></span>
			</div>
			<div class="pokemonai-battle-header-actions">
				<button class="button icon" data-href="volume" aria-label="声音设置" onDblClick={PSHeader.toggleMute}>
					<i class={PS.prefs.mute ? 'fa fa-volume-off' : 'fa fa-volume-up'} aria-hidden></i>
				</button>
				<button class="button danger" onClick={this.leaveBattle}>退出对战</button>
			</div>
		</header>;
	}
	renderPokemonAIDesktop() {
		const activeBattle = getActivePlayerBattle();
		if (activeBattle) return this.renderBattleHeader(activeBattle);
		const section = pokemonAINavSection();
		const ongoing = getPokemonAIOngoingBattles();
		return <header id="header" class="pokemonai-app-header" role="navigation" aria-label="主导航">
			<a class="pokemonai-wordmark" href="/" data-section="home" onClick={this.openSection}>PokémonAI</a>
			<nav class="pokemonai-primary-nav">
				<a class={section === 'home' ? 'cur' : ''} href="/" data-section="home" onClick={this.openSection}>首页</a>
				<a class={section === 'battle' ? 'cur' : ''} href="/ai-battle" data-section="battle" onClick={this.openSection}>对战</a>
				<a class={section === 'teams' ? 'cur' : ''} href="/ai-teams" data-section="teams" onClick={this.openSection}>阵容</a>
				<details class="pokemonai-nav-dropdown">
					<summary class={PS.room.type === 'battle' ? 'cur' : ''}>进行中{!!ongoing.length && <span>{ongoing.length}</span>}</summary>
					{this.renderOngoingMenu()}
				</details>
			</nav>
			<div class="pokemonai-header-tools">
				{this.renderModeBadge()}
				{PokemonAIApp.isOnline() ? <a class="button pokemonai-account-button" href="official-account">
					<i class="fa fa-user-circle" aria-hidden></i> {PS.user.named ? PS.user.name : '账号'}
				</a> : <span class="button pokemonai-account-button pokemonai-local-player">
					<i class="fa fa-user-circle" aria-hidden></i> {}
					{PS.user.named ? PokemonAIApp.displayTrainerName(PS.user.name) : '本地玩家'}
				</span>}
				<details class="pokemonai-nav-dropdown pokemonai-more-dropdown">
					<summary aria-label="更多"><i class="fa fa-ellipsis-h" aria-hidden></i></summary>
					{this.renderMoreMenu()}
				</details>
			</div>
		</header>;
	}
	renderPokemonAIMobile() {
		const activeBattle = getActivePlayerBattle();
		if (activeBattle) return this.renderBattleHeader(activeBattle, true);
		const section = pokemonAINavSection();
		const title = PSHeader.roomInfo(PS.panel).title || 'PokémonAI';
		const showBack = section !== 'home' || !!getPokemonAILayers(PS.room.id).length;
		return <>
			<header id="header" class="pokemonai-mobile-header">
				<button class="pokemonai-mobile-back" onClick={this.mobileBack} disabled={!showBack} aria-label="返回">
					<i class="fa fa-arrow-left" aria-hidden></i>
				</button>
				<div class="pokemonai-mobile-title"><strong>{title}</strong><small>{PokemonAIApp.profile.label}</small></div>
				<details class="pokemonai-nav-dropdown pokemonai-more-dropdown">
					<summary aria-label="更多"><i class="fa fa-ellipsis-v" aria-hidden></i></summary>
					{this.renderMoreMenu()}
				</details>
			</header>
			<nav class="pokemonai-mobile-nav" aria-label="主导航">
				<a class={section === 'home' ? 'cur' : ''} href="/" data-section="home" onClick={this.openSection}>
					<i class="fa fa-home" aria-hidden></i><span>首页</span>
				</a>
				<a class={section === 'battle' ? 'cur' : ''} href="/ai-battle" data-section="battle" onClick={this.openSection}>
					<i class="fa fa-gamepad" aria-hidden></i><span>对战</span>
				</a>
				<a class={section === 'teams' ? 'cur' : ''} href="/ai-teams" data-section="teams" onClick={this.openSection}>
					<i class="fa fa-users" aria-hidden></i><span>阵容</span>
				</a>
			</nav>
		</>;
	}
	renderVertical() {
		if (Config.pokemonaiApp) return this.renderPokemonAIMobile();
		const miniRoomTabs = PSHeader.notifyingMiniRoomTabs();
		return <div
			id="header" class="header-vertical" role="navigation"
			style={`width:${PSView.verticalHeaderWidth - 7}px`} onClick={PSView.scrollToHeader}
		>
			<div class="maintabbarbottom"></div>
			<div class="scrollable-part">
				<img
					class="logo"
					src={`https://${Config.routes.client}/favicon-256.png`}
					alt="Pokémon Showdown! (beta)"
					width="50" height="50"
				/>
				<div class="tablist" role="tablist">
					<ul>
						{PSHeader.renderRoomTab(PS.leftRoomList[0], false, false)}
						{miniRoomTabs.map(roomid => PSHeader.renderRoomTab(roomid))}
					</ul>
					<ul>
						{PS.leftRoomList.slice(1).map(roomid => PSHeader.renderRoomTab(roomid))}
					</ul>
					<ul class="siderooms">
						{PS.rightRoomList.map(roomid => PSHeader.renderRoomTab(roomid))}
					</ul>
				</div>
			</div>
			<div class="userbar">
				{this.renderModeBadge()} {}
				{this.renderUser()} {}
				<div style="float:right">
					<button class="icon button" data-href="volume" title="Sound" aria-label="Sound" onDblClick={PSHeader.toggleMute}>
						<i class={PS.prefs.mute ? 'fa fa-volume-off' : 'fa fa-volume-up'}></i>
					</button> {}
					<button class="icon button" data-href="options" title="Options" aria-label="Options">
						<i class="fa fa-cog" aria-hidden></i>
					</button>
				</div>
			</div>
			{null /* maintabbar */}
			{null /* overflow */}
		</div>;
	}
	override render() {
		if (Config.pokemonaiApp && PS.leftPanelWidth !== null) return this.renderPokemonAIDesktop();
		if (PS.leftPanelWidth === null) {
			return this.renderVertical();
		}
		return <div id="header" class="header" role="navigation">
			<div class="maintabbarbottom"></div>
			{null /* vertical tabs */}
			<div class="userbar">
				{this.renderModeBadge()} {}
				{this.renderUser()} {}
				<button class="icon button" data-href="volume" title="Sound" aria-label="Sound" onDblClick={PSHeader.toggleMute}>
					<i class={PS.prefs.mute ? 'fa fa-volume-off' : 'fa fa-volume-up'}></i>
				</button> {}
				<button class="icon button" data-href="options" title="Options" aria-label="Options">
					<i class="fa fa-cog" aria-hidden></i>
				</button>
			</div>
			<div class="tabbar maintabbar"><div class="inner-1" role={PS.leftPanelWidth ? 'none' : 'tablist'}><div class="inner-2">
				<ul class="maintabbar-left" style={{ width: `${PS.leftPanelWidth}px` }} role={PS.leftPanelWidth ? 'tablist' : 'none'}>
					<li>
						<img
							class="logo"
							src={`https://${Config.routes.client}/favicon-256.png`}
							alt="Pokémon Showdown! (beta)"
							width="48" height="48"
						/>
					</li>
					{PSHeader.renderRoomTab(PS.leftRoomList[0])}
					{PS.leftRoomList.slice(1).map(roomid => PSHeader.renderRoomTab(roomid))}
				</ul>
				<ul class="maintabbar-right" role={PS.leftPanelWidth ? 'tablist' : 'none'}>
					{PS.rightRoomList.map(roomid => PSHeader.renderRoomTab(roomid))}
				</ul>
			</div></div></div>
			<div class="overflow">
				<button name="tablist" class="button" data-href="roomtablist" aria-label="All tabs" type="button">
					<i class="fa fa-caret-down" aria-hidden></i>
				</button>
			</div>
		</div>;
	}
}

export class PSMiniHeader extends preact.Component {
	menuOpen?: boolean;
	override componentDidMount() {
		PSView.addScrollListener(this.handleScroll);
	}
	override componentWillUnmount() {
		PSView.removeScrollListener(this.handleScroll);
	}
	handleScroll = () => {
		if (this.menuOpen !== !PSView.getScrollX()) this.forceUpdate();
	};
	override render() {
		if (Config.pokemonaiApp) return null;
		this.menuOpen = !PSView.getScrollX();

		if (PS.leftPanelWidth !== null) return null;

		const notificationsCount = Object.values(PS.rooms).filter(
			room => room !== PS.room && room?.notifications.length
		).length;
		const { icon, title } = PSHeader.roomInfo(PS.panel);
		const userColor = window.BattleLog && `color:${PS.user.away ? '#888' : BattleLog.usernameColor(PS.user.userid)}`;
		const showMenuButton = PSView.narrowMode;
		const notifying = (
			!showMenuButton && this.menuOpen && Object.values(PS.rooms).some(room => room!.notifications.length)
		) ? ' notifying' : '';
		const menuButton = !showMenuButton ? (
			null
		) : !this.menuOpen ? (
			<button onClick={PSView.scrollToHeader} class={`mini-header-left ${notifying}`} aria-label="Menu">
				{!!notificationsCount && <div class="notification-badge">{notificationsCount}</div>}
				<i class="fa fa-bars" aria-hidden></i>
			</button>
		) : (
			<button onClick={PSView.scrollToRoom} class="mini-header-left" aria-label="Menu">
				<i class="fa fa-arrow-right" aria-hidden></i>
			</button>
		);
		return <div class="mini-header" style={`left:${PSView.verticalHeaderWidth + (PSView.narrowMode ? 0 : -1)}px;`}>
			{menuButton}
			{icon} {title}
			<button data-href="options" class="mini-header-right" aria-label="Options">
				{PS.user.named ? <strong style={userColor}>{PS.user.name}</strong> : <i class="fa fa-cog" aria-hidden></i>}
			</button>
		</div>;
	}
}

preact.render(<PSView />, document.body, document.getElementById('ps-frame')!);
