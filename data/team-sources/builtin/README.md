# 本地 Champions 阵容

把自己维护的 Pokémon Showdown 阵容放在此目录后，重新构建阵容库：

```bash
PYTHONPATH=services/baseline-ai/src python3 scripts/team-library.py build --project-root .
```

支持 `.txt`、`.team`、`.paste`、`.packed`、`.json`、`.yaml` 和 `.yml`。默认按
`champions-reg-mb` 校验并加入 `champions-reg-mb` 对战池；无论文件来自哪里，都请只
放置你有权使用的内容。
