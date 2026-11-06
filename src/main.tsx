import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './ui/index.css'
import App from './ui/App.tsx'
import { FORCE_3D, page2d } from './ui/fallback'

// no WebGPU at all: straight to the 2D game, without starting the 3D one
if (!navigator.gpu && !FORCE_3D) window.location.replace(page2d('no-api'))
else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
