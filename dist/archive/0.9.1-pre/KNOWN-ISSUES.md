# 已知问题（当前版本：0.9.1-pre）

本文件随版本更新。**当前版本未经任何真机验证**，请勿视为可交付版本。

## 阻塞发布的问题

### P0-1 真机完全未验证
`adb devices` 始终为空。以下路径只有单元测试和桌面 Chrome 的证据，**从未在 Android 上运行过一次**：
- WebView 通过 `file:///android_asset/` 加载资源
- 系统 TTS 初始化、发音、语速、英音/美音切换
- `synthesizeToFile` 预取与本地文件播放
- 相机拍照 → FileProvider → 图片回传
- SAF 导出文件
- 返回键行为（`evaluateJavascript` 异步回调时序）
- 覆盖安装升级（版本号递增后的数据处理）

### P0-2 原生桥返回值契约未经设备确认
第五轮修复假设 `@JavascriptInterface` 方法返回的是 JSON **字符串**，前端用 `nativejson.parse()` 解析。Java 侧代码确实是 `return ok(obj)` → `toString()`，但**没有在设备上实测过**。

若该假设有误，表现是静默降级而非崩溃：发音不秒播、设置页始终显示"发音不可用"、在线缓存永不命中。

验证方法：设备上执行
```bash
adb logcat -s MociConsole | grep -i "tts\|native"
```
并观察设置页发音状态。

### P0-3 拍照批改的 FileProvider 未实测
自定义 `CameraFileProvider` 继承 `ContentProvider` 而非 `androidx.core.content.FileProvider`。URI 授权（`FLAG_GRANT_WRITE_URI_PERMISSION`）在 Android 7–14 上的行为未验证。若失败，表现是"拍照后图片取不回来"。

## 已知功能缺口

| 项 | 状态 | 说明 |
|---|---|---|
| 会话草稿续做 | ❌ 未实现 | 学习中杀进程会丢失当前轮次 |
| API Key 加密 | ❌ 未实现 | 明文存 SharedPreferences，需 androidx 依赖 |
| 列表虚拟滚动 | ❌ 未实现 | 词本前 300 / 短语前 400 / 错词每类前 100，有截断提示 |
| 跨时区测试 | ⚠️ 部分 | `due` 已改 UTC 毫秒，但无跨时区模拟断言 |
| 在线 TTS | ⚠️ mock | 无真实端点，仅验证编码与回退 |

## 测试现状

- 单元测试：265/265 通过（Node 环境，非 Android）
- 浏览器验收：68/68 通过（桌面 Chrome，非 WebView）
- APK：构建成功、签名校验通过、assets 路径正确

**这三项都不能替代真机验收。**

## 版本历史

| 版本 | 日期 | 内容 | 依据 |
|---|---|---|---|
| prever | 2026-11-27 | 第五轮修复后的快照，未编号 | `dist/archive/20261127-pre-versioning/`（SHA-256: 76c6f32e…） |
| 0.9.1-pre | 2026-11-27 | 纳入版本管理，含第五轮 5 项缺陷修复 | 当前 |
