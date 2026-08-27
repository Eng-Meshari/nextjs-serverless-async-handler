import { safeAfter } from "../../../src/safe-after.js";

interface CheckoutRequest {
  email: string;
  orderId: string;
}

function isCheckoutRequest(value: unknown): value is CheckoutRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.email === "string" &&
    candidate.email.length > 0 &&
    typeof candidate.orderId === "string" &&
    candidate.orderId.length > 0
  );
}

async function readCheckoutRequest(
  request: Request,
): Promise<CheckoutRequest | null> {
  try {
    const body: unknown = await request.json();
    return isCheckoutRequest(body) ? body : null;
  } catch {
    return null;
  }
}

async function sendReceiptEmail(checkout: CheckoutRequest): Promise<void> {
  const response = await fetch("https://email.example.test/receipts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(checkout),
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    throw new Error(`Receipt service returned HTTP ${response.status}`);
  }
}

/*
 * BAD WAY — do not use detached promises for work that must complete.
 * The serverless invocation may freeze as soon as this response is sent:
 *
 * export async function POST(request: Request): Promise<Response> {
 *   const checkout = await readCheckoutRequest(request);
 *   if (checkout === null) {
 *     return Response.json({ error: "Invalid payload" }, { status: 400 });
 *   }
 *
 *   void fetch("https://email.example.test/receipts", {
 *     method: "POST",
 *     headers: { "content-type": "application/json" },
 *     body: JSON.stringify(checkout),
 *   });
 *   return Response.json({ ok: true, orderId: checkout.orderId });
 * }
 */

/**
 * GOOD WAY — Next.js tracks the callback after the 200 response is returned.
 */
export async function POST(request: Request): Promise<Response> {
  const checkout = await readCheckoutRequest(request);

  if (checkout === null) {
    return Response.json(
      { error: "A non-empty email and orderId are required" },
      { status: 400 },
    );
  }

  safeAfter(
    () => sendReceiptEmail(checkout),
    (err: any): void => {
      console.error("Receipt email failed", {
        error: err,
        orderId: checkout.orderId,
      });
    },
  );

  return Response.json({ ok: true, orderId: checkout.orderId });
}
