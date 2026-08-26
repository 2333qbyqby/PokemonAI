# 升级锁定依赖与 Regulation

PokémonAI 的机制结果由锁定版 Showdown 决定。升级时一次只改一个上游，并记录新旧提交。

## Showdown

```powershell
git -C vendor/pokemon-showdown fetch origin
git -C vendor/pokemon-showdown checkout <commit>
```

同步修改 [config/runtime-lock.json](../config/runtime-lock.json) 和 submodule 指针，然后运行：

```powershell
.\scripts\bootstrap.ps1 -Force
.\scripts\test.ps1 -Integration
```

必须复查三个 Format Pack 的最终 RuleTable、队伍校验、`Battle.toJSON()/fromJSON()` 一致性和真实对局。

## Regulation

更新 Champions Regulation 时：

1. 在锁定 Showdown 提交中确认目标格式、机制数据和 RuleTable。
2. 修改 `packages/pokemonai-engine/src/formats.ts` 与 `config/agents.yaml`。
3. 更新 Meta source 的 upstream format 映射和队伍池。
4. 重新生成客户端配置、队伍索引并发布匹配的新 Meta 快照。
5. 运行三格式单元、属性、集成和 Arena 评测。

环境名称不得写入启发式策略。公开格式 ID、持久化键或用户队伍字段需要改动时，先增加读取旧值和可重复迁移测试，验证成功后再清理旧数据。

## 客户端与静态数据

Showdown 客户端和 PokéAPI 静态中文数据分别按其固定提交升级。更新后执行完整客户端构建、TypeScript、ESLint、CSP、SID 生命周期和移动端截图检查。不得在浏览器运行时新增 PokéAPI 请求。
