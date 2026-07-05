import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

export class HandPresence {
  private landmarker: HandLandmarker | null = null
  private video: HTMLVideoElement | null = null
  private animId: number | null = null
  private stream: MediaStream | null = null
  private running = false
  private wasPresent = false

  /** Fires when a hand first appears in frame. */
  onPresent: (() => void) | null = null
  /** Fires when the last hand leaves the frame. */
  onAbsent: (() => void) | null = null
  /**
   * Fires every frame a hand is detected.
   * value: 0 (far/small) → 1 (close/large), based on bounding-box size.
   * Used to modulate light intensity only — never sound or speed.
   */
  onProximity: ((value: number) => void) | null = null

  /** Returns true once the camera + model are ready. */
  get isReady(): boolean {
    return this.landmarker !== null && this.video !== null
  }

  /**
   * Load the model and open the camera.
   * Must be called inside or after a user gesture (it opens getUserMedia).
   * Resolves when ready, or throws if permission is denied.
   */
  async init(): Promise<void> {
    // Load the MediaPipe WASM bundle and hand-landmark model from CDN.
    // In a gallery without internet this can fail — degrade cleanly to
    // "no presence" instead of leaving the machine half-initialized.
    try {
      const vision = await FilesetResolver.forVisionTasks(WASM_CDN)
      this.landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 1,
      })
    } catch (e) {
      console.warn('HandPresence: model load failed, presence disabled:', e)
      this.landmarker = null
      this.onAbsent?.() // reset any presence-driven UI once
      return // brass button remains the sole control
    }

    // Open camera — hidden video element, front-facing camera preferred
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: 320, height: 240 },
    })
    this.stream = stream

    const video = document.createElement('video')
    video.srcObject = stream
    video.muted = true
    video.playsInline = true
    video.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none'
    document.body.appendChild(video)
    await video.play()
    this.video = video
  }

  /** Start the per-frame detection loop. Call after init(). */
  start(): void {
    if (this.running || !this.landmarker || !this.video) return
    this.running = true
    this.wasPresent = false
    this.loop()
  }

  private loop(): void {
    if (!this.running) return
    const video = this.video!
    const landmarker = this.landmarker!

    if (video.readyState >= 2) {
      const result = landmarker.detectForVideo(video, performance.now())
      const present = result.landmarks.length > 0

      if (present !== this.wasPresent) {
        if (present) this.onPresent?.()
        else this.onAbsent?.()
        this.wasPresent = present
      }

      if (present && result.landmarks[0]) {
        const lm = result.landmarks[0]
        const xs = lm.map((p) => p.x)
        const ys = lm.map((p) => p.y)
        const w = Math.max(...xs) - Math.min(...xs)
        const h = Math.max(...ys) - Math.min(...ys)
        // Normalize: hand spans ~0.1 of frame width when far, ~0.6 when close
        const proximity = Math.min(1, Math.max(0, Math.max(w, h) / 0.45))
        this.onProximity?.(proximity)
      }
    }

    this.animId = requestAnimationFrame(() => this.loop())
  }

  /** Pause the detection loop without releasing the camera. */
  stop(): void {
    this.running = false
    if (this.animId !== null) cancelAnimationFrame(this.animId)
    this.animId = null
    if (this.wasPresent) {
      this.onAbsent?.()
      this.wasPresent = false
    }
  }

  /** Release camera + model. Call on page unload. */
  dispose(): void {
    this.stop()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.video?.remove()
    this.landmarker?.close()
    this.landmarker = null
    this.video = null
    this.stream = null
  }
}
