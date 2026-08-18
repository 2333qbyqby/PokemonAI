/** Generated from config/agents.yaml. Do not edit by hand. */
/* eslint-disable @stylistic/max-len */
export interface PokemonAIFormat {
	id: string; label: string; showdownFormat: string; gameType: 'singles' | 'doubles';
	teamPreview: string; openTeamSheets: boolean; description: string; requiresTeam: boolean;
}
export interface PokemonAIOpponent {
	id: string; label: string; username: string; description: string;
	formatId: string; difficulty: number; style: string;
}
export const PokemonAIConfig = {
	defaultFormat: "champions-reg-mb",
	sourceUrl: "/pokemonai-source.tar.gz",
	teamLibraryUrl: "/data/pokemonai-teams.json",
	formats: [
		{ id: "champions-reg-mb", label: "Pokémon Champions VGC 2026 Reg M-B", showdownFormat: "gen9championsvgc2026regmb", gameType: "doubles" as 'singles' | 'doubles', teamPreview: "bring6_pick4", openTeamSheets: true, description: "六选四双打、开放队伍表，面向 Pokémon Champions 的 VGC 对练。", requiresTeam: true },
		{ id: "gen9-random", label: "Gen 9 Random Battle", showdownFormat: "gen9randombattle", gameType: "singles" as 'singles' | 'doubles', teamPreview: "none", openTeamSheets: false, description: "保留原项目的随机单打模式。", requiresTeam: false },
	] as PokemonAIFormat[],
	opponents: [
		{ id: "vgc-1", label: "VGC Lv.1", username: "PokemonAI VGC 1", description: "只做基本属性、伤害与合法目标判断，在合理行动中高温抽样。", formatId: "champions-reg-mb", difficulty: 1, style: "relaxed" },
		{ id: "vgc-2", label: "VGC Lv.2", username: "PokemonAI VGC 2", description: "会使用 Protect、基础速度控制和简单协同。", formatId: "champions-reg-mb", difficulty: 2, style: "relaxed" },
		{ id: "vgc-3", label: "VGC Lv.3", username: "PokemonAI VGC 3", description: "具备基础双打联合行动评价。", formatId: "champions-reg-mb", difficulty: 3, style: "balanced" },
		{ id: "vgc-4", label: "VGC Lv.4", username: "PokemonAI VGC 4", description: "更重视击杀、换位、顺风和戏法空间。", formatId: "champions-reg-mb", difficulty: 4, style: "balanced" },
		{ id: "vgc-5", label: "VGC Lv.5", username: "PokemonAI VGC 5", description: "能识别常见 Fake Out、重定向与队友强化组合。", formatId: "champions-reg-mb", difficulty: 5, style: "balanced" },
		{ id: "vgc-6", label: "VGC Lv.6", username: "PokemonAI VGC 6", description: "使用更严格的候选剪枝和风险评价。", formatId: "champions-reg-mb", difficulty: 6, style: "aggressive" },
		{ id: "vgc-7", label: "VGC Lv.7", username: "PokemonAI VGC 7", description: "低温选择，重视速度顺序和资源保存。", formatId: "champions-reg-mb", difficulty: 7, style: "balanced" },
		{ id: "vgc-8", label: "VGC Lv.8", username: "PokemonAI VGC 8", description: "当前 CPU 版最高强度，使用完整联合动作排序。", formatId: "champions-reg-mb", difficulty: 8, style: "expert" },
		{ id: "random-easy", label: "随机单打·简单", username: "PokemonAI Easy", description: "随机选择合法行动，适合熟悉操作。", formatId: "gen9-random", difficulty: 1, style: "balanced" },
		{ id: "random-normal", label: "随机单打·普通", username: "PokemonAI Normal", description: "偏好高威力进攻招式。", formatId: "gen9-random", difficulty: 3, style: "balanced" },
		{ id: "random-hard", label: "随机单打·困难", username: "PokemonAI Hard", description: "考虑属性、换人、场地、强化和太晶。", formatId: "gen9-random", difficulty: 5, style: "balanced" },
		{ id: "random-expert", label: "随机单打·专家", username: "PokemonAI Expert", description: "使用 Foul Play 的 MCTS 搜索。", formatId: "gen9-random", difficulty: 8, style: "balanced" },
	] as PokemonAIOpponent[],
} as const;
