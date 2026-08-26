/** Generated from config/agents.yaml. Do not edit by hand. */
/* eslint-disable @stylistic/max-len */
export interface PokemonAIFormat {
	id: string; label: string; showdownFormat: string; gameType: 'singles' | 'doubles';
	teamPreview: string; openTeamSheets: boolean; description: string; requiresTeam: boolean;
}
export interface PokemonAIOpponent {
	id: string; label: string; username: string; formatId: string;
	availability?: string; reason?: string;
}
export const PokemonAIConfig = {
	defaultFormat: "champions-ranked-doubles",
	sourceUrl: "/pokemonai-source.tar.gz",
	teamLibraryUrl: "/data/pokemonai-teams.json",
	formats: [
		{ id: "champions-ranked-doubles", label: "Champions 排位 64 双打", showdownFormat: "gen9championsvgc2026regmb@@@!Open Team Sheets", gameType: "doubles" as 'singles' | 'doubles', teamPreview: "bring6_pick4", openTeamSheets: false, description: "闭队表 BO1，六选四、双首发，Champions Regulation M-B。", requiresTeam: true },
		{ id: "champions-ranked-singles", label: "Champions 排位 63 单打", showdownFormat: "gen9championsbssregmb", gameType: "singles" as 'singles' | 'doubles', teamPreview: "bring6_pick3", openTeamSheets: false, description: "闭队表 BO1，六选三、单首发，Champions Regulation M-B。", requiresTeam: true },
		{ id: "champions-ou", label: "Champions 66 OU 单打", showdownFormat: "gen9championsou", gameType: "singles" as 'singles' | 'doubles', teamPreview: "full_team", openTeamSheets: false, description: "闭队表 BO1，六只全部参战，Champions OU 禁限。", requiresTeam: true },
	] as PokemonAIFormat[],
	opponents: [
		{ id: "ranked-doubles-ai", label: "AI 对手", username: "PokemonAI Doubles", formatId: "champions-ranked-doubles" },
		{ id: "ranked-singles-ai", label: "AI 对手", username: "PokemonAI Singles", formatId: "champions-ranked-singles" },
		{ id: "ou-ai", label: "AI 对手", username: "PokemonAI OU", formatId: "champions-ou" },
	] as PokemonAIOpponent[],
} as const;
