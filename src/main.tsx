import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { installAuthFetch, installAuthAxios, enforceLocalSessionExpiry } from './utils/auth'

gsap.registerPlugin(ScrollTrigger)

// Must run before any component mounts and fires a request.
enforceLocalSessionExpiry()
installAuthFetch()
installAuthAxios()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
