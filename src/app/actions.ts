"use server";

import { api, apiError } from "@/lib/api";
import { validatePayload, type RequestPayload } from "@/lib/selection";

export type SubmitResult = { ok: true; token: string } | { ok: false; error: string };

/**
 * Sends the visitor's request to the OTS API, which recomputes the hours, saves it and emails the
 * customer. The quick checks run here too so a slip is reported without a round trip; the API
 * checks everything again and is what counts.
 */
export async function submitRequest(payload: RequestPayload): Promise<SubmitResult> {
  const invalid = validatePayload(payload);
  if (invalid) return { ok: false, error: invalid };

  let res: Response;
  try {
    // The API saves, then sends the customer email before answering: give it time for both.
    res = await api("/v1/requests", { method: "POST", body: payload, timeoutMs: 30_000 });
  } catch (e) {
    console.error("[submitRequest] API unreachable", e instanceof Error ? e.message : e);
    return { ok: false, error: "We couldn't send your request just now. Your details are still here, so please try again." };
  }
  if (res.status === 201) {
    const body = (await res.json().catch(() => null)) as { token?: unknown } | null;
    if (typeof body?.token === "string") return { ok: true, token: body.token };
  }
  return {
    ok: false,
    error: await apiError(res, "We couldn't send your request just now. Your details are still here, so please try again."),
  };
}
