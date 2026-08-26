/**
 * PokemonAI application bootstrap.
 *
 * This file is loaded before the Showdown client and owns the only supported
 * server-mode switch. Keep it dependency-free: the rest of the client has not
 * been initialized when this script runs.
 */

export type AppMode = 'ai' | 'online';
export type OfficialAuthState = 'idle' | 'checking' | 'authenticated' | 'invalid' | 'network-error';

export interface PokemonAIModeProfile {
	id: AppMode;
	label: string;
	usesOfficialLogin: boolean;
	allowedFormats: readonly ['gen9randombattle'];
	server: {
		id: string,
		host: string,
		port: number,
		httpport?: number,
		altport?: number,
		registered: boolean,
	};
}

const MODE_KEY = 'pokemonai-app-mode';
const SID_KEY = 'pokemonai-official-sid';
const LOCALE_KEY = 'pokemonai-locale';
const ORIENTATION_KEY = 'pokemonai-orientation-tip-seen';
const LOCAL_TRAINER_NAME_PREFIX = 'Local Player ';

function safeStorageGet(key: string): string {
	try {
		return localStorage.getItem(key) || '';
	} catch {
		return '';
	}
}

function safeStorageSet(key: string, value: string) {
	try {
		if (value) {
			localStorage.setItem(key, value);
		} else {
			localStorage.removeItem(key);
		}
	} catch {}
}

function redactSensitiveText(value: string) {
	return value
		.replace(/((?:sid|assertion|challstr)\s*[=:]\s*)[^\s,;&]+/gi, '$1[REDACTED]')
		.replace(/(\/trn\s+[^,]+,[^,]*,).+/gi, '$1[REDACTED]');
}

function sanitizeDiagnosticValue(value: unknown, seen: object[] = []): unknown {
	if (typeof value === 'string') return redactSensitiveText(value);
	if (!value || typeof value !== 'object') return value;
	if (seen.includes(value)) return '[Circular]';
	seen.push(value);
	if (value instanceof Error) {
		const sanitized = new Error(redactSensitiveText(value.message));
		sanitized.name = value.name;
		if (value.stack) sanitized.stack = redactSensitiveText(value.stack);
		return sanitized;
	}
	if (Array.isArray(value)) return value.map(item => sanitizeDiagnosticValue(item, seen));
	if (Object.prototype.toString.call(value) !== '[object Object]') return value;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		result[key] = /^(?:sid|assertion|challstr)$/i.test(key) ? '[REDACTED]' : sanitizeDiagnosticValue(item, seen);
	}
	return result;
}

function installDiagnosticRedaction() {
	const target = console as any;
	if (target.__pokemonaiRedacted) return;
	(['debug', 'error', 'info', 'log', 'warn'] as const).forEach(method => {
		const original = target[method]?.bind(console);
		if (original) {
			target[method] = (...args: unknown[]) => original(...args.map(arg => sanitizeDiagnosticValue(arg)));
		}
	});
	target.__pokemonaiRedacted = true;
}

function parseMode(search = location.search, storedMode = safeStorageGet(MODE_KEY)): AppMode {
	const requestedMode = new URLSearchParams(search).get('mode');
	if (requestedMode === 'ai' || requestedMode === 'online') return requestedMode;
	if (storedMode === 'ai' || storedMode === 'online') return storedMode;
	return 'ai';
}

function parseLocalServer(search = location.search): { host: string, port: number } | null {
	const params = new URLSearchParams(search);
	const server = params.get('server');
	const legacy = /^\?~~([^:/]+)(?::([0-9]+))?/.exec(search);
	const value = server || (legacy ? `${legacy[1]}:${legacy[2] || '8000'}` : '');
	const match = /^([^:/]+)(?::([0-9]+))?$/.exec(value);
	if (!match) return null;
	const port = Number(match[2] || 8000);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
	return { host: match[1], port };
}

function makeProfiles(): Record<AppMode, PokemonAIModeProfile> {
	const localServer = parseLocalServer();
	const secure = location.protocol === 'https:';
	const aiServer = localServer ? {
		id: 'pokemonai', host: localServer.host, port: localServer.port, registered: false,
	} : {
		id: 'pokemonai', host: location.hostname, port: secure ? 443 : 8000,
		httpport: secure ? 443 : undefined, registered: false,
	};
	return {
		ai: {
			id: 'ai', label: 'AI 训练', usesOfficialLogin: false,
			allowedFormats: ['gen9randombattle'], server: aiServer,
		},
		online: {
			id: 'online', label: '真人竞技', usesOfficialLogin: true,
			allowedFormats: ['gen9randombattle'],
			server: {
				id: 'showdown', host: 'sim3.psim.us', port: 443, httpport: 8000,
				altport: 80, registered: true,
			},
		},
	};
}

const appMode = parseMode();
const modeProfiles = makeProfiles();

export const PokemonAIApp = {
	mode: appMode,
	profiles: modeProfiles,
	profile: modeProfiles[appMode],
	officialAuthState: 'idle' as OfficialAuthState,
	localTrainerNumber: 1,
	storageKeys: {
		mode: MODE_KEY,
		officialSid: SID_KEY,
		locale: LOCALE_KEY,
		orientationTipSeen: ORIENTATION_KEY,
	},
	parseMode,
	parseLocalServer,
	isAI() {
		return this.mode === 'ai';
	},
	isOnline() {
		return this.mode === 'online';
	},
	localTrainerName() {
		return `${LOCAL_TRAINER_NAME_PREFIX}${this.localTrainerNumber}`;
	},
	nextLocalTrainerName() {
		this.localTrainerNumber++;
		return this.localTrainerName();
	},
	isLocalTrainerName(name: string) {
		return name.startsWith(LOCAL_TRAINER_NAME_PREFIX);
	},
	displayTrainerName(name: string) {
		const match = /^Local Player (\d+)$/.exec(name);
		return match ? `本地玩家${match[1]}` : name;
	},
	getOfficialSid() {
		return safeStorageGet(SID_KEY).trim();
	},
	hasOfficialSid() {
		return !!this.getOfficialSid();
	},
	saveOfficialSid(sid: string) {
		const cleaned = sid.trim();
		if (!cleaned || cleaned.length > 4096 || /[\r\n]/.test(cleaned)) return false;
		safeStorageSet(SID_KEY, cleaned);
		this.setOfficialAuthState('idle');
		return true;
	},
	clearOfficialSid() {
		safeStorageSet(SID_KEY, '');
		this.setOfficialAuthState('idle');
	},
	setOfficialAuthState(state: OfficialAuthState) {
		this.officialAuthState = state;
		window.dispatchEvent(new CustomEvent('pokemonai-auth-change', { detail: state }));
	},
	modeURL(mode: AppMode) {
		// Always pass mode changes through the site root. The local web server
		// injects its selected Showdown port there; production serves the same
		// client from `/` and needs no extra parameter.
		const url = new URL('/', location.href);
		url.searchParams.set('mode', mode);
		url.hash = '';
		return url.toString();
	},
	navigateToMode(mode: AppMode) {
		safeStorageSet(MODE_KEY, mode);
		location.assign(this.modeURL(mode));
	},
	redactSensitive(value: string) {
		return redactSensitiveText(value);
	},
};

installDiagnosticRedaction();
safeStorageSet(MODE_KEY, appMode);
if (!safeStorageGet(LOCALE_KEY)) safeStorageSet(LOCALE_KEY, 'zh-CN');
document.documentElement.dataset.appMode = appMode;
document.documentElement.lang = 'zh-CN';

const Config = (window as any).Config = {
	version: 'pokemonai-client',
	bannedHosts: [],
	whitelist: ['pokemonshowdown.com', 'smogon.com', 'pokeapi.co'],
	routes: {
		root: 'pokemonshowdown.com',
		client: 'play.pokemonshowdown.com',
		dex: 'dex.pokemonshowdown.com',
		replays: 'replay.pokemonshowdown.com',
		users: 'pokemonshowdown.com/users',
		teams: 'teams.pokemonshowdown.com',
	},
	defaultserver: modeProfiles[appMode].server,
	customcolors: {},
	testclient: true,
	pokemonai: appMode === 'ai',
	pokemonaiApp: PokemonAIApp,
};

(window as any).PokemonAIApp = PokemonAIApp;
(window as any).Config = Config;

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && location.protocol !== 'file:') {
	window.addEventListener('load', () => {
		navigator.serviceWorker.register('/pokemonai-sw.js', { updateViaCache: 'none' }).catch(() => undefined);
	});
}
