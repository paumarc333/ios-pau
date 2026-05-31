import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'iOS Pau',
        short_name: 'Pau',
        description: 'Pau — compañero inteligente',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        background_color: '#080810',
        theme_color: '#080810',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'maskable-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the built app shell + static assets for instant loads.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff,woff2}'],
        // Serve index.html for navigations (SPA), but never for Edge Function routes.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/functions\//],
        // No runtimeCaching: API calls (Supabase, claude-proxy, Finnhub) bypass the
        // service worker and always hit the network, so data is never stale.
        runtimeCaching: [],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  server: { host: true },
})
