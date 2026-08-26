# VGC-Bench 人类策略发现与可控风格专家模型：完整研究与实施计划

**日期**：2026-08-19
**项目定位**：基于 VGC-Bench 现有大规模人类对局数据，从录像中自动发现可迁移的策略风格（strategy modes），并训练“风格可控、强度可控”的 VGC 对战模型。

---

## 摘要

VGC-Bench 建立了 Pokémon VGC 的多智能体 benchmark、真实人类对局数据和行为克隆（Behavior Cloning, BC）/强化学习基线，但其标准 BC 将大量异质的人类轨迹混合为单一策略：

$$
\pi_{\text{BC}}(a\mid s)
$$

这会带来两个未被充分解决的问题：

1. **人类轨迹具有多模态战略结构**：不同玩家、不同队伍、不同局面下可能存在多种合理、但长期执行逻辑不同的打法；
2. **“队伍”与“策略”高度混杂**：直接对 raw state-action trajectory 聚类，极易先聚出 Trick Room、Rain、Hyper Offense 等队伍/体系，而不是玩家在“相似决策机会下”的真实偏好。

本项目提出一条“先发现、再控制”的路线：

1. 从 VGC-Bench 原始 battle logs 重建完整人类轨迹；
2. 训练一个不含玩家身份的 **Context Policy**，估计“在当前队伍、对手和局面下，平均人类会怎么做”；
3. 将真实行为转换成**语义动作残差（semantic action residual）**，即玩家相对于 context baseline 的系统性偏移；
4. 用 trajectory encoder + clustering 学习 strategy embedding / strategy clusters；
5. 通过 Team Leakage、held-out action prediction、cross-team consistency 等指标验证聚类确实更接近 strategy，而不是 team；
6. 基于这些数据驱动的 strategy clusters 训练一个共享 VGC backbone + style-conditioned experts 的可控策略模型；
7. 进一步用 rating 或独立 compute controller 表示 skill / thinking strength，使最终模型实现：

$$
\boxed{
\pi(a\mid s,\ z_{\text{style}},\ z_{\text{skill}})
}
$$

最终研究目标不是训练若干孤立的“进攻 Bot / 防守 Bot”，而是学习一个**人类 VGC 战略空间（strategy space）**，并把这个空间转化成可控制的 policy space。

---

# 1. 研究背景与核心问题

## 1.1 VGC-Bench 提供了什么

VGC-Bench 提供了：

- Pokémon VGC doubles 多智能体环境；
- Pokémon Showdown OTS（Open Team Sheets）录像抓取和 trajectory 重建工具；
- 行为克隆、PPO、自博弈、Fictitious Play、Double Oracle 等 baseline；
- 统一的性能、泛化与 exploitability 评估。

论文的默认 observation 为双方共 12 只 Pokémon 的结构化状态；模型将 move、item、ability 等编码为 latent embedding，再使用 3-layer Transformer 聚合 12 只 Pokémon，并可通过额外时间 Transformer 使用历史帧。[R1]

论文当前的行为克隆目标为：

$$
\mathcal{L}_{BC}
=
-\mathbb{E}_{(s,a)\sim\mathcal D}\log\pi_\theta(a\mid s)
$$

这意味着不同 demonstrator 和不同人类策略模式被汇总到同一个 conditional action distribution 中。[R1]

VGC-Bench 最终版论文也明确将 **Latent Variable Behavior Cloning** 列为未来方向，指出单一 BC 可能将多样的人类 playstyle 压缩为平均策略。[R1]

## 1.2 当前可用数据规模

官方 Scarlet/Violet archive `cameronangliss/vgc-battle-logs-sv` 当前包含：

- **936,352** 场 OTS battle logs；
- 约 **1,872,704** 条 player-perspective trajectories；
- 约 **14,936,632** 个 state-action transitions；
- **18 个 Gen 9 format**，覆盖 Reg A–J 的多个年份/BO3 格式。[R2]

当前 Champions 数据集 `cameronangliss/vgc-battle-logs` 包含：

- **88,905** 场 Reg MA / MB 对局；
- 约 **177,810** 条 trajectories；
- 约 **1,474,324** 个 transitions。[R3]

因此项目的主要约束并不是数据总量，而是：

- 如何得到**不被 Team 主导**的 strategy representation；
- clustering 是否稳定、可解释、可迁移；
- style expert 是否真能保持风格，而不是只学 cluster-specific team distribution。

---

# 2. 研究目标、研究问题与假设

## 2.1 总体目标

学习一个分层结构：

$$
\text{Human Trajectory}
\rightarrow
z_{\text{strategy}}
\rightarrow
\text{Style Cluster / Continuous Style}
\rightarrow
\pi(a\mid s,z_{\text{style}},z_{\text{skill}})
$$

其中：

- `state/team` 描述**当前游戏要求什么**；
- `style` 描述**玩家在多个合理选项中偏好怎么做**；
- `skill` 描述**决策质量/水平**。

## 2.2 Research Questions

### RQ1 — Strategy Discoverability

> 在控制队伍、对手、regulation 和 battle state 后，人类轨迹中是否仍存在稳定的多模态决策模式？

### RQ2 — Team vs Strategy

> 能否学习一个 embedding，使其保留对 action 有用的策略信息，同时显著降低 Team identity / Team archetype 信息？

### RQ3 — Strategy Persistence

> 同一种 strategy 是否可以跨不同队伍表达，而不是只与某个特定 Team archetype 绑定？

### RQ4 — Controllable Imitation

> 使用发现出来的 strategy representation 作为条件，是否能训练一个统一模型稳定地产生不同人类打法？

### RQ5 — Style vs Skill

> 是否能在改变模型强度时保持 style fidelity，即“更强/更弱”不等于“换了一种风格”？

---

# 3. 核心概念定义

## 3.1 不把 Raw Behavior 直接等同于 Style

例如：

- HO 队的 raw attack rate 天然可能高；
- Trick Room 队的 Protect / setup / speed-control 比例天然不同；
- 某些 Pokémon 的 move pool 本身限制 action 类型。

因此：

$$
\text{Raw Behavior}
\neq
\text{Player Strategy}
$$

本项目采用更严格定义：

> **Strategy / Style 是玩家在给定 context 下，相对于同类人类基准表现出的系统性决策偏差。**

写成：

$$
\text{Style}
=
\text{Decision}
-
\mathbb{E}[\text{Decision}\mid\text{Context}]
$$

其中 Context 至少包含：

- 自己的 Team；
- 对手 Team；
- Regulation；
- 当前 battle state；
- 当前合法 action 集。

## 3.2 Strategy Unit

第一版以**单场 player-perspective trajectory**作为最小聚类单元：

$$
\tau_i =
\{(s_t,a_t)\}_{t=1}^{T_i}
$$

不直接把一个 username 固定归入某一类。

一个玩家的长期 style profile 应定义为：

$$
P(z_{\text{strategy}}\mid \text{player})
$$

即“策略模式的分布”，而不是 hard player label。

---

# 4. 数据设计与预处理

## 4.1 从 Raw Logs 重建研究数据集

不直接依赖 VGC-Bench 已保存的 BC trajectory pickle，因为研究需要额外 metadata。

应从原始 JSON / battle log 重新生成：

```text
game_id
timestamp
regulation
bo3_flag

player_id
player_rating
opponent_id
opponent_rating
winner

self_team_id
opponent_team_id
self_core_team_id
opponent_core_team_id

turn
battle_phase
observation
legal_actions
chosen_action
chosen_action_semantics
```

VGC-Bench 的 `logs2trajs.py` 已具备从 Showdown battle logs 重放并恢复 state/action 的主要逻辑，可复用 parser 和 `DoublesEnv.order_to_action` 流程。[R4]

## 4.2 Team ID

至少保留两种 Team 标识：

### Exact Team ID

尽可能对下列 OTS 信息 canonicalize 后 hash：

```text
species
item
ability
tera type
moves
```

### Core Team ID

仅按六只 species canonicalize：

```text
sorted(species_1 ... species_6)
```

用途：

- Exact Team：严格控制完全相同构筑；
- Core Team：允许少量 moveset / item 差异的同核心队伍。

## 4.3 数据过滤

MVP 建议：

- 只保留可成功重放并恢复 action 的 OTS battle；
- 先保留所有 rating，后续分层分析；
- 分开处理 BO1 和 BO3；
- Team Preview 单独作为一个 strategy segment；
- 明确记录无法完全重建的 transition，不静默填充。

---

# 5. 算法设计

# 5.1 总体 Pipeline

```text
Raw VGC Battle Logs
        │
        ▼
Trajectory Reconstruction
        │
        ├── metadata: player/team/rating/regulation
        │
        ▼
Context Policy π0(a | context)
        │
        ▼
Semantic Action Representation φ(a, s)
        │
        ▼
Context-Normalized Residual r_t
        │
        ▼
Ambiguity Weight w_t
        │
        ▼
Strategy Trajectory Encoder
        │
        ▼
z_strategy
        │
        ├── clustering
        ├── interpretation
        └── validation
        │
        ▼
Shared VGC Encoder + Style-Conditioned Experts
        │
        ▼
π(a | s, z_style, z_skill)
```

---

# 5.2 Algorithm A：Context Policy

## 目标

学习：

$$
\boxed{
\pi_0(a\mid c_t)
}
$$

其中：

$$
c_t=(s_t,T_{\text{self}},T_{\text{opp}},r)
$$

它表示：

> 不知道玩家是谁时，在该 context 下平均人类会选择什么。

## 输入

可使用 VGC-Bench 原始 observation：

- 12 Pokémon state；
- side conditions；
- global field state；
- history/frame stack；
- legal action mask。

## 明确禁止输入

第一版 `π0` 不输入：

- `player_id`；
- strategy label；
- trajectory cluster。

rating 也建议默认不输入，以避免“平均策略”被 skill 直接切分。

## 模型

MVP：

- 直接复用 VGC-Bench BC Transformer backbone；
- 输出 legal-action logits。

训练目标：

$$
\mathcal{L}_{context}
=
-\sum_t\log \pi_0(a_t\mid c_t)
$$

Context Policy 本身不是最终 agent，而是**去混杂基线**。

---

# 5.3 Algorithm B：Semantic Action Representation

不能直接使用 raw move ID，因为：

$$
\text{Move ID}\rightarrow\text{Pokémon/Team identity}
$$

泄漏非常严重。

定义：

$$
\phi(a_t,c_t)\in\mathbb{R}^{d_a}
$$

只保留 action 的战略语义。

## MVP Semantic Features

### 行动大类

- `is_direct_damage`
- `is_protect`
- `is_switch`
- `is_pivot`
- `is_setup`
- `is_recovery`
- `is_speed_control`
- `is_disruption`
- `is_redirection`
- `is_field_control`
- `uses_tera`

### Targeting

- target opponent slot 1 / 2；
- target ally；
- spread move；
- 双 Pokémon 是否 double target；
- 是否 split targeting。

### Tempo / Resource

- Tera 使用时机；
- speed-control 使用时机；
- setup 使用时机；
- 是否主动消耗一次性资源；
- 是否保留低 HP Pokémon；
- 是否在领先/落后局面换位。

### Risk Proxy

第一版用可自动计算的 proxy：

- accuracy；
- 是否选择预测性 switch；
- action 的 baseline probability；
- 是否选择低概率但高 payoff 的 action。

其中最稳健的一项是：

$$
\text{Surprisal}(a_t)
=
-\log\pi_0(a_t\mid c_t)
$$

它反映该决策相对于平均人类有多“非典型”，但不直接等价于风险。

---

# 5.4 Algorithm C：Context-Normalized Strategy Residual

在当前 context 下，计算 baseline 的平均 semantic action：

$$
\bar{\phi}_t
=
\mathbb E_{a\sim\pi_0(\cdot\mid c_t)}
[\phi(a,c_t)]
$$

真实玩家实际行为：

$$
\phi_t=\phi(a_t,c_t)
$$

定义 residual：

$$
\boxed{
r_t=\phi_t-\bar{\phi}_t
}
$$

直观意义：

> 玩家不是“攻击了”，而是“在平均玩家只有较低概率进攻的条件下，仍然选择了进攻”。

这是项目的第一核心方法。

---

# 5.5 Algorithm D：Decision Ambiguity Weight

如果某个 turn 几乎只有一个合理动作，则该 turn 对 style 的信息量有限。

根据 context policy entropy：

$$
H_t
=
-\sum_{a\in\mathcal A_t}
\pi_0(a\mid c_t)
\log \pi_0(a\mid c_t)
$$

定义归一化权重：

$$
\boxed{
w_t=
\frac{H_t}
{\log |\mathcal A_t|}
}
$$

含义：

- `w_t ≈ 0`：forced / obvious decision；
- `w_t ≈ 1`：存在多种 plausible actions，更能暴露偏好。

最终输入：

$$
x_t = w_t r_t
$$

可做消融：

- no weighting；
- entropy weighting；
- margin weighting（top-1 与 top-2 policy probability 差距）；
- surprisal weighting。

---

# 5.6 Algorithm E：Trajectory Strategy Encoder

## MVP-0：Statistical Fingerprint

先不使用深度模型：

$$
z_\tau
=
[
\operatorname{mean}(x),
\operatorname{std}(x),
Q_{25}(x),
Q_{50}(x),
Q_{75}(x),
\text{early/mid/late means}
]
$$

优势：

- 可解释；
- 容易 debug；
- 可用于验证 residual idea 本身是否成立。

聚类：

- K-Means；
- Gaussian Mixture Model；
- HDBSCAN。

UMAP / PCA 仅用于可视化，不作为主要证据。

## MVP-1：Temporal Encoder

输入：

$$
\{x_t,\ phase_t,\ resource_t\}_{t=1}^{T}
$$

推荐：

- 2–4 层 Transformer encoder，或
- GRU 作为轻量 baseline。

输出：

$$
z_\tau\in\mathbb R^{32\text{ or }64}
$$

Style Encoder 不直接看到：

- species；
- move ID；
- item；
- ability；
- raw team ID；
- player ID；
- rating。

## Team Preview

Team Preview 单独编码：

$$
z_{\text{preview}}
$$

最终可以：

$$
z_\tau=
f(
z_{\text{preview}},
z_{\text{early}},
z_{\text{mid}},
z_{\text{late}}
)
$$

而不是把选 4 和普通 turn 完全混为一类。

---

# 5.7 Algorithm F：Strategy Clustering

至少比较三类方法。

## Baseline A — Raw Trajectory Clustering

$$
(s,a)\rightarrow Encoder\rightarrow KMeans
$$

预期会有明显 Team leakage。

## Baseline B — STRIL-style Representation

STRIL 使用 trajectory-level strategy latent，并强调多智能体 imitation 数据中的策略多样性，可作为 strategy representation baseline。[R5]

## Baseline C — Policy-Based Trajectory Clustering

Policy-Based Trajectory Clustering 将 cluster center 定义为生成轨迹的 policy，而不是几何中心，并提出 PG-Kmeans / CAAE；其动机非常适合 VGC 的“state distribution ≠ policy style”问题。[R6]

## Ours — Residual Strategy Clustering

$$
\tau
\rightarrow
\{w_t r_t\}
\rightarrow
Encoder
\rightarrow
z_\tau
\rightarrow
Cluster
$$

第一版不必追求复杂 clustering objective，先验证 representation 是否有效。

---

# 5.8 Algorithm G：可选 Team-Adversarial Deconfounding

如果 residual representation 仍有明显 Team leakage，再加入 domain-adversarial objective。

设：

$$
D_{\text{team}}(z_\tau)
$$

尝试预测：

- Team archetype；
- Core Team ID；
- Regulation。

Style encoder 通过 gradient reversal 让表示对主任务有效、但降低 nuisance domain 可辨认性；思想可参考 DANN。[R7]

目标：

$$
\mathcal L
=
\mathcal L_{\text{strategy}}
-
\lambda_{\text{adv}}
\mathcal L_{\text{team}}
$$

注意：

> 不要求 $I(z;Team)=0$。

真实策略确实可能与队伍相关；目标只是防止 `z_strategy` 被 Team identity 主导。

此模块属于**增强项**，不是 MVP 必需。

---

# 5.9 Algorithm H：最终 Style-Conditioned Policy

最终模型不训练 K 个完全独立的大网络。

推荐：

$$
\boxed{
\pi(a\mid s,z_{\text{style}},z_{\text{skill}})
}
$$

## Shared Game Encoder

复用/扩展 VGC-Bench backbone：

$$
h_s=E_{\text{game}}(s)
$$

负责共享：

- mechanics；
- matchup；
- speed / field；
- legal action；
- Pokémon knowledge。

## Style Controller

第一版：

$$
h'=
MLP([h_s;z_{\text{style}}])
$$

第二版：

- Style Adapters；
- Mixture-of-Experts（MoE）。

MoE 形式：

$$
\pi(a\mid s,z)
=
\sum_{k=1}^{K}
g_k(z)\pi_k(a\mid h_s)
$$

MoE 的 trainable gating + expert specialization 可参考 Sparsely-Gated Mixture-of-Experts。[R8]

## 为什么不做 K 个完整独立模型

因为：

$$
\text{Game Knowledge}
\neq
\text{Style Preference}
$$

所有 style 应共享 Pokémon mechanics 和战局理解，只在决策偏好上分化。

---

# 5.10 Algorithm I：Skill / Thinking Strength

Style 与 Skill 必须分离。

## Skill Controller

利用数据中的 rating：

$$
z_{\text{skill}}=
Normalize(\text{rating})
$$

或离散化为：

```text
low
mid
high
expert
```

训练：

$$
\pi(a\mid s,z_{\text{style}},z_{\text{skill}})
$$

核心目标：

> 同一种 style 可以有不同 skill level。

例如：

```text
Aggressive + 1300-level
Aggressive + 1600-level
Aggressive + expert-level
```

## Compute / Thinking Budget

可作为后续第三个独立控制量：

$$
b_{\text{compute}}
$$

例如：

- 单次 forward；
- top-k reranking；
- short rollout；
- deeper search。

MVP 不要求实现 search。

---

# 5.11 Algorithm J：可选 RL 强化与 Style Preservation

BC 成功后，可以进一步提升胜率。

问题：

> 纯 RL 可能使所有专家趋向同一高胜率策略，导致 style collapse。

因此需要：

$$
\max_\pi
R(\pi)
-
\lambda
D_{\text{style}}(\pi,\pi_{\text{target-style}})
$$

可通过生成 trajectory 再送回 style encoder：

$$
\hat z=C(\hat\tau)
$$

约束：

$$
\mathcal L_{\text{style}}
=
D(\hat z,z_{\text{target}})
$$

最终：

$$
\mathcal L
=
\mathcal L_{\text{RL}}
+
\lambda\mathcal L_{\text{style}}
$$

这一阶段属于后续扩展。Competitive Pokémon Singles 已有大规模 offline RL + Transformer 工作，可作为后续从 BC 向 offline RL 扩展的参考。[R9]

---

# 6. 指标验证与实验设计

# 6.1 总原则

一个好的 `z_strategy` 必须同时满足：

$$
\boxed{\text{Action Informative}}
$$

$$
\boxed{\text{Low Team Leakage}}
$$

$$
\boxed{\text{Cross-Context Persistent}}
$$

只看 UMAP 图、Silhouette Score 或 cluster 可视化是不够的。

---

# 6.2 Representation-Level Metrics

## Metric A — Team Leakage

冻结 `z_strategy`，训练 probe：

$$
f(z_\tau)\rightarrow Team
$$

分别预测：

1. Team archetype；
2. Core Team ID；
3. Regulation。

指标：

- Accuracy / Macro-F1；
- mutual information proxy；
- top-k retrieval purity。

期望：

$$
Leakage_{\text{ours}}
<
Leakage_{\text{raw}}
$$

同时不能牺牲 action predictiveness。

## Metric B — Strategy Action Prediction Gain

比较：

$$
P(a\mid s,team)
$$

与：

$$
P(a\mid s,team,z_\tau)
$$

指标：

- Action NLL ↓；
- Top-1 accuracy ↑；
- Top-k accuracy ↑。

核心：

$$
NLL(s,team,z)
<
NLL(s,team)
$$

说明 `z` 提供 context 之外的决策信息。

## Metric C — Cluster Stability

对：

- bootstrap data；
- random seed；
- encoder seed；
- clustering hyperparameter；

计算：

- Adjusted Rand Index；
- Normalized Mutual Information；
- cluster assignment agreement。

避免“某一次 KMeans 恰好聚得好看”。

## Metric D — Cross-Team Player Retrieval

仅在 repeated-player 数据足够时启用。

query：

$$
z_{A,T_1}
$$

检查 nearest neighbors 是否更容易包含：

$$
z_{A,T_2}
$$

而不是：

$$
z_{B,T_1}
$$

指标：

- Recall@K；
- MRR；
- same-player / different-team retrieval rate。

这是验证“跨队伍 style persistence”的强指标。

## Metric E — Same-Team Different-Player Separation

固定 Team：

$$
T
$$

看不同 repeated players 的 embedding 是否存在稳定差异。

避免 cluster 仅反映 Team。

---

# 6.3 Cluster Interpretation Metrics

聚类后再做解释，不预先规定标签。

每个 cluster 统计：

- semantic residual mean；
- Tera timing residual；
- switch / protect / direct damage residual；
- speed-control / setup residual；
- targeting pattern；
- average rating；
- Team archetype distribution；
- player concentration；
- win rate（仅用于描述，不能直接当 style 定义）。

为 cluster 赋予 human-readable 名称时：

1. 根据数值 fingerprint；
2. 抽取代表性 replays；
3. 由 VGC expert 盲评；
4. 记录专家一致率。

可能出现：

```text
Proactive Pressure
Resource-Preserving Control
Prediction-Heavy Positioning
Setup-Centric
Early-Commitment
Late-Game Conservative
```

不要强行要求结果恰好等于“进攻/防守/空间/地雷”。

---

# 6.4 Style-Conditioned Policy Metrics

## Style Fidelity

生成轨迹：

$$
\hat\tau\sim\pi(\cdot\mid z_k)
$$

重新编码：

$$
C(\hat\tau)=\hat z
$$

检查：

$$
sim(\hat z,z_k)
$$

或 cluster classifier：

$$
P(C(\hat\tau)=k)
$$

## Style Separability

不同 style 条件下：

$$
D(\pi_{z_i},\pi_{z_j})
$$

必须显著大于同 style 不同随机 seed 的差异。

## Human Replay Identification

由 VGC 玩家盲看 replay：

> 判断哪一组录像属于目标 style。

这是重要 qualitative validation。

---

# 6.5 Skill Metrics

## Skill Monotonicity

固定 style：

$$
z_{\text{style}}
$$

改变：

$$
z_{\text{skill},1}<z_{\text{skill},2}<\cdots
$$

评估：

- win rate；
- Alpha-Rank；
- action NLL 对不同 rating bucket 的拟合。

期望：

$$
Strength(skill_1)
<
Strength(skill_2)
<
...
$$

## Style Invariance Under Skill Change

关键指标：

$$
StyleSim(skill_{low},skill_{high})
$$

应保持较高。

即：

> 强度变化，但目标打法不应整体漂移成另一个 style。

---

# 6.6 Game-Performance Metrics

继承 VGC-Bench：

- cross-play win rate；
- Alpha-Rank；
- unseen-team generalization；
- exploiter evaluation（后期）。

不能只证明“像某种风格”，还需避免 model 退化成明显无效策略。

---

# 7. 关键 Baselines 与消融实验

## 7.1 Strategy Representation Baselines

| 方法 | 输入 | 目的 |
|---|---|---|
| Raw Statistics | raw action frequencies | 最简单 baseline |
| Raw AE/Transformer | raw state-action | 测 Team leakage |
| Semantic-only | semantic actions | 测去 ID 的作用 |
| STRIL-style | trajectory latent | 已有 strategy representation |
| Policy-Based Clustering | policy likelihood | policy-centered clustering |
| **Residual Fingerprint** | context residual | 我们的 MVP |
| **Residual Temporal Encoder** | residual sequence | 我们的完整表示 |
| + Team Adversarial | residual + GRL | 增强去混杂 |

## 7.2 关键 Ablations

### A1：无 Context Normalization

$$
\phi(a_t)
$$

vs.

$$
\phi(a_t)-E[\phi\mid c_t]
$$

验证 residual 是否是真正贡献。

### A2：无 Ambiguity Weight

$$
r_t
$$

vs.

$$
w_t r_t
$$

验证“决策分歧点更能揭示 style”。

### A3：Raw Move ID vs Semantic Action

验证 semantic abstraction 是否降低 Team leakage。

### A4：无 Team Preview / 有 Team Preview

验证 preview strategy 的额外信息量。

### A5：Statistical Fingerprint vs Temporal Encoder

验证 style 是否需要时序结构。

### A6：Hard Cluster vs Continuous Embedding

比较：

$$
z=\text{one-hot cluster}
$$

和 continuous style latent。

### A7：Style-conditioned MLP vs Adapter vs MoE

最终模型结构消融。

---

# 8. 数据切分设计

必须避免 leakage。

## Split 1 — Random Trajectory Split

只用于 debug，不作为最终主要结果。

## Split 2 — Time Split

训练过去数据，测试未来数据：

$$
t_{\text{train}}<t_{\text{test}}
$$

降低同一时期 meta 泄漏。

## Split 3 — Held-Out Team Split

训练不包含某批 Team：

$$
T_{\text{test}}\cap T_{\text{train}}=\varnothing
$$

验证 style representation / expert 是否跨 Team。

## Split 4 — Player-Aware Split

用于 repeated-player 分析：

- 同一玩家部分 Team 训练；
- 另一支未见 Team 测试。

## Split 5 — Regulation Split（扩展）

例如：

$$
Reg_G\rightarrow Reg_H
$$

用于后续验证 style 是否跨 regulation 稳定。

---

# 9. 具体实施方案

# Phase 0 — 环境与复现

- [ ] Fork / 固定 VGC-Bench commit；
- [ ] 跑通官方 `logs2trajs.py`；
- [ ] 跑通官方 BC `pretrain.py`；
- [ ] 复现一个最小 BC checkpoint；
- [ ] 固定数据 schema 和 experiment config；
- [ ] 所有实验使用 deterministic seed / config logging。

**输出**：

```text
configs/
data_schema.md
reproduction_notes.md
baseline_bc_checkpoint
```

---

# Phase 1 — 数据审计与 Metadata Dataset

实现：

```text
build_metadata_dataset.py
```

生成：

```text
game_id
player_id
rating
team_id
core_team_id
regulation
timestamp
winner
n_turns
```

统计：

- 每个 player 的 games；
- 每个 player 的 unique teams；
- 每个 Team 的 unique players；
- rating 分布；
- regulation 分布；
- exact/core Team 重复率。

**Go/No-Go 检查**：

- 若 repeated-player 丰富：保留 player-style persistence 实验；
- 若 repeated-player 稀疏：主线仍可做 trajectory strategy discovery，不依赖 player identity。

---

# Phase 2 — Semantic Action Engine

实现：

```text
semantic_actions/
    taxonomy.py
    move_semantics.py
    targeting.py
    resource_features.py
    tests/
```

给每个 legal action 计算：

$$
\phi(a,c)
$$

必须写单元测试覆盖：

- attack；
- Protect；
- switch；
- setup；
- TR/Tailwind；
- Fake Out / Taunt / Encore；
- redirection；
- Tera；
- target combinations；
- joint actions。

**输出**：

```text
transition_semantics.parquet
```

---

# Phase 3 — Context Policy

复用 VGC-Bench BC backbone：

```text
models/context_policy.py
train_context_policy.py
```

训练：

$$
\pi_0(a\mid c)
$$

记录：

- train/val NLL；
- top-k accuracy；
- calibration；
- entropy 分布。

输出每个 transition：

```text
context_action_probs
context_entropy
chosen_action_surprisal
expected_semantics
```

---

# Phase 4 — Residual Strategy Dataset

计算：

$$
r_t=
\phi(a_t)-E_{\pi_0}[\phi(a)]
$$

以及：

$$
x_t=w_t r_t
$$

按 trajectory 保存：

```text
trajectory_id
preview_features
residual_sequence
phase_sequence
player_id
team_id
rating
regulation
```

注意：

> metadata 用于评估，不默认输入 style encoder。

---

# Phase 5 — MVP Strategy Discovery

先跑：

### 5.1 Statistical Fingerprint

```text
trajectory → mean/std/quantiles/phase features
```

### 5.2 Clustering

- KMeans；
- GMM；
- HDBSCAN。

### 5.3 Evaluation

同时报告：

- Silhouette / cluster stability；
- Team Leakage；
- Action Prediction Gain；
- cluster semantic fingerprints；
- repeated-player retrieval（如可行）。

**Go/No-Go 条件**：

若 residual representation 相比 raw representation：

1. Team leakage 显著下降；
2. context+style 的 action NLL 显著改善；
3. 聚类稳定；

则进入 deep trajectory encoder。

---

# Phase 6 — Deep Strategy Encoder

实现：

```text
models/strategy_encoder.py
train_strategy_encoder.py
```

比较：

- GRU；
- Transformer；
- STRIL-style latent；
- Residual Transformer。

得到：

$$
z_\tau
$$

再进行 clustering / continuous style 分析。

可选加入 Team adversarial head。

---

# Phase 7 — Style Cluster 定义与专家审阅

对每个 cluster：

1. 计算 semantic residual fingerprint；
2. 抽 representative / centroid trajectories；
3. 抽 boundary trajectories；
4. 检查 Team composition；
5. 邀请 VGC expert 做盲评；
6. 再赋 human-readable label。

禁止：

> 先给标签，再挑录像支持标签。

---

# Phase 8 — Style-Conditioned BC

数据变为：

$$
(s_t,a_t,z_{\tau})
$$

训练：

$$
\pi_\theta(a_t\mid s_t,z_\tau)
$$

第一版：

```text
Shared VGC Encoder
       +
Style Embedding
       +
Conditional MLP Head
```

比较：

- vanilla BC；
- per-cluster independent BC；
- shared conditional BC；
- adapter；
- MoE（增强版）。

---

# Phase 9 — Skill Conditioning

加入 rating：

$$
z_{\text{skill}}
$$

训练：

$$
\pi(a\mid s,z_{\text{style}},z_{\text{skill}})
$$

实验：

```text
same style × low/mid/high skill
```

检查：

- performance monotonicity；
- style fidelity invariance。

---

# Phase 10 — Online Evaluation / Optional RL

在 VGC-Bench 环境进行：

- style-vs-style cross-play；
- style × skill grid；
- unseen-team evaluation；
- human qualitative evaluation。

如果 BC 风格控制已经稳定，再尝试：

- PPO；
- self-play；
- offline RL；
- style-preserving regularization。

---

# 10. 推荐代码目录

```text
vgc-style/
├── configs/
│   ├── data/
│   ├── context_policy/
│   ├── strategy_encoder/
│   └── style_policy/
│
├── data/
│   ├── raw/
│   ├── metadata/
│   ├── transitions/
│   └── trajectories/
│
├── src/
│   ├── parsing/
│   │   ├── replay_parser.py
│   │   ├── team_hash.py
│   │   └── metadata_builder.py
│   │
│   ├── semantics/
│   │   ├── action_taxonomy.py
│   │   ├── move_semantics.py
│   │   └── feature_builder.py
│   │
│   ├── models/
│   │   ├── context_policy.py
│   │   ├── strategy_encoder.py
│   │   ├── style_policy.py
│   │   └── style_moe.py
│   │
│   ├── clustering/
│   │   ├── fingerprints.py
│   │   ├── cluster.py
│   │   └── interpretation.py
│   │
│   └── evaluation/
│       ├── team_leakage.py
│       ├── action_prediction.py
│       ├── cluster_stability.py
│       ├── player_retrieval.py
│       ├── style_fidelity.py
│       └── vgc_crossplay.py
│
├── scripts/
│   ├── build_metadata.py
│   ├── build_semantics.py
│   ├── train_context_policy.py
│   ├── build_residuals.py
│   ├── cluster_strategies.py
│   ├── train_strategy_encoder.py
│   ├── train_style_policy.py
│   └── evaluate_all.py
│
├── tests/
└── reports/
```

---

# 11. MVP 与 Full Version 的边界

## 必须完成的 MVP

1. Raw replay → enriched trajectory；
2. semantic action taxonomy；
3. context policy；
4. strategy residual；
5. statistical/temporal representation；
6. clustering；
7. Team leakage + action prediction + stability；
8. style-conditioned BC；
9. style fidelity evaluation。

MVP 已经可以形成一篇完整工作的主体：

> **发现 VGC 人类轨迹中的 context-normalized strategy modes，并证明这些模式可用于可控 imitation。**

## Full Version 增强项

- repeated-player cross-team persistence；
- Team adversarial representation；
- continuous style interpolation；
- Style MoE；
- skill conditioning；
- compute/thinking controller；
- style-preserving RL；
- cross-regulation transfer；
- BO3 opponent adaptation。

---

# 12. 关键风险与备选方案

## Risk 1：聚类仍然按 Team 分

### 检查

Team Leakage probe 过高。

### 处理顺序

1. 去 raw Pokémon / move ID；
2. 使用 semantic action；
3. context residual；
4. ambiguity weighting；
5. matched-team normalization；
6. 最后才加入 adversarial deconfounding。

---

## Risk 2：没有清晰离散 Cluster

这不代表研究失败。

真实 style 可能是连续 manifold，而不是 K 个类别。

切换为：

$$
z_{\text{strategy}}\in\mathbb R^d
$$

最终模型直接使用 continuous style embedding。

论文故事从：

> discover K styles

改为：

> learn a continuous human strategy space。

---

## Risk 3：Context Policy 不够准

Residual 的质量依赖：

$$
\pi_0(a\mid c)
$$

如果 baseline calibration 很差，residual 会含噪。

处理：

- calibration；
- ensemble context policy；
- rating/format stratification；
- matched-context statistics 作为非神经 baseline。

---

## Risk 4：Repeated Player 太少

主线不依赖 repeated player。

Player identity 只作为额外验证。

如果数据足够：

> 做 cross-team persistence。

如果不足：

> 聚焦 trajectory-level strategy multimodality。

---

## Risk 5：Cluster 只是 Skill

检查：

$$
I(Cluster;Rating)
$$

以及不同 rating bucket 的 cluster composition。

必要时：

- stratified clustering；
- skill-adversarial head；
- 先对 rating effect residualize。

Style 和 Skill 应作为两个不同轴。

---

## Risk 6：专家模型 Style Collapse

如果 style-conditioned policy rollout 后都趋同：

- 增加 style reconstruction loss；
- per-cluster balanced sampling；
- style contrastive loss；
- adapter / MoE；
- RL 阶段加 style-preservation penalty。

---

# 13. 成功标准

## 最低成功标准

与 raw trajectory representation 相比：

1. **Team Leakage 显著降低**；
2. `context + z_strategy` 对 held-out human actions 的 NLL 显著优于 `context only`；
3. clustering 在不同 seed / bootstrap 下具有合理稳定性；
4. clusters 在 semantic residual fingerprint 上具有可解释差异；
5. style-conditioned BC 能生成可由 style encoder 重新识别的对应轨迹。

## 强成功标准

额外满足：

1. 同一玩家不同 Team 的 style embedding 具有显著 persistence；
2. style 可迁移到 unseen Team；
3. continuous style interpolation 产生平滑行为变化；
4. skill 增强时 performance 单调提升，而 style fidelity 基本稳定；
5. VGC expert 能在盲评中识别不同模型的风格差异。

---

# 14. 建议论文故事

## 一句话

> **We discover context-normalized strategic modes from large-scale human VGC trajectories and turn the discovered strategy space into a controllable policy space, disentangling how an agent plays from how well it plays.**

## 论文逻辑

### Part I — Problem

VGC-Bench 的人类数据巨大，但标准 BC：

$$
\pi(a\mid s)
$$

将 heterogeneous strategies 混为单一 policy。

### Part II — Key Challenge

Raw trajectory clustering 会被：

$$
Team\rightarrow State/Action\ Distribution
$$

严重混杂。

### Part III — Method

提出：

$$
\boxed{
Context\text{-}Normalized\ Strategy\ Residual
}
$$

即聚类“相对于同 context 人类基准的决策偏差”，而不是聚类 raw behavior。

### Part IV — Discovery

证明表示：

- action informative；
- team leakage 低；
- clustering 稳定；
- 可形成可解释 strategy modes。

### Part V — Controllable Agent

训练：

$$
\pi(a\mid s,z_{\text{style}},z_{\text{skill}})
$$

把发现的人类 strategy space 转化成可控制的 VGC policy。

### Part VI — Key Result

展示：

> Style 可以改变，而 game competence 共享；Skill 可以改变，而 Style 尽量保持。

---

# 15. 推荐主实验表

## Table A — Representation Quality

| Representation | Action NLL ↓ | Team Leakage ↓ | Cluster Stability ↑ | Cross-Team Retrieval ↑ |
|---|---:|---:|---:|---:|
| Raw Stats |  |  |  |  |
| Raw Transformer |  |  |  |  |
| Semantic Only |  |  |  |  |
| STRIL-style |  |  |  |  |
| Policy Clustering |  |  |  |  |
| Residual Fingerprint |  |  |  |  |
| **Residual Temporal (Ours)** |  |  |  |  |
| + Adversarial |  |  |  |  |

## Table B — Controllable Policy

| Model | Action NLL ↓ | Style Fidelity ↑ | Style Diversity ↑ | Win Rate ↑ |
|---|---:|---:|---:|---:|
| Vanilla BC |  |  |  |  |
| Per-Cluster BC |  |  |  |  |
| Conditional BC |  |  |  |  |
| Adapter |  |  |  |  |
| Style MoE |  |  |  |  |

## Table C — Style × Skill

| Style | Low Skill | Mid Skill | High Skill | Style Drift |
|---|---:|---:|---:|---:|
| Style 1 |  |  |  |  |
| Style 2 |  |  |  |  |
| Style 3 |  |  |  |  |
| ... |  |  |  |  |

---

# 16. 推荐主要图

1. **Overall pipeline diagram**：raw logs → residual → clustering → controllable policy；
2. **Raw vs Residual UMAP**：展示 raw embedding 更按 Team，而 residual 更按决策模式；
3. **Team Leakage vs Action Information Pareto plot**；
4. **Cluster semantic fingerprint radar/heatmap**；
5. **Player strategy distribution**（若 repeated-player 可行）；
6. **Style interpolation plot**；
7. **Style × Skill grid**；
8. **Unseen-Team style transfer**。

---

# 17. 参考资料

## [R1] VGC-Bench

Cameron L. Angliss, Jiaxun Cui, Jiaheng Hu, Arrasy Rahman, Peter Stone.
**VGC-Bench: Towards Mastering Diverse Team Strategies in Competitive Pokémon.**
The 25th International Conference on Autonomous Agents and Multi-Agent Systems (AAMAS 2026).
arXiv: **2506.10326**.

重点参考：

- human-play data collector；
- observation/action representation；
- behavior cloning；
- Transformer policy backbone；
- multi-team generalization；
- future work 中的 latent-variable BC / opponent modeling / search。

## [R2] VGC-Bench Scarlet/Violet Archive

Hugging Face dataset:
`cameronangliss/vgc-battle-logs-sv`

截至本计划撰写时，dataset card 记录：

- 936,352 OTS logs；
- ~1.87M trajectories；
- ~14.94M transitions；
- 18 个 Scarlet/Violet Gen 9 formats。

## [R3] VGC-Bench Champions Dataset

Hugging Face dataset:
`cameronangliss/vgc-battle-logs`

截至本计划撰写时，dataset card 记录：

- 88,905 logs；
- ~177.8K trajectories；
- ~1.47M transitions；
- Champions Reg MA / MB formats。

## [R4] VGC-Bench Official Repository

GitHub repository:
`cameronangliss/vgc-bench`

重点文件：

- `vgc_bench/logs2trajs.py`
- `pretrain.py`
- policy / observation / environment implementation。

## [R5] STRIL

Shiqi Lei, Kanghoon Lee, Linjing Li, Jinkyoo Park.
**Learning Strategy Representation for Imitation Learning in Multi-Agent Games.**
arXiv: **2409.19363**.

关联点：

- heterogeneous multi-agent demonstration；
- trajectory-level strategy representation；
- 不依赖显式 player identity 的 strategy learning。

## [R6] Policy-Based Trajectory Clustering

Hao Hu, Xinqi Wang, Simon Shaolei Du.
**Policy-Based Trajectory Clustering in Offline Reinforcement Learning.**
arXiv: **2506.09202**.

关联点：

- cluster center 应代表 generating policy；
- PG-Kmeans；
- Centroid-Attracted Autoencoder；
- 避免单纯依靠 trajectory geometry。

## [R7] Domain-Adversarial Representation Learning

Yaroslav Ganin et al.
**Domain-Adversarial Training of Neural Networks.**
Journal of Machine Learning Research, 17(59), 2016.

关联点：

- gradient reversal；
- 学习对主任务有用、对 nuisance/domain identity 不敏感的 representation。

## [R8] Mixture-of-Experts

Noam Shazeer et al.
**Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer.**
arXiv: **1701.06538**.

关联点：

- gated expert specialization；
- conditional computation；
- 可作为 style experts 的架构参考。

## [R9] Competitive Pokémon Offline RL

Jake Grigsby, Yuqi Xie, Justin Sasek, Steven Zheng, Yuke Zhu.
**Human-Level Competitive Pokémon via Scalable Offline Reinforcement Learning with Transformers.**
arXiv: **2504.04395**.

关联点：

- 大规模 Pokémon human trajectory；
- sequence model；
- imitation learning → offline RL → self-play fine-tuning。

## [R10] Conditional Multi-Agent Imitation

Andy Shih, Stefano Ermon, Dorsa Sadigh.
**Conditional Imitation Learning for Multi-Agent Games.**
HRI 2022; arXiv: **2201.01448**.

关联点：

- strategy-conditioned multi-agent imitation；
- structured/low-dimensional strategy variation；
- 对新的 agent/partner strategy 进行条件化。

---

# 18. 最终建议

项目第一阶段应避免同时追求：

- 完美的玩家人格标签；
- MoE；
- RL；
- search；
- cross-regulation；
- BO3 adaptation。

最稳健的推进顺序是：

$$
\boxed{
\text{Data}
\rightarrow
\text{Semantic Actions}
\rightarrow
\text{Context Baseline}
\rightarrow
\text{Residual Strategy}
\rightarrow
\text{Clustering Validation}
}
$$

只有当 `z_strategy` 同时证明：

1. **比 raw embedding 少包含 Team 信息**；
2. **能解释额外的人类 action variance**；
3. **在不同数据切分中稳定**；

再进入：

$$
\boxed{
\text{Style-Conditioned Policy}
\rightarrow
\text{Skill Control}
\rightarrow
\text{RL / Transfer}
}
$$

整个工作的最核心创新不应被表述成“给 VGC Bot 加风格标签”，而应是：

> **从强 Team-confounded 的 VGC 人类轨迹中识别 context-normalized strategic variation，并将其转换成可控制的决策模型。**
