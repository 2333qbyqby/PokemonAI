# 扩展智能体能力

面向用户的 AI 只有一个 `agent-runtime/strong` 实现。新增算法时优先实现引擎接口，不创建平行难度后端：

- 行动先验：`PolicyPrior.evaluate`
- 对手分布：`OpponentModel.distribution`
- 叶子价值：`ValueEstimator.evaluate`
- 搜索编排：`SearchPolicy.decide`
- 对战平台：`BattleTransport.observe/submit/capabilities`

未来学习模型应导出 ONNX，并在接口适配器中完成输入形状、格式族、Meta 来源日期和数值有限性检查。加载或推理失败必须回退到启发式实现。

只有接入新的独立运行平台或隔离依赖时才增加 `backends/<id>/backend.yaml`。清单声明 `id`、`runtime`、`entrypoint`、formats、devices 和命令；不要加入模型注册器、难度等级或功能版本字段。

完成扩展后至少运行：

```powershell
.\scripts\build.ps1
```

共享行为通过信息隔离、固定种子复现、非法动作率、模型失败回退和 Arena 运行结果进行调试。
