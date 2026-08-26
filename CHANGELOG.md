# Changelog

## 2026-08-20 — 轻量 AI 后端架构

- 增加 `pokemonai-core`、约定式后端发现、统一 CLI、精简运行配置和私有 runtime catalog。
- 将 poke-env 与 Foul Play 迁入独立后端，并增加可选 VGC-Bench `PolicyPlayer` 适配器、固定模型校验和 Docker profile。
- 用 Python 控制平面和有限指数退避监控替换 Node supervisor，运行数据统一写入 `var/`。
- 增加 Arena JSON/CSV/Markdown 报告、旧数据校验迁移、客户端不可用状态与静态配置回退。
- 阵容资源迁入 `resources/teams`，拆分 PokemonAI 客户端目录、CSS 和策略/团队库公共组件。
- 删除旧 services、薄启动脚本、论文导出和提交的生成索引；配置及状态不引入版本字段。

## 2026-08-18 — VGC / team library / responsive PWA

- Added multi-format agent registry and Champions VGC 2026 Reg M-B.
- Added an eight-level CPU VGC joint-action policy and six-pick-four preview policy.
- Pinned the Champions-compatible VGC-Bench poke-env fork and added a startup data guard for new Mega forms.
- Added cycling VGC team pools and four traceable MIT-licensed VGC-Bench Reg M-B sample teams.
- Added safe, pinned GitHub/local team-source ingestion for paste, packed, JSON and YAML, with atomic cache replacement and Git blob verification.
- Added team fingerprinting, provenance, license gates and Showdown validation.
- Added VGC-Bench and pokemon-vgc-ai declarative adapters.
- Added responsive AI launcher, team library, PWA manifest and service worker.
- Preserved Random Battle baseline and Foul Play modes.
- Added pinned-upstream repair and corrected source-packaging exclusions.
- Expanded Python, source-ingestion, deployment and browser tests.
