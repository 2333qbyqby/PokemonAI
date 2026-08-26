# 数据目录与迁移

运行数据统一放在 `var/`：

```text
var/logs          进程、AI 决策和 Showdown 日志
var/replays       AI 回放
var/evaluations   Arena 与集成测试结果
var/run           精简实例配置和状态
var/generated     团队索引与浏览器公开索引
```

提交仓库的阵容放在 `resources/teams`；第三方同步缓存放在 `var/cache/team-sources`。模型和独立环境放在 `.runtime`。

迁移旧数据：

```powershell
pokemonai state migrate
```

命令复制文件并逐个校验 SHA-256，默认保留 `data/` 中的旧用户数据。只有确认副本完整后，显式执行 `pokemonai state migrate --prune-legacy` 才会删除已验证的旧目录。浏览器继续通过 `/data/pokemonai-teams.json` 访问团队目录，控制平面把它映射到 `var/generated/public/pokemonai-teams.json`。
