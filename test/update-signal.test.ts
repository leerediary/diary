import { describe, it, expect, vi, beforeEach } from 'vitest'

// update-signal holds module-scoped state, so each test gets a fresh module via
// resetModules() + dynamic import to stay order-independent.
describe('update-signal', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  async function fresh() {
    return await import('@/lib/update-signal')
  }

  it('starts unmarked and notifies a subscriber on mark', async () => {
    const sig = await fresh()
    expect(sig.isUpdateAvailable()).toBe(false)
    const fn = vi.fn()
    sig.subscribeUpdateAvailable(fn)
    sig.markUpdateAvailable()
    expect(sig.isUpdateAvailable()).toBe(true)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('replays to a subscriber that mounts after the mark', async () => {
    const sig = await fresh()
    sig.markUpdateAvailable()
    const fn = vi.fn()
    sig.subscribeUpdateAvailable(fn)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('markUpdateAvailable is idempotent', async () => {
    const sig = await fresh()
    const fn = vi.fn()
    sig.subscribeUpdateAvailable(fn)
    sig.markUpdateAvailable()
    sig.markUpdateAvailable()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe removes the subscriber', async () => {
    const sig = await fresh()
    const fn = vi.fn()
    const unsub = sig.subscribeUpdateAvailable(fn)
    unsub()
    sig.markUpdateAvailable()
    expect(fn).not.toHaveBeenCalled()
  })
})
