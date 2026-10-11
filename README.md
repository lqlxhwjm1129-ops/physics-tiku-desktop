# 物理题库 · 桌面版

物理题库的 Electron 桌面外壳。**联网使用**：启动后远程加载线上站点，本身不打包前端资源，因此网页端更新后无需重新打包 exe。

- **应用地址**：https://lqlxhwjm1129-ops.github.io/physics-tiku/
- **网页产物仓库**：https://github.com/lqlxhwjm1129-ops/physics-tiku
- **安装包下载**：见本仓库的 [Releases](../../releases)

## 目录说明

| 文件 | 说明 |
|---|---|
| `main.js` | 主进程：创建窗口、启动时探测并拉起 MinerU 解析服务、退出时关闭 MinerU、退出前清缓存 |
| `preload.js` | 预加载脚本：向渲染进程暴露 `window.desktop`（版本号、打开外链、清缓存重载） |
| `build/icon.ico` | 应用图标 |
| `resources/offline.html` | 启动时网络不可用的兜底页面 |
| `package.json` | 依赖与 electron-builder 打包配置 |

## 环境变量开关

| 变量 | 默认 | 说明 |
|---|---|---|
| `MINERU_AUTOSTART` | 启用 | 设为 `0` 关闭「启动应用时自动拉起 MinerU」 |
| `MINERU_SHUTDOWN` | 启用 | 设为 `0` 关闭「退出应用时自动关闭 MinerU」 |
| `MINERU_DIR` | `D:\mineru-service` | MinerU 服务所在目录 |
| `PHYSICS_TIKU_URL` | 线上地址 | 覆盖应用加载的地址（可指向本地 `http://127.0.0.1:3000/`） |

## 开发与打包

```bash
npm install

# 开发运行
npm start

# 打包 Windows 便携版 + 安装版
npx electron-builder --win -c.win.signAndEditExecutable=false
```

产物输出在 `release/` 目录。

> 国内网络建议先设置镜像，避免下载 Electron 二进制超时：
>
> ```bash
> set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
> set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
> ```

## 更新流程

网页端改动 → 构建并推送 `physics-tiku` 仓库 → 桌面版**刷新即生效**，无需重打包。

仅当 `desktop/` 内代码（`main.js` / `preload.js`）改动时，才需要重新打包并发布新的 Release。
