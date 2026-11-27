# pre-versioning（2026-11-27 快照）

这是纳入版本管理**之前**的最后一个构建，第五轮缺陷修复后的状态。

- 原始文件名：`MociCi.apk`
- SHA-256：`76c6f32e35ff440b4af0a338a5d6a07e023e4fca39d533bd755b14b266f2f8d6`
- 大小：112,656 字节
- 无版本号（manifest 中 versionCode 为空）

## 为什么保留

作为 0.9.1-pre 之前的基线，用于对比行为差异。

## 如何获取

此版本**未上传到 Releases**（Release 从 0.9.1-pre 开始）。
如需此文件，请在本机的 `dist/archive/20261127-pre-versioning/` 目录查找，
或从 git 历史中 checkout：

```bash
git log --all --oneline -- dist/archive/20261127-pre-versioning/MociCi-prever.apk
git checkout <commit> -- dist/archive/20261127-pre-versioning/MociCi-prever.apk
```

（该文件在提交 `ea321b6` 中存在，之后因改用 Releases 而移出仓库。）

## 状态

预发布，未经真机验证。已知问题见当时的 `ACCEPTANCE.md`。
