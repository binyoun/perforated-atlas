import QRCode from 'qrcode'

export function stripPermalink(id: string): string {
  const base = `${location.origin}${import.meta.env.BASE_URL}`
  return `${base}#/strip/${id}`
}

export async function generateQR(id: string): Promise<string> {
  return QRCode.toDataURL(stripPermalink(id), {
    width: 200,
    margin: 1,
    color: { dark: '#C8B070', light: '#0b0b0b' },
  })
}

export function exportPNG(canvas: HTMLCanvasElement, filename: string): void {
  const a = document.createElement('a')
  a.href = canvas.toDataURL('image/png')
  a.download = filename
  a.click()
}
