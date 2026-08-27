# nextjs-serverless-async-handler

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Next.js 16+](https://img.shields.io/badge/Next.js-16%2B-black?logo=next.js)](https://nextjs.org/)
[![ESM](https://img.shields.io/badge/modules-ESM-blue)](https://nodejs.org/api/esm.html)

A small, strictly typed wrapper and reference implementation for running post-response work in Next.js serverless handlers with the native [`after()`](https://nextjs.org/docs/app/api-reference/functions/after) API.

Use it for short, non-critical tasks such as sending a receipt, emitting an analytics event, or writing best-effort diagnostic logs—without making the client wait and without leaving an untracked promise behind.

> [!IMPORTANT]
> `after()` is lifecycle-aware, but it is not a durable queue. It remains subject to the deployment platform's maximum invocation duration and process failures. Use a real queue with retries and persistence for critical, long-running, or exactly-once work.

## The problem

### A serverless response is also a lifecycle boundary

In a long-running Node.js server, returning an HTTP response does not normally terminate the process. In a serverless environment, the platform owns the process lifecycle. Once the response has been produced, the runtime may freeze or tear down the invocation's compute container.

That creates a subtle failure mode:

```ts
export async function POST(): Promise<Response> {
  // Fire-and-forget: the runtime does not know this work matters.
  void fetch("https://email.example.test/receipts", {
    method: "POST",
    body: JSON.stringify({ orderId: "order_123" }),
  });

  return Response.json({ ok: true });
}
```

The route returns quickly, but the detached promise is not tied to the serverless invocation. The platform may flush the response and freeze the container before DNS resolution, connection setup, request-body transmission, or response handling finishes. The result can be intermittent missing work with no error visible to the caller.

Awaiting the work avoids that race, but moves the entire latency onto the request path:

```ts
await sendReceipt(); // Reliable within this request, but the user waits for it.
return Response.json({ ok: true });
```

The real requirement is to tell the runtime: **send the response now, but keep this invocation alive long enough to track this bounded task.**

## The solution

Next.js `after()` has been stable since Next.js 15.1; this package deliberately targets Next.js 16 and later. The API registers work that executes after the response finishes while keeping it attached to the framework-managed request lifecycle.

```ts
import { after } from "next/server";

after(async () => {
  // The runtime can track this returned promise.
  await doBackgroundWork();
});
```

The `safeAfter()` wrapper in this repository:

- passes an async callback directly to `after()` so Next.js can track its promise;
- catches synchronous throws and asynchronous rejections from the task;
- reports failures through an optional logger, defaulting to `console.error`;
- prevents a failing logger from turning the post-response callback into an unhandled rejection.

## Installation

Until the first npm release, install directly from the public GitHub repository:

```bash
npm install github:Eng-Meshari/nextjs-serverless-async-handler
```

After the package is published to npm:

```bash
npm install nextjs-serverless-async-handler
```

To use this repository directly as a template:

```bash
npm install
npm run typecheck
```

Requirements:

- Next.js 16 or later
- Node.js 20.9 or later
- a Server Component, Server Function, Route Handler, or Proxy context that supports `after()`
- a deployment adapter that supports `after()` and an invocation limit long enough for the task

This package is ESM-only.

## Usage example

```ts
import { safeAfter } from "nextjs-serverless-async-handler";

interface CheckoutRequest {
  email: string;
  orderId: string;
}

function isCheckoutRequest(value: unknown): value is CheckoutRequest {
  if (typeof value !== "object" || value === null) return false;

  const input = value as Record<string, unknown>;
  return (
    typeof input.email === "string" &&
    input.email.length > 0 &&
    typeof input.orderId === "string" &&
    input.orderId.length > 0
  );
}

async function sendReceipt(input: CheckoutRequest): Promise<void> {
  const response = await fetch("https://email.example.test/receipts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    throw new Error(`Receipt service returned ${response.status}`);
  }
}

export async function POST(request: Request): Promise<Response> {
  const input: unknown = await request.json();

  if (!isCheckoutRequest(input)) {
    return Response.json({ error: "Invalid payload" }, { status: 400 });
  }

  safeAfter(
    () => sendReceipt(input),
    (error) => console.error("Receipt delivery failed", {
      error,
      orderId: input.orderId,
    }),
  );

  return Response.json({ ok: true, orderId: input.orderId });
}
```

See the complete comparison, including malformed-JSON handling, in [`examples/api/checkout/route.ts`](./examples/api/checkout/route.ts).

## Architecture deep dive

### Request timeline

```text
Client               Next.js route             Serverless runtime          External service
  |                        |                            |                           |
  |---- POST /checkout --->|                            |                           |
  |                        |-- validate input           |                           |
  |                        |-- safeAfter(task) -------->| register tracked work     |
  |<------- 200 OK --------|                            |                           |
  |                        |                            |---- send receipt -------->|
  |                        |                            |<------ completed ----------|
  |                        |                            | invocation may now freeze  |
```

With `void fetch()`, there is no lifecycle registration between the route and the runtime. With `safeAfter()`, `after()` owns the callback and observes the promise returned by the async task. On supporting serverless adapters, Next.js connects this lifecycle to the platform's `waitUntil` primitive.

### Error containment

Post-response work cannot change the status code—the response has already been sent. Failures therefore need an observability path. `safeAfter()` catches task errors and sends them to the supplied logger. The logger should forward structured errors to your monitoring system.

```ts
safeAfter(runTask, (error) => {
  monitoring.captureException(error, {
    tags: { operation: "checkout-receipt" },
  });
});
```

The wrapper deliberately does not retry. Blind retries can duplicate emails, payments, or mutations. If retrying is appropriate, make the operation idempotent and implement a bounded policy—or enqueue a durable job.

### Execution guarantees and limits

`after()` solves invocation tracking, not distributed-systems durability:

| Concern | `void promise` | `safeAfter()` / `after()` | Durable queue |
| --- | --- | --- | --- |
| Response can return first | Yes | Yes | Yes |
| Runtime tracks remaining work | No | Yes | Worker-owned |
| Survives process or region failure | No | No | Typically |
| Persistent retries | No | No | Typically |
| Suitable for long-running work | No | Only within invocation limit | Yes |

Choose `safeAfter()` when the task is short, bounded, and acceptable to lose in a catastrophic process failure. Choose a durable queue when work is business-critical, may exceed the function timeout, needs retries, or requires delivery guarantees.

The callback runs within the route's platform-defined or configured [`maxDuration`](https://nextjs.org/docs/app/api-reference/file-conventions/route-segment-config#maxduration). Static rendering is another important edge case: if `after()` is used in a statically rendered page, its callback runs during build or revalidation rather than after a user request. Static export does not support `after()`, and custom adapters must provide compatible lifecycle support.

### Production checklist

- Persist the primary transaction before scheduling secondary work.
- Make external side effects idempotent using an order or event ID.
- Set timeouts on outbound network calls; do not rely only on the platform timeout.
- Log a stable correlation ID and task name with every failure.
- Keep secrets server-side and validate all request input.
- Monitor duration and failure rate for post-response work.
- Move the task to a queue when its reliability or runtime requirements outgrow `after()`.

## API

### `safeAfter(task, fallbackLogger?)`

Registers a promise-returning task with Next.js `after()`.

```ts
function safeAfter(
  task: () => Promise<void>,
  fallbackLogger?: (err: any) => void,
): void;
```

The function returns immediately. The supplied task runs through the lifecycle managed by Next.js. Errors are contained and reported; they are not propagated to the already-completed HTTP response.

## License

[MIT](./LICENSE) © Meshari
