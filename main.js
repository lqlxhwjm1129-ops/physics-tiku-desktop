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
const https = require('node:https')
const { spawn } = require('node:child_process')
const { app, BrowserWindow, Menu, ipcMain, shell, session, dialog } = require('electron')

/** 线上站点候选（仅远程模式使用；启动时选版本最新的一个，避免单一发布环境故障导致桌面版停更） */
const OFFICIAL_URL = 'https://physics-tiku-42021.app.workbuddy.host/'
const MIRROR_URL = 'https://lqlxhwjm1129-ops.github.io/physics-tiku/'
/** 实际加载的地址（内嵌本地页或线上页；窗口 origin 必须与其一致，避免 CORS） */
let appUrl = OFFICIAL_URL

/**
 * 内嵌本地页面路线（默认）。
 * 打包时 `../dist` 被复制到 `<resources>/app-dist`，启动时用本机 HTTP 服务托管它，
 * 因此**完全不依赖 GitHub Pages 或官方发布环境**，断网也能打开界面。
 * 端口优先 3000 —— 它在云后端 CORS 白名单内，切到「WorkBuddy 云」也能直连登录。
 * 排障需要回到远程加载时设置环境变量 TIKU_REMOTE=1。
 */
const APP_DIST_DIR = path.join(__dirname, '..', 'app-dist')
const LOCAL_PAGE_PORTS = [3000, 3001, 3002, 3003, 3005]
const FORCE_REMOTE = process.env.TIKU_REMOTE === '1'

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}
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

/** 渲染进程日志目录（排查桌面版问题用，主进程捕获 console 并落盘） */
const LOG_DIR = path.join(app.getPath('userData'), 'logs')
const RENDERER_LOG = path.join(LOG_DIR, 'renderer.log')
const RENDERER_LOG_MAX_BYTES = 5 * 1024 * 1024

function ensureLogDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
  } catch {
    // ignore
  }
}

function rotateLogIfNeeded() {
  try {
    if (fs.existsSync(RENDERER_LOG) && fs.statSync(RENDERER_LOG).size > RENDERER_LOG_MAX_BYTES) {
      const backup = `${RENDERER_LOG}.1`
      if (fs.existsSync(backup)) fs.unlinkSync(backup)
      fs.renameSync(RENDERER_LOG, backup)
    }
  } catch {
    // ignore
  }
}

function writeRendererLog(level, message, source, line) {
  ensureLogDir()
  rotateLogIfNeeded()
  const now = new Date().toISOString()
  const levelTag = String(level).toUpperCase().padStart(7, ' ')
  const loc = source ? `${path.basename(source)}:${line ?? 0}` : 'main'
  const lineText = `[${now}] [${levelTag}] [${loc}] ${message}\n`
  try {
    fs.appendFileSync(RENDERER_LOG, lineText, 'utf8')
  } catch {
    // ignore
  }
}

/** @type {BrowserWindow | null} */
let mainWindow = null
/** 退出流程是否已进入（防止 before-quit 重复触发） */
let quitting = false
/** 本次启动是否由本程序拉起过 MinerU（用于日志/兜底判断） */
let mineruStartedByUs = false

// 桌面版可能加载 GitHub Pages 镜像（HTTPS 页面访问本机 127.0.0.1 的 MinerU 时，
// Chromium 的「私有网络访问（PNA）」预检可能拦截本机回环请求，这里显式关闭该拦截）
app.commandLine.appendSwitch(
  'disable-features',
  'BlockInsecurePrivateNetworkRequests,BlockInsecurePrivateNetworkRequestsForNavigations,PrivateNetworkAccessRespectPreflightResults',
)

/** 拉取远端文本（带超时；任何异常都按空串返回，绝不阻塞启动） */
function fetchRemoteText(url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (v) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    try {
      const req = https.get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          finish('')
          return
        }
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          data += chunk
          if (data.length > 8192) req.destroy()
        })
        res.on('end', () => finish(data))
        res.on('aborted', () => finish(data))
      })
      req.on('error', () => finish(''))
      req.setTimeout(timeoutMs, () => {
        req.destroy()
        finish('')
      })
    } catch {
      finish('')
    }
  })
}

/** 读取某线上地址的版本号（version.json 为 "YYYY.MM.DD-HHmm"；读不到返回空串） */
async function readRemoteVersion(baseUrl) {
  const text = await fetchRemoteText(baseUrl + 'version.json')
  const m = text.match(/"version"\s*:\s*"(\d{4}\.\d{2}\.\d{2}-\d{4})"/)
  return m ? m[1] : ''
}

/**
 * 启动时对比官方地址与 GitHub Pages 镜像的线上版本号，加载最新的那个：
 * - 两者版本相同（或镜像读不到）→ 官方地址（零 CORS、直连后端）；
 * - 官方环境故障/停更、镜像更新 → 自动落到镜像（前端在 github.io 域下会自动走 Worker 代理登录）。
 */
async function resolveAppUrl() {
  const [officialV, mirrorV] = await Promise.all([readRemoteVersion(OFFICIAL_URL), readRemoteVersion(MIRROR_URL)])
  if (mirrorV && (!officialV || mirrorV > officialV)) {
    appUrl = MIRROR_URL
  } else {
    appUrl = OFFICIAL_URL
  }
  // eslint-disable-next-line no-console
  console.log(`线上地址选择：${appUrl}（官方 ${officialV || '?'} / 镜像 ${mirrorV || '?'}）`)
}

/** 托管内嵌网页产物的极简静态服务器（只服务 app-dist，防止目录穿越） */
function createStaticServer(rootDir) {
  return http.createServer((req, res) => {
    try {
      const rawPath = decodeURIComponent((req.url || '/').split('?')[0])
      let rel = rawPath.replace(/^\/+/, '')
      if (rel === '') rel = 'index.html'
      let filePath = path.join(rootDir, rel)
      if (!filePath.startsWith(rootDir)) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }
      let exists = fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()
      if (!exists && !path.extname(rel)) {
        // SPA 深链兜底：无扩展名的路径统一回落到 index.html
        filePath = path.join(rootDir, 'index.html')
        exists = fs.existsSync(filePath)
      }
      if (!exists) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Not Found')
        return
      }
      const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' })
      fs.createReadStream(filePath).pipe(res)
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Server Error')
    }
  })
}

/**
 * 启动内嵌页面服务，返回可用端口；产物缺失或端口全被占用时返回 null（调用方回退远程加载）。
 */
async function startEmbeddedPage() {
  if (!fs.existsSync(path.join(APP_DIST_DIR, 'index.html'))) {
    // eslint-disable-next-line no-console
    console.log('未找到内嵌网页产物，改用远程加载')
    return null
  }
  for (const port of LOCAL_PAGE_PORTS) {
    const server = createStaticServer(APP_DIST_DIR)
    const ok = await new Promise((resolve) => {
      const onError = () => {
        try {
          server.close()
        } catch {
          // ignore
        }
        resolve(false)
      }
      server.once('error', onError)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError)
        resolve(true)
      })
    })
    if (ok) {
      // eslint-disable-next-line no-console
      console.log(`内嵌网页已启动：http://127.0.0.1:${port}`)
      return port
    }
  }
  return null
}

/** 本地答案搜索 API（127.0.0.1:8765），由渲染进程注册搜索回调后提供服务 */
const API_PORT = Number.parseInt(process.env.TIKU_API_PORT || '8765', 10)
const API_HOST = '127.0.0.1'
const API_TIMEOUT_MS = 15000
/** 自定义 AI 接口转发超时（模型推理可能较慢） */
const LLM_TIMEOUT_MS = 90000
/** 请求体上限（防止异常大请求打爆内存） */
const MAX_BODY_BYTES = 4 * 1024 * 1024

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  setCorsHeaders(res)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  })
  res.end(body)
}

function parseQuery(url) {
  const u = new URL(url, `http://${API_HOST}:${API_PORT}`)
  return {
    text: u.searchParams.get('text') || '',
    limit: Math.min(50, Math.max(1, Number(u.searchParams.get('limit')) || 10)),
  }
}

async function searchAnswersViaRenderer(params) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('窗口未就绪')
  }
  const expr = `Promise.resolve(window.__tikuApiSearch ? window.__tikuApiSearch(${JSON.stringify(params)}) : null)`
  const result = await mainWindow.webContents.executeJavaScript(expr, false)
  if (!result) throw new Error('前端未注册搜索接口：请先登录并等待页面加载完成')
  return result
}

/** 读取请求体（带体积上限），返回解析后的 JSON 对象 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', (e) => reject(e))
  })
}

/**
 * 把「自定义 AI 接口」的 chat 请求放到主进程发出（Node 无浏览器 CORS 限制）。
 * 上游统一用非流式请求，返回完整文本给渲染进程 —— 界面上的按钮本来就是等整段结果。
 */
function forwardLlmRequest({ baseUrl, apiKey, model, messages }) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(String(baseUrl))
    } catch {
      reject(new Error('接口地址无效'))
      return
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      reject(new Error('仅支持 http/https 接口'))
      return
    }
    if (!model || !Array.isArray(messages) || messages.length === 0) {
      reject(new Error('缺少 model 或 messages'))
      return
    }

    const payload = JSON.stringify({ model: String(model), messages, stream: false })
    const transport = target.protocol === 'https:' ? https : http
    const key = typeof apiKey === 'string' ? apiKey.trim() : ''

    const req = transport.request(
      target,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => {
          data += c
          if (data.length > 4 * 1024 * 1024) req.destroy(new Error('接口返回内容过大'))
        })
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`接口返回 ${res.statusCode}：${data.slice(0, 300)}`))
            return
          }
          try {
            const parsed = JSON.parse(data)
            const content =
              parsed?.choices?.[0]?.message?.content ?? parsed?.choices?.[0]?.text ?? parsed?.output_text ?? ''
            if (typeof content === 'string' && content.trim()) resolve(content)
            else reject(new Error('接口未返回文本内容'))
          } catch {
            if (data.trim()) resolve(data.trim())
            else reject(new Error('接口返回内容无法解析'))
          }
        })
        res.on('error', (e) => reject(e))
      },
    )
    req.on('error', (e) => reject(e))
    req.setTimeout(LLM_TIMEOUT_MS, () => req.destroy(new Error('接口请求超时')))
    req.write(payload)
    req.end()
  })
}

function hasVisionCapability(m) {
  if (!m || typeof m !== 'object') return false
  if (m.capabilities && typeof m.capabilities === 'object' && m.capabilities.vision === true) return true
  if (m.supportsImages === true) return true
  return false
}

/**
 * 转发「获取模型列表」请求（OpenAI 兼容 `GET /models`），返回 { id, vision } 数组。
 * vision 优先以接口返回的 capabilities 为准，否则按模型名推断。
 * 与 chat 转发同理由主进程发出，绕开浏览器 CORS。
 */
function fetchModels({ url, apiKey }) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(String(url))
    } catch {
      reject(new Error('接口地址无效'))
      return
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      reject(new Error('仅支持 http/https 接口'))
      return
    }
    const transport = target.protocol === 'https:' ? https : http
    const key = typeof apiKey === 'string' ? apiKey.trim() : ''

    const req = transport.request(
      target,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => {
          data += c
          if (data.length > 4 * 1024 * 1024) req.destroy(new Error('接口返回内容过大'))
        })
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`接口返回 ${res.statusCode}：${data.slice(0, 300)}`))
            return
          }
          try {
            const parsed = JSON.parse(data)
            const list = Array.isArray(parsed?.data)
              ? parsed.data
              : Array.isArray(parsed?.models)
                ? parsed.models
                : Array.isArray(parsed)
                  ? parsed
                  : []
            const models = list
              .map((m) => {
                if (typeof m === 'string') return { id: m, vision: false }
                if (!m || typeof m !== 'object') return null
                const id = m.id || m.name || m.model
                if (typeof id !== 'string' || !id.trim()) return null
                return { id: id.trim(), vision: hasVisionCapability(m) }
              })
              .filter((x) => x && typeof x.id === 'string' && x.id.length > 0)
            if (models.length === 0) {
              reject(new Error('接口未返回任何模型'))
              return
            }
            resolve(models)
          } catch {
            reject(new Error('接口返回内容无法解析'))
          }
        })
        res.on('error', (e) => reject(e))
      },
    )
    req.on('error', (e) => reject(e))
    req.setTimeout(LLM_TIMEOUT_MS, () => req.destroy(new Error('接口请求超时')))
    req.end()
  })
}

function startLocalApiServer() {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        setCorsHeaders(res)
        res.writeHead(204)
        res.end()
        return
      }

      const pathname = new URL(req.url || '/', `http://${API_HOST}:${API_PORT}`).pathname
      if (pathname === '/api/health') {
        sendJson(res, 200, { ok: true, status: 'ok', app: 'physics-tiku-desktop', version: app.getVersion() })
        return
      }

      if (pathname === '/api/answer' || pathname === '/api/answer/search') {
        if (req.method !== 'GET' && req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '仅支持 GET/POST/OPTIONS' })
          return
        }
        let params
        if (req.method === 'POST') {
          let body = ''
          for await (const chunk of req) body += chunk
          try {
            params = JSON.parse(body || '{}')
          } catch {
            params = {}
          }
        } else {
          params = parseQuery(req.url || '')
        }
        if (!params.text || String(params.text).trim().length === 0) {
          sendJson(res, 400, { ok: false, error: '缺少查询参数 text' })
          return
        }
        const result = await Promise.race([
          searchAnswersViaRenderer(params),
          new Promise((_, reject) => setTimeout(() => reject(new Error('搜索超时')), API_TIMEOUT_MS)),
        ])
        sendJson(res, result && result.ok ? 200 : 400, result ?? { ok: false, error: '搜索无结果' })
        return
      }

      if (pathname === '/api/llm') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '仅支持 POST' })
          return
        }
        const body = await readJsonBody(req)
        const text = await Promise.race([
          forwardLlmRequest(body || {}),
          new Promise((_, reject) => setTimeout(() => reject(new Error('接口请求超时')), LLM_TIMEOUT_MS + 5000)),
        ])
        sendJson(res, 200, { ok: true, text })
        return
      }

      if (pathname === '/api/llm/models') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '仅支持 POST' })
          return
        }
        const body = await readJsonBody(req)
        const models = await Promise.race([
          fetchModels(body || {}),
          new Promise((_, reject) => setTimeout(() => reject(new Error('接口请求超时')), LLM_TIMEOUT_MS + 5000)),
        ])
        sendJson(res, 200, { ok: true, models })
        return
      }

      sendJson(res, 404, { ok: false, error: '接口不存在' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : '未知错误'
      sendJson(res, 500, { ok: false, error: msg })
    }
  })

  server.on('error', (e) => {
    // 端口被占用时静默，不影响主窗口使用
    if (e.code === 'EADDRINUSE') {
      // eslint-disable-next-line no-console
      console.log(`本地 API 端口 ${API_PORT} 已被占用，跳过启动`)
    }
  })

  try {
    server.listen(API_PORT, API_HOST, () => {
      // eslint-disable-next-line no-console
      console.log(`本地答案搜索 API 已启动：http://${API_HOST}:${API_PORT}`)
    })
  } catch {
    // ignore
  }
}

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
    // 优先使用内嵌本地页面（不依赖任何线上服务、断网可用）；不可用时回退远程加载
    const embeddedPort = FORCE_REMOTE ? null : await startEmbeddedPage()
    if (embeddedPort) {
      appUrl = `http://127.0.0.1:${embeddedPort}/`
    } else {
      await resolveAppUrl()
    }
    createWindow()
    startLocalApiServer()

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
      const base = new URL(appUrl)
      if (target.origin !== base.origin) {
        event.preventDefault()
        void shell.openExternal(url)
      }
    } catch {
      // 非法 URL 交给默认处理
    }
  })

  // 捕获渲染进程 console，写入本地日志，便于排查「按 F12 打不开 DevTools」时的问题
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    writeRendererLog(level, message, sourceId, line)
  })

  // F12 / Ctrl+Shift+I / Ctrl+Shift+J 切换 DevTools（无需菜单）
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isDevToolsShortcut =
      input.key === 'F12' ||
      ((input.control || input.meta) && input.shift && (input.key.toLowerCase() === 'i' || input.key.toLowerCase() === 'j'))
    if (isDevToolsShortcut) {
      event.preventDefault()
      mainWindow?.webContents.toggleDevTools()
    }
  })

  // 渲染进程崩溃/无响应也记一笔
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    writeRendererLog('error', `渲染进程退出：${details.reason}`, 'main', 0)
  })
  mainWindow.on('unresponsive', () => {
    writeRendererLog('error', '窗口无响应', 'main', 0)
  })

  writeRendererLog('info', `物理题库桌面版启动，日志路径：${RENDERER_LOG}，加载地址：${appUrl}`, 'main', 0)

  // 主框架加载失败 → 本地离线兜底页（错误码 -3 为用户主动取消，不处理）
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) {
      const query = { url: validatedURL || appUrl, code: String(errorCode), desc: errorDescription || '' }
      void mainWindow?.loadFile(OFFLINE_PAGE, { query })
    }
  })

  void mainWindow.loadURL(appUrl)

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
  ipcMain.handle('desktop:openDevTools', () => {
    mainWindow?.webContents.openDevTools({ mode: 'bottom' })
  })
  ipcMain.handle('desktop:reloadAndClearCache', async () => {
    // 只清 HTTP 磁盘缓存，不清 localStorage/cookies，登录态保留
    await session.fromPartition(PARTITION).clearCache()
    mainWindow?.reload()
  })

  /**
   * 直接下载 PDF：用 Chromium 的打印管线把当前窗口渲染成 PDF 后写盘。
   *
   * 相比渲染进程 `window.print()` 的两点优势：
   *  1. 不弹打印对话框，真正「一键保存」到磁盘；
   *  2. 产出的是**文本型 PDF**（文字可搜索/可选中、体积小），
   *     而不是经「Microsoft Print to PDF」之类虚拟打印机光栅化后的图片型 PDF。
   *
   * 版式完全复用既有打印契约：`preferCSSPageSize` 让 Chromium 采用预览页动态注入的
   * `@page { size }`（A4/A3/B4、横竖版），`@media print` 里的隐藏非打印元素与解除
   * 滚动容器高度限制的规则照常生效。
   */
  ipcMain.handle('desktop:exportPdf', async (_event, options) => {
    const opts = options && typeof options === 'object' ? options : {}
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { ok: false, error: '窗口不可用' }
    }
    try {
      const pdfData = await mainWindow.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: opts.preferCssPageSize !== false,
        landscape: Boolean(opts.landscape),
      })

      const defaultName =
        typeof opts.defaultFileName === 'string' && opts.defaultFileName.trim()
          ? opts.defaultFileName.trim()
          : '试卷.pdf'

      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: '保存 PDF',
        defaultPath: path.join(app.getPath('downloads'), defaultName),
        filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
      })
      if (canceled || !filePath) return { ok: false, canceled: true }

      fs.writeFileSync(filePath, pdfData)
      return { ok: true, path: filePath }
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) }
    }
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
