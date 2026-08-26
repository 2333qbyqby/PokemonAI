# PokémonAI

PokémonAI 是一个以锁定版 Pokémon Showdown 为规则真源的闭队表 BO1 对战平台。当前只提供一个最高强度 AI，支持任意合法队伍和三个 Champions 格式：

| 格式 ID | 对局 | Showdown 规则 |
|---|---|---|
| `champions-ranked-doubles` | 64 双打，双首发 | `gen9championsvgc2026regmb@@@!Open Team Sheets` |
| `champions-ranked-singles` | 63 单打 | `gen9championsbssregmb` |
| `champions-ou` | 66 OU 单打 | `gen9championsou` |

三种格式都关闭公开队表。Regulation 更新通过 [Format Pack](packages/pokemonai-engine/src/formats.ts)、Showdown 锁定提交和 Meta 映射完成，策略代码不绑定环境名称或特定物种。

## 已实现能力

- TypeScript `pokemonai-engine`：公开状态归约、完整联合动作、Belief、Unknown Tail、队伍画像、对局计划、强启发式、对手模型、风险调整搜索和可复现决策日志。
- Node `agent-runtime`：Showdown WebSocket、闭队挑战、原生登录、队伍轮换、会话截止时间、Worker Threads 和请求提交前复验。
- Showdown 粒子：联合队伍假设被构造成私有 Showdown 世界，以公开 HP、状态和活跃位约束；Worker 使用 `Battle.toJSON()/fromJSON()` 克隆并展开同时行动。
- Python `pokemonai-core`：配置、后端发现、队伍库、Meta 导入/发布/回滚、Arena 和进程管理。
- 环境数据页：从 MunchStats 手动检查三种格式的最新数据，支持预览、发布与回滚。
- 保留 Showdown 网页客户端、真人模式、官方 SID 安全边界、PWA、移动端布局和队伍库。

模型接口 `PolicyPrior`、`OpponentModel` 和 `ValueEstimator` 已保留。当前不训练或分发 BC、Value、RL 模型；模型缺失不影响纯 CPU 运行。

## 决策链路

```text
ShowdownTransport
  -> BattleObservation + BattleEvent + LegalSideAction
  -> MetaSnapshot -> BeliefState -> WorldParticles
  -> TeamProfile + GamePlan + HeuristicPolicy
  -> MetaOpponentModel
  -> Showdown Worker Pool
  -> Expected value + lower tail + worst response
  -> validated action + DecisionTrace
```

`BattleObservation` 只包含玩家可见信息。`WorldParticle` 的完整配置与模拟器状态不会写入 trace 或发送给客户端。相同可见历史、Format Pack、Meta 来源日期和随机种子会产生相同候选排序与动作。

## Windows 启动

首次安装：

```powershell
.\scripts\bootstrap.ps1
```

启动和停止：

```powershell
.\scripts\start-local.ps1
.\scripts\stop-local.ps1
```

也可以双击 `PokemonAI.bat`。默认地址是 `http://127.0.0.1:8080/`，Showdown 监听 `127.0.0.1:8000`。自定义端口：

```powershell
.\scripts\start-local.ps1 -WebPort 18080 -ShowdownPort 18000 -NoBrowser
```

本地 Showdown 使用 `--no-security`，机器人登录不访问外部认证服务。真人模式仍由浏览器直接连接官方 Showdown；SID 只保存在浏览器 `pokemonai-official-sid`，不会进入自建服务、URL 或日志。

## Meta 快照

浏览器 AI 页面中的“环境数据”提供固定流程：

```text
检查更新 -> 下载到 staging -> 预览差异与错误 -> 设为当前
```

控制面接口：

- `GET /api/meta/status`
- `POST /api/meta/imports`
- `GET /api/meta/imports/{id}`
- `POST /api/meta/imports/{id}/publish`
- `POST /api/meta/rollback`

网络导入只允许 MunchStats 的固定 HTTPS 主机，并使用大小限制、超时和退避。更新只比较来源日期，快照直接写入 JSON；发布原子替换 current/previous，新数据只影响后续创建的对局。物种边际画像不会伪装成来源提供的完整联合配置。

## 队伍库

重建并用锁定版 Showdown 校验队伍：

```powershell
& .\.runtime\venvs\control-plane\Scripts\python.exe .\scripts\team-library.py build --project-root .
```

项目保留 VGC-Bench 固定提交中的 4 个 MIT 队伍文件，作为普通的有许可证队伍数据，不包含其 AI、训练或运行后端。队伍来源与许可证规则见 [docs/TEAM_SOURCES.md](docs/TEAM_SOURCES.md)。

## 测试与 Arena

完整测试：

```powershell
.\scripts\test.ps1
```

增加本地服务和三种格式真实对局：

```powershell
.\scripts\test.ps1 -Integration
```

Arena 将当前 AI 与“不使用 Belief 和搜索的确定性合法伤害基线”对战，并保存复现元数据：

```powershell
& .\.runtime\venvs\control-plane\Scripts\python.exe -m pokemonai_core.cli `
  --project-root . arena run --config .\config\arena.example.yaml
```

报告写入 `var/evaluations/<timestamp>/`。默认示例为 1,000 场；开始前应先启动本地服务。

## Docker

```bash
docker compose -f compose.prod.yml up -d --build
docker compose -f compose.prod.yml ps
```

Compose 包含 Web/Caddy、Showdown、控制面和三个独立 AI 容器。`var/` 作为运行卷共享 Meta、实例配置、队伍索引和日志。Web 镜像提供当前部署对应的 AGPL 源码归档。

## 目录

- `packages/pokemonai-engine`：策略与搜索数据面。
- `services/agent-runtime`：Showdown 对战运行时。
- `packages/pokemonai-core`：Python 控制面公共包。
- `services/control-plane`：静态站点、目录、Meta API 和 Supervisor。
- `apps/showdown-client`：修改后的 Showdown 客户端。
- `config`：Format、对手、队伍源、Arena 与运行时锁定。
- `resources/teams`：提交仓库的队伍与许可证。
- `var`：生成物、快照、日志、回放和评测，不提交 Git。
- `.runtime`：项目本地 Node/Python 与缓存，不提交 Git。

## 边界

- 权威环境是本地锁定版 Showdown；不控制 Pokémon Champions 主机客户端。
- 所有 AI 对局是闭队表 BO1；公开平台只保留传输接口。
- 粒子状态由公开局面和联合假设约束，不读取服务器真实隐藏状态。构造或模拟失败时按粒子降级，最终仍只提交当前 request 验证通过的命令。
- 当前为启发式叶子价值，没有神经网络或 RL 强度声明。是否达到目标胜率必须由指定 Meta 快照和配对种子 Arena 报告证明。

## 许可证

整合代码和修改后的客户端使用 AGPL-3.0-only。第三方组件保留各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。项目不隶属于 Nintendo、Creatures、GAME FREAK 或 The Pokémon Company。
