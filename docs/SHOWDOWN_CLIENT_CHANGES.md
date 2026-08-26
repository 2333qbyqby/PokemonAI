# Showdown client 上游修改点

PokemonAI 的客户端代码位于 `apps/showdown-client/play.pokemonshowdown.com/src/pokemonai*`。新增代码优先进入 `src/pokemonai/`；目前运行时 catalog 位于 `src/pokemonai/catalog.ts`。上游面板只保留入口、展示和调用。

稳定边界：

- `pokemonai-app.ts` 负责 AI/真人模式、官方 SID 和现有 localStorage 键。
- `pokemonai.ts` 负责认证、挑战、队伍选择和旧键迁移。
- `pokemonai-config.ts` 是 `agents.yaml` 生成的离线回退。
- `/runtime/catalog.json` 是首选目录；失败时无需提示即可回退。
- `panel-mainmenu.tsx` 只展示对手信息、可用性和原因，不出现后端、模型或设备。

更新上游 Showdown client 时，优先保留这些独立文件，并检查 `panel-mainmenu.tsx`、战斗面板注册、`testclient-new.html` 脚本顺序和 PokemonAI CSS 引用。
