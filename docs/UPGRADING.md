# 上游升级流程

第一版禁止依赖自动漂移。升级前创建分支并记录 `config/runtime-lock.json`、
`.gitmodules` 和当前 submodule/tree 提交。

## Showdown Client subtree

```bash
git remote add showdown-client https://github.com/smogon/pokemon-showdown-client.git
git fetch showdown-client
git subtree pull --prefix apps/showdown-client showdown-client <new-commit> --squash
```

解决冲突时只保留 PokémonAI 在 `panel-mainmenu.tsx`、`panel-battle.tsx`、
`pokemonai.ts`、`pokemonai-config.ts` 和 `testclient-new.html` 的有意修改。更新
`runtime-lock.json` 和第三方声明中的提交。

## Showdown Server / Foul Play submodule

```bash
git -C vendor/pokemon-showdown fetch origin
git -C vendor/pokemon-showdown checkout <new-commit>
git -C vendor/foul-play fetch origin
git -C vendor/foul-play checkout <new-commit>
git add vendor/pokemon-showdown vendor/foul-play
```

不要直接在 submodule 内保留整合补丁；本项目通过配置、启动参数和独立适配器集成。

## Python / Rust / Node 依赖

更新锁定版本与官方 URL 后，删除一个专门的测试 checkout 中的 `.runtime/`，从零运行：

```powershell
.\scripts\bootstrap.ps1
.\scripts\test.ps1 -Integration
.\scripts\test-prod.ps1
```

检查四场对战均为正常终局、没有非法行动、日志路径正确、专家确实打印 MCTS 搜索和
太晶特性相关决策。最后在临时 VPS 从空环境重建并用手机蜂窝网络验收 HTTPS、401、
WebSocket 与 8000 不可公网访问，再合并升级提交。
