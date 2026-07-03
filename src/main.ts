import { translate } from './engine/translate'
import { StripRenderer } from './apparatus/StripRenderer'
import type { NoteEvent } from './engine/types'

const input = document.getElementById('memory-input') as HTMLTextAreaElement
const charCount = document.getElementById('char-count') as HTMLSpanElement
const translateBtn = document.getElementById('translate-btn') as HTMLButtonElement
const canvas = document.getElementById('strip-canvas') as HTMLCanvasElement
const playPauseBtn = document.getElementById('play-pause-btn') as HTMLButtonElement
const iconPlay = playPauseBtn.querySelector('.icon-play') as SVGElement
const iconPause = playPauseBtn.querySelector('.icon-pause') as SVGElement
const stripMeta = document.getElementById('strip-meta') as HTMLDivElement

const renderer = new StripRenderer(canvas)

// Phase 1: just log notes as they cross the read head (no sound yet).
renderer.onNotePlay = (note: NoteEvent, trackIndex: number) => {
  console.log('note', note.pitch, 'track', trackIndex, note)
}

// --- Char count -----------------------------------------------------------

function updateCharCount(): void {
  charCount.textContent = String(input.value.length)
}
input.addEventListener('input', updateCharCount)
updateCharCount()

// --- Play/pause button UI -------------------------------------------------

function setButtonPlaying(isPlaying: boolean): void {
  iconPlay.style.display = isPlaying ? 'none' : ''
  iconPause.style.display = isPlaying ? '' : 'none'
  playPauseBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play')
}

/** Poll the renderer so the button reflects when the strip finishes on its own. */
function watchPlayback(): void {
  if (playPauseBtn.disabled) return
  if (!renderer.isPlaying) {
    setButtonPlaying(false)
    return
  }
  requestAnimationFrame(watchPlayback)
}

// --- Translate ------------------------------------------------------------

translateBtn.addEventListener('click', () => {
  const text = input.value
  const strip = translate(text)

  // Phase 1 debugging.
  console.log('strip JSON', strip)

  renderer.load(strip)

  playPauseBtn.disabled = false

  const noteCount = strip.notes.filter((n) => n.pitch).length
  stripMeta.innerHTML = [
    `locale: ${strip.locale_hint}`,
    `${strip.source_length} chars`,
    `${noteCount} notes`,
    `${strip.strip_length_mm} mm`,
  ].join(' &nbsp;·&nbsp; ')

  // Auto-play.
  renderer.play()
  setButtonPlaying(true)
  watchPlayback()
})

// --- Play/pause toggle ----------------------------------------------------

playPauseBtn.addEventListener('click', () => {
  if (renderer.isPlaying) {
    renderer.pause()
    setButtonPlaying(false)
  } else {
    renderer.play()
    setButtonPlaying(true)
    watchPlayback()
  }
})
