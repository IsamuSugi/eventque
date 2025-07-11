import { EventEmitter } from 'events'

/**
 * Defines the mapping from event names to their argument tuple types.
 * Users should provide their own event map interface.
 *
 * Example:
 * interface MyEvents {
 *   log: [string];
 *   compute: [number, number];
 * }
 */
export interface EventMap {
  [event: string]: any[]
}

/**
 * The function signature for an EventQue listener.
 * The last argument is always an AbortSignal for cancellation support.
 */
export type ListenerArgs<T extends any[]> = [...T, AbortSignal]
export type Listener<T extends any[]> = (...args: ListenerArgs<T>) => any | Promise<any>

/**
 * Options for customizing the behavior of emitAsync.
 */
export interface EmitOptions {
  parallel?: boolean
  stopOnError?: boolean
  timeoutMs?: number
}

/**
 * Allows configuring default EmitOptions per event type.
 */
export type EventSpecificOptions<E extends EventMap> = {
  [K in keyof E]?: EmitOptions
}

/**
 * Configuration options for the EventQue constructor.
 */
export interface EventQConfig<E extends EventMap> {
  defaultOptions?: EmitOptions
  perEventOptions?: EventSpecificOptions<E>
}

/**
 * Represents the result of calling emitAsync on one listener.
 */
export interface EmitResult<TArgs extends any[]> {
  listener: Listener<TArgs>
  value: unknown
  error: Error | null
}

/**
 * EventQue - A type-safe, async-friendly, queue-based event emitter.
 *
 * Features:
 * - Async emit with Promise results
 * - Queueing to guarantee order of emits
 * - Parallel or sequential listener execution
 * - Per-listener timeout with AbortSignal cancellation
 * - Event-specific default options
 * - Compatible with Node.js EventEmitter (on, once, off)
 */
export class EventQue<E extends EventMap> {
  private readonly emitter = new EventEmitter()
  private readonly queue: (() => Promise<void>)[] = []
  private processing = false
  private readonly defaultOptions: EmitOptions
  private readonly perEventOptions: EventSpecificOptions<E>

  constructor(config?: EventQConfig<E>) {
    this.defaultOptions = config?.defaultOptions ?? {}
    this.perEventOptions = config?.perEventOptions ?? {}
  }

  /**
   * Register a listener for the given event.
   * The listener must accept AbortSignal as the last parameter.
   */
  on<K extends keyof E>(event: K, listener: Listener<E[K]>): void {
    this.emitter.on(event as string | symbol, listener)
  }

  /**
   * Register a listener that runs only once.
   */
  once<K extends keyof E>(event: K, listener: Listener<E[K]>): void {
    this.emitter.once(event as string | symbol, listener)
  }

  /**
   * Remove a registered listener.
   */
  off<K extends keyof E>(event: K, listener: Listener<E[K]>): void {
    this.emitter.off(event as string | symbol, listener)
  }

  /**
   * Emit an event asynchronously, returning a Promise of all listener results.
   * The call is queued to ensure order of emits.
   */
  emitAsync<K extends keyof E>(event: K, ...argsAndMaybeOptions: [...E[K], EmitOptions?]): Promise<EmitResult<E[K]>[]> {
    // extract options
    let callOptions: EmitOptions
    let args: E[K]

    if (
      argsAndMaybeOptions.length &&
      typeof argsAndMaybeOptions[argsAndMaybeOptions.length - 1] === 'object' &&
      !(argsAndMaybeOptions[argsAndMaybeOptions.length - 1] instanceof Error) &&
      !Array.isArray(argsAndMaybeOptions[argsAndMaybeOptions.length - 1])
    ) {
      callOptions = argsAndMaybeOptions.pop() as EmitOptions
      args = argsAndMaybeOptions as unknown as E[K]
    } else {
      callOptions = {}
      args = argsAndMaybeOptions as unknown as E[K]
    }

    // merge options: global -> per-event -> call
    const mergedOptions: EmitOptions = {
      ...this.defaultOptions,
      ...(this.perEventOptions[event] ?? {}),
      ...callOptions,
    }

    return new Promise<EmitResult<E[K]>[]>((resolve) => {
      this.queue.push(async () => {
        const listeners = this.emitter.listeners(event as string | symbol) as Listener<E[K]>[]
        const results: EmitResult<E[K]>[] = []

        const invokeListener = async (listener: Listener<E[K]>, signal: AbortSignal): Promise<unknown> => {
          return Promise.resolve().then(() => listener(...args, signal))
        }

        const runWithTimeout = (listener: Listener<E[K]>): Promise<unknown> => {
          const controller = new AbortController()
          const signal = controller.signal

          return new Promise((resolve, reject) => {
            let settled = false
            const timeout = mergedOptions.timeoutMs
              ? setTimeout(() => {
                  if (!settled) {
                    controller.abort()
                    settled = true
                    reject(new Error(`Listener timed out after ${mergedOptions.timeoutMs}ms`))
                  }
                }, mergedOptions.timeoutMs)
              : null

            invokeListener(listener, signal)
              .then((value) => {
                if (!settled) {
                  settled = true
                  if (timeout) clearTimeout(timeout)
                  resolve(value)
                }
              })
              .catch((err) => {
                if (!settled) {
                  settled = true
                  if (timeout) clearTimeout(timeout)
                  reject(err)
                }
              })
          })
        }

        if (mergedOptions.parallel) {
          await Promise.all(
            listeners.map(async (listener) => {
              try {
                const value = await runWithTimeout(listener)
                results.push({ listener, value, error: null })
              } catch (err) {
                results.push({ listener, value: null, error: err instanceof Error ? err : new Error(String(err)) })
                if (mergedOptions.stopOnError) throw err
              }
            })
          )
        } else {
          for (const listener of listeners) {
            try {
              const value = await runWithTimeout(listener)
              results.push({ listener, value, error: null })
            } catch (err) {
              results.push({ listener, value: null, error: err instanceof Error ? err : new Error(String(err)) })
              if (mergedOptions.stopOnError) break
            }
          }
        }

        resolve(results)
      })

      this.processQueue()
    })
  }

  private async processQueue() {
    if (this.processing) return
    this.processing = true

    while (this.queue.length > 0) {
      const task = this.queue.shift()
      if (task) {
        try {
          await task()
        } catch (_) {
          // errors are handled in task
        }
      }
    }

    this.processing = false
  }
}
