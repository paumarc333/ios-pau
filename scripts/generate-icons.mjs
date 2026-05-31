// Generate PWA icons from the neon-triangle logo (public/favicon.svg).
// The triangle is centered over a #080810 background. Run with: node scripts/generate-icons.mjs
import sharp from 'sharp'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUBLIC = resolve(__dirname, '..', 'public')
const BG = { r: 0x08, g: 0x08, b: 0x10, alpha: 1 } // #080810

const logoSvg = await readFile(resolve(PUBLIC, 'favicon.svg'))

// Render the logo at a target inner size, then composite it centered on a solid square.
async function makeIcon({ size, logoRatio, out }) {
  const inner = Math.round(size * logoRatio)
  const logoPng = await sharp(logoSvg)
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()

  await sharp({
    create: { width: size, height: size, channels: 4, background: BG },
  })
    .composite([{ input: logoPng, gravity: 'center' }])
    .png()
    .toFile(resolve(PUBLIC, out))

  console.log(`✓ ${out} (${size}x${size}, logo ${Math.round(logoRatio * 100)}%)`)
}

// Standard icons: ~62% logo. Maskable: ~46% so the triangle stays inside the safe zone.
await makeIcon({ size: 192, logoRatio: 0.62, out: 'pwa-192x192.png' })
await makeIcon({ size: 512, logoRatio: 0.62, out: 'pwa-512x512.png' })
await makeIcon({ size: 512, logoRatio: 0.46, out: 'maskable-512x512.png' })
await makeIcon({ size: 180, logoRatio: 0.6, out: 'apple-touch-icon.png' })

console.log('Done.')
