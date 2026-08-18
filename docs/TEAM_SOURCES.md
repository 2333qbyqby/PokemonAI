# 阵容源与统一阵容库

## 设计目的

阵容源层把本地队伍、开源项目中的队伍文件和未来的环境数据转换成同一种
`TeamRecord`，供三个地方共用：AI 对手轮换、玩家阵容库 UI 和算法回归测试。运行时
不直接读取任意 GitHub 仓库。

```text
本地目录 / 固定 GitHub commit
          │
          ▼
安全发现与下载（只允许数据文件）
          │
          ▼
Adapter：paste / packed / JSON / YAML
          │
          ▼
TeamSet[6] → packed + paste + metadata
          │
          ├─ SHA-256 内容指纹去重
          ├─ 体系标签
          ├─ 来源/commit/许可证
          └─ 同版本 Showdown validate-team
                 │
                 ▼
 data/team-library/index.json
 public data/pokemonai-teams.json
```

## 支持格式

- Pokémon Showdown 可读 paste；
- Pokémon Showdown packed team；
- 包含 `paste`、`packed`、`team`、`teams`、`sets` 或 `data` 字段的 JSON/YAML；
- 直接由六个结构化 set 构成的 JSON/YAML；
- 本地目录；
- GitHub 仓库中的固定 40 位 commit。

声明式 Adapter：

- `showdown-directory`：项目内 paste/packed 文件；
- `vgc-bench`：VGC-Bench 的目录和结构化队伍；
- `pokemon-vgc-ai`：pokemon-vgc-ai 的 paste/packed 队伍，并映射到 Champions pool；
- `generic-json`、`generic-yaml`、`auto`。

Adapter 是受控解析模式，不是可以从外部仓库动态导入并执行的 Python 插件。

## 安全约束

GitHub 来源必须：

- 使用 `owner/repository` 格式；
- 固定到完整 40 位 commit；
- 只匹配配置中的 include 路径；
- 只允许 `.txt`、`.team`、`.paste`、`.packed`、`.json`、`.yaml`、`.yml`；
- 遵守 `max_files` 和 `max_total_bytes`；
- 防止绝对路径和 `..` 路径穿越；
- 拒绝指向配置根目录外部的符号链接；
- 校验 Git tree 声明的字节数和 Git Blob SHA，并记录 SHA-256；
- 先写入临时目录，全部校验成功后原子替换旧缓存，失败时保留上一份可用缓存；
- 不执行仓库代码、构建脚本、安装脚本或 Git hook。

许可证为 `UNKNOWN` 的来源不能启用、显式同步或加入构建，除非维护者审核后设置
`allow_unknown_license: true`。这个开关意味着维护者接受相应授权责任，不是自动判定。

## 配置示例

```yaml
cache_dir: data/team-sources/cache
library_dir: data/team-library
sources:
  - id: my-teams
    label: 我的阵容
    type: directory
    path: data/team-sources/local
    adapter: showdown-directory
    enabled: true
    license: AGPL-3.0-only
    format_id: champions-reg-mb
    pool: champions-reg-mb

  - id: vgc-bench
    label: VGC-Bench
    type: github
    repository: cameronangliss/vgc-bench
    ref: d79f9532947ac114dce1dda2456a590afcd375b2
    include: ["teams/**/*"]
    adapter: vgc-bench
    enabled: false
    license: MIT
```

`enabled: true` 的来源会进入常规构建；默认关闭、许可证已知的来源可以通过
`--source` 临时显式加入。默认关闭且许可证未知的来源仍会被拒绝。

## 命令

Windows bootstrap 后：

```powershell
$py = '.\.runtime\venvs\baseline-ai\Scripts\python.exe'

# 同步所有 enabled GitHub 来源
& $py .\scripts\team-library.py sync --project-root .

# 只同步一个默认关闭但许可证已知的来源
& $py .\scripts\team-library.py sync --project-root . --source vgc-bench

# 构建 enabled 来源
& $py .\scripts\team-library.py build --project-root .

# 将指定的默认关闭来源额外加入本次构建
& $py .\scripts\team-library.py build --project-root . --source vgc-bench

# 查看索引
& $py .\scripts\team-library.py list --project-root .
```

Linux/已安装开发环境下可使用：

```bash
PYTHONPATH=services/baseline-ai/src python3 scripts/team-library.py build --project-root .
```

## 格式归属与可玩性

每支队伍必须有 `format_id` 和 `pool`。来源可以显式指定；没有指定时 Adapter 会根据
目录和文件名推断。无法确定的队伍会标记为 `unclassified` 或 `vgc-unclassified`，仍可
出现在研究索引中，但不会自动进入 Champions 运行池。

构建器只接受恰好六个 set 的 VGC 队伍。相同队伍的 paste/packed 或多个来源版本会得到
相同 fingerprint；索引保留重复来源信息，但运行池只保留一个实体。

## Showdown 校验

当 `vendor/pokemon-showdown/data/tags.ts` 可用时，构建器调用：

```text
node vendor/pokemon-showdown/pokemon-showdown validate-team <showdown-format>
```

结果：

- `valid`：可运行；
- `invalid`：写入错误但不进入公开 UI 和运行池；
- `prevalidated`：通过本地结构、六只、物种/道具重复、Champions Stat Points 与 IV 检查，但当前源码包缺少完整 Showdown 数据；
- `unclassified`：没有对应 Format Pack。

运行时阵容池拒绝所有以 `invalid` 开头的状态，但允许 `prevalidated`，以便薄源码包完成首次修复
前仍能生成静态目录。正式部署应在 bootstrap/Docker 构建后重新验证并得到 `valid`。

## 外部项目说明

项目按 MIT 许可证随包提供 VGC-Bench 固定提交中的 MB1–MB4 Reg M-B 样例，并保留
许可证、仓库、commit 与原路径；完整 VGC-Bench 来源默认不下载，可显式同步用于扩展阵容池和泛化评测。
与当前 Champions Regulation 不匹配的队伍不会被强行放进运行池。

`pokemon-vgc-ai` 的 paste/packed 目录结构已被适配，但检查时没有发现可确认的仓库级
许可证，因此配置保持关闭并阻止再分发。交付中的可玩样例只来自许可证明确的
VGC-Bench 子集，不包含该许可证未知项目的阵容文件。
