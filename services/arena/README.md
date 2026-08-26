# Arena

Arena 的实现位于 `pokemonai_core.arena`，由统一 CLI 启动：

```text
pokemonai arena run --config config/arena.example.yaml
```

服务目录只保留运行边界说明；不会再维护第二套脚本或依赖环境。报告写入 `var/evaluations/<timestamp>/`。
