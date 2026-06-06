'use client'

import { useEffect } from 'react'
import { trackOnce } from './track'

/**
 * Fires the anonymous `landing_viewed` funnel event once per browser session.
 * Render once near the top of a public marketing page (renders nothing).
 */
export function LandingViewTracker() {
  useEffect(() => {
    trackOnce('landing_viewed')
  }, [])
  return null
}
