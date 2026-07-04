import { translate } from './engine/translate'
import { StripRenderer } from './apparatus/StripRenderer'
import { SoundEngine } from './sound/SoundEngine'
import type { NoteEvent } from './engine/types'

function latLonToTile(lat: number, lon: number, zoom: number): { x: number; y: number; z: number } {
  const n = 2 ** zoom
  const x = Math.floor(((lon + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  return { x, y, z: zoom }
}

async function fetchMapPaper(
  cityQuery: string,
): Promise<{ img: HTMLImageElement; displayName: string } | null> {
  try {
    const geoRes = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(cityQuery)}&format=json&limit=1`,
      { headers: { 'User-Agent': 'perforated-atlas/1.0 (github.com/binyoun/perforated-atlas)' } }
    )
    const geoData = await geoRes.json()
    if (!geoData.length) return null

    const lat = parseFloat(geoData[0].lat)
    const lon = parseFloat(geoData[0].lon)
    const { x, y, z } = latLonToTile(lat, lon, 15)
    const tileUrl = `https://basemaps.cartocdn.com/rastertiles/dark_matter/${z}/${x}/${y}.png`

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = tileUrl
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('tile load failed'))
    })
    return { img, displayName: geoData[0].display_name as string }
  } catch {
    return null
  }
}

const cityInput = document.getElementById('city-input') as HTMLInputElement
const countryInput = document.getElementById('country-input') as HTMLInputElement
const wordGrid = document.getElementById('word-grid') as HTMLDivElement
const translateBtn = document.getElementById('translate-btn') as HTMLButtonElement
const canvas = document.getElementById('strip-canvas') as HTMLCanvasElement
const playPauseBtn = document.getElementById('play-pause-btn') as HTMLButtonElement
const iconPlay = playPauseBtn.querySelector('.icon-play') as SVGElement
const iconPause = playPauseBtn.querySelector('.icon-pause') as SVGElement
const stripMeta = document.getElementById('strip-meta') as HTMLDivElement
const imageUpload = document.getElementById('image-upload') as HTMLInputElement
const paperStatus = document.getElementById('paper-status') as HTMLSpanElement

const WORD_COUNT = 12

// --- Paper source (map tile or uploaded image) ----------------------------

let pendingPaper: HTMLImageElement | null = null
let uploadedPaper: HTMLImageElement | null = null
let paperDebounce: ReturnType<typeof setTimeout> | null = null
let paperFetchSeq = 0

imageUpload.addEventListener('change', () => {
  const file = imageUpload.files?.[0]
  if (!file) return
  const img = new Image()
  const url = URL.createObjectURL(file)
  img.onload = () => {
    URL.revokeObjectURL(url)
    uploadedPaper = img
    paperStatus.textContent = file.name
    // Uploaded image overrides map
  }
  img.onerror = () => URL.revokeObjectURL(url)
  img.src = url
})

function scheduleMapFetch(): void {
  if (paperDebounce !== null) clearTimeout(paperDebounce)
  paperDebounce = setTimeout(() => {
    const query = `${cityInput.value.trim()} ${countryInput.value.trim()}`.trim()
    if (!query) {
      pendingPaper = null
      if (!uploadedPaper) paperStatus.textContent = ''
      return
    }
    const seq = ++paperFetchSeq
    if (!uploadedPaper) paperStatus.textContent = 'locating…'
    void fetchMapPaper(query).then((result) => {
      // Ignore stale responses from earlier keystrokes.
      if (seq !== paperFetchSeq) return
      if (result) {
        pendingPaper = result.img
        if (!uploadedPaper) paperStatus.textContent = result.displayName.split(',')[0]
      } else {
        pendingPaper = null
        if (!uploadedPaper) paperStatus.textContent = ''
      }
    })
  }, 800)
}

const renderer = new StripRenderer(canvas)

const soundEngine = new SoundEngine()
let soundReady = false

async function ensureSound(): Promise<void> {
  if (soundReady) return
  try {
    await soundEngine.init()
    soundReady = true
  } catch (e) {
    console.warn('Audio init failed:', e)
  }
}

// Phase 2: play each note as it crosses the read head.
renderer.onNotePlay = (note: NoteEvent) => {
  soundEngine.triggerNote(note)
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
cityInput.addEventListener('input', scheduleMapFetch)
countryInput.addEventListener('input', scheduleMapFetch)
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
    soundEngine.stopMechanical()
    return
  }
  requestAnimationFrame(watchPlayback)
}

// --- Translate ------------------------------------------------------------

async function doTranslate(): Promise<void> {
  const words = filledWords()
  if (words.length === 0) return
  const text = words.join(' ')
  const city = cityInput.value.trim()
  const country = countryInput.value.trim()

  const strip = translate(text, city, country)
  console.log('strip JSON', strip)

  // 1. Dissolve the input UI — text becomes pattern; the original is gone.
  wordGrid.classList.add('dissolving')
  document.querySelector('.place-fields')?.classList.add('dissolving')
  document.querySelector('.lang-hint')?.classList.add('dissolving')
  translateBtn.classList.add('dissolving')

  // 2. Load the strip (holes hidden until punch).
  renderer.load(strip)
  // Uploaded image takes priority over the auto-fetched map tile.
  renderer.setPaper(uploadedPaper ?? pendingPaper)

  // 3. Show the apparatus area.
  const apparatusArea = document.querySelector('.apparatus-area') as HTMLElement
  apparatusArea.classList.add('visible')

  playPauseBtn.disabled = false

  stripMeta.innerHTML = [
    strip.city || '',
    strip.country || '',
    `${strip.word_count} words`,
    `${strip.strip_length_mm} mm`,
  ]
    .filter(Boolean)
    .join('  ·  ')

  // 4. Init audio during the dissolve pause.
  await ensureSound()

  // 5. Wait for the dissolve to mostly complete, then punch the holes.
  await new Promise((r) => setTimeout(r, 700))
  await renderer.punch()

  // 6. Play.
  soundEngine.startMechanical()
  renderer.play()
  setButtonPlaying(true)
  watchPlayback()
}

translateBtn.addEventListener('click', doTranslate)

// --- Play/pause toggle ----------------------------------------------------

playPauseBtn.addEventListener('click', async () => {
  if (renderer.isPlaying) {
    renderer.pause()
    setButtonPlaying(false)
    soundEngine.stopMechanical()
  } else {
    // Keep the apparatus visible (already true after first translate).
    document.querySelector('.apparatus-area')?.classList.add('visible')
    await ensureSound()
    soundEngine.startMechanical()
    renderer.play()
    setButtonPlaying(true)
    watchPlayback()
  }
})
