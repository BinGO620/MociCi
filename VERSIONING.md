# 版本管理说明

## 版本号规则

版本号唯一来源是 `version.json`，构建时由 `tools/build.sh` 注入到 APK 的 manifest。

```json
{
  "versionCode": 2,
  "versionName": "0.9.1-pre",
  "stage": "pre-release"
}
```

- `versionCode`：整数，**每次发版必须递增**，否则无法覆盖升级
- `versionName`：展示用，`0.x-pre` 表示未经真机验证的预发布版
- `stage`：`pre-release` / `release`，写入构建清单

## 构建与归档

```bash
bash tools/build.sh            # 产出 dist/MociCi-<versionName>.apk
bash tools/build.sh --qa       # debuggable 包，仅用于截图/灌数据
bash tools/build.sh --no-archive  # 跳过归档（用于反复调试）
```

每次构建会自动：

1. 从 `version.json` 注入版本号
2. 校验签名与 assets 路径
3. 计算 SHA-256
4. 把 APK、`SHA256SUMS.txt`、`version.json`、`KNOWN-ISSUES.md` 复制到 `dist/archive/<versionName>/`
5. 在仓库根写 `MANIFEST.txt`

## 目录约定

| 路径 | 内容 | 是否入库 |
|---|---|---|
| `app/` | 源码 | ✅ |
| `tests/` | 单元测试 | ✅ |
| `tools/` | 构建、开发服务器、QA 脚本 | ✅ |
| `dist/archive/` | **每个历史版本的 APK + 校验和** | ✅ |
| `dist/*.apk` | 当前构建产物（每次覆盖） | ❌ |
| `build/` | 中间产物，可随时删除重建 | ❌ |
| `secrets/` | 签名密钥 | ❌ **绝不入库** |

## 发布前检查清单

- [ ] `version.json` 的 `versionCode` 已递增
- [ ] `bash tools/build.sh` 通过，`APK entries OK`
- [ ] `KNOWN-ISSUES.md` 与实际状态一致
- [ ] 真机安装并跑完 README「真机验证清单」10 项
- [ ] 归档目录中的 SHA-256 与 `MANIFEST.txt` 一致
- [ ] `secrets/` 已在仓库之外另存备份

## 回滚方式

```bash
# 从归档恢复某个历史版本
adb install -r dist/archive/<version>/MociCi-<version>.apk

# 核对是否为同一份构建
cd dist/archive/<version> && sha256sum -c SHA256SUMS.txt
```

> 覆盖安装必须使用同一把签名密钥，否则系统会拒绝升级，只能卸载重装。
