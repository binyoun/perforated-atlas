import * as Tone from 'tone'
import type { NoteEvent } from '../engine/types'

export class SoundEngine {
  private poly: Tone.PolySynth<Tone.Synth> | null = null
  private click: Tone.NoiseSynth | null = null
  private hiss: Tone.Noise | null = null
  private master: Tone.Limiter | null = null
  private initialized = false

  async init(): Promise<void> {
    if (this.initialized) return
    await Tone.start() // iOS AudioContext unlock — must be called inside a user gesture

    this.master = new Tone.Limiter(-2).toDestination()

    // Reverb: small wooden music-box resonance chamber
    const reverb = new Tone.Reverb({ decay: 1.2, wet: 0.28 })
    await reverb.ready
    reverb.connect(this.master)

    // Music-box tine: FM synth for a more natural, slightly inharmonic metal tine
    this.poly = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 5.1,        // slightly inharmonic — real metal tines are not perfectly harmonic
      modulationIndex: 0.3,    // low FM depth: just adds the metallic transient
      oscillator: { type: 'sine' },
      envelope: {
        attack: 0.001,
        decay: 1.8,             // slow fundamental decay (~real music-box tine)
        sustain: 0.0,
        release: 0.4,
      },
      modulation: { type: 'sine' },
      modulationEnvelope: {
        attack: 0.001,
        decay: 0.055,           // very fast overtone decay → brief metallic click that settles to pure tone
        sustain: 0.0,
        release: 0.02,
      },
      volume: -7,
    }) as unknown as Tone.PolySynth<Tone.Synth>   // PolySynth<FMSynth> but triggerAttackRelease signature is compatible
    this.poly.connect(reverb)

    // Tooth click: very short white noise burst per note
    this.click = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.01, sustain: 0, release: 0.005 },
      volume: -32,
    })
    this.click.connect(this.master)

    // Paper hiss: continuous pink noise, very quiet, runs while playing
    this.hiss = new Tone.Noise('pink')
    this.hiss.volume.value = -60 // start silent; ramped up on play
    this.hiss.connect(this.master)
    this.hiss.start() // start now but at -60 dB (silent)

    this.initialized = true
  }

  triggerNote(note: NoteEvent): void {
    if (!this.initialized || !note.pitch) return
    const now = Tone.now()
    this.poly?.triggerAttackRelease(note.pitch, Math.max(note.dur * 0.85, 0.05), now)
    this.click?.triggerAttackRelease('64n', now)
  }

  startMechanical(): void {
    if (!this.initialized || !this.hiss) return
    this.hiss.volume.rampTo(-50, 0.4) // fade hiss in
  }

  stopMechanical(): void {
    if (!this.initialized || !this.hiss) return
    this.hiss.volume.rampTo(-60, 2.0) // wind down over 2 s
  }

  dispose(): void {
    this.poly?.dispose()
    this.click?.dispose()
    this.hiss?.stop()
    this.hiss?.dispose()
    this.master?.dispose()
    this.initialized = false
  }
}
