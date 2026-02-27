import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import streamSaver from 'streamsaver'
import { routeTree } from './routeTree.gen'

import './styles/main.css'
import './styles/components.css'
import './styles/animations.css'

// Configure StreamSaver to use local assets for offline support (Docker) and better performance.
// Relative path is generally most compatible for both Vercel and Docker environments.
streamSaver.mitm = '/streamsaver/mitm.html'

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
