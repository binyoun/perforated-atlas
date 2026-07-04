export interface GlowEntry {
  hue: number       // HSL hue 0–360
  trackY: number    // canvas y-center of the track (fixed at read-head moment)
  startTime: number // performance.now() when triggered
  decayMs: number   // total decay duration in ms
}

export class GlowTracker {
  private glows: GlowEntry[] = []

  add(hue: number, trackY: number, decayMs = 1100): void {
    this.glows.push({ hue, trackY, startTime: performance.now(), decayMs })
  }

  /** Returns glows still alive, each with current alpha 0–1. Prunes dead ones. */
  tick(): Array<GlowEntry & { alpha: number }> {
    const now = performance.now()
    this.glows = this.glows.filter(g => now - g.startTime < g.decayMs)
    return this.glows.map(g => ({
      ...g,
      alpha: Math.pow(1 - (now - g.startTime) / g.decayMs, 1.6), // ease-out curve
    }))
  }

  clear(): void {
    this.glows = []
  }
}
