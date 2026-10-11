/**
 * Electron 主进程（远程加载路线）。
 *
 * 安全与体验基线（见 ARCH-V2 §1.4 / §7.12）：
 * - 窗口 origin 与线上完全一致 → SDK 对 /.cloud/** 的请求同源，零 CORS；
 * - 持久分区 `persist:physics-tiku`：SDK 用 localStorage 存凭据会落盘，登录态跨启动保留；
 *   **绝不调用 session.clearStorageData()**（否则丢登录态）；
 * - contextIsolation + sandbox + nodeIntegration:false；外链交系统浏览器；单实例锁；
 * - 加载失败时展示本地离线兜底页 resources/offline.html。
 */
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { app, BrowserWindow, Menu, ipcMain, shell, session } = require('electron')

/** 线上站点（窗口 origin 必须与此一致，避免 CORS） */
const APP_URL = 'https://physics-tiku-42021.app.workbuddy.host/'
/** 持久化分区（保登录态） */
const PARTITION = 'persist:physics-tiku'
const OFFLINE_PAGE = path.join(__dirname, 'resources', 'offline.html')

/**
 * 本机 MinerU 增强解析服务（可选组件）。
 * 桌面版与 MinerU 同生命周期：
 * - 启动软件时若探测到服务未在线，自动拉起它（已在线则跳过，避免重复启动）；
 * - 关闭软件时自动停止 MinerU（8000 代理 + 8001 本体），不残留后台进程。
 * 环境变量开关：MINERU_AUTOSTART=0 不自动启动；MINERU_SHUTDOWN=0 不在退出时关闭。
 * 服务目录不在默认位置时用 MINERU_DIR 指定。
 */
const MINERU_DIR = process.env.MINERU_DIR || 'D:\\mineru-service'
const MINERU_START_CMD = 'start-mineru.cmd'
const MINERU_STOP_CMD = 'stop-mineru.cmd'
const MINERU_HEALTH_URL = 'http://127.0.0.1:8000/v1/health'
/** MinerU 监听端口：8000 对外 CORS 代理，8001 内部 API（退出时按端口兜底结束） */
const MINERU_PORTS = [8000, 8001]
const MINERU_AUTOSTART = process.env.MINERU_AUTOSTART !== '0'
const MINERU_SHUTDOWN = process.env.MINERU_SHUTDOWN !== '0'

/** @type {BrowserWindow | null} */
let mainWindow = null
/** 退出流程是否已进入（防止 before-quit 重复触发） */
let quitting = false
/** 本次启动是否由本程序拉起过 MinerU（用于日志/兜底判断） */
let mineruStartedByUs = false

// 单实例锁：已在运行则聚焦已有窗口并退出本次启动
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    app.setName('物理题库')
    Menu.setApplicationMenu(null)
    registerIpc()
    // 启动软件时自动拉起本机 MinerU 增强解析服务（不阻塞窗口显示）
    void ensureMineru()
    // 清理 HTTP 磁盘缓存，避免线上更新后桌面版仍请求旧版 JS chunk（不清 localStorage/cookies，登录态保留）
    await session.fromPartition(PARTITION).clearCache()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/**
 * 关闭软件时同步关闭 MinerU：
 * 先拦截退出，异步停掉 MinerU 服务，完成后再真正退出（带超时兜底，最多等 8 秒）。
 */
app.on('before-quit', (event) => {
  if (quitting || !MINERU_SHUTDOWN) return
  quitting = true
  event.preventDefault()
  void shutdownMineru().finally(() => app.exit(0))
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    title: '物理题库',
    backgroundColor: '#1565c0',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show())

  // 新窗口（target=_blank）一律交系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 站外跳转交系统浏览器，保持窗口内始终是本站（origin 一致）
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url)
      const base = new URL(APP_URL)
      if (target.origin !== base.origin) {
        event.preventDefault()
        void shell.openExternal(url)
      }
    } catch {
      // 非法 URL 交给默认处理
    }
  })

  // 主框架加载失败 → 本地离线兜底页（错误码 -3 为用户主动取消，不处理）
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) {
      const query = { url: validatedURL || APP_URL, code: String(errorCode), desc: errorDescription || '' }
      void mainWindow?.loadFile(OFFLINE_PAGE, { query })
    }
  })

  void mainWindow.loadURL(APP_URL)

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/** 渲染进程经 preload 请求的能力（sandbox 下 shell 只能在主进程调用） */
function registerIpc() {
  ipcMain.handle('desktop:openExternal', (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      return shell.openExternal(url)
    }
    return undefined
  })
  ipcMain.handle('desktop:appVersion', () => app.getVersion())
  ipcMain.handle('desktop:reloadAndClearCache', async () => {
    // 只清 HTTP 磁盘缓存，不清 localStorage/cookies，登录态保留
    await session.fromPartition(PARTITION).clearCache()
    mainWindow?.reload()
  })
}

/** 探测本机 MinerU 是否已在线（短超时，避免拖慢启动） */
function probeMineru(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(MINERU_HEALTH_URL, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolve(false)
    })
  })
}

/**
 * 启动时自动拉起 MinerU 服务：
 * - 目录 / 启动脚本缺失 → 跳过（前端会自动回退内置解析）；
 * - 服务已在线 → 跳过（不重复启动）；
 * - 否则 detached 启动，独立于桌面版进程常驻。
 */
async function ensureMineru() {
  if (!MINERU_AUTOSTART) return
  const startScript = path.join(MINERU_DIR, MINERU_START_CMD)
  if (!fs.existsSync(startScript)) return
  if (await probeMineru()) return
  try {
    const child = spawn('cmd.exe', ['/c', MINERU_START_CMD], {
      cwd: MINERU_DIR,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    mineruStartedByUs = true
  } catch {
    // 启动失败不影响主流程：上传时前端检测不到服务会自动回退本地解析
  }
}

/** 按端口结束监听进程（stop 脚本缺失或执行失败时的兜底） */
function killMineruPorts() {
  return new Promise((resolve) => {
    const cmd =
      MINERU_PORTS.map(
        (p) =>
          `for /f "tokens=5" %a in ('netstat -ano ^| findstr ":${p}" ^| findstr "LISTENING"') do taskkill /F /PID %a`,
      ).join(' & ') + ' & exit /b 0'
    try {
      const child = spawn('cmd.exe', ['/c', cmd], { windowsHide: true, stdio: 'ignore' })
      child.on('exit', () => resolve())
      child.on('error', () => resolve())
    } catch {
      resolve()
    }
  })
}

/**
 * 停止 MinerU 服务（8000 / 8001）：
 * - 服务不在线且非本次启动 → 无需处理，直接返回；
 * - 优先调用 stop-mineru.cmd（按端口优雅结束）；脚本缺失或异常时按端口兜底强杀；
 * - 全程最长 8 秒，绝不阻塞/卡住软件退出。
 */
function shutdownMineru() {
  return new Promise((resolve) => {
    if (!MINERU_SHUTDOWN) return resolve()
    const done = () => resolve()
    const timer = setTimeout(done, 8000)
    const finish = () => {
      clearTimeout(timer)
      resolve()
    }

    void probeMineru(1000).then((online) => {
      if (!online && !mineruStartedByUs) {
        finish()
        return
      }
      const stopScript = path.join(MINERU_DIR, MINERU_STOP_CMD)
      if (!fs.existsSync(stopScript)) {
        void killMineruPorts().then(finish)
        return
      }
      try {
        const child = spawn('cmd.exe', ['/c', MINERU_STOP_CMD], {
          cwd: MINERU_DIR,
          windowsHide: true,
          stdio: 'ignore',
        })
        child.on('exit', () => {
          // 脚本执行后仍在线则兜底强杀
          void probeMineru(800).then((stillOnline) => {
            if (stillOnline) void killMineruPorts().then(finish)
            else finish()
          })
        })
        child.on('error', () => {
          void killMineruPorts().then(finish)
        })
      } catch {
        void killMineruPorts().then(finish)
      }
    })
  })
}
