# PokémonAI

PokémonAI 是一个个人使用、完全开源的宝可梦 AI 对战站。它复用 Pokémon Showdown
的规则引擎和战斗界面，在 PC 与手机浏览器中提供可调难度的
**Pokémon Champions VGC 2026 Regulation M-B** 双打陪练，同时保留 Gen 9 Random
Battle 单打模式；一个剑盾风格中文界面既能连接自建 Pokémon Showdown 与 AI 训练，
也能由浏览器直接连接 Showdown 官方服务器进行真人随机匹配或指定玩家挑战。

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
- `AI 训练` / `真人竞技` 双模式，切换服务器时受控刷新，不保留跨服房间状态。
- 随机单打四档难度与 VGC 八档难度，官方随机匹配、指定玩家挑战、游客昵称和
  SID 设备授权流程；真人模式只开放 `gen9randombattle`。
- 本地 `zh-Hans` 界面与术语数据，以及为 844×390 横屏对战优化的触控布局。
- 官方密码不会进入 PokémonAI；SID 只保存在当前浏览器并仅发往官方登录接口。
- Windows 项目内 Node/Python/Rust/uv 和两个互相隔离的 Python 环境。
- 本地进程守护、完整 Showdown 对战 JSON、AI 决策日志和原始输出。
- Ubuntu VPS 的 Docker Compose、Caddy HTTPS、Basic Auth 和 WebSocket 反代。
- 页面内“源码”入口指向本次构建随站点提供的源码归档。

暂不包括聊天大厅、赛事、多人并发、LLM、训练或排行榜。

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

最简单的方式是在资源管理器中双击项目根目录的
[`PokemonAI.bat`](PokemonAI.bat)。它会优先使用 PowerShell 7，首次运行时自动执行
环境准备，遇到端口占用会从 8080/8000 开始自动选择附近的可用端口，最后打开浏览器。
再次双击会直接打开已经运行的站点。停止时双击
[`Stop-PokemonAI.bat`](Stop-PokemonAI.bat)。首次准备环境需要联网，可能需要几分钟。

也可以在终端中手动执行：

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

## 使用双模式客户端

默认入口是 `/?mode=ai`，顶部模式切换器和首页卡片可以进入真人模式。固定入口为：

- `/?mode=ai`：连接本站 `/showdown`（本地开发时连接启动脚本显示的端口）；
- `/?mode=online`：浏览器直接连接 `wss://sim3.psim.us/showdown/websocket`。

AI 模式先设置游客昵称，再选择规则与难度：Champions VGC 六选四或经典随机单打。
真人模式可直接“快速匹配”，或输入昵称发起指定玩家挑战；真人模式始终固定使用
第九世代随机对战。对战中切换模式会要求确认，确认后先投降，再清理当前服务器状态
并刷新到另一模式。

手机首页支持竖屏；首次进入战斗会提示横置手机。844×390 横屏时，战场约占 65%，
右侧是大尺寸选招/换人区，日志可按需展开。浏览器不会强制锁定屏幕方向。

### 官方账号 SID 授权

真人模式无需账号即可使用游客昵称。如果要使用已注册账号：

1. 在客户端打开“官方账号授权”，前往官方 Test Client 页面并在官方域名完成登录；
2. 复制官方页面提供的 SID，粘贴到 PokémonAI 的设备授权输入框；
3. 保存后页面刷新，客户端收到官方 `challstr` 时直接向官方登录接口验证 SID。

PokémonAI 不提供官方密码输入框，也不会把 SID 发送到自建 Showdown、VPS 后端、URL、
埋点或普通日志。SID 仅保存在当前浏览器的 `pokemonai-official-sid` 键，可随时在授权页
“清除本机授权”。授权失效时需要重新获取；普通网络故障不会自动删除 SID。账号注册、
修改密码和切换其他注册账号仍在官方页面完成，这是 Showdown Test Client 的同源安全
边界，而不是 PokémonAI 的账号系统。

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

运行数据均在未提交的 `data/` 下（见“数据与日志”），战斗 UI 不硬编码机器人用户名。

## 测试

完整 Windows 静态、Python、客户端构建、TypeScript、ESLint 与单元测试：

```powershell
.\scripts\test.ps1
```

这会运行配置/部署测试、客户端构建、TypeScript 检查、ESLint 和客户端单元测试。
测试覆盖模式解析/切换、固定格式、SID 生命周期与日志脱敏、本地中文快照和 CSP。
包含所有机器人真实对战的集成测试：

```powershell
.\scripts\test.ps1 -Integration
```

只跑配置、部署与浏览器端静态测试：

```powershell
.\scripts\test-static.sh
```

## Docker 部署（Ubuntu VPS）

```bash
docker compose -f compose.prod.yml up -d --build
docker compose -f compose.prod.yml ps
```

Showdown 只在 Compose 内网暴露 8000；Caddy 对页面、源码归档和 AI 模式的
`/showdown/*` WebSocket 统一做 HTTPS 与 Basic Auth。真人模式的 WebSocket 和登录
验证由手机浏览器直接访问官方域名，不经过 VPS。Caddy CSP 禁止远程可执行脚本，只
放行本站、官方 WebSocket/登录接口和官方素材域名。证书与 Caddy 配置保存在命名卷，
战斗和 AI 日志是仓库目录下的 bind mount。生产源码归档会在构建时确认并补齐固定
提交的 Showdown 数据，满足修改版网络服务的源码提供要求。

## 更新中文术语快照

运行时不会请求 PokéAPI。维护者升级锁定数据后，可用独立基线 Python 环境重新生成：

```powershell
. .\scripts\common.ps1
& $BaselinePython .\scripts\generate-zh-hans.py
```

若 GitHub 归档接口限流，可把锁定的 `PokeAPI/api-data` 仓库检出到本地，并传入
`--source-dir path\to\api-data`。生成结果和提交元数据会一起进入仓库；
特殊形态或新属性词条维护在 [config/zh-hans-overrides.json](config/zh-hans-overrides.json)。

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

本地 Supervisor 每秒检查 Showdown、AI 进程和静态站点；异常退出会自动拉起。
`stop-local.ps1` 会先停止 Supervisor，再停止所有托管子进程。

### 备份与恢复日志

部署机上执行：

```bash
tar -C . -czf "pokemonai-logs-$(date +%Y%m%d-%H%M%S).tar.gz" data
```

恢复前停止 Compose，把归档中的 `data/` 解压回同一路径，再重新启动。证书卷通常
无需随日志备份；如要迁移整台服务器，再单独备份 `pokemonai_caddy_data` 卷。

## 已知边界

当前 VGC 最高难度是**完整合法联合动作的 CPU 启发式排序**，不是多回合精确
minimax/MCTS，也没有神经网络或 LLM。它适合个人从休闲到中等强度的陪练，但不能
宣称达到顶尖 VGC 选手水平。精确 Showdown 分支模拟、对手行动收益矩阵和小型
policy/value 网络都保留了清晰扩展边界，尚未伪装成已完成能力。

每个注册机器人同时接受一场挑战；个人部署足够，若未来多人使用，应增加机器人池或
Match Service。PWA 会缓存启动器和阵容库，但离线时没有本地战斗服务，因此不能真正
离线完成对战。当前交付是共享 Web 客户端，不包含 App Store/Play Store 原生壳。

## 版本与升级

所有版本锁定在 [config/runtime-lock.json](config/runtime-lock.json)、submodule 指针和
客户端 subtree 提交。升级必须一次只处理一个上游，记录旧/新提交，重新生成配置，
运行完整单元与集成测试，再重建生产镜像。详细命令见
[docs/UPGRADING.md](docs/UPGRADING.md)。

## 许可证

整合代码和修改后的客户端使用 AGPL-3.0-only。第三方组件继续保留自己的许可证，
详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。完整 AGPL 文本保留在
`apps/showdown-client/LICENSE`，根目录 [LICENSE](LICENSE) 说明了整个项目的授权。
项目不隶属于 Nintendo、Creatures、GAME FREAK 或 The Pokémon Company。
