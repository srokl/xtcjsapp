import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import streamSaver from 'streamsaver'
import { routeTree } from './routeTree.gen'

import './styles/main.css'
import './styles/components.css'
import './styles/animations.css'

// Configure StreamSaver to use local assets for offline support (Docker) and better performance.
// Commented out to default to jimmywarting.github.io for better compatibility with Vercel as requested.
// streamSaver.mitm = window.location.origin + '/streamsaver/mitm.html'

const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
)
