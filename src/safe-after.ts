import { after } from "next/server";

/** Receives an error raised by a task registered through {@link safeAfter}. */
export type SafeAfterErrorLogger = (err: any) => void;

const defaultErrorLogger: SafeAfterErrorLogger = (err: any): void => {
  console.error("[safeAfter] Background task failed", err);
};

/**
 * Registers bounded post-response work with the Next.js request lifecycle.
 *
 * In a traditional, long-lived Node.js process, returning an HTTP response does
 * not normally stop other work scheduled on the event loop. A serverless
 * platform has different lifecycle semantics: after the response is flushed,
 * it may freeze or tear down the invocation container. A detached promise such
 * as `void sendEmail()` is invisible to that lifecycle and can be interrupted
 * without completing or surfacing its rejection.
 *
 * Next.js 16+'s native `after()` API gives the runtime ownership of the
 * callback. This wrapper returns the task's awaited promise from that callback,
 * allowing the runtime to track it after the response has completed. It also
 * contains both synchronous task throws and asynchronous task rejections so a
 * post-response failure does not escape as an unhandled rejection.
 *
 * This is not a durable job queue. Registered work is still constrained by the
 * host's maximum invocation duration and cannot survive a process crash or
 * forced termination. Use persistent queue infrastructure for long-running or
 * business-critical work that needs retries or delivery guarantees.
 *
 * @param task - A promise-returning, bounded unit of post-response work.
 * @param fallbackLogger - Optional error reporter. Defaults to `console.error`.
 *   Logger failures are contained to keep the registered callback resolved.
 * @returns Nothing. Next.js owns the registered callback's lifecycle.
 *
 * @example
 * ```ts
 * safeAfter(
 *   () => sendReceipt(orderId),
 *   (err) => monitoring.captureException(err),
 * );
 * ```
 */
export function safeAfter(
  task: () => Promise<void>,
  fallbackLogger: SafeAfterErrorLogger = defaultErrorLogger,
): void {
  after(async (): Promise<void> => {
    try {
      await task();
    } catch (err: unknown) {
      try {
        // Awaiting is harmless for a synchronous logger and also contains a
        // rejected promise if a consumer supplies an async function at runtime.
        await fallbackLogger(err);
      } catch (loggerError: unknown) {
        // A custom logger must not make the lifecycle callback reject. Use the
        // platform console as the final, dependency-free reporting boundary.
        try {
          console.error("[safeAfter] Error logger failed", {
            loggerError,
            taskError: err,
          });
        } catch {
          // Some runtimes can replace console methods. There is no safer sink.
        }
      }
    }
  });
}
