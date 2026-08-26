# 队伍来源

队伍源由 [config/team-sources.yaml](../config/team-sources.yaml) 声明，生成索引写入 `var/generated/team-library/index.json`，浏览器公开副本写入 `var/generated/public/pokemonai-teams.json`。

当前内置数据：

- 64 双打：VGC-Bench MB1-MB4 的 MIT 队伍文件。
- 63 单打：同一批合法 Champions 队伍作为普通队伍样例。
- 66 OU：只纳入通过 `gen9championsou` 校验的 MB3。
- 用户队伍：`resources/teams/builtin/`，默认进入 64 队伍池。

VGC-Bench 在这里仅是带许可证和固定来源记录的队伍数据，不是 AI、模型或运行依赖。

## 构建

```powershell
$py = '.\.runtime\venvs\control-plane\Scripts\python.exe'
& $py .\scripts\team-library.py build --project-root .
```

构建过程会：

1. 只读取声明目录和允许的扩展名。
2. 解析 Showdown paste、packed team、JSON 或 YAML。
3. 规范化 set，并按 `format_id + pool + content fingerprint` 去重。
4. 使用锁定版 Showdown 对每个目标格式执行 `validate-team`。
5. 保留来源、许可证、固定提交、原路径和校验错误。

无许可证或校验失败的队伍不会进入 AI 可用索引。相同队伍可以在不同格式池中分别存在，因为合法性与选出规则不同。

## 新增本地来源

在 `config/team-sources.yaml` 增加稳定的来源 ID：

```yaml
- id: local-singles
  label: 我的 63 队伍
  type: directory
  path: resources/teams/my-singles
  include: ["**/*.txt"]
  adapter: showdown-directory
  enabled: true
  license: USER-PROVIDED
  format_id: champions-ranked-singles
  pool: champions-ranked-singles
```

路径必须留在项目目录内；同步器不会执行来源中的脚本。公开或再分发第三方队伍前，必须确认许可证并保留 attribution。

## Meta 本地导入

环境数据页的“本地文件”导入与队伍库用途不同：它把完整队伍或统计数据写入 Meta staging，用于 Belief 先验，不会自动加入玩家可选队伍库。发布前仍需预览来源、格式和错误。
