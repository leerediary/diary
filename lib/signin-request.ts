type Listener = () => void
const listeners: Set<Listener> = new Set()

export function requestSignIn() {
  listeners.forEach(l => l())
}

export function onSignInRequested(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
