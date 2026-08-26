# 本地 Champions 阵容

把自己维护的 Pokémon Showdown 阵容放在此目录后，重新构建阵容库：

```bash
PYTHONPATH=packages/pokemonai-core/src python3 scripts/team-library.py build --project-root .
```

支持 `.txt`、`.team`、`.paste`、`.packed`、`.json`、`.yaml` 和 `.yml`。默认按
目标格式校验并加入相应对战池；无论文件来自哪里，都请只
放置你有权使用的内容。
