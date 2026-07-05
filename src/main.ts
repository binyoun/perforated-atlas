import { translate } from './engine/translate'
import { StripRenderer } from './apparatus/StripRenderer'
import { SoundEngine } from './sound/SoundEngine'
import { HandPresence } from './presence/HandPresence'
import type { NoteEvent, StripJSON } from './engine/types'
import { saveStrip, loadStrip } from './archive/db'
import { ArchiveView } from './archive/ArchiveView'
import { generateQR, exportPNG, stripPermalink } from './archive/export'
import { archiveEnabled } from './archive/supabase'

function latLonToTile(lat: number, lon: number, zoom: number): { x: number; y: number; z: number } {
  const n = 2 ** zoom
  const x = Math.floor(((lon + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  return { x, y, z: zoom }
}

async function fetchMapFromCoords(lat: number, lon: number): Promise<HTMLImageElement | null> {
  try {
    const { x, y, z } = latLonToTile(lat, lon, 15)
    const tileUrl = `https://basemaps.cartocdn.com/rastertiles/dark_matter/${z}/${x}/${y}.png`
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = tileUrl
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('tile load failed'))
    })
    return img
  } catch {
    return null
  }
}

async function reverseGeocode(lat: number, lon: number): Promise<{ city: string; country: string }> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
      { headers: { 'User-Agent': 'perforated-atlas/1.0 (github.com/binyoun/perforated-atlas)' } }
    )
    const data = await res.json()
    const addr = (data.address as Record<string, string>) || {}
    const city = addr.city || addr.town || addr.municipality || addr.village || addr.county || ''
    const country = addr.country || ''
    return { city, country }
  } catch {
    return { city: '', country: '' }
  }
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

/** Fetch a required element by id; fail loudly at startup instead of silently later. */
function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Perforated Atlas: required element #${id} missing from DOM`)
  return el as T
}

const cityInput = requireEl<HTMLInputElement>('city-input')
const countryInput = requireEl<HTMLInputElement>('country-input')
const wordGrid = requireEl<HTMLDivElement>('word-grid')
const translateBtn = requireEl<HTMLButtonElement>('translate-btn')
const canvas = requireEl<HTMLCanvasElement>('strip-canvas')
const playPauseBtn = requireEl<HTMLButtonElement>('play-pause-btn')
const iconPlay = playPauseBtn.querySelector<SVGElement>('.icon-play')
const iconPause = playPauseBtn.querySelector<SVGElement>('.icon-pause')
const stripMeta = requireEl<HTMLDivElement>('strip-meta')
const imageUpload = requireEl<HTMLInputElement>('image-upload')
const paperStatus = requireEl<HTMLSpanElement>('paper-status')

const WORD_COUNT = 12

// --- Welcome state ----------------------------------------------------------
// First load shows only the title plate; one instruction line fades in, then
// the input area takes over (after a beat, or on the visitor's first gesture).

const mainEl = document.querySelector('main')
const welcomeLine = document.getElementById('welcome-line')
let welcomeDone = false

function endWelcome(): void {
  if (welcomeDone) return
  welcomeDone = true
  mainEl?.setAttribute('data-state', 'input')
}

setTimeout(() => welcomeLine?.classList.add('shown'), 1500)
setTimeout(endWelcome, 4500)
window.addEventListener('keydown', endWelcome, { once: true })
window.addEventListener('pointerdown', endWelcome, { once: true })

/** Reveal the apparatus section (null-safe; used from several flows). */
function showApparatus(): void {
  document.querySelector('.apparatus-area')?.classList.add('visible')
}

// --- Post-translation afterword ----------------------------------------------

let afterwordTimers: ReturnType<typeof setTimeout>[] = []

/** "The words are gone." — fade in 0.5s after the punch, fade out after 4s. */
function showAfterword(): void {
  const el = document.getElementById('afterword')
  if (!el) return
  for (const t of afterwordTimers) clearTimeout(t)
  afterwordTimers = [
    setTimeout(() => el.classList.add('visible'), 500),
    setTimeout(() => el.classList.remove('visible'), 4500),
  ]
}

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

const handPresence = new HandPresence()
let presenceActive = false

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

// --- GPS geolocation (primary source; manual fields are the fallback) --------

function initGeolocation(): void {
  if (!navigator.geolocation) return
  if (!uploadedPaper) paperStatus.textContent = 'detecting location…'

  // Safety net: some browsers never invoke either callback (e.g. the
  // permission prompt is ignored). Don't leave "detecting location…" forever.
  const statusTimeout = setTimeout(() => {
    if (paperStatus.textContent === 'detecting location…') {
      paperStatus.textContent = ''
    }
  }, 12000)

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      clearTimeout(statusTimeout)
      const { latitude, longitude } = pos.coords

      // Tile fetch and reverse geocode in parallel — no forward-geocode step needed
      const [img, { city, country }] = await Promise.all([
        fetchMapFromCoords(latitude, longitude),
        reverseGeocode(latitude, longitude),
      ])

      // Only fill if the user hasn't typed anything manually
      if (!cityInput.value && city) cityInput.value = city
      if (!countryInput.value && country) countryInput.value = country

      if (!uploadedPaper) {
        pendingPaper = img
        paperStatus.textContent = city || 'location found'
      }
    },
    () => {
      clearTimeout(statusTimeout)
      // Permission denied or unavailable — fall back to manual entry silently
      if (!uploadedPaper && !pendingPaper) paperStatus.textContent = ''
    },
    { timeout: 10000, maximumAge: 60000 }
  )
}

initGeolocation()

// --- Play/pause button UI -------------------------------------------------

function setButtonPlaying(isPlaying: boolean): void {
  if (iconPlay) iconPlay.style.display = isPlaying ? 'none' : ''
  if (iconPause) iconPause.style.display = isPlaying ? '' : 'none'
  playPauseBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play')
  const label = document.getElementById('btn-label')
  if (label) label.textContent = isPlaying ? 'PAUSE' : 'PLAY'
}

/**
 * Update the tiny camera status dot in the controls area.
 * true = hand present, false = camera ready but no hand, null = hide.
 */
function setCameraIndicator(present: boolean | null): void {
  const el = document.getElementById('camera-indicator')
  if (!el) return
  if (present === null) {
    el.style.display = 'none'
    return
  }
  el.style.display = 'block'
  el.dataset.present = present ? '1' : '0'
}

/** Poll the renderer so the button reflects when the strip finishes on its own. */
function watchPlayback(): void {
  if (playPauseBtn.disabled) return
  if (!renderer.isPlaying) {
    setButtonPlaying(false)
    soundEngine.stopMechanical()
    renderer.setLightIntensity(1.0)
    return
  }
  requestAnimationFrame(watchPlayback)
}

/**
 * Wake-not-operate: open the camera and let a hand play/pause the machine.
 * Idempotent. If the camera is denied or unavailable, the brass button
 * remains the sole control and the indicator hides itself.
 */
async function activatePresence(): Promise<void> {
  if (presenceActive) return
  presenceActive = true

  // Wire proximity to light intensity immediately — init is async
  handPresence.onProximity = (v) => renderer.setLightIntensity(v)

  handPresence.onPresent = async () => {
    setCameraIndicator(true)
    if (!renderer.isPlaying) {
      await ensureSound()
      soundEngine.startMechanical()
      renderer.play()
      setButtonPlaying(true)
      watchPlayback()
    }
  }

  handPresence.onAbsent = () => {
    setCameraIndicator(false)
    if (renderer.isPlaying) {
      renderer.pause()
      setButtonPlaying(false)
      soundEngine.stopMechanical()
    }
  }

  try {
    await handPresence.init()
    if (!handPresence.isReady) {
      // Model/CDN load failed (offline gallery) — brass button fallback only
      presenceActive = false
      setCameraIndicator(null)
      return
    }
    handPresence.start()
    setCameraIndicator(false) // ready, no hand yet
  } catch {
    // Camera permission denied or unavailable — brass button fallback only
    presenceActive = false
    setCameraIndicator(null) // null = hide the indicator
  }
}

// --- Share UI (QR + permalink + PNG export) -------------------------------

async function updateShareUI(strip: StripJSON): Promise<void> {
  const panel = document.getElementById('share-panel')
  const qrImg = document.getElementById('qr-img') as HTMLImageElement | null
  const copyBtn = document.getElementById('copy-link-btn') as HTMLButtonElement | null
  const exportBtn = document.getElementById('export-png-btn') as HTMLButtonElement | null
  if (!panel || !qrImg || !copyBtn || !exportBtn) return

  if (!archiveEnabled) { panel.style.display = 'none'; return }

  panel.style.display = 'block'
  qrImg.src = await generateQR(strip.id)

  copyBtn.onclick = async () => {
    await navigator.clipboard.writeText(stripPermalink(strip.id))
    copyBtn.textContent = 'copied!'
    setTimeout(() => { copyBtn.textContent = 'copy link' }, 2000)
  }

  exportBtn.onclick = () => {
    exportPNG(canvas, `perforated-atlas-${strip.id.slice(0, 8)}.png`)
  }
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
  showApparatus()

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

  // 5b. "The words are gone. Only the pattern remains."
  showAfterword()

  // 6. Save to archive (fire-and-forget — don't block playback)
  void saveStrip(strip).then(() => {
    archiveView.prepend(strip)
  })

  // 7. Show share UI (QR + permalink + export)
  void updateShareUI(strip)

  // 8. The machine is woken, not operated — wait silently for a hand.
  void activatePresence()
}

translateBtn.addEventListener('click', doTranslate)

// --- Play/pause toggle ----------------------------------------------------

async function togglePlayPause(): Promise<void> {
  // A tap on the brass button also tries to wake the camera (idempotent).
  void activatePresence()
  if (renderer.isPlaying) {
    renderer.pause()
    setButtonPlaying(false)
    soundEngine.stopMechanical()
  } else {
    // Keep the apparatus visible (already true after first translate).
    showApparatus()
    await ensureSound()
    soundEngine.startMechanical()
    renderer.play()
    setButtonPlaying(true)
    watchPlayback()
  }
}

playPauseBtn.addEventListener('click', () => void togglePlayPause())

// Spacebar toggles play/pause once a strip is loaded (unless typing in a field).
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
  if (playPauseBtn.disabled) return
  e.preventDefault()
  void togglePlayPause()
})

// --- Archive view ---------------------------------------------------------

const archiveSection = requireEl<HTMLElement>('archive-section')
const archiveView = new ArchiveView(archiveSection)

// When a visitor selects an archive strip, load and play it
archiveView.onSelect = (strip) => {
  renderer.load(strip)
  renderer.setPaper(uploadedPaper ?? pendingPaper)
  showApparatus()
  playPauseBtn.disabled = false
  void updateShareUI(strip)
  // Update URL hash for shareability
  history.pushState(null, '', `#/strip/${strip.id}`)
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

// Load archive on startup (non-blocking)
void archiveView.load()

// --- Permalink hash routing -----------------------------------------------

async function handleHashRoute(): Promise<void> {
  const match = location.hash.match(/^#\/strip\/([0-9a-f-]{36})$/)
  if (!match) return
  const strip = await loadStrip(match[1])
  if (!strip) return

  // Load and show the strip without going through the input flow
  endWelcome() // permalink arrivals skip the welcome beat
  renderer.load(strip)
  renderer.setPaper(uploadedPaper ?? pendingPaper)
  showApparatus()
  playPauseBtn.disabled = false

  void updateShareUI(strip)
}

window.addEventListener('hashchange', () => void handleHashRoute())
void handleHashRoute() // check on load
