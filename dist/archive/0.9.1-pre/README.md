# 0.9.1-pre

**安装包不在此目录**，通过 GitHub Releases 分发：

https://github.com/BinGO620/MociCi/releases/tag/v0.9.1-pre

直接下载链接：
https://github.com/BinGO620/MociCi/releases/download/v0.9.1-pre/MociCi-0.9.1-pre.apk

## 校验

```
sha256  5d5f3cd14460f558be1b335bf91acef22d5e779bb43057bf7d096e2aaf933117
```

下载后核对（Windows PowerShell）：

```powershell
Get-FileHash .\MociCi-0.9.1-pre.apk -Algorithm SHA256
```

或 Linux / macOS：

```bash
shasum -a 256 MociCi-0.9.1-pre.apk
```

## 本地如何重建这一版

```bash
# version.json 中 versionCode 需为 2、versionName 为 0.9.1-pre
bash tools/build.sh
```

重建出来的 APK 字节不会与 Release 完全一致（时间戳、签名随机数），
但功能等价；若需**严格一致的字节**，请从 Release 下载。

## 状态

预发布，未经真机验证。详见仓库根目录 `KNOWN-ISSUES.md`。
