import type React from 'react'

/** Action-Blue quiet text button (Apple Design System). Single source of truth
 *  for the #0066cc interactive affordance used by AccountEntry and DataPortability.
 *  fontFamily: 'inherit' — set the enclosing element's font to the SF Pro stack
 *  and the buttons pick it up. */
export const ACTION_BLUE_BUTTON: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  color: '#0066cc',
  fontFamily: 'inherit',
  fontSize: 14,
  fontWeight: 400,
}
