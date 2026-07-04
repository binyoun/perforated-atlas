import type { StripJSON } from '../engine/types'
import { loadRecent } from './db'
import { archiveEnabled } from './supabase'

export class ArchiveView {
  private container: HTMLElement
  onSelect: ((strip: StripJSON) => void) | null = null

  constructor(container: HTMLElement) {
    this.container = container
  }

  async load(): Promise<void> {
    if (!archiveEnabled) {
      this.container.style.display = 'none'
      return
    }
    const strips = await loadRecent(24)
    this.render(strips)
  }

  private render(strips: StripJSON[]): void {
    if (strips.length === 0) {
      this.container.style.display = 'none'
      return
    }
    this.container.innerHTML = ''

    const heading = document.createElement('p')
    heading.className = 'archive-heading'
    heading.textContent = 'Archive'
    this.container.appendChild(heading)

    const list = document.createElement('div')
    list.className = 'archive-list'

    for (const strip of strips) {
      const row = document.createElement('button')
      row.className = 'archive-row'
      row.dataset.id = strip.id

      const place = strip.city || strip.country
        ? [strip.city, strip.country].filter(Boolean).join(', ')
        : 'unknown place'

      const date = new Date(strip.created_at).toLocaleDateString('en', {
        year: 'numeric', month: 'short', day: 'numeric',
      })

      const dot = `<span class="archive-dot" style="background:${strip.palette[0]}"></span>`

      row.innerHTML = `
        ${dot}
        <span class="archive-place">${place}</span>
        <span class="archive-meta">${strip.word_count ?? '?'} words · ${strip.strip_length_mm} mm · ${date}</span>
      `
      row.addEventListener('click', () => this.onSelect?.(strip))
      list.appendChild(row)
    }

    this.container.appendChild(list)
  }

  /** Prepend a newly created strip to the archive without reloading. */
  prepend(strip: StripJSON): void {
    const list = this.container.querySelector('.archive-list')
    if (!list) return

    const row = document.createElement('button')
    row.className = 'archive-row archive-row--new'
    row.dataset.id = strip.id

    const place = strip.city || strip.country
      ? [strip.city, strip.country].filter(Boolean).join(', ')
      : 'unknown place'

    const dot = `<span class="archive-dot" style="background:${strip.palette[0]}"></span>`
    row.innerHTML = `
      ${dot}
      <span class="archive-place">${place}</span>
      <span class="archive-meta">${strip.word_count ?? '?'} words · ${strip.strip_length_mm} mm · just now</span>
    `
    row.addEventListener('click', () => this.onSelect?.(strip))
    list.prepend(row)
  }
}
