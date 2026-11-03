import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules/')) return

          const pkgPath = id.split('node_modules/')[1]
          const parts = pkgPath.split('/')
          const pkgName = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]

          if (pkgName === 'react' || pkgName === 'react-dom' || pkgName === 'scheduler') {
            return 'vendor-react'
          }
          if (pkgName === 'react-window') {
            return 'vendor-react-window'
          }
          if (pkgName.startsWith('@antv/')) {
            return `vendor-antv-${pkgName.slice('@antv/'.length)}`
          }
        },
      },
    },
  },
})
