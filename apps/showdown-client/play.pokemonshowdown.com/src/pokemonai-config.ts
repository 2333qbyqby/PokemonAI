/** Generated from config/agents.yaml. Do not edit by hand. */
export interface PokemonAIOpponent {
	id: string; label: string; username: string; description: string;
}
export const PokemonAIConfig = {
	format: "gen9randombattle",
	sourceUrl: "/pokemonai-source.tar.gz",
	opponents: [
		{ id: "easy", label: "简单", username: "PokemonAI Easy", description: "随机选择合法行动，适合熟悉操作。" },
		{ id: "normal", label: "普通", username: "PokemonAI Normal", description: "偏好高威力进攻招式。" },
		{ id: "hard", label: "困难", username: "PokemonAI Hard", description: "考虑属性、换人、场地、强化和太晶。" },
		{ id: "expert", label: "专家", username: "PokemonAI Expert", description: "使用 Foul Play 的 MCTS 搜索。" },
	] as PokemonAIOpponent[],
} as const;
