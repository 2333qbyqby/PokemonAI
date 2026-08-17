# PokémonAI

PokémonAI 第一版是一个个人使用、完全开源的 Gen 9 Random Battle AI 对战站。
它保留 Pokémon Showdown 的官方战斗界面，并整合三档 poke-env 基线 AI 和一档
Foul Play MCTS AI。

## 已实现范围

- 首页“AI 对战”入口、四档难度、游客昵称流程、同难度再来一局和更换难度。
- 简单 `RandomPlayer`、普通 `MaxBasePowerPlayer`、困难
  `SimpleHeuristicsPlayer`、专家 Foul Play（500ms MCTS）。
- 仅 `gen9randombattle`，每个机器人同时只接受一场。
- Windows 项目内 Node/Python/Rust/uv 和两个互相隔离的 Python 环境。
- 本地进程守护、完整 Showdown 对战 JSON、AI 决策日志和原始输出。
- Ubuntu VPS 的 Docker Compose、Caddy HTTPS、Basic Auth 和 WebSocket 反代。
- 页面内“源码”入口指向本次构建随站点提供的源码归档。

第一版不包括账号系统、自定义配队、多人并发、PWA、LLM、训练或排行榜。

## Windows 本地启动

需要 Windows 10/11、PowerShell 7（Windows PowerShell 5.1 也可）、Git 和网络。
系统 Node/Python/Rust 的版本不会被使用，也不会修改系统 PATH。

```powershell
.\scripts\bootstrap.ps1
.\scripts\start-local.ps1
```

浏览器会打开 <http://127.0.0.1:8080>。停止服务：

```powershell
.\scripts\stop-local.ps1
```

若端口已占用，可显式选择其他端口：

```powershell
.\scripts\start-local.ps1 -WebPort 8081 -ShowdownPort 8001
```

同一 Wi-Fi 手机调试时使用 `-ListenLan`；脚本会显示局域网 URL。该模式没有
HTTPS 或密码，只应在可信局域网短时使用。默认只监听 `127.0.0.1`。

`bootstrap.ps1` 会校验官方 SHA-256，并把以下内容放进 `.runtime/`：

- Node.js 24.19.0、uv 0.12.5、Python 3.12.13、Rust 1.97.1；
- npm/uv/Cargo 缓存；
- `baseline-ai` 与 `foul-play` 两个虚拟环境。

专家环境优先使用 `artifacts/wheels/poke_engine-0.0.48-*.whl`。没有 wheel 时，
会使用项目内 Rust 和本机 MSVC 构建；没有 MSVC 的机器应从项目 Release 下载
预编译 Windows wheel 放入上述目录后再运行 bootstrap。

## 配置与日志

新增或调整 AI 的唯一登记入口是 [config/agents.yaml](config/agents.yaml)。运行
bootstrap 或测试会生成客户端公开配置；战斗 UI 不硬编码机器人用户名。

运行数据均在未提交的 `data/`：

- `data/battles/YYYY-MM/gen9randombattle/.../*.log.json`：完整 Showdown 对战；
- `data/agents/baseline/decisions/*.jsonl`：基线 AI 每次决策和耗时；
- `data/agents/foul-play/logs/`：Foul Play 原始日志；
- `data/process-logs/`：所有本地进程 stdout/stderr；
- `data/test-results/`：端到端机器人对战结果。

本地 Supervisor 每秒检查 Showdown、四个 AI 进程和静态站点；异常退出会自动
拉起。`stop-local.ps1` 会先停止 Supervisor，再停止所有托管子进程。

## 测试

静态与单元测试：

```powershell
.\scripts\test.ps1
```

这会运行配置/部署测试、客户端构建、TypeScript 检查、ESLint 和客户端单元测试。
四档真实对战（专家场可能需要数分钟）：

```powershell
.\scripts\test.ps1 -Integration
```

集成测试默认使用 18000/18080，避免和日常服务冲突。Docker/Caddy 的生产配置
校验在已安装 Docker 的机器运行：

```powershell
.\scripts\test-prod.ps1
```

## Ubuntu VPS 部署

目标是 Ubuntu 24.04 x86-64、2 vCPU、4 GB RAM、20 GB 磁盘。VPS 只需 Git、
Docker Engine 和 Docker Compose 插件，不需要 Node、Python或 Rust。先把域名 A/AAAA
记录指向 VPS，并只放行 22、80、443。

```bash
cp .env.example .env
docker run --rm caddy:2.10.2-alpine caddy hash-password --plaintext '换成强密码'
```

编辑 `.env`：设置真实域名、ACME 邮箱、用户名，并把输出的密码哈希放在单引号内。
然后部署：

```bash
mkdir -p data/battles data/agents/baseline data/agents/foul-play
docker compose -f compose.prod.yml up -d --build
docker compose -f compose.prod.yml ps
```

Caddy 同时保护页面、源码归档和 `/showdown/*` WebSocket；Showdown 只使用 Compose
内部的 `expose: 8000`，没有宿主机端口映射。证书与 Caddy 配置保存在命名卷，
战斗和 AI 日志是仓库目录下的 bind mount。

检查外网端口时，应确认 `https://域名` 未认证返回 401、认证后可进入，且
`http://服务器IP:8000` 无法访问。Caddy 会自动申请和续期证书。

## 备份与恢复日志

部署机上执行：

```bash
tar -C . -czf "pokemonai-logs-$(date +%Y%m%d-%H%M%S).tar.gz" data
```

恢复前停止 Compose，把归档中的 `data/` 解压回同一路径，再重新启动。证书卷通常
无需随日志备份；如要迁移整台服务器，再单独备份 `pokemonai_caddy_data` 卷。

## 版本与升级

所有版本锁定在 [config/runtime-lock.json](config/runtime-lock.json)、submodule 指针和
客户端 subtree 提交。升级必须一次只处理一个上游，记录旧/新提交，重新生成配置，
运行完整单元与四档集成测试，再重建生产镜像。详细命令见
[docs/UPGRADING.md](docs/UPGRADING.md)。

## 开源与许可证

整合代码和修改后的客户端使用 AGPL-3.0-only。AGPL 的关键点是：通过网络向用户
提供修改版程序时，也要让用户能取得对应源码。因此页面上的“PokemonAI 源码”会
下载构建时生成的完整源码归档；这正是愿意开源后可以安全复用官方客户端的原因。

Showdown 服务端、客户端、poke-env、Foul Play 和 poke-engine 的边界、锁定提交及
许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。完整 AGPL 文本保留在
`apps/showdown-client/LICENSE`，根目录 [LICENSE](LICENSE) 说明了整个项目的授权。
