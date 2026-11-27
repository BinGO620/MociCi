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
4. 把 APK、`SHA256SUMS.txt`、`version.json`、`KNOWN-ISSUES.md` 复制到 `dist/archive/<versionName>/`（该目录的 APK 不入库）
5. 在仓库根写 `MANIFEST.txt`

## 目录约定

| 路径 | 内容 | 是否入库 |
|---|---|---|
| `app/` | 源码 | ✅ |
| `tests/` | 单元测试 | ✅ |
| `tools/` | 构建、开发服务器、QA 脚本 | ✅ |
| `dist/archive/` | **每个历史版本的校验和、说明、version.json**（APK 本体不入库） | ✅ |
| GitHub Releases | **安装包分发渠道**，每个 tag 挂一个 APK | — |
| `dist/*.apk` | 当前构建产物（每次覆盖） | ❌ |
| `build/` | 中间产物，可随时删除重建 | ❌ |
| `secrets/` | 签名密钥 | ❌ **绝不入库** |

## 发布流程（GitHub Releases）

安装包通过 Release 分发，不进入 git 仓库。



未安装 `gh` 时用 GitHub API 上传（见本次操作记录）。

## 发布前检查清单

- [ ] `version.json` 的 `versionCode` 已递增
- [ ] `bash tools/build.sh` 通过，`APK entries OK`
- [ ] `KNOWN-ISSUES.md` 与实际状态一致
- [ ] 真机安装并跑完 README「真机验证清单」10 项
- [ ] 归档目录中的 SHA-256 与 `MANIFEST.txt` 一致
- [ ] `secrets/` 已在仓库之外另存备份

## 回滚方式

```bash
# 从 GitHub Releases 下载某个历史版本并安装
VER=0.9.1-pre
curl -L -o old.apk "https://github.com/BinGO620/MociCi/releases/download/v${VER}/MociCi-${VER}.apk"
adb install -r old.apk
```

核对校验和：

```bash
cd "dist/archive/${VER}" && sha256sum -c SHA256SUMS.txt
```

> 覆盖安装必须使用同一把签名密钥，否则系统会拒绝升级，只能卸载重装。
