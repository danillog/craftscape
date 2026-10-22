import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // published at danillogomes.com/craftscape/; absolute so it also works when the
  // URL is opened without the trailing slash
  base: command === 'build' ? '/craftscape/' : '/',
}))
