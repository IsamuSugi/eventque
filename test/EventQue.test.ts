import { describe, it, expect } from 'vitest'
import { EventQue } from '../src/EventQue'

interface MyEvents extends Record<string, any[]> {
  log: [string]
  compute: [number, number]
}

describe('EventQue', () => {
  it('should register and call a simple listener', async () => {
    const emitter = new EventQue<MyEvents>()
    let called = false

    emitter.on('log', (msg, signal) => {
      if (signal.aborted) return
      called = msg === 'Hello'
    })

    await emitter.emitAsync('log', 'Hello')
    expect(called).toBe(true)
  })

  it('should return results from listeners', async () => {
    const emitter = new EventQue<MyEvents>()
    emitter.on('compute', async (a, b, signal) => {
      if (signal.aborted) throw new Error('Cancelled')
      return a + b
    })

    const results = await emitter.emitAsync('compute', 2, 3)
    expect(results[0].value).toBe(5)
    expect(results[0].error).toBeNull()
  })

  it('should timeout and abort listener', async () => {
    const emitter = new EventQue<MyEvents>({
      defaultOptions: { timeoutMs: 50 },
    })

    emitter.on('log', async (msg, signal) => {
      await new Promise((res) => setTimeout(res, 1000))
      if (signal.aborted) throw new Error('Cancelled')
    })

    const results = await emitter.emitAsync('log', 'Slow')
    expect(results[0].error).toBeInstanceOf(Error)
    expect(results[0].error?.message).toMatch(/timed out/i)
  })
})
