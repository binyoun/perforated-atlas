import type { NoteEvent, StripJSON } from '../engine/types'
import { SANKYO_30 } from '../engine/translate'
import { GlowTracker } from '../light/GlowTracker'

// --- Renderer configuration -------------------------------------------------
// Every tunable visual constant lives here. Firmware note: PIXELS_PER_SECOND
// is the canvas analogue of the physical scroll speed (36 mm/s).

export const RENDERER_CONFIG = {
  // Geometry
  TRACK_HEIGHT: 11,
  TRACK_GAP: 1,
  TRACK_COUNT: 30,
  PIXELS_PER_SECOND: 108, // ~9px-equivalent scroll per 250ms note
  READ_HEAD_X_RATIO: 0.32, // comb sits at 32% from left edge
  ACTIVE_TOLERANCE_PX: 4,

  // Paper — cooler, less yellow, translucent parchment
  PAPER_COLOR: '#E8E0CC',
  PAPER_EDGE_DARK: '#A09060',
  EDGE_SHADOW_HEIGHT: 8,
  STRIP_DROP_SHADOW: 'rgba(0,0,0,0.6)', // strip floats above the background
  STRIP_DROP_SHADOW_SIZE: 4,
  GRAIN_TILE_SIZE: 128, // px, offscreen noise tile
  GRAIN_ALPHA: 0.045,

  // Holes
  HOLE_COLOR: '#0C0800',
  HOLE_RIM_DARK: 'rgba(80,40,0,0.5)',
  HOLE_RIM_LIGHT: 'rgba(255,240,200,0.08)', // 1px inset rim: physical depth

  // Comb — engraved, desaturated brass
  COMB_COLOR: '#6B5214',
  TINE_BRIGHT: '#B08C18',
  TINE_HIGHLIGHT: 'rgba(255,230,150,0.45)', // 1px engraved top line per tine
  TINE_WIDTH: 3,
  TINE_LENGTH: 18,
  COMB_BODY_WIDTH: 20,

  // Scene
  BACKGROUND: '#0b0b0b',
  EDGE_FADE_WIDTH: 120,

  // Animation
  PUNCH_DURATION_MS: 1200,
  IDLE_PERIOD_MS: 3000, // breathing period of the idle pulse
  IDLE_BASE_RADIUS: 90, // px, pulse radius before breathing scale
} as const

const C = RENDERER_CONFIG
const STRIP_HEIGHT = C.TRACK_COUNT * (C.TRACK_HEIGHT + C.TRACK_GAP) // 360px
const TRACK_PITCH = C.TRACK_HEIGHT + C.TRACK_GAP

/**
 * Rounded-rectangle path helper (radius clamped to fit the rect).
 */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

/**
 * Build a small offscreen tile of monochrome noise, used as a repeating
 * paper-grain pattern. Procedural — no image assets.
 */
function makeGrainTile(size: number): HTMLCanvasElement {
  const tile = document.createElement('canvas')
  tile.width = size
  tile.height = size
  const tctx = tile.getContext('2d')!
  const imageData = tctx.createImageData(size, size)
  const px = imageData.data
  for (let i = 0; i < px.length; i += 4) {
    const v = Math.floor(Math.random() * 255)
    px[i] = v
    px[i + 1] = v
    px[i + 2] = v
    px[i + 3] = 255
  }
  tctx.putImageData(imageData, 0, 0)
  return tile
}

export class StripRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D

  private strip: StripJSON | null = null
  private _totalDuration = 0

  private playing = false
  private _currentTime = 0
  private lastFrameTime = 0
  private rafId: number | null = null

  private firedNotes = new Set<number>()

  private glowTracker = new GlowTracker()
  private activeNoteIds = new Set<number>()
  private punchProgress = 1

  private paperImage: HTMLImageElement | null = null
  private grainPattern: CanvasPattern | null = null

  private lightIntensity = 1.0

  // Idle breathing: a slow ambient pulse at the read head while the strip is
  // loaded but not playing — the machine is alive, waiting for a hand.
  private idleRafId: number | null = null
  private idleStart = 0

  onNotePlay: ((note: NoteEvent, trackIndex: number) => void) | null = null

  private readonly resizeHandler: () => void
  private resizeObserver: ResizeObserver | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas context not available')
    this.ctx = ctx

    this.grainPattern = ctx.createPattern(makeGrainTile(C.GRAIN_TILE_SIZE), 'repeat')

    // Window resize covers devicePixelRatio changes (e.g. moving the window
    // between displays); the ResizeObserver covers element-level layout
    // changes (mobile rotation, responsive reflow).
    this.resizeHandler = () => this.resize()
    window.addEventListener('resize', this.resizeHandler)
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize())
      this.resizeObserver.observe(canvas)
    }

    this.syncCanvasSize()
    this.draw()
  }

  /** Re-sync the canvas backing store to its current CSS size and redraw. */
  resize(): void {
    this.syncCanvasSize()
    this.draw()
  }

  /** Match the canvas backing store to its CSS size and device pixel ratio. */
  private syncCanvasSize(): void {
    const dpr = window.devicePixelRatio || 1
    const rect = this.canvas.getBoundingClientRect()
    const cssW = rect.width || this.canvas.clientWidth || 800
    const cssH = rect.height || this.canvas.clientHeight || 420
    this.canvas.width = Math.round(cssW * dpr)
    this.canvas.height = Math.round(cssH * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  private get cssWidth(): number {
    const dpr = window.devicePixelRatio || 1
    return this.canvas.width / dpr
  }

  private get cssHeight(): number {
    const dpr = window.devicePixelRatio || 1
    return this.canvas.height / dpr
  }

  private get readHeadX(): number {
    return this.cssWidth * C.READ_HEAD_X_RATIO
  }

  private get stripY(): number {
    return (this.cssHeight - STRIP_HEIGHT) / 2
  }

  /** Set the strip paper backdrop. Persists across strip loads/resets. */
  setPaper(img: HTMLImageElement | null): void {
    this.paperImage = img
  }

  /**
   * Modulate the afterglow bloom intensity (0.1–1). Driven by hand proximity:
   * the machine glows brighter as a hand approaches. Light only, never sound.
   */
  setLightIntensity(value: number): void {
    this.lightIntensity = Math.max(0.1, Math.min(1, value))
  }

  load(strip: StripJSON): void {
    this.glowTracker.clear()
    this.activeNoteIds.clear()
    this.strip = strip
    this._totalDuration = strip.notes.reduce((sum, n) => sum + n.dur, 0)
    this._currentTime = 0
    this.playing = false
    this.firedNotes.clear()
    this.lightIntensity = 1.0
    this.cancelRaf()
    this.draw()
    this.startIdle()
  }

  play(): void {
    if (!this.strip || this.playing) return
    this.stopIdle()
    // If we're at (or past) the end, restart from the beginning.
    if (this._currentTime >= this._totalDuration + 1) {
      this.reset()
    }
    this.playing = true
    this.lastFrameTime = performance.now()
    this.rafId = requestAnimationFrame(this.tick)
  }

  pause(): void {
    this.playing = false
    this.cancelRaf()
    this.startIdle()
  }

  reset(): void {
    this.glowTracker.clear()
    this.activeNoteIds.clear()
    this._currentTime = 0
    this.firedNotes.clear()
    this.lightIntensity = 1.0
    this.draw()
  }

  /**
   * Animate holes appearing as if stamped into the strip. Runs for ~1.2s and
   * resolves when the punch frontier has swept the full strip. Call before play().
   */
  punch(): Promise<void> {
    return new Promise(resolve => {
      if (!this.strip) {
        resolve()
        return
      }

      this.stopIdle()
      const start = performance.now()

      const animate = (): void => {
        const elapsed = performance.now() - start
        this.punchProgress = Math.min(elapsed / C.PUNCH_DURATION_MS, 1)
        this.draw()

        if (this.punchProgress < 1) {
          requestAnimationFrame(animate)
        } else {
          this.punchProgress = 1
          if (!this.playing) this.startIdle()
          resolve()
        }
      }

      this.punchProgress = 0
      requestAnimationFrame(animate)
    })
  }

  dispose(): void {
    this.cancelRaf()
    this.stopIdle()
    window.removeEventListener('resize', this.resizeHandler)
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.onNotePlay = null
  }

  get isPlaying(): boolean {
    return this.playing
  }

  get currentTime(): number {
    return this._currentTime
  }

  /** Total strip duration in seconds. Mirrors what firmware derives from notes. */
  get totalDuration(): number {
    return this._totalDuration
  }

  /** Playback progress 0–1. */
  get progress(): number {
    if (this._totalDuration <= 0) return 0
    return Math.min(1, this._currentTime / this._totalDuration)
  }

  private cancelRaf(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  // --- Idle breathing -------------------------------------------------------

  private startIdle(): void {
    if (this.idleRafId !== null || !this.strip || this.playing) return
    this.idleStart = performance.now()
    const loop = (now: number): void => {
      if (this.playing || !this.strip) {
        this.idleRafId = null
        return
      }
      this.draw()
      this.drawIdlePulse(now)
      this.idleRafId = requestAnimationFrame(loop)
    }
    this.idleRafId = requestAnimationFrame(loop)
  }

  private stopIdle(): void {
    if (this.idleRafId !== null) {
      cancelAnimationFrame(this.idleRafId)
      this.idleRafId = null
    }
  }

  /** Slow sin-based pulse at the read head: scale 0.8–1.0, period ~3s. */
  private drawIdlePulse(now: number): void {
    const ctx = this.ctx
    const phase = ((now - this.idleStart) % C.IDLE_PERIOD_MS) / C.IDLE_PERIOD_MS
    const breathe = 0.9 + 0.1 * Math.sin(phase * Math.PI * 2) // 0.8–1.0 scale
    const radius = C.IDLE_BASE_RADIUS * breathe
    const cx = this.readHeadX
    const cy = this.stripY + STRIP_HEIGHT / 2

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    const pulse = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
    pulse.addColorStop(0, `rgba(255,240,200,${0.05 * breathe})`)
    pulse.addColorStop(0.6, `rgba(255,240,200,${0.02 * breathe})`)
    pulse.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = pulse
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2)
    ctx.restore()
  }

  private tick = (now: number): void => {
    if (!this.playing) return
    const dt = (now - this.lastFrameTime) / 1000
    this.lastFrameTime = now
    this._currentTime += dt

    this.fireActiveNotes()
    this.draw()

    if (this._currentTime >= this._totalDuration + 1) {
      this.playing = false
      this.rafId = null
      this.startIdle() // strip finished — the machine waits again
      return
    }
    this.rafId = requestAnimationFrame(this.tick)
  }

  private fireActiveNotes(): void {
    if (!this.strip || !this.onNotePlay) return
    this.strip.notes.forEach((note, i) => {
      if (this.firedNotes.has(i)) return
      if (note.pitch === null) return
      const holeX = this.readHeadX + (note.t - this._currentTime) * C.PIXELS_PER_SECOND
      if (Math.abs(holeX - this.readHeadX) <= C.ACTIVE_TOLERANCE_PX) {
        this.firedNotes.add(i)
        const trackIndex = SANKYO_30.indexOf(note.pitch as (typeof SANKYO_30)[number])
        this.onNotePlay?.(note, trackIndex)
      }
    })
  }

  // --- Drawing ------------------------------------------------------------

  private draw(): void {
    const ctx = this.ctx
    const w = this.cssWidth
    const h = this.cssHeight

    ctx.fillStyle = C.BACKGROUND
    ctx.fillRect(0, 0, w, h)

    this.drawStripShadow()
    this.drawPaper()
    this.drawSpotlight()
    this.drawHoles()
    this.drawBlooms()
    this.drawEdgeFades()
    this.drawComb()
  }

  /** Drop shadow above and below the strip — it floats over the background. */
  private drawStripShadow(): void {
    const ctx = this.ctx
    const w = this.cssWidth
    const y = this.stripY
    const s = C.STRIP_DROP_SHADOW_SIZE

    const topShadow = ctx.createLinearGradient(0, y - s, 0, y)
    topShadow.addColorStop(0, 'rgba(0,0,0,0)')
    topShadow.addColorStop(1, C.STRIP_DROP_SHADOW)
    ctx.fillStyle = topShadow
    ctx.fillRect(0, y - s, w, s)

    const botShadow = ctx.createLinearGradient(0, y + STRIP_HEIGHT, 0, y + STRIP_HEIGHT + s)
    botShadow.addColorStop(0, C.STRIP_DROP_SHADOW)
    botShadow.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = botShadow
    ctx.fillRect(0, y + STRIP_HEIGHT, w, s)
  }

  /** Subtle backlight at read head — drawn after paper, before holes. */
  private drawSpotlight(): void {
    const ctx = this.ctx
    const readHeadX = this.readHeadX
    const stripY = this.stripY
    const stripCenterY = stripY + STRIP_HEIGHT / 2
    const spotlight = ctx.createRadialGradient(
      readHeadX,
      stripCenterY,
      0,
      readHeadX,
      stripCenterY,
      STRIP_HEIGHT * 0.7,
    )
    spotlight.addColorStop(0, 'rgba(255, 240, 180, 0.04)')
    spotlight.addColorStop(1, 'rgba(0, 0, 0, 0)')
    ctx.fillStyle = spotlight
    ctx.fillRect(0, stripY, this.cssWidth, STRIP_HEIGHT)
  }

  /** Left and right gradient fades over the strip edges. */
  private drawEdgeFades(): void {
    const ctx = this.ctx
    const w = this.cssWidth
    const stripY = this.stripY
    const fw = C.EDGE_FADE_WIDTH

    // Left fade
    const leftFade = ctx.createLinearGradient(0, stripY, fw, stripY)
    leftFade.addColorStop(0, 'rgba(11,11,11,1)')
    leftFade.addColorStop(1, 'rgba(11,11,11,0)')
    ctx.fillStyle = leftFade
    ctx.fillRect(0, stripY, fw, STRIP_HEIGHT)

    // Right fade
    const rightFade = ctx.createLinearGradient(w - fw, stripY, w, stripY)
    rightFade.addColorStop(0, 'rgba(11,11,11,0)')
    rightFade.addColorStop(1, 'rgba(11,11,11,1)')
    ctx.fillStyle = rightFade
    ctx.fillRect(w - fw, stripY, fw, STRIP_HEIGHT)
  }

  private drawPaper(): void {
    const ctx = this.ctx
    const w = this.cssWidth
    const y = this.stripY
    const canvas = { width: w }
    const stripY = y

    // Draw paper (map image or parchment fallback)
    if (this.paperImage) {
      // Fixed map backdrop — the city doesn't scroll; the perforations move through it
      ctx.save()
      ctx.globalAlpha = 0.38
      ctx.drawImage(this.paperImage, 0, stripY, canvas.width, STRIP_HEIGHT)
      ctx.restore()
      // Dark overlay to keep contrast with holes
      ctx.fillStyle = 'rgba(11, 11, 11, 0.45)'
      ctx.fillRect(0, stripY, canvas.width, STRIP_HEIGHT)
    } else {
      ctx.fillStyle = C.PAPER_COLOR
      ctx.fillRect(0, stripY, canvas.width, STRIP_HEIGHT)
    }

    // Paper grain: procedural noise tile, barely-there, gives the strip
    // material presence without any image asset.
    if (this.grainPattern) {
      ctx.save()
      ctx.globalAlpha = C.GRAIN_ALPHA
      ctx.globalCompositeOperation = 'overlay'
      ctx.fillStyle = this.grainPattern
      ctx.fillRect(0, stripY, w, STRIP_HEIGHT)
      ctx.restore()
    }

    // Very faint track dividers, as if lit from below.
    ctx.strokeStyle = 'rgba(160, 140, 100, 0.12)'
    ctx.lineWidth = 0.5
    for (let i = 1; i < C.TRACK_COUNT; i++) {
      const lineY = Math.round(y + i * TRACK_PITCH) + 0.5
      ctx.beginPath()
      ctx.moveTo(0, lineY)
      ctx.lineTo(w, lineY)
      ctx.stroke()
    }

    // Top edge shadow.
    const topGrad = ctx.createLinearGradient(0, y, 0, y + C.EDGE_SHADOW_HEIGHT)
    topGrad.addColorStop(0, C.PAPER_EDGE_DARK)
    topGrad.addColorStop(1, 'rgba(200,168,80,0)')
    ctx.fillStyle = topGrad
    ctx.fillRect(0, y, w, C.EDGE_SHADOW_HEIGHT)

    // Bottom edge shadow.
    const botGrad = ctx.createLinearGradient(
      0,
      y + STRIP_HEIGHT - C.EDGE_SHADOW_HEIGHT,
      0,
      y + STRIP_HEIGHT,
    )
    botGrad.addColorStop(0, 'rgba(200,168,80,0)')
    botGrad.addColorStop(1, C.PAPER_EDGE_DARK)
    ctx.fillStyle = botGrad
    ctx.fillRect(0, y + STRIP_HEIGHT - C.EDGE_SHADOW_HEIGHT, w, C.EDGE_SHADOW_HEIGHT)
  }

  private drawHoles(): void {
    if (!this.strip) return
    const ctx = this.ctx
    const w = this.cssWidth
    const readHeadX = this.readHeadX
    const y0 = this.stripY

    for (const note of this.strip.notes) {
      if (note.pitch === null) continue
      const trackIndex = SANKYO_30.indexOf(
        note.pitch as (typeof SANKYO_30)[number],
      )
      if (trackIndex < 0) continue

      // Punch reveal: holes appear only once the frontier has swept past them.
      const holeNormalizedX =
        this._totalDuration > 0 ? note.t / this._totalDuration : 0
      if (holeNormalizedX > this.punchProgress) continue

      const holeWidth = note.dur * C.PIXELS_PER_SECOND - 2
      const holeX = readHeadX + (note.t - this._currentTime) * C.PIXELS_PER_SECOND

      // Cull holes fully off-screen.
      if (holeX + holeWidth < 0 || holeX > w) continue

      const holeY =
        y0 + (C.TRACK_COUNT - 1 - trackIndex) * TRACK_PITCH + C.TRACK_GAP / 2

      // Deterministic per-hole variation — same strip always renders identically.
      const j0 = ((Math.sin(note.t * 127.1 + trackIndex * 311.7) * 43758.5) % 1 + 1) % 1
      const j1 = ((Math.sin(note.t * 251.3 + trackIndex * 157.9) * 38291.2) % 1 + 1) % 1
      const j2 = ((Math.sin(note.t *  73.6 + trackIndex * 419.5) * 51847.3) % 1 + 1) % 1

      const holeW = holeWidth * (0.88 + j0 * 0.18)
      const holeH = C.TRACK_HEIGHT * (0.72 + j1 * 0.26)
      const yJitter = (j2 - 0.5) * 2.0

      const cx = holeX + holeWidth / 2
      const cy = holeY + C.TRACK_HEIGHT / 2 + yJitter

      const holeColor = this.paperImage ? 'rgba(220, 200, 150, 0.18)' : C.HOLE_COLOR
      ctx.beginPath()
      ctx.ellipse(cx, cy, holeW / 2, holeH / 2, 0, 0, Math.PI * 2)
      ctx.fillStyle = holeColor
      ctx.fill()

      // Dark outer rim (die-cut edge).
      ctx.strokeStyle = C.HOLE_RIM_DARK
      ctx.lineWidth = 0.5
      ctx.stroke()

      // Light inset rim — physical depth.
      ctx.beginPath()
      ctx.ellipse(cx, cy, Math.max(1, holeW / 2 - 1), Math.max(1, holeH / 2 - 1), 0, 0, Math.PI * 2)
      ctx.strokeStyle = C.HOLE_RIM_LIGHT
      ctx.lineWidth = 1
      ctx.stroke()

      // Stamp flash on holes at the punch frontier.
      const atFrontier = Math.abs(holeNormalizedX - this.punchProgress) < 0.03
      if (atFrontier && this.punchProgress < 1) {
        const flash = ctx.createRadialGradient(cx, cy, 0, cx, cy, 8)
        flash.addColorStop(0, 'rgba(255,255,255,0.8)')
        flash.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = flash
        ctx.fillRect(cx - 8, cy - 8, 16, 16)
      }
    }
  }

  private drawBlooms(): void {
    if (!this.strip) return
    const ctx = this.ctx
    const readHeadX = this.readHeadX
    const y0 = this.stripY

    // --- Layer 1: persistent afterglow field ------------------------------
    // Accumulated blooms from notes that recently crossed the read head, each
    // decaying over ~1s. Overlapping blooms breathe into a luminous field.
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (const entry of this.glowTracker.tick()) {
      const glow = ctx.createRadialGradient(
        readHeadX,
        entry.trackY,
        0,
        readHeadX,
        entry.trackY,
        70,
      )
      glow.addColorStop(
        0,
        `hsla(${entry.hue}, 60%, 68%, ${entry.alpha * 0.5 * this.lightIntensity})`,
      )
      glow.addColorStop(
        0.4,
        `hsla(${entry.hue}, 45%, 55%, ${entry.alpha * 0.18 * this.lightIntensity})`,
      )
      glow.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = glow
      ctx.fillRect(readHeadX - 70, entry.trackY - 70, 140, 140)
    }
    ctx.restore()

    // --- Layer 2: instantaneous read-head flash on first activation -------
    const nowActive = new Set<number>()
    this.strip.notes.forEach((note, i) => {
      if (note.pitch === null || note.hue === null) return
      const trackIndex = SANKYO_30.indexOf(
        note.pitch as (typeof SANKYO_30)[number],
      )
      if (trackIndex < 0) return

      const holeWidth = note.dur * C.PIXELS_PER_SECOND - 2
      const holeX = readHeadX + (note.t - this._currentTime) * C.PIXELS_PER_SECOND
      const holeCenterX = holeX + holeWidth / 2

      if (Math.abs(holeCenterX - readHeadX) > C.ACTIVE_TOLERANCE_PX) return

      nowActive.add(i)

      const holeY =
        y0 + (C.TRACK_COUNT - 1 - trackIndex) * TRACK_PITCH + C.TRACK_GAP / 2
      const holeCenterY = holeY + C.TRACK_HEIGHT / 2

      // Only on the false -> true transition: seed a decaying glow and flash.
      if (!this.activeNoteIds.has(i)) {
        this.glowTracker.add(note.hue, holeCenterY)

        // Brief sharp flash at the read head — the tine being struck.
        const flash = ctx.createRadialGradient(
          readHeadX,
          holeCenterY,
          0,
          readHeadX,
          holeCenterY,
          20,
        )
        flash.addColorStop(0, `hsla(${note.hue}, 70%, 80%, 0.7)`)
        flash.addColorStop(0.5, `hsla(${note.hue}, 60%, 65%, 0.2)`)
        flash.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = flash
        ctx.fillRect(readHeadX - 20, holeCenterY - 20, 40, 40)
      }
    })
    this.activeNoteIds = nowActive
  }

  private drawComb(): void {
    const ctx = this.ctx
    const readHeadX = this.readHeadX
    const y0 = this.stripY

    // Tines: thin horizontal lines extending left, one per track.
    for (let track = 0; track < C.TRACK_COUNT; track++) {
      const rowTop = y0 + (C.TRACK_COUNT - 1 - track) * TRACK_PITCH + C.TRACK_GAP / 2
      const tineCenterY = rowTop + C.TRACK_HEIGHT / 2
      const tineTop = tineCenterY - C.TINE_WIDTH / 2
      const tineLeft = readHeadX - C.COMB_BODY_WIDTH / 2 - C.TINE_LENGTH

      // Base tine.
      ctx.fillStyle = C.COMB_COLOR
      ctx.fillRect(tineLeft, tineTop, C.TINE_LENGTH, C.TINE_WIDTH)
      // Bright top half.
      ctx.fillStyle = C.TINE_BRIGHT
      ctx.fillRect(tineLeft, tineTop, C.TINE_LENGTH, C.TINE_WIDTH / 2)
      // 1px engraved highlight along the top edge of each tine.
      ctx.fillStyle = C.TINE_HIGHLIGHT
      ctx.fillRect(tineLeft, tineTop, C.TINE_LENGTH, 1)
    }

    // Brass body: rounded rect.
    const bodyX = readHeadX - C.COMB_BODY_WIDTH / 2
    const bodyY = y0 - 6
    const bodyH = STRIP_HEIGHT + 12
    const bodyGrad = ctx.createLinearGradient(bodyX, 0, bodyX + C.COMB_BODY_WIDTH, 0)
    bodyGrad.addColorStop(0, '#6E5310')
    bodyGrad.addColorStop(0.5, C.COMB_COLOR)
    bodyGrad.addColorStop(0.5, C.TINE_BRIGHT)
    bodyGrad.addColorStop(1, '#7A5C10')
    roundRectPath(ctx, bodyX, bodyY, C.COMB_BODY_WIDTH, bodyH, 4)
    ctx.fillStyle = bodyGrad
    ctx.fill()
  }
}
