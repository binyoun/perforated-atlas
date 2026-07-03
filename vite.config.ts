/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/perforated-atlas/',
  test: {
    environment: 'node',
  },
})
