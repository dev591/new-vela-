import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Render tests run in jsdom (no browser needed): `npm test`.
export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'], restoreMocks: true },
})
