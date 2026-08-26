# PokémonAI 闭队表架构

## 进程边界

```text
Browser / PWA
  -> control-plane (catalog, Meta API, static files)
  -> local Showdown (authoritative rules and battle protocol)
  -> agent-runtime x 3
       -> pokemonai-engine
       -> Showdown worker threads
```

- 浏览器只接收格式、对手可用性和公开队伍目录，不接收后端路径、Meta 私有候选或粒子世界。
- `pokemonai-core` 管理配置、队伍数据、Meta JSON 快照、Arena 和进程状态。
- `agent-runtime` 每个账号一次只接受配置允许的格式；每场对局固定 Meta 来源日期和队伍。
- Showdown 是机制与合法性的唯一规则真源。Format Pack 测试会检查最终 RuleTable，而不只比较格式字符串。

## 信息边界

`ObservationReducer` 只归约对应玩家能收到的协议，包括 Team Preview、招式、伤害、速度顺序、公开道具/特性、状态、场地、换人和倒下。自己的 request 用于合法动作和自己的已知信息，不会把对手隐藏 set 写进观察。

`BeliefEngine` 根据 Team Preview 中的物种画像生成配置假设：

1. 每只宝可梦从 MunchStats 的技能、道具、特性、性格和能力点边际分布中采样。
2. Meta 覆盖之外始终保留至少 10% Unknown Tail。
3. 招式、道具、特性和形态执行硬过滤；速度顺序等公开事件更新条件似然。
4. 后验退化为空时重新约束生成，并在 trace 标记恢复。
5. 粒子状态只存在内存与 Worker 消息中，不进入日志。

## 决策

`TeamProfile` 从队伍招式、道具、特性和基础速度提取速度控制、重定向、干扰、场地、续航、强化、轮转与终局角色。`GamePlan` 再结合双方存活资源决定首发、威胁、保留点和风险姿态。

`HeuristicPolicy` 对完整一方行动评分。双打动作先组成联合命令，再检查重复换入、资源冲突、目标和空位 `pass`。三种策略族共享生存、伤害、击杀、速度、资源、位置、信息、胜利条件与风险分项，再添加格式特有分项。

`MetaOpponentModel` 从 Belief 配置和公开活跃位生成对手候选，并按当前物种的技能携带概率加权。

`ShowdownParticleFactory` 不读取真实隐藏状态。它把每个联合假设构造成锁定版 Showdown 世界，并以当前公开 HP、状态、活跃位、天气和场地约束。Worker 通过 `Battle.toJSON()/fromJSON()` 克隆世界并模拟双方同时行动。无法构造或被 Showdown 拒绝的单个样本会跳过；如果没有完成搜索结果，依次回退启发式和最高分合法动作。

搜索默认限制为 10 秒、预留 500ms、4,000 节点、64 粒子和 8 Worker。64 保留 Top-6 联合动作，单打保留 Top-8；对手响应先按模型概率取 Top-8，再补一个启发式最坏响应。完成首回合矩阵后，如果剩余预算仍超过 40%，Worker 会从 Showdown 的下一次合法 request 对根部 Top-2 做小型第二回合 maximin 展开。选择值综合期望、25% 下尾和最坏响应，领先时提高风险权重；只有置信区间重叠时才按 battle seed 做可复现决胜。

## Meta

导入先读取 MunchStats 的三种格式更新时间。日期未变化时不下载物种详情；变化格式写入 `var/meta/imports/<id>/snapshot.json`。发布步骤为：

1. 校验 staging 同时包含三种格式和完整物种画像。
2. 将现有 `current.json` 保存为 `previous.json`。
3. 原子替换 `current.json`。

失败不会改动当前数据；回滚交换 current/previous。运行中的对局保留创建时的 Meta 对象，新对局才读取新数据。

## 可复现日志

`DecisionTrace` 包含格式、Meta 来源日期、公开历史哈希、种子、候选分项、Belief 摘要、搜索样本、置信区间、最终动作、回退和耗时。它不包含完整 set、粒子 JSON、SID 或认证信息。

`OfficialGameTransport` 只定义闭队表公开观察、合法行动提交和能力声明，并由公开观察 fixture 验证；当前仓库不包含 Pokémon Champions 主机控制实现。

## 扩展接口

- `PolicyPrior.evaluate`
- `OpponentModel.distribution`
- `ValueEstimator.evaluate`
- `SearchPolicy.decide`
- `BattleTransport.observe/submit/capabilities`
- `MunchStatsAdapter.probe_all/fetch_format`

未来模型统一放在这些接口后，建议导出 ONNX。模型加载、推理或形状校验失败必须回到现有 CPU 路径，不维护平行产品实现。
