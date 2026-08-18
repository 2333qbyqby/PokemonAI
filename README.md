# PokémonAI

PokémonAI 是一个面向个人娱乐的、自托管的宝可梦 AI 对战站。它复用 Pokémon
Showdown 的规则引擎和战斗界面，在 PC 与手机浏览器中提供可调难度的
**Pokémon Champions VGC 2026 Regulation M-B** 双打陪练，同时保留原项目的
Gen 9 Random Battle 单打模式。

项目的首要目标不是做复盘教练或天梯机器人，而是让玩家随时打开网页，选队后就能
从轻松到较难地连续和 AI 对战。VGC 决策器只使用 CPU，不依赖显卡、LLM 或在线模型
API。

## 当前能力

- Champions VGC 六选四、双首发、开放队伍表和双打合法目标。
- 8 档 VGC 难度；低难度在合理候选中抽样，高难度减少随机性并加强风险判断。
- 两个场上位置作为一个联合动作评价，能识别 Fake Out + 强化、重定向 +
  Trick Room、Helping Hand + 进攻、双集火、双换和己方范围伤害等组合。
- 4 套来自 VGC-Bench 固定提交、按 MIT 许可证随包提供的 Reg M-B 样例队伍；每次新对局自动轮换。
- 安全的开源阵容源接入层：Showdown paste、packed、JSON、YAML、本地目录和固定
  GitHub commit，带许可证门槛、文件限制、指纹去重和 Showdown 校验。
- 阵容库页面、规则/难度/队伍一页式启动器、手机触控尺寸与安全区适配。
- 一套 Preact/TypeScript UI 同时覆盖 PC 和手机，并提供可安装的 PWA 外壳。
- 原有 RandomPlayer、MaxBasePowerPlayer、SimpleHeuristicsPlayer 与 Foul Play
  随机单打模式继续保留。
- Windows 本地运行、Ubuntu VPS Docker Compose、Caddy HTTPS/Basic Auth、日志和
  进程守护。

## 工作方式

```text
PC / 手机浏览器
       │
       ▼
响应式 Showdown 客户端 / PWA
       │  challenge + 玩家队伍
       ▼
Pokémon Showdown 服务端  ← 唯一规则真源
       │  合法动作与战斗状态
       ▼
poke-env DoubleBattle
       │
       ├── 六选四 / 双首发评分
       ├── 合法联合动作枚举
       ├── 单动作与搭档协同评分
       ├── OTS / 已知招式风险估计
       └── 难度温度、候选数与合理性下限
       │
       ▼
AI 联合指令
```

VGC 算法实现位于：

- `services/baseline-ai/src/baseline_ai/vgc_policy.py`：纯 Python、可单测的策略层；
- `services/baseline-ai/src/baseline_ai/vgc_player.py`：poke-env 双打适配；
- `services/baseline-ai/src/baseline_ai/runner.py`：机器人注册、阵容轮换和决策日志。

详细设计见 [docs/VGC_ARCHITECTURE.md](docs/VGC_ARCHITECTURE.md)。

Champions 新增了当前通用 poke-env 静态数据中没有的 Mega 形态。baseline 服务因此不
使用 PyPI 上的通用数据快照，而是固定安装 VGC-Bench 使用的 Champions 兼容 fork：
`cameronangliss/poke-env@379a04628e42b2a2c94790c0788204b652f7ae1b`。机器人启动时会
检查 `Staraptor-Mega` 和 `Dragonite-Mega` 等数据标记；安装到错误版本时会立即给出
明确错误，不会等到实际对局中崩溃。该依赖仍为 MIT 许可证，提交与仓库同时记录在
`config/runtime-lock.json` 和 `THIRD_PARTY_NOTICES.md`。

## Windows 本地启动

需要 Windows 10/11、PowerShell、Git 和首次安装时可访问互联网。项目不会修改系统
Node/Python/Rust 或系统 PATH，工具链都安装在 `.runtime/`。

```powershell
.\scripts\bootstrap.ps1
.\scripts\start-local.ps1
```

浏览器会打开 <http://127.0.0.1:8080>。停止服务：

```powershell
.\scripts\stop-local.ps1
```

只运行 VGC 与三档 poke-env 单打、不启动 Foul Play：

```powershell
.\scripts\bootstrap.ps1 -SkipExpert
.\scripts\start-local.ps1 -SkipExpert
```

同一 Wi-Fi 下用手机访问：

```powershell
.\scripts\start-local.ps1 -ListenLan
```

脚本会显示局域网地址。该模式没有 HTTPS 与密码，只应在可信局域网使用。进入页面后
可通过浏览器“添加到主屏幕”安装 PWA；对战本身仍需要连接本机 Showdown 服务。

上传的早期源码包曾误排除 `vendor/pokemon-showdown/data/`。当前 bootstrap 会从
`config/runtime-lock.json` 中的**固定提交**自动补齐缺失文件，不会拉取移动的
`master` 分支。bootstrap 同时会安装上面固定提交的 Champions 兼容 poke-env。第一次
修复或从零创建 Python 环境需要 GitHub 网络访问；后续使用已有 `.runtime/` 不需要重复
下载。

## 阵容库与开源项目接入

项目随包提供 4 套来自 VGC-Bench 固定提交的 MIT 许可证 Champions 样例队伍。构建阵容索引：

```powershell
.\.runtime\venvs\baseline-ai\Scripts\python.exe .\scripts\team-library.py build --project-root .
```

同步 VGC-Bench 中固定提交的数据（MIT，默认不自动下载）：

```powershell
.\.runtime\venvs\baseline-ai\Scripts\python.exe .\scripts\team-library.py sync `
  --project-root . --source vgc-bench
.\.runtime\venvs\baseline-ai\Scripts\python.exe .\scripts\team-library.py build `
  --project-root . --source vgc-bench
```

显式 `--source` 会把默认关闭但许可证已知的来源加入本次操作。`pokemon-vgc-ai` 的
阵容适配器已经实现，但该仓库在检查时没有发现可确认的许可证，因此默认禁止同步和
再分发；只有在你自行确认授权并修改 `config/team-sources.yaml` 后才能启用。

同步器只读取固定 commit 中允许扩展名的数据文件，不 clone 后执行代码，也不会运行
外部仓库的安装脚本。阵容会转换为统一结构、按内容指纹去重，并在完整 Showdown 数据
可用时通过同版本 `validate-team` 校验。详见
[docs/TEAM_SOURCES.md](docs/TEAM_SOURCES.md)。

## 配置

统一入口是 [config/agents.yaml](config/agents.yaml)：

- `formats` 注册 Showdown 格式、单/双打、六选四、OTS 和阵容池；
- `opponents` 注册机器人用户名、后端、格式、难度和风格；
- `default_format` 决定客户端默认选择；
- `team_library_path` 指向运行时阵容索引。

阵容来源在 [config/team-sources.yaml](config/team-sources.yaml)。更换 Champions
Regulation 时，应先更新并验证 Showdown 锁定提交，再添加/修改 Format Pack 与阵容
池，而不是在算法中写死新的宝可梦名称。

修改配置后重新生成公开客户端配置：

```powershell
.\.runtime\venvs\baseline-ai\Scripts\python.exe .\scripts\generate-client-config.py `
  --config .\config\agents.yaml `
  --output .\apps\showdown-client\play.pokemonshowdown.com\src\pokemonai-config.ts
```

## 测试

完整 Windows 静态、Python、客户端构建、TypeScript、ESLint 与单元测试：

```powershell
.\scripts\test.ps1
```

包含所有机器人真实对战的集成测试：

```powershell
.\scripts\test.ps1 -Integration
```

只跑指定机器人可直接使用：

```powershell
.\.runtime\venvs\baseline-ai\Scripts\python.exe .\scripts\run-bot-integration.py `
  --config .\config\agents.yaml `
  --websocket-url ws://127.0.0.1:8000/showdown/websocket `
  --output .\data\test-results\vgc.json `
  --agent vgc-1 --agent vgc-8
```

本次交付环境执行过的测试与未能在沙箱内执行的项目记录在
[IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md)。

## Ubuntu VPS 部署

目标环境为 Ubuntu 24.04 x86-64、2 vCPU、4 GB RAM。VPS 只需要 Git、Docker
Engine 和 Docker Compose 插件。

```bash
cp .env.example .env
docker run --rm caddy:2.10.2-alpine caddy hash-password --plaintext '换成强密码'
# 编辑 .env
docker compose -f compose.prod.yml up -d --build
docker compose -f compose.prod.yml ps
```

Showdown 只在 Compose 内网暴露 8000；Caddy 对页面、源码归档和 WebSocket 统一做
HTTPS 与 Basic Auth。生产源码归档会在构建时确认并补齐固定提交的 Showdown 数据，
满足修改版网络服务的源码提供要求。

## 数据与日志

版本化内容：

- `data/team-sources/vendored/vgc-bench/`：随包提供的 VGC-Bench Reg M-B 样例及 MIT 许可证；
- `data/team-sources/builtin/`：预留给项目自有或用户维护的本地阵容；
- `data/team-library/index.json`：AI 使用的统一阵容索引；
- `apps/.../data/pokemonai-teams.json`：阵容库页面的公开索引。

运行时内容（被 Git/打包排除）：

- `data/battles/`：Showdown 对战日志；
- `data/agents/baseline/decisions/`：AI 候选评分与选择；
- `data/agents/foul-play/`：Foul Play 日志；
- `data/team-sources/cache/`：外部阵容源缓存；
- `data/test-results/`：集成测试结果。

## 已知边界

当前 VGC 最高难度是**完整合法联合动作的 CPU 启发式排序**，不是多回合精确
minimax/MCTS，也没有神经网络或 LLM。它适合个人从休闲到中等强度的陪练，但不能
宣称达到顶尖 VGC 选手水平。精确 Showdown 分支模拟、对手行动收益矩阵和小型
policy/value 网络都保留了清晰扩展边界，尚未伪装成已完成能力。

每个注册机器人同时接受一场挑战；个人部署足够，若未来多人使用，应增加机器人池或
Match Service。PWA 会缓存启动器和阵容库，但离线时没有本地战斗服务，因此不能真正
离线完成对战。当前交付是共享 Web 客户端，不包含 App Store/Play Store 原生壳。

## 许可证

整合代码和修改后的客户端使用 AGPL-3.0-only。第三方组件继续保留自己的许可证，
详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。项目不隶属于 Nintendo、
Creatures、GAME FREAK 或 The Pokémon Company。
