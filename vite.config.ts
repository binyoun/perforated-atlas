/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/perforated-atlas/',
  optimizeDeps: {
    exclude: ['@mediapipe/tasks-vision'],
  },
  test: {
    environment: 'node',
  },
})
