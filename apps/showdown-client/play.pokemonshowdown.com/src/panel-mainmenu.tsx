/**
 * Main menu panel
 *
 * @author Guangcong Luo <guangcongluo@gmail.com>
 * @license AGPLv3
 */

import preact from "../js/lib/preact";
import { Net, PSLoginServer } from "./client-connection";
import { PSBackground } from "./client-core";
import { Config, PS, PSRoom, type PSRoomFocusOptions, type RoomID, type RoomOptions, type Team } from "./client-main";
import { PSIcon, PSPanelErrorBoundary, PSPanelWrapper, PSRoomPanel, PSView, ReconnectTimer } from "./panels";
import type { BattlesRoom } from "./panel-battle";
import type { ChatRoom } from "./panel-chat";
import type { LadderFormatRoom } from "./panel-ladder";
import type { RoomsRoom } from "./panel-rooms";
import { TeamBox, type SelectType } from "./panel-teamdropdown";
import { Dex, toID, type ID } from "./battle-dex";
import type { Args } from "./battle-text-parser";
import { BattleLog } from "./battle-log"; // optional
import { Teams } from "./battle-teams";
import {
	challengeOfficialPlayer, challengePokemonAI,
	ensurePokemonAITrainerIdentity, openPokemonAISetup, pokemonAISetupStore,
	resumePendingOnlineAction, resumePendingPokemonAIChallenge,
	selectPokemonAIAITeamSettings, selectPokemonAILocalTeam, selectPokemonAISetupFormat,
	startOfficialRandomBattle, subscribePokemonAISetup,
	switchPokemonAIMode, type PokemonAITeamMode, type PokemonAITeamSelection,
} from "./pokemonai";
import { PokemonAIConfig } from "./pokemonai-config";
import { PokemonAIApp } from "./pokemonai-app";
import {
	openPokemonAILocalTeamEditor, pokemonAILocalTeamStore,
	type PokemonAILocalTeamRecord,
} from "./pokemonai/teams";
import { PokemonAILocalTeamCarousel, type PokemonAILocalTeamCarouselItem } from "./pokemonai/team-carousel";
import {
	closePokemonAILayer, focusPokemonAIReturnTarget, getPokemonAITopLayer, navigatePokemonAI, openPokemonAILayer,
	subscribePokemonAINavigation, type PokemonAIReturnTarget,
} from "./pokemonai/navigation";

export type RoomInfo = {
	title: string, id?: RoomID, desc?: string, userCount?: number, section?: string, privacy?: 'hidden',
	spotlight?: string, subRooms?: string[],
};

export class MainMenuRoom extends PSRoom {
	override readonly classType: string = 'mainmenu';
	listeners: Record<string, ((response: any) => void)[] | null> = {};
	userdetailsCache: {
		[userid: string]: {
			userid: ID,
			name: string,
			avatar?: string | number,
			status?: string,
			group?: string,
			customgroup?: string,
			rooms?: { [roomid: string]: { isPrivate?: true, p1?: string, p2?: string } },
		},
	} = {};
	roomsCache: {
		battleCount?: number,
		userCount?: number,
		chat?: RoomInfo[],
		sectionTitles?: string[],
	} = {};
	searchCountdown: { format: string, packedTeam: string, countdown: number, timer: number } | null = null;
	/** used to track the moment between "search sent" and "server acknowledged search sent" */
	teamSent: string | null = null;
	search: { searching: string[], games: Record<RoomID, string> | null } = { searching: [], games: null };
	disallowSpectators: boolean | null = PS.prefs.disallowspectators;
	lastChallenged: number | null = null;
	constructor(options: RoomOptions) {
		super(options);
		if (this.backlog) {
			// these aren't set yet, but a lot of things could go wrong if we don't
			PS.rooms[''] = this;
			PS.mainmenu = this;
			for (const args of this.backlog) {
				this.receiveLine(args);
			}
			this.backlog = null;
		}
	}
	adjustPrivacy() {
		PS.prefs.set('disallowspectators', this.disallowSpectators);
		if (this.disallowSpectators) return '/noreply /hidenext \n';
		return '';
	}
	startSearch = (format: string, team?: Team, parentElem?: HTMLElement | null) => {
		PS.requestNotifications();
		if (this.searchCountdown) {
			PS.alert("Wait for this countdown to finish first...", { parentElem });
			return;
		} else if (this.search.searching.includes(format)) {
			PS.alert(`You're already searching for a ${BattleLog.formatName(format)} battle...`, { parentElem });
			return;
		}
		this.searchCountdown = {
			format,
			packedTeam: team?.packedTeam || '',
			countdown: 3,
			timer: setInterval(this.doSearchCountdown, 1000),
		};
		this.update(null);
	};
	searchingFormat() {
		return this.searchCountdown?.format || this.teamSent ||
			this.search.searching?.[this.search.searching.length - 1] || null;
	}
	cancelSearch = () => {
		if (this.searchCountdown) {
			clearTimeout(this.searchCountdown.timer);
			this.searchCountdown = null;
			this.update(null);
			return true;
		}
		if (this.teamSent || this.search.searching?.length) {
			this.teamSent = null;
			PS.send(`/cancelsearch`);
			this.update(null);
			return true;
		}
		return false;
	};
	doSearchCountdown = () => {
		if (!this.searchCountdown) return; // ??? race???

		this.searchCountdown.countdown--;
		if (this.searchCountdown.countdown <= 0) {
			this.doSearch(this.searchCountdown);
			clearTimeout(this.searchCountdown.timer);
			this.searchCountdown = null;
		}
		this.update(null);
	};
	doSearch = (search: NonNullable<typeof this.searchCountdown>) => {
		this.teamSent = search.format;
		const privacy = this.adjustPrivacy();
		PS.send(`/utm ${search.packedTeam}`);
		PS.send(`${privacy}/search ${search.format}`);
	};
	override receiveLine(args: Args) {
		const [cmd] = args;
		switch (cmd) {
		case 'challstr': {
			const [, challstr] = args;
			PS.user.challstr = challstr;
			if (PokemonAIApp.isAI()) {
				// Personal training uses an automatic local identity. Showdown still
				// requires a named protocol user before it can create a battle.
				PS.user.initializing = false;
				PS.user.update(null);
				PS.send('/language simplifiedchinese');
				ensurePokemonAITrainerIdentity();
				return;
			}
			PokemonAIApp.setOfficialAuthState(PokemonAIApp.hasOfficialSid() ? 'checking' : 'idle');
			PSLoginServer.query(
				'upkeep', { challstr }
			).then(res => {
				if (!res) {
					if (PokemonAIApp.hasOfficialSid()) PokemonAIApp.setOfficialAuthState('network-error');
					PS.user.initializing = false;
					PS.user.update(null);
					return;
				}
				if (!res?.username) {
					if (PokemonAIApp.hasOfficialSid()) PokemonAIApp.setOfficialAuthState('invalid');
					PS.user.initializing = false;
					PS.user.update(null);
					return;
				}
				// | , ; are not valid characters in names
				res.username = res.username.replace(/[|,;]+/g, '');
				if (res.loggedin) {
					PS.user.registered = { name: res.username, userid: toID(res.username) };
					PokemonAIApp.setOfficialAuthState('authenticated');
				}
				PS.user.handleAssertion(res.username, res.assertion);
			});
			return;
		} case 'updateuser': {
			const [, fullName, namedCode, avatar, settingsJSON] = args;
			const named = namedCode === '1';
			// PokemonAI deliberately uses guest identities only. The upstream client
			// waits for an optional login-server upkeep request before showing the
			// nickname action; the self-hosted test client should be usable without it.
			if (named || PokemonAIApp.isAI()) PS.user.initializing = false;
			if (settingsJSON) {
				PS.prefs.set('serversettings', { ...PS.prefs.serversettings, ...JSON.parse(settingsJSON) });
			}
			PS.user.setName(fullName, named, avatar);
			if (named) {
				if (PokemonAIApp.isAI()) {
					PS.user.loggingIn = null;
					if (PS.rooms.login) PS.leave('login' as RoomID);
				}
				PS.send('/language simplifiedchinese');
				setTimeout(resumePendingPokemonAIChallenge, 0);
				setTimeout(resumePendingOnlineAction, 0);
			}
			PS.teams.loadRemoteTeams();
			return;
		} case 'updatechallenges': {
			const [, challengesBuf] = args;
			this.receiveChallenges(challengesBuf);
			return;
		} case 'updatesearch': {
			const [, searchBuf] = args;
			this.receiveSearch(searchBuf);
			return;
		} case 'queryresponse': {
			const [, queryId, responseJSON] = args;
			this.handleQueryResponse(queryId as ID, JSON.parse(responseJSON));
			return;
		} case 'pm': {
			const [, user1, user2, message] = args;
			this.handlePM(user1, user2, message);
			let sideRoom = PS.rightPanel as ChatRoom;
			if (sideRoom?.type === "chat" && PS.prefs.inchatpm) sideRoom?.log?.add(args);
			return;
		} case 'customgroups': {
			const [, groupsList] = args;
			PS.server.parseGroups(groupsList);
			return;
		} case 'formats': {
			this.parseFormats(args);
			return;
		} case 'popup': {
			let [, message] = args;
			for (const roomid in PS.rooms) {
				const room = PS.rooms[roomid] as ChatRoom | MainMenuRoom;
				if (room.teamSent) {
					room.teamSent = null;
					room.update(null);
				}
				if (room.type === 'team') (room as any).cancelUpload();
			}
			let width: number | undefined;
			if (message.startsWith('|wide|')) {
				message = message.slice(6);
				width = 960;
			}
			PS.alert(message.replace(/\|\|/g, '\n'), { width });
			return;
		}
		}
		const lobby = PS.rooms['lobby'];
		if (lobby) lobby.receiveLine(args);
	}
	receiveChallenges(dataBuf: string) {
		let json;
		try {
			json = JSON.parse(dataBuf);
		} catch {}
		for (const userid in json.challengesFrom) {
			PS.getPMRoom(toID(userid));
		}
		if (json.challengeTo) {
			PS.getPMRoom(toID(json.challengeTo.to));
		}
		for (const roomid in PS.rooms) {
			const room = PS.rooms[roomid] as ChatRoom;
			if (!room.pmTarget) continue;
			const targetUserid = toID(room.pmTarget);
			if (!room.challenged && !(targetUserid in json.challengesFrom) &&
				!room.challenging && json.challengeTo?.to !== targetUserid) {
				continue;
			}
			room.challenged = room.parseChallenge(json.challengesFrom[targetUserid]);
			room.challenging = json.challengeTo?.to === targetUserid ? room.parseChallenge(json.challengeTo.format) : null;
			room.update(null);
		}
	}
	receiveSearch(dataBuf: string) {
		let json;
		this.teamSent = null;
		try {
			json = JSON.parse(dataBuf);
		} catch {}
		this.search = json;
		this.update(null);
	}
	parseFormats(formatsList: string[]) {
		let isSection = false;
		let section = '';

		let column = 0;

		window.NonBattleGames = { rps: 'Rock Paper Scissors' };
		for (let i = 3; i <= 9; i += 2) {
			window.NonBattleGames[`bestof${i}`] = `Best-of-${i}`;
		}
		window.BattleFormats = {};
		for (let j = 1; j < formatsList.length; j++) {
			const entry = formatsList[j];
			if (isSection) {
				section = entry;
				isSection = false;
			} else if (entry === ',LL') {
				PS.teams.usesLocalLadder = true;
			} else if (entry === '' || (entry.startsWith(',') && !isNaN(Number(entry.slice(1))))) {
				isSection = true;

				if (entry) {
					column = parseInt(entry.slice(1), 10) || 0;
				}
			} else {
				let name = entry;
				let searchShow = true;
				let challengeShow = true;
				let tournamentShow = true;
				let partner = false;
				let bestOfDefault = false;
				let teraPreviewDefault = false;
				let itemClauseDefault = false;
				let team: 'preset' | null = null;
				let teambuilderLevel: number | null = null;
				let lastCommaIndex = name.lastIndexOf(',');
				let code = lastCommaIndex >= 0 ? parseInt(name.substr(lastCommaIndex + 1), 16) : NaN;
				if (!isNaN(code)) {
					name = name.substr(0, lastCommaIndex);
					if (code & 1) team = 'preset';
					if (!(code & 2)) searchShow = false;
					if (!(code & 4)) challengeShow = false;
					if (!(code & 8)) tournamentShow = false;
					if (code & 16) teambuilderLevel = 50;
					if (code & 32) partner = true;
					if (code & 64) bestOfDefault = true;
					if (code & 128) teraPreviewDefault = true;
					if (code & 256) itemClauseDefault = true;
				} else {
					// Backwards compatibility: late 0.9.0 -> 0.10.0
					if (name.substr(name.length - 2) === ',#') { // preset teams
						team = 'preset';
						name = name.substr(0, name.length - 2);
					}
					if (name.substr(name.length - 2) === ',,') { // search-only
						challengeShow = false;
						name = name.substr(0, name.length - 2);
					} else if (name.substr(name.length - 1) === ',') { // challenge-only
						searchShow = false;
						name = name.substr(0, name.length - 1);
					}
				}
				let id = toID(name);
				let isTeambuilderFormat = !team && !name.endsWith('Custom Game');
				let teambuilderFormat = '' as ID;
				let teambuilderFormatName = '';
				if (isTeambuilderFormat) {
					teambuilderFormatName = name;
					if (!id.startsWith('gen')) {
						teambuilderFormatName = '[Gen 6] ' + name;
					}
					let parenPos = teambuilderFormatName.indexOf('(');
					if (parenPos > 0 && name.endsWith(')')) {
						// variation of existing tier
						teambuilderFormatName = teambuilderFormatName.slice(0, parenPos).trim();
					}
					if (teambuilderFormatName !== name) {
						teambuilderFormat = toID(teambuilderFormatName);
						if (BattleFormats[teambuilderFormat]) {
							BattleFormats[teambuilderFormat].isTeambuilderFormat = true;
						} else {
							BattleFormats[teambuilderFormat] = {
								id: teambuilderFormat,
								name: teambuilderFormatName,
								team,
								section,
								column,
								rated: false,
								isTeambuilderFormat: true,
								effectType: 'Format',
							};
						}
						isTeambuilderFormat = false;
					}
				}
				if (BattleFormats[id]?.isTeambuilderFormat) {
					isTeambuilderFormat = true;
				}
				// make sure formats aren't out-of-order
				if (BattleFormats[id]) delete BattleFormats[id];
				BattleFormats[id] = {
					id,
					name,
					team,
					section,
					column,
					searchShow,
					challengeShow,
					tournamentShow,
					bestOfDefault,
					teraPreviewDefault,
					itemClauseDefault,
					rated: searchShow && id.substr(4, 7) !== 'unrated',
					teambuilderLevel,
					partner,
					teambuilderFormat,
					isTeambuilderFormat,
					effectType: 'Format',
				};
			}
		}

		// Match base formats to their variants, if they are unavailable in the server.
		let multivariantFormats: { [id: string]: 1 } = {};
		for (let id in BattleFormats) {
			let teambuilderFormat = BattleFormats[BattleFormats[id].teambuilderFormat!];
			if (!teambuilderFormat || multivariantFormats[teambuilderFormat.id]) continue;
			if (!teambuilderFormat.searchShow && !teambuilderFormat.challengeShow && !teambuilderFormat.tournamentShow) {
				// The base format is not available.
				if (teambuilderFormat.battleFormat) {
					multivariantFormats[teambuilderFormat.id] = 1;
					teambuilderFormat.battleFormat = '';
				} else {
					teambuilderFormat.battleFormat = id;
				}
			}
		}
		PS.teams.update('format');
	}
	handlePM(user1: string, user2: string, message?: string) {
		const userid1 = toID(user1);
		const userid2 = toID(user2);
		const pmTarget = PS.user.userid === userid1 ? user2 : user1;
		const pmTargetid = PS.user.userid === userid1 ? userid2 : userid1;
		let roomid = `dm-${pmTargetid}` as RoomID;
		if (pmTargetid === PS.user.userid) roomid = 'dm-' as RoomID;
		let room = PS.rooms[roomid] as ChatRoom | undefined;
		if (!room) {
			PS.addRoom({
				id: roomid,
				args: { pmTarget },
				autofocus: false,
			});
			room = PS.rooms[roomid] as ChatRoom;
		} else {
			room.updateTarget(pmTarget);
		}
		if (message) room.receiveLine([`c`, user1, message]);
		PS.update();
	}
	/**
	 * Client-to-server query. Handles `/crq` aka `/cmd`.
	 *
	 * Most queries are still handled hardcoded, so this is only for certain
	 * special queries that need a Promise.
	 */
	makeQuery(id: string, param?: string, excludeParamFromListener?: boolean) {
		let fullid = id;
		if (param && !excludeParamFromListener) fullid += ` ${toID(param)}`;
		return new Promise<any>(resolve => {
			if (!this.listeners[fullid]) {
				this.listeners[fullid] = [];
				PS.send(`/cmd ${id} ${param || ''}`);
			}
			this.listeners[fullid]!.push(resolve);
		});
	}
	handleQueryResponse(id: ID, response: any) {
		let fullid: string = id;
		switch (id) {
		case 'userdetails':
			let userid = response.userid;
			fullid += ` ${userid}`;
			let userdetails = this.userdetailsCache[userid];
			if (!userdetails) {
				this.userdetailsCache[userid] = response;
			} else {
				response.status ||= '';
				Object.assign(userdetails, response);
			}
			if (userid === PS.user.userid) {
				if (response.avatar !== undefined && PS.user.avatar !== `${response.avatar}`) {
					PS.user.avatar = `${response.avatar}`;
					PS.user.update(null);
				}
			}
			PS.rooms[`user-${userid}`]?.update(null);
			PS.rooms[`viewuser-${userid}`]?.update(null);
			PS.rooms[`users`]?.update(null);
			break;
		case 'rooms':
			if (response.pspl) {
				for (const roomInfo of response.pspl) roomInfo.spotlight = "Spotlight";
				response.chat = [...response.pspl, ...response.chat];
				response.pspl = null;
			}
			if (response.official) {
				for (const roomInfo of response.official) roomInfo.section = "Official";
				response.chat = [...response.official, ...response.chat];
				response.official = null;
			}
			this.roomsCache = response;
			const roomsRoom = PS.rooms[`rooms`] as RoomsRoom;
			if (roomsRoom) roomsRoom.update(null);
			break;
		case 'roomlist':
			const battlesRoom = PS.rooms[`battles`] as BattlesRoom;
			if (battlesRoom) {
				const battleTable = response.rooms;
				const battles = [];
				for (const battleid in battleTable) {
					battleTable[battleid].id = battleid;
					battles.push(battleTable[battleid]);
				}
				battlesRoom.battles = battles;
				battlesRoom.update(null);
			}
			break;
		case 'laddertop':
			for (const [roomid, ladderRoom] of Object.entries(PS.rooms)) {
				if (roomid.startsWith('ladder-')) {
					(ladderRoom as LadderFormatRoom).update(response);
				}
			}
			break;
		case 'teamupload':
			if (PS.teams.uploading) {
				const team = PS.teams.uploading;
				team.teamid = response.teamid;
				team.uploaded = {
					teamid: response.teamid,
					notLoaded: false,
					private: response.private,
				};
				PS.rooms[`team-${team.key}`]?.update(null);
				PS.rooms.teambuilder?.update(null);
				PS.teams.uploading = null;
			}
			break;
		case 'teamupdate':
			for (const team of PS.teams.list) {
				if (team.teamid === response.teamid) {
					team.uploaded = {
						teamid: response.teamid,
						notLoaded: false,
						private: response.private,
					};
					PS.rooms[`team-${team.key}`]?.update(null);
					PS.rooms.teambuilder?.update(null);
					PS.teams.uploading = null;
					break;
				}
			}
			break;
		}
		for (const callback of this.listeners[fullid] || []) callback(response);
		delete this.listeners[fullid];
	}
}

class NewsPanel extends PSRoomPanel {
	static readonly id = 'news';
	static readonly routes = ['news'];
	static readonly title = 'News';
	static readonly location = 'mini-window';
	change = (ev: Event) => {
		const target = ev.currentTarget as HTMLInputElement;
		this.setClient(target.value as '0' | '1' | 'leave');
	};
	setClient(setting: '0' | '1' | 'leave') {
		if (setting === '1') {
			document.cookie = "preactalpha=1; expires=Thu, 1 Sep 2026 12:00:00 UTC; path=/";
		} else if (setting === '0') {
			document.cookie = "preactalpha=0; expires=Thu, 1 Sep 2026 12:00:00 UTC; path=/";
		} else {
			document.cookie = "preactalpha=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
		}
		if (setting === 'leave') {
			document.location.href = `/`;
		}
	}
	override componentDidMount() {
		if (!document.cookie.includes('preactalpha=')) this.setClient('1');
	}
	override render() {
		const cookieSet = !document.cookie.includes('preactalpha=0');
		return <PSPanelWrapper room={this.props.room} fullSize>
			<div class="construction">
				This is the client rewrite beta test.
				<form>
					<label class="checkbox">
						<input type="radio" name="preactalpha" value="1" onChange={this.change} checked={cookieSet} /> {}
						Use Rewrite always
					</label>
					<label class="checkbox">
						<input type="radio" name="preactalpha" value="0" onChange={this.change} checked={!cookieSet} /> {}
						Use Rewrite with URL
					</label>
					<label class="checkbox">
						<input type="radio" name="preactalpha" value="leave" onChange={this.change} /> {}
						Back to the old client
					</label>
				</form>
				Provide feedback in <a href="development" style="color:black">the Dev chatroom</a>.
			</div>
			<div class="readable-bg" dangerouslySetInnerHTML={{ __html: PS.newsHTML }}></div>
		</PSPanelWrapper>;
	}
}

class MainMenuPanel extends PSRoomPanel<MainMenuRoom> {
	static readonly id = 'mainmenu';
	static readonly routes = [''];
	static readonly Model = MainMenuRoom;
	static readonly icon = <i class="fa fa-home" aria-hidden></i>;
	override componentDidMount() {
		super.componentDidMount();
		this.subscribeTo(PSBackground);
		window.addEventListener('pokemonai-auth-change', this.handleAppUpdate);
	}
	override componentWillUnmount() {
		window.removeEventListener('pokemonai-auth-change', this.handleAppUpdate);
		super.componentWillUnmount();
	}
	handleAppUpdate = () => this.forceUpdate();
	override focus(options?: PSRoomFocusOptions) {
		if (!options?.preventScroll) PSView.scrollToRoom();
		if (PSView.hasTapped) return;

		PSView.politeFocus(this.base?.querySelector<HTMLButtonElement>('.formatselect'));
	}
	submitSearch = (ev: Event, format: string, team?: Team) => {
		if (!PS.user.named) {
			PS.join('login' as RoomID, {
				parentElem: this.base!.querySelector<HTMLElement>('.big.button'),
			});
			return;
		}
		PS.mainmenu.startSearch(format, team, ev.target as HTMLElement);
	};
	handleDragStart = (e: DragEvent) => {
		const room = PS.getRoom(e.currentTarget);
		if (!room) return;
		const foreground = (PS.leftPanel.id === room.id || PS.rightPanel?.id === room.id);
		PS.dragging = { type: 'room', roomid: room.id, foreground };
	};
	handleDragEnter = (e: DragEvent) => {
		// console.log('dragenter ' + e.dataTransfer!.dropEffect);
		e.preventDefault();
		if (PS.dragging?.type !== 'room') return;
		const draggingRoom = PS.dragging.roomid;
		if (draggingRoom === null) return;

		const draggedOverRoom = PS.getRoom(e.target);
		if (draggingRoom === draggedOverRoom?.id) return;

		const index = PS.miniRoomList.indexOf(draggedOverRoom?.id as any);
		if (index >= 0) {
			PS.dragOnto(PS.rooms[draggingRoom]!, 'mini-window', index);
		} else if (PS.rooms[draggingRoom]?.location !== 'mini-window') {
			PS.dragOnto(PS.rooms[draggingRoom]!, 'mini-window', 0);
		}

		// dropEffect !== 'none' prevents bounce-back animation in
		// Chrome/Safari/Opera
		// if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
	};
	renderMiniRoom(room: PSRoom) {
		return <PSPanelErrorBoundary key={room.id} room={room} />;
	}
	handleClickMinimize = (e: MouseEvent) => {
		if ((e.target as Element)?.getAttribute('data-cmd')) {
			return;
		}
		if (((e.target as Element)?.parentNode as Element)?.getAttribute('data-cmd')) {
			return;
		}
		const room = PS.getRoom(e.currentTarget);
		if (room) {
			room.minimized = !room.minimized;
			this.forceUpdate();
		}
	};
	renderMiniRooms() {
		return PS.miniRoomList.map(roomid => {
			const room = PS.rooms[roomid]!;
			const notifying = room.notifications.length ? ' notifying' : room.isSubtleNotifying ? ' subtle-notifying' : '';
			return <div
				class={`mini-window${room.minimized ? ' collapsed' : ''}${room === PS.room ? ' focused' : ''}`}
				key={roomid} data-roomid={roomid}
			>
				<h3
					class={`mini-window-header${notifying}`} draggable onDragStart={this.handleDragStart} onClick={this.handleClickMinimize}
				>
					<button class="closebutton" data-cmd="/close" aria-label="Close" tabIndex={-1}>
						<i class="fa fa-times-circle" aria-hidden></i>
					</button>
					<button class="maximizebutton" data-cmd="/maximize" tabIndex={-1} aria-label="Maximize">
						<i class="fa fa-stop-circle" aria-hidden></i>
					</button>
					<button class="minimizebutton" tabIndex={-1} aria-label="Expand/Collapse">
						<i class="fa fa-minus-circle" aria-hidden></i>
					</button>
					{room.title}
				</h3>
				{this.renderMiniRoom(room)}
			</div>;
		});
	}
	renderGames() {
		if (!PS.mainmenu.search.games) return null;

		// This does not use the word "game" because it includes things like help tickets
		return <div class="menugroup">
			<p class="label">You are in:</p>
			{Object.entries(PS.mainmenu.search.games).map(([roomid, gameName]) => <div>
				<a class="blocklink" href={`${roomid}`}>{gameName}</a>
			</div>)}
		</div>;
	}
	renderSearchButton() {
		if (PS.down) {
			return <div class="menugroup" style="background: rgba(10,10,10,.6)">
				{PS.down === 'ddos' ? (
					<p class="error"><strong>Pok&eacute;mon Showdown is offline due to a DDoS attack!</strong></p>
				) : (
					<p class="error"><strong>Pok&eacute;mon Showdown is offline due to technical difficulties!</strong></p>
				)}
				<p>
					<div style={{ textAlign: 'center' }}>
						<img width="96" height="96" src={`//${Config.routes.client}/sprites/gen5/teddiursa.png`} alt="" />
					</div>
					Bear with us as we freak out.
				</p>
				<p>(We'll be back up in a few hours.)</p>
			</div>;
		}

		if (!PS.user.userid || PS.isOffline) {
			return <TeamForm class="menugroup" onSubmit={this.submitSearch} selectType="search">
				<button class="mainmenu1 mainmenu big button disabled" disabled name="search">
					<em>{PS.isOffline ? [<span class="fa-stack fa-lg">
						<i class="fa fa-plug fa-flip-horizontal fa-stack-1x" aria-hidden></i>
						<i class="fa fa-ban fa-stack-2x text-danger" aria-hidden></i>
					</span>, " Disconnected"] : "Connecting..."}</em>
				</button>
				{PS.isOffline && <p class="buttonbar">
					<button class="button" data-cmd="/reconnect">
						<i class="fa fa-plug" aria-hidden></i> <strong>Reconnect</strong>
					</button> {}
					<ReconnectTimer />
				</p>}
			</TeamForm>;
		}

		return <TeamForm
			class="menugroup" format={PS.mainmenu.searchingFormat() || undefined}
			selectType="search" onSubmit={this.submitSearch}
		>
			<p>
				<button class="button small" data-href="battleoptions" title="Options" aria-label="Options">
					Battle options <i class="fa fa-caret-down"></i>
				</button></p>
			{PS.mainmenu.searchCountdown ? (
				<>
					<button class="mainmenu1 mainmenu big button disabled" disabled><strong>
						<i class="fa fa-refresh fa-spin" aria-hidden></i> Searching in {PS.mainmenu.searchCountdown.countdown}...
					</strong></button>
					<p class="buttonbar"><button class="button" data-cmd="/cancelsearch">Cancel</button></p>
				</>
			) : PS.mainmenu.searchingFormat() ? (
				<>
					<button class="mainmenu1 mainmenu big button disabled" disabled>
						<strong><i class="fa fa-refresh fa-spin" aria-hidden></i> Searching...</strong>
					</button>
					<p class="buttonbar"><button class="button" data-cmd="/cancelsearch">Cancel</button></p>
				</>
			) : (
				<button class="mainmenu1 mainmenu big button" type="submit">
					<strong>Battle!</strong><br />
					<small>Find a random opponent</small>
				</button>
			)}
		</TeamForm>;
	}
	renderBackgroundCredit() {
		const attrib = PSBackground.attrib;
		if (!attrib) return null;
		return (
			<small>
				<a href={attrib.url} target="_blank" class="subtle">"{attrib.title}" <small>background by {attrib.artist}</small></a>
			</small>
		);
	}
	switchMode = (ev: Event) => {
		const button = ev.currentTarget as HTMLButtonElement;
		if (button.value !== 'ai' && button.value !== 'online') return;
		switchPokemonAIMode(button.value, button);
	};
	startOnlineBattle = (ev: Event) => {
		startOfficialRandomBattle(ev.currentTarget as HTMLElement);
	};
	cancelOnlineSearch = () => {
		PS.mainmenu.cancelSearch();
	};
	challengeOnlinePlayer = (ev: Event) => {
		ev.preventDefault();
		const form = ev.currentTarget as HTMLFormElement;
		const input = form.elements.namedItem('opponent') as HTMLInputElement;
		challengeOfficialPlayer(input.value, input);
	};
	openAISetup = (ev: MouseEvent) => {
		ev.preventDefault();
		const target = ev.currentTarget as HTMLElement;
		const view = target.dataset.view === 'library' ? 'library' : 'setup';
		openPokemonAISetup(target.dataset.format, view);
	};
	renderModeSwitcher() {
		return <div class="pokemonai-mode-switch" role="group" aria-label="对战模式">
			<button
				class={PokemonAIApp.isAI() ? 'cur' : ''} value="ai" onClick={this.switchMode}
				aria-pressed={PokemonAIApp.isAI()}
			>
				<i class="fa fa-microchip" aria-hidden></i> AI 训练
			</button>
			<button
				class={PokemonAIApp.isOnline() ? 'cur' : ''} value="online" onClick={this.switchMode}
				aria-pressed={PokemonAIApp.isOnline()}
			>
				<i class="fa fa-globe" aria-hidden></i> 真人竞技
			</button>
		</div>;
	}
	renderConnectionStatus() {
		const connected = !!PS.connection?.connected && !PS.isOffline;
		return <div class={`pokemonai-status ${connected ? 'online' : 'offline'}`}>
			<span class="pokemonai-status-dot" aria-hidden></span>
			{connected ? `${PokemonAIApp.profile.label}服务器已连接` : '服务器连接中断'}
			{!connected && <button class="button" data-cmd="/reconnect">重新连接</button>}
		</div>;
	}
	renderAIHome() {
		const state = pokemonAISetupStore.getState();
		const format = PokemonAIConfig.formats.find(entry => entry.id === state.formatId) || PokemonAIConfig.formats[0];
		const selected = pokemonAISetupStore.selection(format.id);
		return <section class="pokemonai-mode-content" aria-labelledby="pokemonai-ai-title">
			<div class="pokemonai-section-heading">
				<div><h2 id="pokemonai-ai-title">AI 训练</h2></div>
			</div>
			<div class="pokemonai-vgc-card pokemonai-home-resume">
				<div><strong><i class="fa fa-gamepad" aria-hidden></i> {format.label}</strong>
					<small>{selected?.name ? `当前队伍：${selected.name}` : '尚未选择出战队伍'}</small>
				</div>
				<a class="button strong" href="ai-battle" data-format={format.id} onClick={this.openAISetup}>进入对战</a>
			</div>
		</section>;
	}
	renderOfficialAuth() {
		const hasSid = PokemonAIApp.hasOfficialSid();
		const authState = PokemonAIApp.officialAuthState;
		let detail = hasSid ? '设备授权已保存，正在验证官方账号。' : '可使用游客昵称，也可以授权已有账号。';
		if (authState === 'authenticated') detail = `已授权账号：${PS.user.registered?.name || PS.user.name}`;
		if (authState === 'invalid') detail = '设备授权已失效，请重新获取 SID。';
		if (authState === 'network-error') detail = '暂时无法验证授权，请检查网络后重试。';
		return <div class={`pokemonai-account-card auth-${authState}`}>
			<div><strong><i class="fa fa-shield" aria-hidden></i> 官方账号</strong><small>{detail}</small></div>
			<a class="button" href="official-account">{hasSid ? '管理授权' : '授权账号'}</a>
		</div>;
	}
	renderOnlineHome() {
		return <section class="pokemonai-mode-content online-mode" aria-labelledby="pokemonai-online-title">
			<div class="pokemonai-section-heading">
				<div><h2 id="pokemonai-online-title">真人竞技</h2></div>
			</div>
			{this.renderOfficialAuth()}
			<div class="pokemonai-vgc-card pokemonai-home-resume">
				<div><strong><i class="fa fa-globe" aria-hidden></i> 第九世代随机对战</strong><small>快速匹配或挑战指定玩家</small></div>
				<a class="button strong" href="ai-battle">进入对战</a>
			</div>
		</section>;
	}
	renderPokemonAIHome() {
		return <PSPanelWrapper room={this.props.room} onDragEnter={this.handleDragEnter}>
			<div class="pokemonai-home">
				<header class="pokemonai-hero">
					<div class="pokemonai-brand"><span class="brand-mark"><i class="fa fa-circle" aria-hidden></i></span>
						<div><h1>Pokémon<span>AI</span></h1><p>对战训练终端</p></div>
					</div>
					{this.renderModeSwitcher()}
				</header>
				{this.renderConnectionStatus()}
				{this.renderGames()}
				{PokemonAIApp.isAI() ? this.renderAIHome() : this.renderOnlineHome()}
				<footer class="pokemonai-footer">
					<span>开源个人对战训练项目</span>
					<a href={PokemonAIConfig.sourceUrl} target="_blank">源码与许可证</a>
				</footer>
			</div>
		</PSPanelWrapper>;
	}
	override render() {
		if (Config.pokemonaiApp) return this.renderPokemonAIHome();
		const onlineButton = ' button' + (PS.isOffline ? ' disabled' : '');
		const tinyLayout = this.props.room.width < 620 ? ' tiny-layout' : '';
		return <PSPanelWrapper room={this.props.room} onDragEnter={this.handleDragEnter}>
			<div class={`mainmenu-mini-windows${tinyLayout}`}>
				{!PS.leftPanelWidth && Config.includes?.mainmenuHTML && (
					<div dangerouslySetInnerHTML={{ __html: Config.includes.mainmenuHTML }} />
				)}
				{this.renderMiniRooms()}
			</div>
			<div class={`mainmenu${tinyLayout}`}>
				<div class="mainmenu-left">
					{this.renderGames()}

					{Config.pokemonai && <div class="menugroup pokemonai-main-actions">
						<p><a class={"mainmenu1 mainmenu big button" + (PS.isOffline ? ' disabled' : '')} href="ai-battle">
							<strong>PokémonAI 对战</strong><br />
							<small>{PokemonAIConfig.formats.map(format => format.label).join('、')}</small>
						</a></p>
						<p class="buttonbar"><a
							class="button" href="ai-battle" data-view="library" onClick={this.openAISetup}
						>
							<i class="fa fa-th-large" aria-hidden></i> 阵容库
						</a></p>
					</div>}

					{this.renderSearchButton()}

					<div class="menugroup">
						<p><a class="mainmenu2 mainmenu button" href="teambuilder">Teambuilder</a></p>
						<p><a class={"mainmenu3 mainmenu" + onlineButton} href="ladder">Ladder</a></p>
						<p><a class={"mainmenu4 mainmenu" + onlineButton} href="view-tournaments-all">Tournaments</a></p>
					</div>

					<div class="menugroup">
						<p><a class={"mainmenu4 mainmenu" + onlineButton} href="battles">Watch a battle</a></p>
						<p><a class={"mainmenu5 mainmenu" + onlineButton} href="users">Find a user</a></p>
						<p><a class={"mainmenu6 mainmenu" + onlineButton} href="view-friends-all">Friends</a></p>
						<p><a class={"mainmenu7 mainmenu" + onlineButton} href="resources">Info & Resources</a></p>
					</div>
				</div>
				<div class="mainmenu-right" style={{ display: PS.leftPanelWidth ? 'none' : 'block' }}>
					<div class="menugroup">
						<p><a class={"mainmenu1 mainmenu" + onlineButton} href="rooms">Chat rooms</a></p>
						{PS.server.id !== 'showdown' && (
							<p><a class={"mainmenu2 mainmenu" + onlineButton} href="lobby">Lobby chat</a></p>
						)}
					</div>
				</div>
				<div class="mainmenu-footer">
					<div class="bgcredit">{this.renderBackgroundCredit()}</div>
					<small>
						<a href={`//${Config.routes.dex}/`} target="_blank">Pok&eacute;dex</a> | {}
						<a href={`//${Config.routes.replays}/`} target="_blank">Replays</a> | {}
						<a href="//smogon.com/forums/" target="_blank">Forum</a> | {}
						<a href={`//${Config.routes.root}/rules`} target="_blank">Rules</a> | {}
						<a href={`//${Config.routes.root}/credits`} target="_blank">Credits</a> | {}
						<a href={`//${Config.routes.root}/privacy`} target="_blank">Privacy</a> | {}
						<a href={PokemonAIConfig.sourceUrl} target="_blank">PokemonAI 源码</a>
					</small>
					<CCPAIntercept />
				</div>
			</div>
		</PSPanelWrapper>;
	}
}

type PokemonAITeamSummary = {
	id: string, name: string, format_id: string, source_label: string, source_repository?: string,
	tags: string[], archetype: string, paste: string, roster: { species_name?: string, species: string }[],
	validation_status: string, packed: string,
};

type PokemonAITeamInspection = PokemonAITeamSelection & {
	sourceLabel: string,
	validationStatus: string,
};

type PokemonAIAICapability = {
	teamCount: number,
	popularTeamCount: number,
	modes: Record<PokemonAITeamMode, boolean>,
};

type PokemonAIAICapabilities = {
	publishedAt: string | null,
	formats: Record<string, PokemonAIAICapability>,
};

type PokemonAIPoolTeam = {
	id: string,
	formatId: string,
	name: string,
	roster: string[],
	sourceKind: 'observed' | 'inferred' | 'builtin',
	battles: number | null,
};

type PokemonAIPoolTeamDetail = PokemonAIPoolTeam & {
	packedTeam: string,
};

const pokemonAITeamModeOptions: readonly { value: PokemonAITeamMode, label: string, icon: string }[] = [
	{ value: 'mirror', label: '和我相同', icon: 'fa-clone' },
	{ value: 'counter', label: '克制我的队伍', icon: 'fa-crosshairs' },
	{ value: 'popular-random', label: '随机热门队伍', icon: 'fa-fire' },
	{ value: 'generated-random', label: '纯随机', icon: 'fa-random' },
	{ value: 'fixed', label: '固定队伍', icon: 'fa-thumb-tack' },
];

function pokemonAITeamModeLabel(mode: PokemonAITeamMode) {
	return pokemonAITeamModeOptions.find(option => option.value === mode)?.label || '随机热门队伍';
}

function pokemonAIValidationLabel(status: string) {
	if (pokemonAITeamIsUsable(status)) return '可用';
	return status.startsWith('invalid') ? '不可用' : '待检查';
}

function pokemonAITeamIsUsable(status: string) {
	return status === 'valid' || status === 'prevalidated';
}

function pokemonAIRosterFromPacked(packedTeam: string) {
	if (!packedTeam) return [];
	try {
		return Teams.unpackSpeciesOnly(packedTeam).map(species => Dex.species.get(species).name || species);
	} catch {
		return [];
	}
}

/* eslint-disable no-restricted-syntax, no-restricted-globals, @stylistic/max-len, @stylistic/indent, @typescript-eslint/no-misused-promises */
class AISetupPanel extends PSRoomPanel {
	static readonly id = 'aibattle';
	static readonly routes = ['ai-battle'];
	static readonly title = 'PokémonAI 对战准备';
	static readonly location = 'left';

	catalogTeams: PokemonAITeamSummary[] | null = null;
	catalogError = '';
	inspectedTeam: PokemonAITeamInspection | null = null;
	activeLocalTeamIds: Record<string, string> = {};
	aiCapabilities: PokemonAIAICapabilities | null = null;
	aiCapabilitiesError = '';
	selectingAITeam = false;
	aiPoolTeams: PokemonAIPoolTeam[] | null = null;
	aiPoolError = '';
	aiPoolQuery = '';
	aiPoolDraftQuery = '';
	aiPoolPage = 1;
	aiPoolTotal = 0;
	aiPoolRequest = 0;
	aiPoolDetail: PokemonAIPoolTeamDetail | null = null;
	aiPoolDetailLoading = false;
	unsubscribeSetup: (() => void) | null = null;
	unsubscribeLocal: (() => void) | null = null;
	unsubscribeNavigation: (() => void) | null = null;
	teamPickerView: 'local' | 'catalog' = 'local';
	catalogReady = () => this.forceUpdate();
	returnTargetReady = (event: Event) => {
		const target = (event as CustomEvent<PokemonAIReturnTarget>).detail;
		if (target.roomid !== 'ai-battle' || target.args?.openTeamPicker !== true) return;
		this.teamPickerView = target.args.teamPickerView === 'catalog' ? 'catalog' : 'local';
		openPokemonAILayer('team-picker', 'ai-battle' as RoomID, { view: this.teamPickerView });
	};

	override componentDidMount() {
		super.componentDidMount();
		this.subscribeTo(PS.teams);
		this.unsubscribeSetup = subscribePokemonAISetup(() => this.forceUpdate());
		this.unsubscribeLocal = pokemonAILocalTeamStore.subscribe(() => this.forceUpdate());
		this.unsubscribeNavigation = subscribePokemonAINavigation(() => {
			if (getPokemonAITopLayer('ai-battle' as RoomID)?.kind !== 'team-detail') this.inspectedTeam = null;
			this.forceUpdate();
		});
		window.addEventListener('pokemonai-catalog-ready', this.catalogReady);
		window.addEventListener('pokemonai-return-target', this.returnTargetReady);
		void this.loadAICapabilities();
	}
	override componentWillUnmount() {
		this.unsubscribeSetup?.();
		this.unsubscribeLocal?.();
		this.unsubscribeNavigation?.();
		window.removeEventListener('pokemonai-catalog-ready', this.catalogReady);
		window.removeEventListener('pokemonai-return-target', this.returnTargetReady);
		super.componentWillUnmount();
	}
	loadCatalog() {
		const endpoints = [PokemonAIConfig.teamLibraryUrl, '/api/meta/teams'].map(
			url => new URL(url, document.location.origin).href
		);
		const requests = endpoints.map(endpoint => Net(endpoint).get().then(text => {
			const data = JSON.parse(text) as { teams?: PokemonAITeamSummary[] };
			return { teams: Array.isArray(data?.teams) ? data.teams : [], error: '' };
		}, error => ({ teams: [] as PokemonAITeamSummary[], error: String(error?.message || error) })));
		Promise.all(requests).then(results => {
			const teams: Record<string, PokemonAITeamSummary> = {};
			for (const result of results) {
				for (const team of result.teams) teams[team.id] = team;
			}
			this.catalogTeams = Object.values(teams);
			this.catalogError = this.catalogTeams.length ? '' : results.map(result => result.error).filter(Boolean).join('；');
			this.forceUpdate();
		});
	}
	selectFormat = (ev: MouseEvent) => {
		this.inspectedTeam = null;
		this.selectingAITeam = false;
		selectPokemonAISetupFormat((ev.currentTarget as HTMLButtonElement).value);
		this.forceUpdate();
	};
	async loadAICapabilities() {
		try {
			const response = await fetch('/api/ai/capabilities', { cache: 'no-store' });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			this.aiCapabilities = await response.json() as PokemonAIAICapabilities;
			this.aiCapabilitiesError = '';
		} catch (error) {
			this.aiCapabilitiesError = error instanceof Error ? error.message : String(error);
		} finally {
			this.forceUpdate();
		}
	}
	selectAITeamMode = (ev: MouseEvent) => {
		const mode = (ev.currentTarget as HTMLButtonElement).value as PokemonAITeamMode;
		const state = pokemonAISetupStore.getState();
		selectPokemonAIAITeamSettings(state.formatId, { ...pokemonAISetupStore.getAITeamSettings(state.formatId), mode });
	};
	openAITeamPool = () => {
		this.selectingAITeam = true;
		this.aiPoolPage = 1;
		this.aiPoolQuery = '';
		this.aiPoolDraftQuery = '';
		this.aiPoolDetail = null;
		void this.loadAITeamPool();
		this.forceUpdate();
	};
	closeAITeamPool = () => {
		this.selectingAITeam = false;
		this.aiPoolRequest++;
		this.aiPoolDetail = null;
		this.forceUpdate();
	};
	async loadAITeamPool() {
		const request = ++this.aiPoolRequest;
		const formatId = pokemonAISetupStore.getState().formatId;
		this.aiPoolTeams = null;
		this.aiPoolDetail = null;
		this.aiPoolError = '';
		this.forceUpdate();
		const params = new URLSearchParams({
			format_id: formatId,
			query: this.aiPoolQuery,
			cursor: String((this.aiPoolPage - 1) * 20),
			limit: '20',
		});
		try {
			const response = await fetch(`/api/ai/team-pool?${params}`, { cache: 'no-store' });
			const result = await response.json() as { teams?: PokemonAIPoolTeam[], total?: number, error?: string };
			if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
			if (request !== this.aiPoolRequest) return;
			this.aiPoolTeams = result.teams || [];
			this.aiPoolTotal = Number(result.total || 0);
		} catch (error) {
			if (request !== this.aiPoolRequest) return;
			this.aiPoolTeams = [];
			this.aiPoolError = error instanceof Error ? error.message : String(error);
		} finally {
			if (request === this.aiPoolRequest) this.forceUpdate();
		}
	}
	updateAIPoolQuery = (ev: Event) => {
		this.aiPoolDraftQuery = (ev.currentTarget as HTMLInputElement).value;
	};
	searchAITeamPool = (ev: Event) => {
		ev.preventDefault();
		this.aiPoolQuery = this.aiPoolDraftQuery.trim();
		this.aiPoolPage = 1;
		void this.loadAITeamPool();
	};
	moveAITeamPoolPage = (ev: MouseEvent) => {
		const direction = Number((ev.currentTarget as HTMLButtonElement).value);
		const pages = Math.max(1, Math.ceil(this.aiPoolTotal / 20));
		this.aiPoolPage = Math.max(1, Math.min(pages, this.aiPoolPage + direction));
		void this.loadAITeamPool();
	};
	inspectAITeam = async (ev: MouseEvent) => {
		const id = (ev.currentTarget as HTMLButtonElement).value;
		this.aiPoolDetailLoading = true;
		this.forceUpdate();
		try {
			const response = await fetch(`/api/ai/team-pool/${encodeURIComponent(id)}`, { cache: 'no-store' });
			const result = await response.json() as PokemonAIPoolTeamDetail & { error?: string };
			if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
			this.aiPoolDetail = result;
			this.aiPoolError = '';
		} catch (error) {
			this.aiPoolError = error instanceof Error ? error.message : String(error);
		} finally {
			this.aiPoolDetailLoading = false;
			this.forceUpdate();
		}
	};
	closeAITeamDetail = () => {
		this.aiPoolDetail = null;
		this.forceUpdate();
	};
	selectFixedAITeam = (ev: MouseEvent) => {
		const id = (ev.currentTarget as HTMLButtonElement).value;
		const team = this.aiPoolTeams?.find(entry => entry.id === id) || (this.aiPoolDetail?.id === id ? this.aiPoolDetail : null);
		if (!team) return;
		const formatId = pokemonAISetupStore.getState().formatId;
		selectPokemonAIAITeamSettings(formatId, { mode: 'fixed', fixedTeamId: team.id, fixedTeamName: team.name });
		this.closeAITeamPool();
	};
	openTeamPicker = (view: 'local' | 'catalog') => {
		this.teamPickerView = view;
		if (view === 'catalog' && !this.catalogTeams && !this.catalogError) this.loadCatalog();
		openPokemonAILayer('team-picker', 'ai-battle' as RoomID, { view });
		this.forceUpdate();
	};
	openLocalTeams = () => {
		this.openTeamPicker('local');
	};
	openCatalogTeams = () => {
		this.openTeamPicker('catalog');
	};
	closeTeamPicker = () => closePokemonAILayer('ai-battle' as RoomID);
	showLocalPicker = () => { this.teamPickerView = 'local'; this.inspectedTeam = null; this.forceUpdate(); };
	showCatalogPicker = () => {
		this.teamPickerView = 'catalog';
		this.inspectedTeam = null;
		if (!this.catalogTeams && !this.catalogError) this.loadCatalog();
		this.forceUpdate();
	};
	manageAllTeams = () => { void navigatePokemonAI('teams', { args: { view: this.teamPickerView } }); };
	showTeamSource = (ev: MouseEvent) => {
		this.inspectedTeam = null;
		pokemonAISetupStore.setView((ev.currentTarget as HTMLButtonElement).value === 'catalog' ? 'library' : 'setup');
		this.forceUpdate();
	};
	setupLocalTeams(formatId: string) {
		const format = PokemonAIConfig.formats.find(entry => entry.id === formatId) || PokemonAIConfig.formats[0];
		const localFormat = PS.teams.teambuilderFormat(format.showdownFormat);
		return pokemonAILocalTeamStore.list().filter(team => (
			team.kind === 'team' && team.validation.status !== 'invalid' &&
			PS.teams.teambuilderFormat(team.formatId) === localFormat && pokemonAIRosterFromPacked(team.packedTeam).length === 6
		));
	}

	activeSetupLocalTeam(formatId: string, teams: PokemonAILocalTeamRecord[], selected: PokemonAITeamSelection | null) {
		let activeId = this.activeLocalTeamIds[formatId];
		if (!teams.some(team => team.id === activeId)) {
			activeId = teams.find(team => team.id === selected?.localTeamId)?.id || teams[0]?.id || '';
			this.activeLocalTeamIds[formatId] = activeId;
		}
		return teams.find(team => team.id === activeId) || null;
	}

	setupCarouselItems(
		formatId: string, teams: PokemonAILocalTeamRecord[], selected: PokemonAITeamSelection | null
	): PokemonAILocalTeamCarouselItem[] {
		const format = PokemonAIConfig.formats.find(entry => entry.id === formatId) || PokemonAIConfig.formats[0];
		return teams.map(team => ({
			id: team.id,
			name: team.name,
			formatLabel: format.label,
			notes: team.notes,
			validationStatus: team.validation.status,
			validationLabel: team.validation.status === 'valid' ? '可出战' : '待检查',
			roster: pokemonAIRosterFromPacked(team.packedTeam).map(species => ({ species: toID(species), displayName: species })),
			isBattleTeam: selected?.localTeamId === team.id,
		}));
	}

	browseLocalTeam = (id: string) => {
		const formatId = pokemonAISetupStore.getState().formatId;
		this.activeLocalTeamIds[formatId] = id;
		this.inspectedTeam = null;
		this.forceUpdate();
	};

	localInspection(record: PokemonAILocalTeamRecord, formatId: string): PokemonAITeamInspection {
		return {
			formatId, source: 'showdown', key: record.id, localTeamId: record.id,
			name: record.name, packedTeam: record.packedTeam,
			sourceLabel: '本地队伍', validationStatus: record.validation.status,
		};
	}
	localizeCatalogTeam(source: PokemonAITeamSelection) {
		if (!source.packedTeam) return null;
		const format = PokemonAIConfig.formats.find(entry => entry.id === source.formatId);
		if (!format) return null;
		const localFormat = PS.teams.teambuilderFormat(format.showdownFormat);
		const existing = pokemonAILocalTeamStore.list().find(record => (
			record.formatId === localFormat && record.packedTeam === source.packedTeam && record.kind === 'team'
		));
		if (existing) return existing;
		const record = pokemonAILocalTeamStore.create({
			name: source.name, formatId: localFormat, notes: '', packedTeam: source.packedTeam,
		});
		return pokemonAILocalTeamStore.update(record.id, {
			validation: { status: 'valid', checkedAt: new Date().toISOString(), errors: [] },
		}) || record;
	}
	selectCatalogTeam = (ev: MouseEvent) => {
		const team = this.catalogTeams?.find(entry => entry.id === (ev.currentTarget as HTMLButtonElement).value);
		if (!team?.packed || !pokemonAITeamIsUsable(team.validation_status)) return;
		const source: PokemonAITeamSelection = {
			formatId: team.format_id,
			source: 'catalog', key: team.id, name: team.name, packedTeam: team.packed,
		};
		const local = this.localizeCatalogTeam(source);
		if (!local) return;
		selectPokemonAILocalTeam(team.format_id, local.id);
		this.activeLocalTeamIds[team.format_id] = local.id;
		if (getPokemonAITopLayer('ai-battle' as RoomID)?.kind === 'team-picker') this.closeTeamPicker();
		this.forceUpdate();
	};
	selectPickerLocal = (ev: MouseEvent) => {
		const record = pokemonAILocalTeamStore.get((ev.currentTarget as HTMLButtonElement).value);
		const formatId = pokemonAISetupStore.getState().formatId;
		if (!record || record.validation.status === 'invalid') return;
		selectPokemonAILocalTeam(formatId, record.id);
		this.activeLocalTeamIds[formatId] = record.id;
		this.closeTeamPicker();
	};
	showTeamDetails(team: PokemonAITeamInspection) {
		this.inspectedTeam = team;
		if (getPokemonAITopLayer('ai-battle' as RoomID)?.kind === 'team-picker') {
			openPokemonAILayer('team-detail', 'ai-battle' as RoomID, { teamId: team.key });
		}
		this.forceUpdate();
		if (this.props.room.width < 900) {
			setTimeout(() => this.base?.querySelector('.pokemonai-team-summary')?.scrollIntoView({ block: 'start' }), 0);
		}
	}
	inspectCatalogTeam = (ev: MouseEvent) => {
		const team = this.catalogTeams?.find(entry => entry.id === (ev.currentTarget as HTMLButtonElement).value);
		if (!team?.packed || !pokemonAITeamIsUsable(team.validation_status)) return;
		this.showTeamDetails({
			formatId: team.format_id,
			source: 'catalog', key: team.id, name: team.name, packedTeam: team.packed,
			sourceLabel: team.source_label, validationStatus: team.validation_status,
		});
	};
	inspectActiveTeam = () => {
		const state = pokemonAISetupStore.getState();
		const selected = pokemonAISetupStore.selection(state.formatId);
		const record = this.activeSetupLocalTeam(state.formatId, this.setupLocalTeams(state.formatId), selected);
		if (record) this.showTeamDetails(this.localInspection(record, state.formatId));
	};
	closeTeamDetails = () => {
		const inspectedKey = this.inspectedTeam?.key;
		this.inspectedTeam = null;
		if (getPokemonAITopLayer('ai-battle' as RoomID)?.kind === 'team-detail') closePokemonAILayer('ai-battle' as RoomID);
		this.forceUpdate();
		if (inspectedKey) setTimeout(() => this.base?.querySelector<HTMLElement>(
			`[data-carousel-id="${CSS.escape(inspectedKey)}"] .pokemonai-carousel-card-button`
		)?.focus(), 0);
	};
	selectInspectedTeam = () => {
		if (!this.inspectedTeam) return;
		if (this.inspectedTeam.localTeamId) {
			selectPokemonAILocalTeam(this.inspectedTeam.formatId, this.inspectedTeam.localTeamId);
		} else if (this.inspectedTeam.packedTeam) {
			const local = this.localizeCatalogTeam({
				formatId: this.inspectedTeam.formatId, source: 'catalog', key: this.inspectedTeam.key,
				name: this.inspectedTeam.name, packedTeam: this.inspectedTeam.packedTeam,
			});
			if (local) selectPokemonAILocalTeam(this.inspectedTeam.formatId, local.id);
		}
		if (getPokemonAITopLayer('ai-battle' as RoomID)?.kind === 'team-detail') history.go(-2);
		this.forceUpdate();
	};
	selectActiveTeam = () => {
		const state = pokemonAISetupStore.getState();
		const selected = pokemonAISetupStore.selection(state.formatId);
		const record = this.activeSetupLocalTeam(state.formatId, this.setupLocalTeams(state.formatId), selected);
		if (!record) return;
		selectPokemonAILocalTeam(state.formatId, record.id);
		this.forceUpdate();
	};
	editActiveTeam = () => {
		const state = pokemonAISetupStore.getState();
		const selected = pokemonAISetupStore.selection(state.formatId);
		const record = this.activeSetupLocalTeam(state.formatId, this.setupLocalTeams(state.formatId), selected);
		if (!record) return;
		this.openTeamPicker('local');
		setTimeout(() => openPokemonAILocalTeamEditor(record.id, this.teamEditorReturnTarget('local')), 0);
	};
	teamEditorReturnTarget(view: 'local' | 'catalog'): PokemonAIReturnTarget {
		return {
			roomid: 'ai-battle' as RoomID,
			args: { openTeamPicker: true, teamPickerView: view, formatId: pokemonAISetupStore.getState().formatId },
			historyBack: true,
		};
	}
	openTeamEditor(team: Team) {
		const roomid = `team-${team.key}` as RoomID;
		if (PS.rooms[roomid]) PS.rooms[roomid].args = { ...PS.rooms[roomid].args, pokemonAIReturn: true };
		PS.join(roomid, { args: { pokemonAIReturn: true } });
	}
	editLocalTeam = (ev: MouseEvent) => {
		const key = (ev.currentTarget as HTMLButtonElement).value;
		if (pokemonAILocalTeamStore.get(key)) openPokemonAILocalTeamEditor(key, this.teamEditorReturnTarget('local'));
	};
	copyCatalogTeamToEditor(source: PokemonAITeamSelection) {
		const record = this.localizeCatalogTeam(source);
		if (!record) return;
		openPokemonAILocalTeamEditor(record.id, this.teamEditorReturnTarget('catalog'));
	}
	editCatalogTeam = (ev: MouseEvent) => {
		const source = this.catalogTeams?.find(entry => entry.id === (ev.currentTarget as HTMLButtonElement).value);
		if (!source?.packed) return;
		this.copyCatalogTeamToEditor({
			formatId: source.format_id, source: 'catalog', key: source.id,
			name: source.name, packedTeam: source.packed,
		});
	};
	editInspectedTeam = () => {
		const inspected = this.inspectedTeam;
		if (!inspected) return;
		if (inspected.source === 'showdown' && inspected.localTeamId) {
			const open = () => openPokemonAILocalTeamEditor(
				inspected.localTeamId!, this.teamEditorReturnTarget(this.teamPickerView)
			);
			if (getPokemonAITopLayer('ai-battle' as RoomID)?.kind === 'team-detail') {
				closePokemonAILayer('ai-battle' as RoomID);
				setTimeout(open, 0);
			} else {
				open();
			}
			return;
		}
		if (getPokemonAITopLayer('ai-battle' as RoomID)?.kind === 'team-detail') {
			closePokemonAILayer('ai-battle' as RoomID);
			setTimeout(() => this.copyCatalogTeamToEditor(inspected), 0);
		} else {
			this.copyCatalogTeamToEditor(inspected);
		}
	};
	startBattle = (ev: MouseEvent) => {
		const state = pokemonAISetupStore.getState();
		const opponent = PokemonAIConfig.opponents.find(entry => entry.formatId === state.formatId);
		const selection = pokemonAISetupStore.selection(state.formatId);
		if (!opponent) return;
		challengePokemonAI(opponent, selection || undefined, ev.currentTarget as HTMLElement);
	};
	startOnlineBattle = (ev: MouseEvent) => {
		startOfficialRandomBattle(ev.currentTarget as HTMLElement);
	};
	cancelOnlineSearch = () => PS.mainmenu.cancelSearch();
	challengeOnlinePlayer = (ev: Event) => {
		ev.preventDefault();
		const form = ev.currentTarget as HTMLFormElement;
		const input = form.elements.namedItem('opponent') as HTMLInputElement;
		challengeOfficialPlayer(input.value, input);
	};
	renderOnlineSetup() {
		const searching = !!PS.mainmenu.searchingFormat();
		const hasSid = PokemonAIApp.hasOfficialSid();
		const authState = PokemonAIApp.officialAuthState;
		let accountDetail = hasSid ? '设备授权已保存，正在验证官方账号。' : '可使用游客昵称，也可以授权已有账号。';
		if (authState === 'authenticated') accountDetail = `已授权账号：${PS.user.registered?.name || PS.user.name}`;
		if (authState === 'invalid') accountDetail = '设备授权已失效，请重新授权。';
		if (authState === 'network-error') accountDetail = '暂时无法验证授权，请检查网络后重试。';
		return <PSPanelWrapper room={this.props.room}><main class="pokemonai-workspace pokemonai-online-setup">
			<header class="pokemonai-page-header">
				<div><h2>真人对战</h2><p>第九世代随机对战</p></div>
				<a class="button" href="official-account"><i class="fa fa-user-circle" aria-hidden></i> 账号授权</a>
			</header>
			<div class={`pokemonai-account-card auth-${authState}`}>
				<div><strong><i class="fa fa-shield" aria-hidden></i> 官方账号</strong><small>{accountDetail}</small></div>
				<a class="button" href="official-account">{hasSid ? '管理授权' : '授权账号'}</a>
			</div>
			<div class="pokemonai-online-grid">
				<section class="pokemonai-action-card primary">
					<span class="card-icon"><i class="fa fa-bolt" aria-hidden></i></span>
					<h3>快速匹配</h3>
					<p>在 Pokémon Showdown 官方天梯寻找真人对手。</p>
					{searching ? <button class="button danger" onClick={this.cancelOnlineSearch}>
						<i class="fa fa-refresh fa-spin" aria-hidden></i> 取消匹配
					</button> : <button class="button strong" onClick={this.startOnlineBattle} disabled={PS.isOffline}>开始匹配</button>}
				</section>
				<form class="pokemonai-action-card" onSubmit={this.challengeOnlinePlayer}>
					<span class="card-icon"><i class="fa fa-crosshairs" aria-hidden></i></span>
					<h3>挑战指定玩家</h3>
					<p>输入对方的 Showdown 昵称并发送挑战。</p>
					<input class="textbox" name="opponent" placeholder="对手昵称" autocomplete="off" />
					<button class="button strong" type="submit" disabled={PS.isOffline}>发送挑战</button>
				</form>
			</div>
		</main></PSPanelWrapper>;
	}
	renderRoster(roster: string[]) {
		return <div class="pokemonai-roster">{roster.slice(0, 6).map((species, index) => <span key={`${species}-${index}`}>
			{species}
		</span>)}</div>;
	}
	renderTeamDetails(team: PokemonAITeamInspection, selected: PokemonAITeamSelection | null) {
		let sets: Teams.PokemonSet[] = [];
		try {
			sets = Teams.unpack(team.packedTeam);
		} catch {}
		const isSelected = !!team.localTeamId && selected?.localTeamId === team.localTeamId;
		const statLabels = { hp: 'HP', atk: '攻击', def: '防御', spa: '特攻', spd: '特防', spe: '速度' } as const;
		return <>
			<div class="pokemonai-detail-heading">
				<button class="button icon" onClick={this.closeTeamDetails} title="返回" aria-label="返回出战队伍">
					<i class="fa fa-arrow-left" aria-hidden></i>
				</button>
				<div><h3>阵容详情</h3><p>{team.name}</p></div>
			</div>
			<p class="pokemonai-detail-source">{team.sourceLabel} · {pokemonAIValidationLabel(team.validationStatus)}</p>
			<div class="pokemonai-set-list">{sets.map((set, index) => {
				const species = Dex.species.get(set.species).name || set.species;
				const stats = Object.entries(set.evs || {}).filter((entry): entry is [keyof typeof statLabels, number] => (
					entry[0] in statLabels && typeof entry[1] === 'number' && entry[1] > 0
				)).map(([stat, value]) => `${statLabels[stat]} ${value}`).join(' / ');
				return <section class="pokemonai-set-detail" key={`${species}-${index}`}>
					<header><strong>{species}</strong>{set.item && <span>{set.item}</span>}</header>
					{(set.ability || set.nature || set.teraType) && <p>{[
						set.ability, set.nature && `${set.nature}性格`, set.teraType && `太晶 ${set.teraType}`,
					].filter(Boolean).join(' · ')}</p>}
					{stats && <p>{stats}</p>}
					<ul>{set.moves.map(move => <li key={move}>{Dex.moves.get(move).name || move}</li>)}</ul>
				</section>;
			})}</div>
			{!sets.length && <p class="pokemonai-summary-empty">无法读取这支队伍的详细配置。</p>}
			<div class="pokemonai-detail-actions">
				{!isSelected && <button class="button strong" onClick={this.selectInspectedTeam}>
					<i class="fa fa-check" aria-hidden></i> 设为出战队伍
				</button>}
				<button class="button" onClick={this.editInspectedTeam}>
					<i class="fa fa-pencil" aria-hidden></i> {team.source === 'catalog' ? '复制并编辑' : '编辑'}
				</button>
			</div>
		</>;
	}
	renderLocalTeams(formatId: string, selected: PokemonAITeamSelection | null) {
		const teams = this.setupLocalTeams(formatId);
		if (!teams.length) return <div class="pokemonai-empty-state">
			<p>这个规则下还没有本地队伍。</p>
			<button class="button strong" onClick={this.openLocalTeams}><i class="fa fa-plus" aria-hidden></i> 新建本地队伍</button>
		</div>;
		const active = this.activeSetupLocalTeam(formatId, teams, selected);
		return <PokemonAILocalTeamCarousel
			items={this.setupCarouselItems(formatId, teams, selected)} activeId={active?.id || null}
			label="当前规则的本地队伍" onActiveChange={this.browseLocalTeam}
		/>;
	}
	renderAITeamSettings(formatId: string) {
		const settings = pokemonAISetupStore.getAITeamSettings(formatId);
		const capability = this.aiCapabilities?.formats[formatId];
		return <section class="pokemonai-ai-team-settings" aria-labelledby="pokemonai-ai-team-heading">
			<div class="pokemonai-section-bar"><h3 id="pokemonai-ai-team-heading">AI 队伍</h3></div>
			<div class="pokemonai-ai-mode-grid" role="radiogroup" aria-label="选择 AI 队伍方式">
				{pokemonAITeamModeOptions.map(option => {
					const selected = settings.mode === option.value;
					const disabled = capability?.modes[option.value] === false;
					return <button
						class={selected ? 'cur' : ''} value={option.value} onClick={this.selectAITeamMode}
						role="radio" aria-checked={selected} disabled={disabled} key={option.value}
					>
						<i class={`fa ${option.icon}`} aria-hidden></i><span>{option.label}</span>
					</button>;
				})}
			</div>
			{settings.mode === 'fixed' && <div class="pokemonai-fixed-team-row">
				<span>{settings.fixedTeamName || '尚未选择 AI 队伍'}</span>
				<button class="button" onClick={this.openAITeamPool} disabled={capability?.modes.fixed === false}>
					<i class="fa fa-list" aria-hidden></i> 选择队伍
				</button>
			</div>}
			{this.aiCapabilitiesError && <p class="message-error">AI 队伍暂时无法读取。</p>}
		</section>;
	}
	renderAITeamPoolDetail(team: PokemonAIPoolTeamDetail, format: (typeof PokemonAIConfig.formats)[number]) {
		let sets: Teams.PokemonSet[] = [];
		try {
			sets = Teams.unpack(team.packedTeam);
		} catch {}
		const statLabels = { hp: 'HP', atk: '攻击', def: '防御', spa: '特攻', spd: '特防', spe: '速度' } as const;
		return <section class="pokemonai-ai-pool-detail" aria-labelledby="pokemonai-ai-pool-detail-heading">
			<div class="pokemonai-detail-heading">
				<button class="button icon" onClick={this.closeAITeamDetail} title="返回" aria-label="返回 AI 队伍列表">
					<i class="fa fa-arrow-left" aria-hidden></i>
				</button>
				<div><h3 id="pokemonai-ai-pool-detail-heading">{team.name}</h3><p>{format.label}</p></div>
			</div>
			<div class="pokemonai-ai-set-grid">{sets.map((set, index) => {
				const species = Dex.species.get(set.species).name || set.species;
				const stats = Object.entries(set.evs || {}).filter((entry): entry is [keyof typeof statLabels, number] => (
					entry[0] in statLabels && typeof entry[1] === 'number' && entry[1] > 0
				)).map(([stat, value]) => `${statLabels[stat]} ${value}`).join(' / ');
				return <article class="pokemonai-ai-set" key={`${species}-${index}`}>
					<header>
						<span class="picon" style={Dex.getPokemonIcon(toID(species))} aria-hidden></span>
						<div><strong>{species}</strong><small>{set.item || '无道具'}</small></div>
					</header>
					<p>{[set.ability, set.nature && `${set.nature}性格`, set.teraType && `太晶 ${set.teraType}`].filter(Boolean).join(' · ')}</p>
					{stats && <p>{stats}</p>}
					<ul>{set.moves.map(move => <li key={move}>{Dex.moves.get(move).name || move}</li>)}</ul>
				</article>;
			})}</div>
			{!sets.length && <p class="pokemonai-summary-empty">无法读取这支队伍的详细配置。</p>}
			<div class="pokemonai-ai-pool-detail-actions">
				<button class="button strong" value={team.id} onClick={this.selectFixedAITeam}>
					<i class="fa fa-check" aria-hidden></i> 选择这支队伍
				</button>
			</div>
		</section>;
	}
	renderAITeamPool(format: (typeof PokemonAIConfig.formats)[number]) {
		const settings = pokemonAISetupStore.getAITeamSettings(format.id);
		const pages = Math.max(1, Math.ceil(this.aiPoolTotal / 20));
		return <PSPanelWrapper room={this.props.room}><main class="pokemonai-workspace pokemonai-ai-pool">
			<header class="pokemonai-page-header">
				<div class="pokemonai-detail-heading">
					{!this.aiPoolDetail && <button class="button icon" onClick={this.closeAITeamPool} title="返回" aria-label="返回对战准备">
						<i class="fa fa-arrow-left" aria-hidden></i>
					</button>}
					<div><h2>选择 AI 队伍</h2><p>{format.label}</p></div>
				</div>
			</header>
			{!this.aiPoolDetail && <form class="pokemonai-ai-pool-toolbar" onSubmit={this.searchAITeamPool}>
				<label class="textbox pokemonai-ai-pool-search">
					<i class="fa fa-search" aria-hidden></i>
					<input
						type="search" value={this.aiPoolDraftQuery} onInput={this.updateAIPoolQuery}
						placeholder="搜索队伍或宝可梦" aria-label="搜索 AI 队伍"
					/>
				</label>
				<button class="button" type="submit">搜索</button>
			</form>}
			{this.aiPoolDetail ? this.renderAITeamPoolDetail(this.aiPoolDetail, format) : this.aiPoolError ? <div class="message-error">AI 队伍加载失败：{this.aiPoolError}</div> :
				this.aiPoolTeams === null ? <p class="pokemonai-loading"><i class="fa fa-refresh fa-spin" aria-hidden></i> 正在加载…</p> :
				!this.aiPoolTeams.length ? <div class="pokemonai-empty-state"><p>没有符合条件的队伍。</p></div> :
				<div class="pokemonai-ai-pool-grid" aria-label="AI 队伍列表">{this.aiPoolTeams.map(team => {
					const selected = settings.fixedTeamId === team.id;
					return <article class={`pokemonai-ai-pool-card${selected ? ' cur' : ''}`} key={team.id}>
						<header><strong>{team.name}</strong>{selected && <span><i class="fa fa-check" aria-hidden></i> 已选择</span>}</header>
						<div class="pokemonai-ai-pool-roster">{team.roster.slice(0, 6).map((species, index) => <span title={species} key={`${species}-${index}`}>
							<span class="picon" style={Dex.getPokemonIcon(toID(species))} aria-hidden></span><small>{species}</small>
						</span>)}</div>
						<footer>
							<small>{team.battles ? `${team.battles} 场` : '可用'}</small>
							<span class="pokemonai-ai-pool-card-actions">
								<button class="button" value={team.id} onClick={this.inspectAITeam}>查看</button>
								<button class="button strong" value={team.id} onClick={this.selectFixedAITeam}>{selected ? '继续使用' : '选择'}</button>
							</span>
						</footer>
					</article>;
				})}</div>}
			{this.aiPoolDetailLoading && <p class="pokemonai-loading"><i class="fa fa-refresh fa-spin" aria-hidden></i> 正在加载…</p>}
			{!this.aiPoolDetail && <nav class="pokemonai-ai-pool-pagination" aria-label="AI 队伍分页">
				<button class="button icon" value="-1" onClick={this.moveAITeamPoolPage} disabled={this.aiPoolPage <= 1 || this.aiPoolTeams === null} aria-label="上一页">
					<i class="fa fa-chevron-left" aria-hidden></i>
				</button>
				<span>第 {this.aiPoolPage} / {pages} 页</span>
				<button class="button icon" value="1" onClick={this.moveAITeamPoolPage} disabled={this.aiPoolPage >= pages || this.aiPoolTeams === null} aria-label="下一页">
					<i class="fa fa-chevron-right" aria-hidden></i>
				</button>
			</nav>}
		</main></PSPanelWrapper>;
	}
	renderCatalogTeams(formatId: string, selected: PokemonAITeamSelection | null) {
		if (this.catalogError) return <div class="message-error">阵容库加载失败：{this.catalogError}</div>;
		if (!this.catalogTeams) return <p><i class="fa fa-refresh fa-spin" aria-hidden></i> 正在读取阵容库…</p>;
		const teams = this.catalogTeams.filter(team => team.format_id === formatId);
		if (!teams.length) return <div class="pokemonai-empty-state"><p>这个规则下暂无内置阵容。</p></div>;
		return <div class="pokemonai-team-list">{teams.map(team => {
			const usable = pokemonAITeamIsUsable(team.validation_status);
			const isSelected = selected?.source === 'catalog' && selected.key === team.id ||
				!!selected?.packedTeam && selected.packedTeam === team.packed;
			return <article class={`pokemonai-team-card${isSelected ? ' cur' : ''}${usable ? '' : ' disabled'}`} key={team.id}>
				<button class="pokemonai-team-select" value={team.id} onClick={this.selectCatalogTeam} disabled={!usable}>
					<span class="pokemonai-team-title">
						<strong>{team.name}</strong>
						<small>{team.source_label} · {pokemonAIValidationLabel(team.validation_status)}</small>
					</span>
					{this.renderRoster(team.roster.map(mon => (
						mon.species_name || Dex.species.get(mon.species).name || mon.species
					)))}
					{isSelected && <i class="fa fa-check-circle pokemonai-selected-check" aria-label="已选择"></i>}
				</button>
				<div class="pokemonai-team-card-actions">
					<button
						class="button icon" value={team.id} onClick={this.inspectCatalogTeam}
						title="查看阵容" aria-label={`查看 ${team.name}`} disabled={!usable}
					>
						<i class="fa fa-eye" aria-hidden></i>
					</button>
					<button
						class="button icon" value={team.id} onClick={this.editCatalogTeam}
						title="复制并编辑" aria-label={`复制并编辑 ${team.name}`} disabled={!usable}
					>
						<i class="fa fa-pencil" aria-hidden></i>
					</button>
				</div>
			</article>;
		})}</div>;
	}
	renderTeamPicker(format: (typeof PokemonAIConfig.formats)[number], selected: PokemonAITeamSelection | null) {
		const topLayer = getPokemonAITopLayer('ai-battle' as RoomID);
		if (topLayer?.kind !== 'team-picker' && topLayer?.kind !== 'team-detail') return null;
		const localTeams = this.setupLocalTeams(format.id);
		return <div class="pokemonai-team-picker-backdrop" role="presentation">
			<section class="pokemonai-team-picker" role="dialog" aria-modal="true" aria-labelledby="pokemonai-team-picker-title">
				<header>
					<div><h2 id="pokemonai-team-picker-title">{topLayer.kind === 'team-detail' ? '阵容详情' : '更换队伍'}</h2><p>{format.label}</p></div>
					<button class="button icon" onClick={topLayer.kind === 'team-detail' ? this.closeTeamDetails : this.closeTeamPicker} aria-label="关闭">
						<i class="fa fa-times" aria-hidden></i>
					</button>
				</header>
				{topLayer.kind === 'team-detail' && this.inspectedTeam ? <div class="pokemonai-team-picker-detail">
					{this.renderTeamDetails(this.inspectedTeam, selected)}
				</div> : <>
					<div class="pokemonai-workspace-tabs" role="tablist" aria-label="队伍来源">
						<button role="tab" class={this.teamPickerView === 'local' ? 'cur' : ''} aria-selected={this.teamPickerView === 'local'} onClick={this.showLocalPicker}>本地</button>
						<button role="tab" class={this.teamPickerView === 'catalog' ? 'cur' : ''} aria-selected={this.teamPickerView === 'catalog'} onClick={this.showCatalogPicker}>线上</button>
					</div>
					<div class="pokemonai-team-picker-list">{this.teamPickerView === 'local' ? (
						!localTeams.length ? <div class="pokemonai-empty-state"><p>这个规则下还没有本地队伍。</p></div> : localTeams.map(team => {
							const isSelected = selected?.localTeamId === team.id;
							return <article class={`pokemonai-team-card${isSelected ? ' cur' : ''}`} key={team.id}>
								<button class="pokemonai-team-select" value={team.id} onClick={this.selectPickerLocal}>
									<span class="pokemonai-team-title"><strong>{team.name}</strong><small>本地队伍 · {team.validation.status === 'valid' ? '可出战' : '待检查'}</small></span>
									{this.renderRoster(pokemonAIRosterFromPacked(team.packedTeam))}
									{isSelected && <i class="fa fa-check-circle pokemonai-selected-check" aria-label="已选择"></i>}
								</button>
								<div class="pokemonai-team-card-actions">
									<button class="button icon" value={team.id} onClick={() => this.showTeamDetails(this.localInspection(team, format.id))} aria-label={`查看 ${team.name}`}><i class="fa fa-eye" aria-hidden></i></button>
									<button class="button icon" value={team.id} onClick={this.editLocalTeam} aria-label={`编辑 ${team.name}`}><i class="fa fa-pencil" aria-hidden></i></button>
								</div>
							</article>;
						})
					) : this.renderCatalogTeams(format.id, selected)}</div>
					<footer><button class="button" onClick={this.manageAllTeams}><i class="fa fa-folder-open" aria-hidden></i> 管理全部阵容</button></footer>
				</>}
			</section>
		</div>;
	}

	override render() {
		if (PokemonAIApp.isOnline()) return this.renderOnlineSetup();
		const state = pokemonAISetupStore.getState();
		const format = PokemonAIConfig.formats.find(entry => entry.id === state.formatId) || PokemonAIConfig.formats[0];
		if (this.selectingAITeam) return this.renderAITeamPool(format);
		const opponent = PokemonAIConfig.opponents.find(entry => entry.formatId === format.id);
		const selected = pokemonAISetupStore.selection(format.id);
		const localTeams = this.setupLocalTeams(format.id);
		const activeTeam = this.activeSetupLocalTeam(format.id, localTeams, selected);
		const activeRoster = activeTeam ? pokemonAIRosterFromPacked(activeTeam.packedTeam) : [];
		const activeIsSelected = !!activeTeam && selected?.localTeamId === activeTeam.id;
		const aiTeamSettings = pokemonAISetupStore.getAITeamSettings(format.id);
		const unavailable = !opponent || (!!opponent.availability && opponent.availability !== 'ready');
		const aiTeamUnavailable = this.aiCapabilities?.formats[format.id]?.modes[aiTeamSettings.mode] === false ||
			(aiTeamSettings.mode === 'fixed' && !aiTeamSettings.fixedTeamId);
		return <PSPanelWrapper room={this.props.room}><main class="pokemonai-workspace pokemonai-setup">
			<header class="pokemonai-page-header">
				<div><h2>对战准备</h2><p>{format.label}</p></div>
				<nav class="pokemonai-page-actions" aria-label="对战准备操作">
					<button class="button" onClick={this.openLocalTeams}><i class="fa fa-exchange" aria-hidden></i> 更换队伍</button>
				</nav>
			</header>
			<section class="pokemonai-format-section" aria-labelledby="pokemonai-format-heading">
				<h3 id="pokemonai-format-heading">规则</h3>
				<div class="pokemonai-format-segments" role="group" aria-label="选择规则">
					{PokemonAIConfig.formats.map(entry => <button
						key={entry.id} class={entry.id === format.id ? 'cur' : ''} value={entry.id}
						onClick={this.selectFormat} aria-pressed={entry.id === format.id}
					>{entry.label.replace('Champions ', '')}</button>)}
				</div>
				{unavailable && <p class="message-error">{opponent?.reason || '该规则的 AI 暂不可用。'}</p>}
			</section>
			<div class={`pokemonai-setup-grid${this.inspectedTeam ? ' has-detail' : ''}`}>
				<section class="pokemonai-team-browser" aria-labelledby="pokemonai-teams-heading">
					<div class="pokemonai-section-bar">
						<h3 id="pokemonai-teams-heading">本地队伍</h3>
					</div>
					{this.renderLocalTeams(format.id, selected)}
					{this.renderAITeamSettings(format.id)}
				</section>
				<aside class={`pokemonai-team-summary${this.inspectedTeam ? ' is-detail' : ''}`}>
					<div class="pokemonai-summary-body">{this.inspectedTeam ?
						this.renderTeamDetails(this.inspectedTeam, selected) : <>
							<h3>队伍摘要</h3>
							<dl>
								<dt>规则</dt><dd>{format.label}</dd>
								<dt>正在查看</dt><dd>{activeTeam?.name || '没有可用队伍'}</dd>
								<dt>AI 队伍</dt><dd>{pokemonAITeamModeLabel(aiTeamSettings.mode)}{
									aiTeamSettings.mode === 'fixed' && aiTeamSettings.fixedTeamName ? ` · ${aiTeamSettings.fixedTeamName}` : ''
								}</dd>
							</dl>
							{activeTeam ? <>
								{this.renderRoster(activeRoster)}
								<p class="pokemonai-validation">
									<i class={`fa ${activeIsSelected ? 'fa-check-circle' : 'fa-eye'}`} aria-hidden></i>
									{' '}{activeIsSelected ? '已设为出战' : '正在查看'}
								</p>
								<div class="pokemonai-detail-actions">
									{!activeIsSelected && <button class="button strong" onClick={this.selectActiveTeam}>
										<i class="fa fa-check" aria-hidden></i> 设为出战队伍
									</button>}
									<button class="button" onClick={this.inspectActiveTeam}><i class="fa fa-eye" aria-hidden></i> 查看详情</button>
									<button class="button" onClick={this.editActiveTeam}><i class="fa fa-pencil" aria-hidden></i> 编辑</button>
								</div>
							</> : <p class="pokemonai-summary-empty">当前规则下没有可用的本地队伍。</p>}
						</>}
					</div>
					<p class="pokemonai-start-team">{selected ? <>出战：<strong>{selected.name}</strong></> : '尚未设置出战队伍'}</p>
					<button
						class="button strong pokemonai-start-button" onClick={this.startBattle}
						disabled={!selected || unavailable || aiTeamUnavailable || PS.isOffline}
					>
						<i class="fa fa-play" aria-hidden></i> 开始对战
					</button>
				</aside>
			</div>
		</main>{this.renderTeamPicker(format, selected)}</PSPanelWrapper>;
	}
}
/* eslint-enable no-restricted-syntax, no-restricted-globals, @stylistic/max-len, @stylistic/indent, @typescript-eslint/no-misused-promises */

type PokemonAIMetaImport = {
	id: string, state: 'running' | 'up_to_date' | 'ready' | 'failed',
	changed_formats?: string[], source_updated_at?: Record<string, string>, counts?: Record<string, number>,
	progress?: { formatId?: string, current?: number, total?: number }, warnings?: string[], error?: string,
};

type PokemonAIMetaRequestOptions = {
	method?: 'GET' | 'POST', body?: string,
};

type PokemonAIMetaSnapshotStatus = {
	fetchedAt?: string, publishedAt?: string,
	formats: Record<string, {
		sourceUpdatedAt: string, speciesCount: number, teamSourceUpdatedAt?: string,
		teamCount?: number, playableTeamCount?: number,
	}>,
};

type PokemonAIMetaStatus = {
	source: { id: string, label: string, url: string },
	current: PokemonAIMetaSnapshotStatus | null,
	previous: PokemonAIMetaSnapshotStatus | null,
	canRollback: boolean,
};

function pokemonAIMetaDate(value?: string) {
	if (!value) return '暂无数据';
	if (/^\d{4}-\d{2}$/.test(value)) return value;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

class AIMetaPanel extends PSRoomPanel {
	static readonly id = 'aimeta';
	static readonly routes = ['ai-meta'];
	static readonly title = '环境数据';
	static readonly location = 'left';

	status: PokemonAIMetaStatus | null = null;
	activeImport: PokemonAIMetaImport | null = null;
	message = '';
	busy = false;
	timer: ReturnType<typeof setTimeout> | null = null;

	override componentDidMount() {
		super.componentDidMount();
		navigator.serviceWorker?.addEventListener('controllerchange', this.handleServiceWorkerChange);
		this.loadStatus();
	}
	override componentWillUnmount() {
		if (this.timer) clearTimeout(this.timer);
		navigator.serviceWorker?.removeEventListener('controllerchange', this.handleServiceWorkerChange);
		super.componentWillUnmount();
	}
	handleServiceWorkerChange = () => this.loadStatus();
	back = () => {
		focusPokemonAIReturnTarget((this.props.room.args?.returnTo as PokemonAIReturnTarget | undefined) || {
			roomid: '' as RoomID,
		});
		PS.leave(this.props.room.id);
	};

	request<T>(url: string, init: PokemonAIMetaRequestOptions = {}) {
		const endpoint = new URL(url, document.location.origin).href;
		const pending = init.method === 'POST' ? Net(endpoint).post({
			body: init.body,
			headers: { 'Content-Type': 'application/json', 'X-PokemonAI-Control': '1' },
		}) : Net(endpoint).get();
		return pending.then(text => {
			const value = JSON.parse(text) as T & { error?: string };
			if (value.error) throw new Error(value.error);
			return value;
		});
	}
	loadStatus = () => {
		this.request<PokemonAIMetaStatus>('/api/meta/status').then(value => {
			this.status = value;
			this.message = '';
		}, error => {
			this.message = error instanceof Error ? error.message : String(error);
		}).then(() => this.forceUpdate());
	};
	startImport = () => {
		this.busy = true;
		this.message = '';
		this.forceUpdate();
		this.request<PokemonAIMetaImport>('/api/meta/imports', {
			method: 'POST', body: '{}',
		}).then(value => {
			this.activeImport = value;
			this.pollImport(value.id);
		}, error => {
			this.message = error instanceof Error ? error.message : String(error);
			this.busy = false;
			this.forceUpdate();
		});
	};
	pollImport = (id: string) => {
		this.timer = setTimeout(() => {
			this.request<PokemonAIMetaImport>(`/api/meta/imports/${id}`).then(value => {
				this.activeImport = value;
				if (value.state === 'running') {
					this.pollImport(id);
				} else {
					this.busy = false;
					if (value.state === 'up_to_date') this.message = '当前数据已是最新。';
				}
			}, error => {
				this.message = error instanceof Error ? error.message : String(error);
				this.busy = false;
			}).then(() => this.forceUpdate());
		}, 700);
	};
	publish = () => {
		if (!this.activeImport) return;
		this.request(`/api/meta/imports/${this.activeImport.id}/publish`, { method: 'POST', body: '{}' }).then(() => {
			this.message = '数据已更新。';
			this.activeImport = null;
			this.loadStatus();
		}, error => {
			this.message = error instanceof Error ? error.message : String(error);
			this.forceUpdate();
		});
	};
	rollback = (ev: MouseEvent) => {
		PS.confirm('恢复上一次数据？', {
			okButton: '恢复', cancelButton: '取消', parentElem: ev.currentTarget as HTMLElement,
		}).then(confirmed => {
			if (!confirmed) return;
			this.request('/api/meta/rollback', { method: 'POST', body: '{}' }).then(() => {
				this.message = '已恢复上一次数据。';
				this.loadStatus();
			}, error => {
				this.message = error instanceof Error ? error.message : String(error);
				this.forceUpdate();
			});
		});
	};

	override render() {
		const current = this.status?.current;
		const progress = this.activeImport?.progress;
		const progressFormat = PokemonAIConfig.formats.find(format => format.id === progress?.formatId);
		return <PSPanelWrapper room={this.props.room}><main class="pokemonai-workspace pokemonai-meta">
			<div class="pokemonai-launcher-head">
				<div class="pokemonai-detail-heading">
					<button class="button icon" onClick={this.back} aria-label="返回"><i class="fa fa-arrow-left" aria-hidden></i></button>
					<div><h2>环境数据</h2></div>
				</div>
				<button class="button" onClick={this.rollback} disabled={!this.status?.canRollback || this.busy}>
					<i class="fa fa-undo" aria-hidden></i> 恢复上一次数据
				</button>
			</div>
			<div class="pokemonai-meta-toolbar">
				<span>{this.status?.source ?
					<a href={this.status.source.url} target="_blank">{this.status.source.label}</a> : 'MunchStats'}</span>
				<button class="button strong" onClick={this.startImport} disabled={this.busy}>
					<i class="fa fa-refresh" aria-hidden></i> 检查更新
				</button>
			</div>
			<section class="pokemonai-meta-status">
				{current ? <dl>{PokemonAIConfig.formats.map(format => {
					const item = current.formats[format.id];
					return <><dt>{format.label}</dt><dd>{item ? <>
						{pokemonAIMetaDate(item.sourceUpdatedAt)} · {item.speciesCount} 只 · {item.teamCount || 0} 支阵容
						{!!item.playableTeamCount && ` · ${item.playableTeamCount} 支可直接使用`}
					</> : '暂无数据'}</dd></>;
				})}</dl> : <p>尚无环境数据。</p>}
			</section>
			{this.message && <p class="pokemonai-meta-message">{this.message}</p>}
			{this.activeImport && <section class="pokemonai-meta-preview">
				<h3>{this.activeImport.state === 'running' ? '正在检查更新' :
				this.activeImport.state === 'failed' ? '更新失败' :
				this.activeImport.state === 'up_to_date' ? '已是最新数据' : '可用更新'}</h3>
				{this.activeImport.error && <p class="message-error">{this.activeImport.error}</p>}
				{progress?.total && <p>{progressFormat?.label || progress.formatId}：{progress.current || 0} / {progress.total}</p>}
				{this.activeImport.counts && <dl>{PokemonAIConfig.formats.map(format => <>
					<dt>{format.label}</dt><dd>{this.activeImport?.counts?.[format.id] || 0} 只</dd>
				</>)}</dl>}
				{this.activeImport.warnings?.map(warning => <p class="message-warning">{warning}</p>)}
				{this.activeImport.state === 'ready' && <button class="button strong" onClick={this.publish}>
					<i class="fa fa-check" aria-hidden></i> 应用数据
				</button>}
			</section>}
		</main></PSPanelWrapper>;
	}
}

class OfficialAccountPanel extends PSRoomPanel {
	static readonly id = 'officialaccount';
	static readonly routes = ['official-account'];
	static readonly title = '官方账号授权';
	static readonly location = 'modal-popup';
	static readonly noURL = true;

	declare state: { error?: string };

	override componentDidMount() {
		super.componentDidMount();
		this.base?.addEventListener('keydown', this.handleDialogKeyDown);
		const dialog = this.base?.closest<HTMLElement>('[role="dialog"]');
		dialog?.setAttribute('aria-modal', 'true');
		dialog?.setAttribute('aria-labelledby', 'pokemonai-auth-title');
		setTimeout(() => this.base?.querySelector<HTMLElement>('button[name=closeRoom]')?.focus(), 0);
	}
	override componentWillUnmount() {
		this.base?.removeEventListener('keydown', this.handleDialogKeyDown);
		super.componentWillUnmount();
	}
	handleDialogKeyDown = (ev: KeyboardEvent) => {
		if (ev.key === 'Escape') {
			ev.preventDefault();
			PS.closePopup();
			return;
		}
		if (ev.key !== 'Tab' || !this.base) return;
		const focusable = Array.from(this.base.querySelectorAll<HTMLElement>(
			'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
		));
		if (!focusable.length) return;
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (ev.shiftKey && document.activeElement === first) {
			ev.preventDefault();
			last.focus();
		} else if (!ev.shiftKey && document.activeElement === last) {
			ev.preventDefault();
			first.focus();
		}
	};

	saveSID = (ev: Event) => {
		ev.preventDefault();
		const input = this.base?.querySelector<HTMLInputElement>('input[name=sid]');
		if (!input || !PokemonAIApp.saveOfficialSid(input.value)) {
			this.setState({ error: 'SID 不能为空，且不能包含换行。' });
			return;
		}
		location.reload();
	};
	clearSID = () => {
		PokemonAIApp.clearOfficialSid();
		location.reload();
	};

	override render() {
		const hasSid = PokemonAIApp.hasOfficialSid();
		return <PSPanelWrapper room={this.props.room} width={430}><div class="pad pokemonai-auth-panel">
			<button class="closebutton" name="closeRoom" type="button" aria-label="关闭">
				<i class="fa fa-times" aria-hidden></i>
			</button>
			<h2 id="pokemonai-auth-title"><i class="fa fa-shield" aria-hidden></i> 官方账号授权</h2>
			<p>PokémonAI 不接收你的 Showdown 密码。请先在官方页面登录，再复制当前设备的 Test Client SID。</p>
			<p><a
				class="button" href="https://play.pokemonshowdown.com/testclient-key.php"
				target="_blank" rel="noopener noreferrer"
			>前往官方页面获取 SID <i class="fa fa-external-link" aria-hidden></i></a></p>
			<form onSubmit={this.saveSID}>
				<label class="label">
					<span>设备 SID</span>
					<input
						class="textbox" type="password" name="sid" autocomplete="off"
						placeholder="粘贴 SID，不会上传到 PokémonAI 服务器"
					/>
				</label>
				{this.state.error && <p class="message-error">{this.state.error}</p>}
				<p class="buttonbar">
					<button class="button strong" type="submit">保存并验证</button> {}
					{hasSid && <button class="button danger" type="button" onClick={this.clearSID}>清除已有授权</button>} {}
					<button class="button" type="button" name="closeRoom">取消</button>
				</p>
			</form>
			<p><small>SID 是敏感的会话凭据，只保存在当前浏览器。不要发送给其他人。</small></p>
		</div></PSPanelWrapper>;
	}
}

export class CCPAIntercept extends preact.Component {
	intercepted = false;
	override shouldComponentUpdate() {
		this.intercept();
		return false;
	}
	override componentDidMount() {
		this.intercept();
		setTimeout(() => this.intercept(), 500);
		setTimeout(() => this.intercept(), 1000);
		setTimeout(() => this.intercept(), 2000);
		setTimeout(() => this.intercept(), 3000);
		setTimeout(() => this.intercept(), 5000);
		setTimeout(() => this.intercept(), 10000);
	}
	intercept() {
		if (this.intercepted || !window.$) return;
		const $ccpa = $('.fc-dns-dialog');
		if (!$ccpa.length) return;
		$ccpa.appendTo(this.base!);
		// $ccpa.css({ position: 'relative', zIndex: 2 });
		this.intercepted = true;
	}
	override render() {
		return <div></div>;
	}
}

export class FormatDropdown extends preact.Component<{
	selectType?: SelectType, format?: string, defaultFormat?: string, placeholder?: string,
	onChange?: JSX.EventHandler<Event>,
}> {
	declare base?: HTMLButtonElement;
	format = '';
	change = (e: Event) => {
		if (!this.base) return;
		this.format = this.base.value;
		this.forceUpdate();
		if (this.props.onChange) this.props.onChange(e);
	};
	render() {
		this.format = this.props.format || this.format || this.props.defaultFormat || '';
		let [formatName, customRules] = this.format.split('@@@');
		customRules = customRules?.replace(/,/g, ', ');
		if (window.BattleLog) formatName = BattleLog.formatName(formatName);
		if (this.props.format && !this.props.onChange) {
			// There's intentionally no `disabled` prop. If this is out of sync
			// with the `format` and `onChange` props, that's a bug.
			return <button
				name="format" value={this.format} class="select formatselect preselected" disabled
			>
				{formatName}
				{!!customRules && [<br />, <small>Custom rules: {customRules}</small>]}
			</button>;
		}
		return <button
			name="format" value={this.format} data-selecttype={this.props.selectType}
			class="select formatselect" data-href="/formatdropdown" onChange={this.change}
		>
			{formatName || (!!this.props.placeholder && <em>{this.props.placeholder}</em>) || null}
			{!!customRules && [<br />, <small>Custom rules: {customRules}</small>]}
		</button>;
	}
}

class TeamDropdown extends preact.Component<{ format: string }> {
	teamFormat = '';
	teamKey = '';
	change = () => {
		if (!this.base) return;
		this.teamKey = (this.base as HTMLButtonElement).value;
		this.forceUpdate();
	};
	getDefaultTeam(teambuilderFormat: string) {
		for (const team of PS.teams.list) {
			if (!team.isBox && team.format === teambuilderFormat) return team.key;
		}
		return '';
	}
	render() {
		const teamFormat = PS.teams.teambuilderFormat(this.props.format);
		const formatData = window.BattleFormats?.[teamFormat];
		if (formatData?.team) {
			return <button class="select teamselect preselected" name="team" value="random" disabled>
				<div class="team">
					<strong>Random team</strong>
					<small>
						<PSIcon pokemon={null} />
						<PSIcon pokemon={null} />
						<PSIcon pokemon={null} />
						<PSIcon pokemon={null} />
						<PSIcon pokemon={null} />
						<PSIcon pokemon={null} />
					</small>
				</div>
			</button>;
		}
		if (teamFormat !== this.teamFormat) {
			this.teamFormat = teamFormat;
			this.teamKey = this.getDefaultTeam(teamFormat);
		}
		const team = PS.teams.byKey[this.teamKey] || null;
		return <button
			name="team" value={this.teamKey}
			class="select teamselect" data-href="/teamdropdown" data-format={teamFormat} onChange={this.change}
			disabled={!!PS.mainmenu.searchingFormat()}
		>
			{PS.roomTypes['teamdropdown'] && <TeamBox team={team} noLink />}
		</button>;
	}
}

export class TeamForm extends preact.Component<{
	children: preact.ComponentChildren,
	class?: string, format?: string, teamFormat?: string, hideFormat?: boolean, selectType?: SelectType,
	defaultFormat?: string,
	allowEmptyTeam?: boolean,
	onSubmit: ((e: Event, format: string, team?: Team) => void) | null,
	onValidate?: ((e: Event, format: string, team?: Team) => void) | null,
}> {
	format = '';
	teraPreview = false;
	bestOf = false;
	bestOfValue = '3';
	customRules = false;
	customRuleText = '';
	itemClause = false;
	changeFormat = (ev: Event) => {
		this.setFormat((ev.target as HTMLButtonElement).value);
	};
	setFormat(format: string) {
		const [baseFormat, customRules] = format.split('@@@');
		this.format = baseFormat;
		this.loadCustomRules(customRules);
	};
	loadCustomRules(customRules: string) {
		this.bestOf = false;
		this.bestOfValue = '3';
		this.teraPreview = false;
		this.itemClause = false;
		if (!customRules) {
			this.customRules = false;
			this.customRuleText = '';
			return;
		}

		this.customRules = true;
		const unknownRules: string[] = [];
		for (const rule of customRules.split(',')) {
			const trimmedRule = rule.trim();
			if (!trimmedRule) continue;
			const bestOfMatch = /^best[-\s]*of\s*=\s*(\d+)$/i.exec(trimmedRule);
			if (bestOfMatch) {
				this.bestOf = true;
				this.bestOfValue = bestOfMatch[1];
			} else if (/^tera\s+type\s+preview$/i.test(trimmedRule)) {
				this.teraPreview = true;
			} else if (/^item\s+clause\s*=\s*1$/i.test(trimmedRule)) {
				this.itemClause = true;
			} else {
				unknownRules.push(trimmedRule);
			}
		}
		this.customRuleText = unknownRules.join('\n');
	};
	changeBestOfValue = (ev: Event) => {
		this.bestOfValue = (ev.target as HTMLInputElement).value;
	};
	changeCustomRules = (ev: Event) => {
		this.customRuleText = (ev.target as HTMLTextAreaElement).value;
	};
	addCustomRules(format: string, rules: string[]) {
		if (!rules.length) return format;
		const hasCustomRules = format.includes('@@@');
		return `${format}${hasCustomRules ? ', ' : '@@@ '}${rules.join(', ')}`;
	}
	submit = (ev: Event, validate?: 'validate') => {
		ev.preventDefault();
		let format = this.format;
		// in tournaments, format is the custom name & teamFormat is the original format.
		const teambuilderFormat = PS.teams.teambuilderFormat(this.props.teamFormat || format);
		const teamElement = this.base!.querySelector<HTMLButtonElement>('button[name=team]');
		const teamKey = teamElement!.value;
		const team = teamKey ? PS.teams.byKey[teamKey] : undefined;
		if (!window.BattleFormats[teambuilderFormat]?.team && !team && !this.props.allowEmptyTeam) {
			PS.alert('You need to go into the Teambuilder and build a team for this format.', {
				parentElem: teamElement!,
			});
			return;
		}
		const customRules: string[] = [];
		if (this.customRules) {
			if (this.bestOf) {
				customRules.push(`Best of = ${this.bestOfValue || '3'}`);
			}
			if (this.teraPreview) customRules.push('Tera Type Preview');
			customRules.push(...this.customRuleText.split('\n').map(rule => rule.trim()).filter(Boolean));
		}
		if (this.itemClause) {
			customRules.push('Item Clause = 1');
		}
		format = this.addCustomRules(format, customRules);
		PS.teams.loadTeam(team).then(() => {
			(validate === 'validate' ? this.props.onValidate : this.props.onSubmit)?.(ev, format, team);
		});
	};
	toggleCustomRule = (ev: Event) => {
		const checked = (ev.target as HTMLInputElement)?.checked;
		const rule = (ev.target as HTMLInputElement)?.name;
		if (rule === 'terapreview') this.teraPreview = checked;
		if (rule === 'bestof') this.bestOf = checked;
		if (rule === 'customrules') {
			this.customRules = checked;
			if (!checked) {
				this.bestOf = false;
				this.teraPreview = false;
			}
			this.forceUpdate();
		}
		if (rule === 'itemclause') this.itemClause = checked;
	};
	handleClick = (ev: Event) => {
		let target = ev.target as HTMLButtonElement | null;
		while (target && target !== this.base) {
			if (target.tagName === 'BUTTON' && target.name === 'validate') {
				this.submit(ev, 'validate');
				return;
			}
			target = target.parentNode as HTMLButtonElement | null;
		}
	};
	render() {
		if (window.BattleFormats) {
			this.format ||= this.props.defaultFormat || '';
			if (!this.format) {
				this.format = `gen${Dex.gen}randombattle`;

				const starredPrefs = PS.prefs.starredformats || {};
				// .reverse() because the newest starred format should be the default one
				const starred = Object.keys(starredPrefs).filter(id => starredPrefs[id] === true).reverse();
				for (let id of starred) {
					let format = window.BattleFormats[id];
					if (!format) continue;
					if (this.props.selectType === 'challenge' && format?.challengeShow === false) continue;
					if (this.props.selectType === 'search' && format?.searchShow === false) continue;
					if (this.props.selectType === 'teambuilder' && format?.team) continue;
					this.format = id;
					break;
				}
			}
		}
		if (this.props.defaultFormat?.startsWith('!!')) {
			// The !! means that it overrides any current format, and will only be
			// sent as a prop once
			this.setFormat(this.props.defaultFormat.slice(2));
		}
		if (this.props.format) this.format = this.props.format;
		if (!this.props.format && this.format.includes('@@@')) this.setFormat(this.format);
		const formatId = toID(this.format.split('@@@')[0]);
		const format = window.BattleFormats[formatId];
		const showCustomRules = this.props.selectType === 'challenge' && !this.props.format;
		return <form class={this.props.class} onSubmit={this.submit} onClick={this.handleClick}>
			{!this.props.hideFormat && <p>
				<label class="label">
					Format:<br />
					<FormatDropdown
						selectType={this.props.selectType} format={this.format}
						onChange={this.props.format ? undefined : this.changeFormat}
					/>
				</label>
			</p>}
			<p>
				<label class="label">
					Team:<br />
					<TeamDropdown format={this.props.teamFormat || this.format} />
				</label>
			</p>
			{showCustomRules && (!this.customRules ? <p>
				<label class="checkbox"><input
					type="checkbox" name="customrules" checked={this.customRules} onChange={this.toggleCustomRule}
				/> Custom rules</label>
			</p> : <fieldset class="fieldset">
				<legend><label class="checkbox"><input
					type="checkbox" name="customrules" checked={this.customRules} onChange={this.toggleCustomRule}
				/> Custom rules</label></legend>
				{(format?.bestOfDefault || this.bestOf) && <p>
					<label class="checkbox">
						<input
							type="checkbox" name="bestof" checked={this.bestOf} onChange={this.toggleCustomRule}
						/>
						<abbr title="Start a team-locked best-of-n series">Best-of-<input
							name="bestofvalue" type="number" min="3" max="9" step="2" value={this.bestOfValue}
							onInput={this.changeBestOfValue}
							style="width: 28px; vertical-align: initial;"
						/></abbr></label>
				</p>}
				{(format?.teraPreviewDefault || this.teraPreview) && <p>
					<label class="checkbox"><input
						type="checkbox" name="terapreview" checked={this.teraPreview} onChange={this.toggleCustomRule}
					/> Tera Type Preview</label>
				</p>}
				{(format?.itemClauseDefault || this.itemClause) && <p>
					<label class="checkbox"><input
						type="checkbox" name="itemclause" checked={this.itemClause} onChange={this.toggleCustomRule}
					/> Item Clause</label>
				</p>}
				<textarea
					name="customrules" class="textbox" rows={3} placeholder="Rules separated by commas or lines"
					value={this.customRuleText} onInput={this.changeCustomRules}
					style="min-height:3em"
				/>
				<small><a
					href="https://github.com/smogon/pokemon-showdown/blob/master/config/CUSTOM-RULES.md" target="_blank"
				>Custom rules guide</a></small>
			</fieldset>)}
			<p>{this.props.children}</p>
		</form>;
	}
}

PS.addRoomType(NewsPanel, AISetupPanel, AIMetaPanel, OfficialAccountPanel, MainMenuPanel);
