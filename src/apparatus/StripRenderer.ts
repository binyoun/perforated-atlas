import type { NoteEvent, StripJSON } from '../engine/types'
import { SANKYO_30 } from '../engine/translate'

// --- Visual constants -----------------------------------------------------

const TRACK_HEIGHT = 11
const TRACK_GAP = 1
const TRACK_COUNT = 30
const STRIP_HEIGHT = TRACK_COUNT * (TRACK_HEIGHT + TRACK_GAP) // 360px
const PIXELS_PER_SECOND = 108 // ~9mm-equivalent scroll per 250ms note
const READ_HEAD_X_RATIO = 0.32 // comb sits at 32% from left edge
const PAPER_COLOR = '#F0DEB0'
const PAPER_EDGE_DARK = '#C8A850'
const HOLE_COLOR = '#140A00'
const HOLE_RADIUS = 3
const COMB_COLOR = '#8B6914'
const TINE_BRIGHT = '#D4A820'
const TINE_WIDTH = 3
const BACKGROUND = '#0b0b0b'
const COMB_BODY_WIDTH = 22

const TRACK_PITCH = TRACK_HEIGHT + TRACK_GAP
const ACTIVE_TOLERANCE_PX = 4
const TINE_LENGTH = 18
const EDGE_SHADOW_HEIGHT = 8
const BLOOM_RADIUS = 40

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

  load(strip: StripJSON): void {
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
    this._currentTime = 0
    this.firedNotes.clear()
    this.draw()
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
    this.drawHoles()
    this.drawBlooms()
    this.drawComb()
  }

  private drawPaper(): void {
    const ctx = this.ctx
    const w = this.cssWidth
    const y = this.stripY

    // Paper base fills full width.
    ctx.fillStyle = PAPER_COLOR
    ctx.fillRect(0, y, w, STRIP_HEIGHT)

    // Track dividers between tracks.
    ctx.strokeStyle = 'rgba(180,150,80,0.35)'
    ctx.lineWidth = 1
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

      const holeWidth = note.dur * PIXELS_PER_SECOND - 2
      const holeX = readHeadX + (note.t - this._currentTime) * PIXELS_PER_SECOND

      // Cull holes fully off-screen.
      if (holeX + holeWidth < 0 || holeX > w) continue

      const holeY =
        y0 + (TRACK_COUNT - 1 - trackIndex) * TRACK_PITCH + TRACK_GAP / 2

      roundRectPath(ctx, holeX, holeY, holeWidth, TRACK_HEIGHT, HOLE_RADIUS)
      ctx.fillStyle = HOLE_COLOR
      ctx.fill()

      // 1px lighter inner rim.
      ctx.strokeStyle = 'rgba(80,40,0,0.5)'
      ctx.lineWidth = 0.5
      ctx.stroke()
    }
  }

  private drawBlooms(): void {
    if (!this.strip) return
    const ctx = this.ctx
    const readHeadX = this.readHeadX
    const y0 = this.stripY

    for (const note of this.strip.notes) {
      if (note.pitch === null || note.hue === null) continue
      const trackIndex = SANKYO_30.indexOf(
        note.pitch as (typeof SANKYO_30)[number],
      )
      if (trackIndex < 0) continue

      const holeWidth = note.dur * PIXELS_PER_SECOND - 2
      const holeX = readHeadX + (note.t - this._currentTime) * PIXELS_PER_SECOND
      const holeCenterX = holeX + holeWidth / 2

      if (Math.abs(holeCenterX - readHeadX) > ACTIVE_TOLERANCE_PX) continue

      const holeY =
        y0 + (TRACK_COUNT - 1 - trackIndex) * TRACK_PITCH + TRACK_GAP / 2
      const cx = holeX + holeWidth / 2
      const cy = holeY + TRACK_HEIGHT / 2

      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, BLOOM_RADIUS)
      grad.addColorStop(0, `hsla(${note.hue}, 80%, 70%, 0.6)`)
      grad.addColorStop(1, `hsla(${note.hue}, 80%, 70%, 0)`)
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(cx, cy, BLOOM_RADIUS, 0, Math.PI * 2)
      ctx.fill()
    }
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
