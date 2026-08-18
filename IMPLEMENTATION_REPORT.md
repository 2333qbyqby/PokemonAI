# PokémonAI VGC 端到端实现报告

交付版本：0.2.0  
交付日期：2026-08-18

## 完成范围

本轮改造把原本仅支持 `gen9randombattle` 的个人 AI 对战站扩展为以
`gen9championsvgc2026regmb` 为默认模式的 Pokémon Champions VGC PvE 应用，同时保留
原有随机单打与 Foul Play 专家模式。

完成的核心能力包括：

- 八档 VGC AI，从高温合理抽样逐步收敛到低温联合行动排序；
- 六选四、双首发、两个位置的合法联合行动、目标选择、单换／双换与强制换人；
- Open Team Sheets 接受流程及 poke-env 0.15 的 OTS 请求竞态兼容；
- Protect、Fake Out、速度控制、重定向、Helping Hand、场地天气、强化、双集火、
  重复击杀、队友范围伤害、换人节奏和一次性系统资源等启发式评价；
- 独立的、可版本化阵容源层，支持 Showdown paste、packed、JSON、YAML、本地目录与
  固定 commit 的 GitHub 仓库；
- 阵容来源许可证门禁、Git blob SHA 校验、下载配额、路径逃逸拦截、原子替换、去重、
  Champions Stat Points／31 IV 预校验与可选 Showdown 真值校验；
- 4 支 VGC-Bench MIT 样例阵容随包离线可用；第三方 `pokemon-vgc-ai` 仅作为禁用的
  适配配置存在，因其仓库未声明可确认的许可证而不会被默认下载或再分发；
- 手机／PC 共用的响应式 AI 对战面板、动态阵容库、搜索筛选、阵容复制与本地选择记忆；
- PWA manifest、Service Worker、主屏幕安装资源和手机安全区适配；
- 浏览器挑战流程中的 packed-team 命令分隔符清理，固定队制缺少阵容时会阻止开战；
- Windows 启动、Docker 镜像、Caddy 根路径、源码归档与上游缺失文件的固定提交修复链路。

## 算法结构

VGC AI 没有把两只在场宝可梦独立决策，而是先使用 poke-env 的
`DoubleBattle.valid_orders` 与 `DoubleBattleOrder.join_orders` 枚举 Showdown 认可的合法
联合行动，再由纯 Python 的 `VGCPolicy` 对整个行动对评分。

不同难度共用同一策略实现，通过以下参数连续控制强度，而不是随机选择明显错误的动作：

- 候选质量下限；
- Top-K 候选数量；
- softmax 温度；
- 有界评分噪声；
- 对手威胁权重；
- 队伍预览温度；
- 太晶／Mega 等资源使用阈值。

因此低难度仍会避开免疫目标、非法联合换人和极端送死动作，高难度则更稳定地选择评分最高
的场面方案。决策日志会记录前五个候选、分项得分和耗时，便于后续按实际对局调整权重。

当前实现定位为 CPU 友好的第一代策略：它包含完整的联合行动合法性与较丰富的单回合评价，
但没有把完整 Showdown 状态复制进多层搜索树，也没有引入 GPU 模型。这样更符合个人手机
陪练、低延迟和低服务器配置的目标。未来可以在不改 UI、协议和阵容系统的前提下，将小型
policy/value 模型或 Showdown Sim Worker 接到现有策略接口中。

## 阵容接入

阵容同步工具入口为：

```bash
python scripts/team-library.py list-sources --project-root .
python scripts/team-library.py sync --project-root . --source vgc-bench
python scripts/team-library.py build --project-root .
```

GitHub 阵容源必须固定到 40 位 commit SHA。同步器只读取允许扩展名的数据文件，不克隆后
执行任何外部脚本，不运行依赖安装，也不加载仓库 Python／JavaScript 模块。所有来源、commit、
原始路径、许可证、文件 SHA、阵容 fingerprint 和校验结果都写入私有目录
`data/team-library/index.json`；浏览器使用经过裁剪的公开目录
`data/pokemonai-teams.json`。

## UI 与双端

主入口现在优先展示 AI 对战。AI 面板先选规则，再选难度和阵容；VGC 模式能够直接使用阵容库
中的 packed team，不要求用户先在 Showdown Teambuilder 里建立同一支队伍。游客命名后会保留
待发挑战、格式和阵容。战斗结束后可以同难度再来一局或返回更换设置。

手机端使用单列卡片、大触摸目标、底部安全区和紧凑筛选；PC 端使用双列阵容与更宽的信息区。
两端共用同一 Preact／TypeScript 代码和 Showdown 战斗界面，没有复制业务逻辑。

## 验证结果

最终静态门禁 `./scripts/test-static.sh` 已通过，具体结果为：

- Python 单元测试：**48 项通过**；
- 阵容目录重建：**4 支可用阵容**，私有／公开目录均生成成功；
- 浏览器与 Web Server 测试：**23 项，其中 20 项通过、3 项按条件跳过**；
- 修改过的 TypeScript 定向转译成功；
- 生成 JavaScript、Service Worker 和 Web Server 语法检查通过；
- YAML／JSON 解析、Python `compileall` 和 Git patch whitespace 检查通过；
- Web Server 真实 HTTP 冒烟覆盖健康检查、根路径跳转、manifest MIME、路径穿越、畸形 URL
  和异常后的继续服务；
- 挑战流程测试覆盖离线拦截、固定队缺队拦截、游客命名后恢复、阵容库直接挑战及换行注入清理。

## 沙箱内无法完成的验证

用户上传的源码包是一个“薄上游副本”：其中缺少 Pokémon Showdown 的 `data/` 目录，且归档中
的部分 `node_modules` 是空目录。当前执行环境又无法访问外网，因此本轮不能在沙箱内重新执行
完整的 `npm ci + node build + tsc + eslint`，也不能启动完整 Showdown 进行真实 VGC 对局或构建
Docker 镜像。

交付代码没有隐藏这一限制，而是增加了确定性的修复路径：

```bash
python scripts/ensure-upstreams.py --project-root .
```

Windows `bootstrap.ps1` 会自动运行该步骤；Dockerfile 也会在缺文件时从
`config/runtime-lock.json` 中记录的准确 commit 恢复 Pokémon Showdown 与 Foul Play，再进行正式
构建。因此在具备正常网络的开发机／VPS 上，首次 bootstrap 或 Docker build 才是完整运行验收
的最后一步。此报告不会把该尚未在沙箱中执行的实战测试描述为已通过。

## 主要入口

- `config/agents.yaml`：格式与 AI 难度注册表；
- `config/team-sources.yaml`：阵容源、commit、许可证和配额；
- `services/baseline-ai/src/baseline_ai/vgc_policy.py`：VGC 联合行动策略；
- `services/baseline-ai/src/baseline_ai/vgc_player.py`：poke-env 运行时与 OTS 兼容；
- `services/baseline-ai/src/baseline_ai/team_library.py`：阵容同步、解析、校验和目录；
- `apps/showdown-client/play.pokemonshowdown.com/src/pokemonai.ts`：挑战与阵容选择状态；
- `apps/showdown-client/play.pokemonshowdown.com/src/panel-mainmenu.tsx`：PC／手机 AI 面板；
- `docs/VGC_ARCHITECTURE.md`、`docs/TEAM_SOURCES.md`、`docs/MOBILE_PWA.md`：维护文档。
