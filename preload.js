/**
 * 预加载脚本：在 sandbox + contextIsolation 下，仅向渲染进程暴露最小只读能力。
 * 通过 contextBridge 暴露到 window.desktop（不泄漏 Node / Electron 内部对象）。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  /** 运行平台：'win32' | 'darwin' | 'linux' */
  platform: process.platform,
  /** 应用版本（由主进程读取 package.json 后返回） */
  getAppVersion: () => ipcRenderer.invoke('desktop:appVersion'),
  /** 用系统默认浏览器打开 http(s) 链接 */
  openExternal: (url) => ipcRenderer.invoke('desktop:openExternal', url),
  /** 清 HTTP 磁盘缓存后重载当前窗口（用于线上更新后 chunk 加载失败时一键恢复） */
  reloadAndClearCache: () => ipcRenderer.invoke('desktop:reloadAndClearCache'),
})
