import type { NoteEvent, StripJSON } from '../engine/types'
import { SANKYO_30 } from '../engine/translate'
import { GlowTracker } from '../light/GlowTracker'

// --- Visual constants -----------------------------------------------------

const TRACK_HEIGHT = 11
const TRACK_GAP = 1
const TRACK_COUNT = 30
const STRIP_HEIGHT = TRACK_COUNT * (TRACK_HEIGHT + TRACK_GAP) // 360px
const PIXELS_PER_SECOND = 108 // ~9mm-equivalent scroll per 250ms note
const READ_HEAD_X_RATIO = 0.32 // comb sits at 32% from left edge
// Paper — cooler, less yellow, more translucent parchment
const PAPER_COLOR = '#E8E0CC' // was #F0DEB0, too yellow
const PAPER_EDGE_DARK = '#A09060' // was #C8A850
// Holes — deeper
const HOLE_COLOR = '#0C0800' // was #140A00
// Comb — less saturated brass
const COMB_COLOR = '#6B5214' // was #8B6914
const TINE_BRIGHT = '#B08C18' // was #D4A820
const TINE_WIDTH = 3
const BACKGROUND = '#0b0b0b'
const COMB_BODY_WIDTH = 20

const TRACK_PITCH = TRACK_HEIGHT + TRACK_GAP
const ACTIVE_TOLERANCE_PX = 4
const TINE_LENGTH = 18
const EDGE_SHADOW_HEIGHT = 8

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

export class StripRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D

  private strip: StripJSON | null = null
  private totalDuration = 0

  private playing = false
  private _currentTime = 0
  private lastFrameTime = 0
  private rafId: number | null = null

  private firedNotes = new Set<number>()

  private glowTracker = new GlowTracker()
  private activeNoteIds = new Set<number>()
  private punchProgress = 1

  private paperImage: HTMLImageElement | null = null

  onNotePlay: ((note: NoteEvent, trackIndex: number) => void) | null = null

  private readonly resizeHandler: () => void

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas context not available')
    this.ctx = ctx

    this.resizeHandler = () => {
      this.syncCanvasSize()
      this.draw()
    }
    window.addEventListener('resize', this.resizeHandler)

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
    return this.cssWidth * READ_HEAD_X_RATIO
  }

  private get stripY(): number {
    return (this.cssHeight - STRIP_HEIGHT) / 2
  }

  /** Set the strip paper backdrop. Persists across strip loads/resets. */
  setPaper(img: HTMLImageElement | null): void {
    this.paperImage = img
  }

  load(strip: StripJSON): void {
    this.glowTracker.clear()
    this.activeNoteIds.clear()
    this.strip = strip
    this.totalDuration = strip.notes.reduce((sum, n) => sum + n.dur, 0)
    this._currentTime = 0
    this.playing = false
    this.firedNotes.clear()
    this.cancelRaf()
    this.draw()
  }

  play(): void {
    if (!this.strip || this.playing) return
    // If we're at (or past) the end, restart from the beginning.
    if (this._currentTime >= this.totalDuration + 1) {
      this.reset()
    }
    this.playing = true
    this.lastFrameTime = performance.now()
    this.rafId = requestAnimationFrame(this.tick)
  }

  pause(): void {
    this.playing = false
    this.cancelRaf()
  }

  reset(): void {
    this.glowTracker.clear()
    this.activeNoteIds.clear()
    this._currentTime = 0
    this.firedNotes.clear()
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

      const duration = 1200 // ms total punch animation
      const start = performance.now()

      const animate = (): void => {
        const elapsed = performance.now() - start
        this.punchProgress = Math.min(elapsed / duration, 1)
        this.draw()

        if (this.punchProgress < 1) {
          requestAnimationFrame(animate)
        } else {
          this.punchProgress = 1
          resolve()
        }
      }

      this.punchProgress = 0
      requestAnimationFrame(animate)
    })
  }

  dispose(): void {
    this.cancelRaf()
    window.removeEventListener('resize', this.resizeHandler)
    this.onNotePlay = null
  }

  get isPlaying(): boolean {
    return this.playing
  }

  get currentTime(): number {
    return this._currentTime
  }

  private cancelRaf(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  private tick = (now: number): void => {
    if (!this.playing) return
    const dt = (now - this.lastFrameTime) / 1000
    this.lastFrameTime = now
    this._currentTime += dt

    this.fireActiveNotes()
    this.draw()

    if (this._currentTime >= this.totalDuration + 1) {
      this.playing = false
      this.rafId = null
      return
    }
    this.rafId = requestAnimationFrame(this.tick)
  }

  private fireActiveNotes(): void {
    if (!this.strip || !this.onNotePlay) return
    this.strip.notes.forEach((note, i) => {
      if (this.firedNotes.has(i)) return
      if (note.pitch === null) return
      const holeX = this.readHeadX + (note.t - this._currentTime) * PIXELS_PER_SECOND
      if (Math.abs(holeX - this.readHeadX) <= ACTIVE_TOLERANCE_PX) {
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

    ctx.fillStyle = BACKGROUND
    ctx.fillRect(0, 0, w, h)

    this.drawPaper()
    this.drawSpotlight()
    this.drawHoles()
    this.drawBlooms()
    this.drawEdgeFades()
    this.drawComb()
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

    // Left fade
    const leftFade = ctx.createLinearGradient(0, stripY, 120, stripY)
    leftFade.addColorStop(0, 'rgba(11,11,11,1)')
    leftFade.addColorStop(1, 'rgba(11,11,11,0)')
    ctx.fillStyle = leftFade
    ctx.fillRect(0, stripY, 120, STRIP_HEIGHT)

    // Right fade
    const rightFade = ctx.createLinearGradient(w - 120, stripY, w, stripY)
    rightFade.addColorStop(0, 'rgba(11,11,11,0)')
    rightFade.addColorStop(1, 'rgba(11,11,11,1)')
    ctx.fillStyle = rightFade
    ctx.fillRect(w - 120, stripY, 120, STRIP_HEIGHT)
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
      ctx.fillStyle = PAPER_COLOR
      ctx.fillRect(0, stripY, canvas.width, STRIP_HEIGHT)
    }

    // Very faint track dividers, as if lit from below.
    ctx.strokeStyle = 'rgba(160, 140, 100, 0.12)'
    ctx.lineWidth = 0.5
    for (let i = 1; i < TRACK_COUNT; i++) {
      const lineY = Math.round(y + i * TRACK_PITCH) + 0.5
      ctx.beginPath()
      ctx.moveTo(0, lineY)
      ctx.lineTo(w, lineY)
      ctx.stroke()
    }

    // Top edge shadow.
    const topGrad = ctx.createLinearGradient(0, y, 0, y + EDGE_SHADOW_HEIGHT)
    topGrad.addColorStop(0, PAPER_EDGE_DARK)
    topGrad.addColorStop(1, 'rgba(200,168,80,0)')
    ctx.fillStyle = topGrad
    ctx.fillRect(0, y, w, EDGE_SHADOW_HEIGHT)

    // Bottom edge shadow.
    const botGrad = ctx.createLinearGradient(
      0,
      y + STRIP_HEIGHT - EDGE_SHADOW_HEIGHT,
      0,
      y + STRIP_HEIGHT,
    )
    botGrad.addColorStop(0, 'rgba(200,168,80,0)')
    botGrad.addColorStop(1, PAPER_EDGE_DARK)
    ctx.fillStyle = botGrad
    ctx.fillRect(0, y + STRIP_HEIGHT - EDGE_SHADOW_HEIGHT, w, EDGE_SHADOW_HEIGHT)
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
        this.totalDuration > 0 ? note.t / this.totalDuration : 0
      if (holeNormalizedX > this.punchProgress) continue

      const holeWidth = note.dur * PIXELS_PER_SECOND - 2
      const holeX = readHeadX + (note.t - this._currentTime) * PIXELS_PER_SECOND

      // Cull holes fully off-screen.
      if (holeX + holeWidth < 0 || holeX > w) continue

      const holeY =
        y0 + (TRACK_COUNT - 1 - trackIndex) * TRACK_PITCH + TRACK_GAP / 2

      const holeRadius = Math.min(holeWidth / 2, TRACK_HEIGHT / 2)
      const holeColor = this.paperImage ? 'rgba(220, 200, 150, 0.18)' : HOLE_COLOR
      roundRectPath(ctx, holeX, holeY, holeWidth, TRACK_HEIGHT, holeRadius)
      ctx.fillStyle = holeColor
      ctx.fill()

      // 1px lighter inner rim.
      ctx.strokeStyle = 'rgba(80,40,0,0.5)'
      ctx.lineWidth = 0.5
      ctx.stroke()

      // Stamp flash on holes at the punch frontier.
      const atFrontier = Math.abs(holeNormalizedX - this.punchProgress) < 0.03
      if (atFrontier && this.punchProgress < 1) {
        const holeCenterY = holeY + TRACK_HEIGHT / 2
        const flashX = holeX + holeWidth / 2
        const flash = ctx.createRadialGradient(
          flashX,
          holeCenterY,
          0,
          flashX,
          holeCenterY,
          8,
        )
        flash.addColorStop(0, 'rgba(255,255,255,0.8)')
        flash.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = flash
        ctx.fillRect(flashX - 8, holeCenterY - 8, 16, 16)
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
      glow.addColorStop(0, `hsla(${entry.hue}, 60%, 68%, ${entry.alpha * 0.5})`)
      glow.addColorStop(
        0.4,
        `hsla(${entry.hue}, 45%, 55%, ${entry.alpha * 0.18})`,
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

      const holeWidth = note.dur * PIXELS_PER_SECOND - 2
      const holeX = readHeadX + (note.t - this._currentTime) * PIXELS_PER_SECOND
      const holeCenterX = holeX + holeWidth / 2

      if (Math.abs(holeCenterX - readHeadX) > ACTIVE_TOLERANCE_PX) return

      nowActive.add(i)

      const holeY =
        y0 + (TRACK_COUNT - 1 - trackIndex) * TRACK_PITCH + TRACK_GAP / 2
      const holeCenterY = holeY + TRACK_HEIGHT / 2

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
    for (let track = 0; track < TRACK_COUNT; track++) {
      const rowTop = y0 + (TRACK_COUNT - 1 - track) * TRACK_PITCH + TRACK_GAP / 2
      const tineCenterY = rowTop + TRACK_HEIGHT / 2
      const tineTop = tineCenterY - TINE_WIDTH / 2
      const tineLeft = readHeadX - COMB_BODY_WIDTH / 2 - TINE_LENGTH
      const tineRight = readHeadX - COMB_BODY_WIDTH / 2

      // Base tine.
      ctx.fillStyle = COMB_COLOR
      ctx.fillRect(tineLeft, tineTop, TINE_LENGTH, TINE_WIDTH)
      // Bright top half highlight.
      ctx.fillStyle = TINE_BRIGHT
      ctx.fillRect(tineLeft, tineTop, TINE_LENGTH, TINE_WIDTH / 2)
      void tineRight
    }

    // Brass body: rounded rect.
    const bodyX = readHeadX - COMB_BODY_WIDTH / 2
    const bodyY = y0 - 6
    const bodyH = STRIP_HEIGHT + 12
    const bodyGrad = ctx.createLinearGradient(bodyX, 0, bodyX + COMB_BODY_WIDTH, 0)
    bodyGrad.addColorStop(0, '#6E5310')
    bodyGrad.addColorStop(0.5, COMB_COLOR)
    bodyGrad.addColorStop(0.5, TINE_BRIGHT)
    bodyGrad.addColorStop(1, '#7A5C10')
    roundRectPath(ctx, bodyX, bodyY, COMB_BODY_WIDTH, bodyH, 4)
    ctx.fillStyle = bodyGrad
    ctx.fill()
  }
}
