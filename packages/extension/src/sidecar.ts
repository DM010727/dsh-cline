import * as http from 'node:http'
import { EventEmitter } from 'node:events'
import type { SidecarState, SidecarStatus } from '@dsh-cline/protocol'

/** Cold boot (first run initializes the profile) can be slow on fresh machines. */
const START_TIMEOUT_MS = 180_000
const PROBE_TIMEOUT_MS = 3_000
/** Poll cadence while waiting for the service to answer. */
const POLL_MS = 1_000
/** Watchdog cadence once ready: how fast a dead DSH is detected and revived. */
const WATCHDOG_MS = 5_000
/** How often the process-discovery fallback refreshes its candidate list. */
const DISCOVER_EVERY_MS = 5_000

/** Executable plus argv for one launch. */
export interface SidecarCommand {
  cmd: string
  args: string[]
  /** Loopback host/port the service is expected on; drives the probe URL. */
  host: string
  port: number
}

/**
 * Terminal-resident service operations, implemented by the extension host:
 * the DSH web process lives in a visible VS Code terminal the user can watch
 * and keep, not in a hidden child of the extension host.
 */
export interface SidecarHost {
  /**
   * Start the service: create/reuse the DSH terminal, wait for the shell to
   * accept input, and type the command. Resolves once the line was sent -
   * awaiting it keeps the probe loop from polling a command that never ran
   * (the sendText/creation race on Windows PowerShell drops the Enter).
   */
  launch(cmd: SidecarCommand): void | Promise<void>
  /**
   * Best-effort discovery of locally running `dsh web` listeners (candidate
   * URLs read from process command lines). Probed as a FALLBACK when the
   * configured port stays silent: whatever made the actual port diverge from
   * the configured one, a running dsh web is still found and bound to.
   */
  discoverUrls?(): Promise<string[]>
  /** Whether the service terminal still exists (not closed by the user). */
  alive(): boolean
  /** Best-effort interrupt of the running process (Ctrl+C in the terminal). */
  interrupt?(): void
}

/** State transition broadcast; `url` is set on ready. */
export interface SidecarChangeEvent {
  state: SidecarState
  url?: string
  detail?: string
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Owns the DSH web service lifecycle in terminal-resident mode: probe the
 * loopback URL to decide whether DSH already runs locally (bind to it when it
 * does), launch `dsh web` in the VS Code terminal when it does not, poll until
 * it answers, and keep a watchdog that auto-relaunches DSH after it dies -
 * a reboot of the machine, a killed process, or a closed terminal must never
 * leave the panel unusable. Generation ids keep a superseded start (config
 * edit, restart) from clobbering the state of the attempt that replaced it.
 */
export class SidecarManager extends EventEmitter {
  private state: SidecarState = 'stopped'
  private urlValue?: string
  private detailValue?: string
  private starting?: Promise<string>
  private watchdog?: NodeJS.Timeout
  private gen = 0
  private disposed = false
  /**
   * How the current ready URL was reached: 'bind' = an already-running dsh web
   * answered the probe (its in-memory plugin predates any on-disk plugin
   * update this activation just installed); 'launch' = we launched it, so it
   * boots the on-disk plugin. The extension reads this to auto-restart a bound
   * instance once after a plugin update, so upgrades self-heal without the
   * user running the restart command.
   */
  public lastReadyVia?: 'bind' | 'launch'

  /**
   * @param resolveCommand - invoked at every start, so config edits apply on
   *   restart without re-reading here.
   * @param preLaunch - awaited before each start; used to ensure the `dsh`
   *   runtime exists. Receives a callback to surface progress into the detail.
   * @param host - terminal-backed operations (launch/alive/interrupt).
   */
  constructor(
    private readonly resolveCommand: () => SidecarCommand,
    private readonly preLaunch?: (detail: (msg: string) => void) => Promise<void>,
    private readonly host?: SidecarHost,
  ) {
    super()
  }

  /** Current snapshot for status bars and webview shells. */
  status(): SidecarStatus {
    return { state: this.state, url: this.urlValue, detail: this.detailValue }
  }

  /**
   * Bring the service to ready and resolve its URL. Concurrent calls share one
   * attempt; an already-ready service resolves at once. A service that answers
   * on the probe URL is bound to as-is (user-started or leftover instance),
   * never relaunched.
   * @returns the loopback URL, e.g. http://127.0.0.1:52341
   */
  start(): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('sidecar manager disposed'))
    if (this.state === 'ready' && this.urlValue !== undefined) return Promise.resolve(this.urlValue)
    if (this.starting !== undefined) return this.starting
    this.starting = this.bringUp()
    return this.starting
  }

  /** Prepare the runtime, then bind-or-launch and wait for the service. */
  private async bringUp(): Promise<string> {
    const gen = this.gen
    try {
      if (this.preLaunch !== undefined) {
        this.setState('starting', undefined, '正在准备 dsh 运行时…')
        await this.preLaunch(msg => this.setState('starting', undefined, msg))
      }
      const url = this.baseUrl()
      this.setState('starting', undefined, '正在检测本地 DSH…')
      // Bind to an instance that is already running locally - never relaunch it.
      if (await this.probe(url)) return this.settleReady(gen, url, 'bind')
      // Not running: launch it in the terminal (the host waits for the shell
      // to accept input before typing), then wait for a listener to answer.
      this.setState('starting', undefined, 'DSH 启动中：正在 VS Code 终端中启动 dsh web…')
      await this.host?.launch(this.resolveCommand())
      const deadline = Date.now() + START_TIMEOUT_MS
      // The configured port is probed every tick; the process-discovery
      // fallback refreshes its candidates periodically and is probed when the
      // configured port stays silent. No per-tick state updates: the starting
      // page stays static (a re-rendering "countdown" reloads the webview
      // every few seconds, which reads as the panel endlessly refreshing).
      let discovered: string[] = []
      let discoveredAt = 0
      // Squatter detection: a listener that never serves the GUI within this
      // window after OUR launch is a leftover process holding the port (the
      // fresh `dsh web` died on EADDRINUSE in the terminal). Fail fast with
      // the recovery command instead of riding out the whole start timeout.
      const SQUATTER_MS = 30_000
      let squatterSince: number | undefined
      while (Date.now() < deadline) {
        await delay(POLL_MS)
        if (gen !== this.gen) throw new Error('superseded')
        if (await this.probe(url)) return this.settleReady(gen, url, 'launch')
        // Fail fast when the service terminal was closed mid-startup.
        if (this.host !== undefined && !this.host.alive()) {
          throw new Error('DSH 启动失败：「DSH Cline 服务」终端已被关闭。请重试，并保持该终端开启。')
        }
        if (await this.carrierUp(url)) {
          if (squatterSince === undefined) squatterSince = Date.now()
          if (Date.now() - squatterSince >= SQUATTER_MS) {
            throw new Error('端口 ' + url + ' 被一个无响应的残留进程占用（新启动的 dsh web 已因端口冲突退出，'
              + '详见「DSH Cline 服务」终端）。请执行命令面板中的「DSH Cline: 清理残留 DSH 进程」后重试。')
          }
        } else {
          squatterSince = undefined
        }
        if (this.host?.discoverUrls !== undefined && Date.now() - discoveredAt >= DISCOVER_EVERY_MS) {
          discoveredAt = Date.now()
          discovered = await this.host.discoverUrls()
        }
        for (const candidate of discovered) {
          if (candidate === url) continue
          // Only bind DISCOVERED instances that are OURS: the candidate must
          // serve /dsh-cline/health (mounted by the host-services plugin). A
          // foreign `dsh web` (user's own ~/.dsh home, no plugin, no bridge)
          // answers 404 there - binding it left the panel on a DSH whose
          // DSH-Cline features were all dead. The CONFIGURED port keeps its
          // plain bind: an instance there was started on our port on purpose.
          if (await this.probe(candidate) && await this.probeOurs(candidate)) {
            return this.settleReady(gen, candidate, 'bind')
          }
        }
      }
      throw new Error('DSH ' + (START_TIMEOUT_MS / 1000) + 's 内未就绪（探测 ' + url
        + (discovered.length === 0 ? '' : ' 及已发现实例 ' + discovered.join('、') + ' 均无应答')
        + '）。请查看「DSH Cline 服务」终端中的输出后重试；若端口被旧实例占用（配置页报'
        + ' "not registered" 类错误），执行「DSH Cline: 重启 DSH 服务」替换它。')
    } catch (err: unknown) {
      if (gen !== this.gen) throw err
      this.starting = undefined
      const message = err instanceof Error ? err.message : String(err)
      this.setState('failed', undefined, message)
      throw err
    }
  }

  /** Generation-checked ready transition: a superseded attempt never settles. */
  private settleReady(gen: number, url: string, via: 'bind' | 'launch'): string {
    if (gen !== this.gen) throw new Error('superseded')
    this.starting = undefined
    this.lastReadyVia = via
    this.setState('ready', url)
    this.armWatchdog(url)
    return url
  }

  /** Stop tracking the service (and the watchdog); a new start launches fresh. */
  stop(): void {
    this.gen++
    this.starting = undefined
    this.stopWatchdog()
    this.urlValue = undefined
    this.setState('stopped')
  }

  /**
   * Interrupt the running process, wait for it to die, then start again;
   * resolves with the new URL. The old instance is interrupted by its OWN url
   * (captured before stop), so a config edit that changes the port still
   * kills the process on the old port instead of probing the new one. The
   * interrupt decision needs only a LISTENER (any HTTP answer) - including a
   * broken zombie the readiness probe refuses - or the relaunch would race a
   * squatter still holding the port.
   */
  async restart(): Promise<string> {
    const previousUrl = this.urlValue
    this.stop()
    const url = previousUrl ?? this.baseUrl()
    if (this.host?.interrupt !== undefined && await this.carrierUp(url)) {
      this.host.interrupt()
      for (let i = 0; i < 8; i++) {
        await delay(1_000)
        if (!(await this.carrierUp(url))) break
      }
    }
    return this.start()
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    this.removeAllListeners()
  }

  /**
   * While ready, probe the service and auto-relaunch it when it dies - the
   * panel must survive the user closing the DSH process, its terminal, or a
   * machine reboot followed by a VS Code start.
   */
  private armWatchdog(url: string): void {
    this.stopWatchdog()
    const gen = this.gen
    // probe() resolves true when the service is REALLY up (the web GUI
    // answers), so `alive` here means "still serving". A healthy service must
    // be left alone; only a service that stays dead across consecutive checks
    // is restarted - a single slow probe (3s timeout) or a momentary 5xx must
    // never kill a healthy DSH, or the panel would reload between the GUI and
    // the starting page forever.
    let misses = 0
    this.watchdog = setInterval(() => {
      if (this.disposed || gen !== this.gen) return this.stopWatchdog()
      void this.probe(url).then(alive => {
        if (this.disposed || gen !== this.gen) return
        if (alive) { misses = 0; return }
        if (++misses < 2) return
        misses = 0
        this.stopWatchdog()
        this.urlValue = undefined
        this.setState('starting', undefined, '检测到 DSH 已停止，正在自动重启…')
        void this.start().catch(() => { /* state broadcast already surfaced */ })
      })
    }, WATCHDOG_MS)
    this.watchdog.unref()
  }

  private stopWatchdog(): void {
    if (this.watchdog !== undefined) {
      clearInterval(this.watchdog)
      this.watchdog = undefined
    }
  }

  /** Loopback base URL derived from the resolved command's host/port. */
  private baseUrl(): string {
    const { host, port } = this.resolveCommand()
    return 'http://' + host + ':' + port
  }

  /** Any HTTP answer below 500 proves a LISTENER exists (healthy or not). */
  private carrierUp(url: string): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      const req = http.get(url, res => {
        res.resume()
        resolve((res.statusCode ?? 500) < 500)
      })
      req.on('error', () => resolve(false))
      req.setTimeout(PROBE_TIMEOUT_MS, () => {
        req.destroy()
        resolve(false)
      })
    })
  }

  /**
   * A listener proves the carrier is up, not that DSH works: a bundle-less
   * instance (pre-scaffold zombie) listens and answers 404 to everything, and
   * binding to it left the panel on a broken GUI whose settings writes all
   * failed with "namespace is not registered". Ready therefore requires the
   * web GUI itself to answer: `GET /` must return 200 HTML - only a fully
   * composed instance serves the SPA fallback on the root. A still-booting
   * instance answers 404 until its rows mount, which the poll loop rides out.
   */
  private probe(url: string): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      const req = http.get(url, res => {
        const ok = (res.statusCode ?? 500) === 200
          && /^text\/html/.test(String(res.headers['content-type'] ?? ''))
        res.resume()
        resolve(ok)
      })
      req.on('error', () => resolve(false))
      req.setTimeout(PROBE_TIMEOUT_MS, () => {
        req.destroy()
        resolve(false)
      })
    })
  }

  /**
   * Whether the instance at `url` carries OUR host-services plugin: it serves
   * `/dsh-cline/health` (200 with the bridge up, 502 with it down - either
   * proves the route exists). A foreign `dsh web` 404s there, so discovered
   * candidates are only bound when this passes.
   */
  private probeOurs(url: string): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      const req = http.get(url + '/dsh-cline/health', res => {
        const status = res.statusCode ?? 0
        res.resume()
        resolve(status !== 404 && status !== 0)
      })
      req.on('error', () => resolve(false))
      req.setTimeout(PROBE_TIMEOUT_MS, () => {
        req.destroy()
        resolve(false)
      })
    })
  }

  private setState(state: SidecarState, url?: string, detail?: string): void {
    this.state = state
    // The ready transition carries the resolved loopback URL; persist it so
    // status()/shell can build the GUI iframe (status().url was never written
    // before, so the shell stayed on the blank "DSH Sidecar" overlay forever).
    if (url !== undefined) this.urlValue = url
    if (state === 'ready') this.detailValue = undefined
    else if (detail !== undefined) this.detailValue = detail
    this.emit('change', { state, url: url ?? this.urlValue, detail: this.detailValue } satisfies SidecarChangeEvent)
  }
}
