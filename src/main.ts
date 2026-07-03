import { translate } from './engine/translate'
import { StripRenderer } from './apparatus/StripRenderer'
import type { NoteEvent } from './engine/types'

const cityInput = document.getElementById('city-input') as HTMLInputElement
const countryInput = document.getElementById('country-input') as HTMLInputElement
const wordGrid = document.getElementById('word-grid') as HTMLDivElement
const translateBtn = document.getElementById('translate-btn') as HTMLButtonElement
const canvas = document.getElementById('strip-canvas') as HTMLCanvasElement
const playPauseBtn = document.getElementById('play-pause-btn') as HTMLButtonElement
const iconPlay = playPauseBtn.querySelector('.icon-play') as SVGElement
const iconPause = playPauseBtn.querySelector('.icon-pause') as SVGElement
const stripMeta = document.getElementById('strip-meta') as HTMLDivElement

const WORD_COUNT = 12

const renderer = new StripRenderer(canvas)

// Phase 1: just log notes as they cross the read head (no sound yet).
renderer.onNotePlay = (note: NoteEvent, trackIndex: number) => {
  console.log('note', note.pitch, 'track', trackIndex, note)
}

// --- Build 12 word boxes --------------------------------------------------

const wordBoxes: HTMLInputElement[] = []
for (let i = 0; i < WORD_COUNT; i++) {
  const box = document.createElement('input')
  box.type = 'text'
  box.className = 'word-box'
  box.maxLength = 20
  box.autocomplete = 'off'
  box.dataset.index = String(i)
  wordGrid.appendChild(box)
  wordBoxes.push(box)
}

/** Words in order, empties removed. */
function filledWords(): string[] {
  return wordBoxes.map((b) => b.value.trim()).filter((w) => w.length > 0)
}

function focusBox(index: number): void {
  if (index >= 0 && index < wordBoxes.length) {
    wordBoxes[index].focus()
  }
}

// --- Translate button enabled state ---------------------------------------

function updateTranslateEnabled(): void {
  translateBtn.disabled = filledWords().length === 0
}

// --- Word box behaviour ---------------------------------------------------

for (const box of wordBoxes) {
  box.addEventListener('input', () => {
    box.classList.toggle('filled', box.value.trim().length > 0)
    updateTranslateEnabled()
  })

  box.addEventListener('keydown', (e) => {
    const index = Number(box.dataset.index)

    if (e.key === 'Enter') {
      e.preventDefault()
      const nextIndex = index + 1
      const isLast = nextIndex >= wordBoxes.length
      // Enter on the last box, or when the next box is empty, triggers translate.
      const nextEmpty = !isLast && wordBoxes[nextIndex].value.trim().length === 0
      if (isLast || nextEmpty) {
        if (!translateBtn.disabled) doTranslate()
      } else {
        focusBox(nextIndex)
      }
      return
    }

    if (e.key === 'Tab' && !e.shiftKey) {
      // Let the browser handle Tab into the natural next box; only intercept
      // to keep focus inside the grid when on the last box.
      if (index === wordBoxes.length - 1) {
        e.preventDefault()
        focusBox(0)
      }
    }
  })
}

cityInput.addEventListener('input', updateTranslateEnabled)
countryInput.addEventListener('input', updateTranslateEnabled)
updateTranslateEnabled()

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

function doTranslate(): void {
  const words = filledWords()
  const text = words.join(' ')
  const city = cityInput.value.trim()
  const country = countryInput.value.trim()

  const strip = translate(text, city, country)

  // Phase 1 debugging.
  console.log('strip JSON', strip)

  renderer.load(strip)

  playPauseBtn.disabled = false

  stripMeta.innerHTML = [
    strip.city,
    strip.country,
    `${strip.word_count} words`,
    `${strip.strip_length_mm} mm`,
  ].join(' &nbsp;·&nbsp; ')

  // Auto-play.
  renderer.play()
  setButtonPlaying(true)
  watchPlayback()
}

translateBtn.addEventListener('click', doTranslate)

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
