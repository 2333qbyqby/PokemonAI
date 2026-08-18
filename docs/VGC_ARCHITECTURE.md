# VGC 算法与架构

## 目标和边界

本实现面向个人娱乐、低算力设备和可控难度。规则正确性由锁定版本的 Pokémon
Showdown 负责；Python AI 不重复实现完整招式、特性、道具和伤害规则。策略层的任务
是从 poke-env 已生成的合法动作中选出合理的联合行动。

算法不调用 GPU、LLM 或远程 API。当前最高档是单回合启发式策略，不是完整
minimax/MCTS。这样可以在普通 VPS 和家用 PC 上同时常驻多档机器人，并把出招延迟
保持在交互可接受范围。

## 运行链路

```text
Showdown Champions 格式
  └─ 处理合法性、OTS、速度、伤害、状态和回合推进
       └─ poke-env DoubleBattle
            ├─ battle.valid_orders
            ├─ active_pokemon / opponent_active_pokemon
            ├─ team / opponent_team
            └─ fields / side_conditions / revealed moves
                 └─ VGCHeuristicPlayer
                      ├─ DoubleBattleOrder.join_orders
                      └─ VGCPolicy
                           ├─ team preview policy
                           ├─ single-order evaluator
                           ├─ joint synergy evaluator
                           ├─ opponent-pressure estimator
                           └─ bounded-rational selector
```

`vgc_policy.py` 只依赖标准库和 duck-typed 对象，因此可以在没有 Showdown 服务的
情况下单元测试。`vgc_player.py` 才依赖 poke-env，负责把合法 DoubleBattleOrder 与
策略连接起来。

## Champions 数据兼容层

Champions 包含主线 poke-env 0.15.0 静态数据未覆盖的新 Mega 形态。baseline 包固定
安装 VGC-Bench 的 Champions 兼容 poke-env fork，提交为
`379a04628e42b2a2c94790c0788204b652f7ae1b`，而不是依赖会漂移的分支。该 fork 继续提供
`DoubleBattle.valid_orders`、`DoubleBattleOrder.join_orders` 等接口，并补充 Champions
物种数据。

`champions_compat.py` 在任何 VGC 机器人连接 Showdown 前检查关键数据标记。缺少
`staraptormega` 或 `dragonitemega` 时，服务会拒绝启动并提示重新 bootstrap／构建镜像，
避免在队伍预览或 Mega 进化发生后才以 `KeyError` 中断一局。策略层本身仍然不把具体
形态写进决策规则；这些标记只用于确认运行时数据版本正确。

## 六选四与双首发

队伍预览对 6 只队伍枚举选四和有序双首发。每个候选计算：

- 四只宝可梦的耐久、进攻、速度和已知功能招式；
- 首发 Fake Out、Tailwind、Trick Room、重定向、Wide Guard 和天气/场地能力；
- Fake Out + 速度控制、重定向 + 强化等首发协同；
- 对面 OTS 阵容的粗略属性对位；
- Item Clause、类型覆盖和角色重复。

低难度从较宽的合理候选池抽样，高难度把温度和候选数压低。返回 `/team` 所需的
一基索引顺序，前两只是首发，后两只是后排。

## 联合动作而非独立动作

VGC 两个位置不能独立贪心。运行时先让 poke-env 生成每个位置的合法动作与合法目标，
再用 `DoubleBattleOrder.join_orders` 得到完整合法联合行动。策略只对这些合法组合
评分，因此不会自行拼接重复换入、无效目标或冲突系统资源。

单动作分数包括：

- 招式威力、命中、期望连击、STAB、属性倍率、攻防比和范围伤害折扣；
- 击倒、残血优先级、免疫目标和重复攻击已倒下目标；
- Protect 连用、回复时机、强化、速度控制、状态、场地、换位招式；
- 换入后的血量、属性对位、威吓/天气/场地能力、原场宝可梦强化资源；
- 从 OTS 或已经暴露招式估计的对手最大即时压力；未知招式时退化到种族值和属性估计；
- Mega进化/特殊系统资源是否用于足够高价值的行动。

联合分数另外处理：

- Helping Hand + 有伤害的搭档招式；
- Follow Me/Rage Powder + 强化、Trick Room 或 Tailwind；
- Fake Out + 强化/速度控制；
- Protect 为搭档创造节奏；
- 双集火对高血量目标的收益和对残血目标的过量伤害；
- 重复 Tailwind/Trick Room/天气场地；
- 双换节奏、重复换入；
- Earthquake 等 `allAdjacent` 招式对队友的伤害；
- Pollen Puff 等负目标位置的队友治疗，以及少量明确的队友触发组合。

每次决策会把前若干候选、总分、分项和耗时写入 JSONL，以便调参和定位异常；UI 不
显示复盘内容。

## 难度

难度不是“固定概率随机按键”。所有等级先拒绝灾难性动作，再改变以下参数：

| 参数 | 低难度 | 高难度 |
|---|---:|---:|
| softmax 温度 | 高 | 低 |
| 候选 Top-K | 多 | 少 |
| 相对最优分的合理性下限 | 宽 | 窄 |
| 评分噪声 | 较高 | 很低 |
| 对手即时压力权重 | 低 | 高 |
| 队伍预览温度 | 高 | 低 |

因此低难度会选择“合理但次优”的操作，而不会随机攻击免疫目标或重复换入同一只宝可梦。
`profile_for_difficulty` 支持 1～10；默认配置常驻 8 档，以控制个人部署的连接数和内存。

## 阵容轮换

`TeamPool` 从统一阵容索引读取特定 pool 的 packed team。`TeamPoolTeambuilder` 在
poke-env 每次接受新挑战时调用 `yield_team()`，因此同一难度机器人会逐局轮换，而
不是启动后永远使用一支队。

## Regulation 更新

与具体环境相关的信息放在配置和阵容数据中：

```yaml
formats:
  - id: champions-reg-mb
    showdown_format: gen9championsvgc2026regmb
    game_type: doubles
    team_preview: bring6_pick4
    open_team_sheets: true
    team_pool: champions-reg-mb
```

更新流程应为：

1. 更新 `runtime-lock.json` 中 Showdown 的固定提交；
2. 如果 Champions 数据结构有变化，更新并固定兼容 poke-env 的提交；
3. 确认新的 Champions 格式 ID；
4. 新增 Format Pack/阵容 pool；
5. 重建并验证阵容库；
6. 运行算法单测和真实对局集成测试；
7. 观察不同难度的胜率是否总体单调。

策略依赖招式结构、属性、目标、场面和合法动作，而不是大量 `if species == ...`，所以
环境换队与开放旧宝可梦时可以继续工作。全新机制仍需要增加评价分项和测试。

## 未来可插拔增强

下列能力尚未实现，但已有明确落点：

- `Showdown Sim Worker`：根据 battle input log 克隆局面，对 Top-K 联合行动做精确
  一回合或两回合推进；
- 对手 Top-K 联合行动及收益矩阵；
- 当前 Regulation 的 usage/set prior；
- 10M～50M policy/value 网络，用于候选排序，导出 ONNX 并在 CPU 推理；
- 多机器人 Match Service 和并发槽位分配。

这些增强不应替换 Showdown 的规则判断，也不应让模型直接输出未经合法动作掩码约束的
文本指令。
