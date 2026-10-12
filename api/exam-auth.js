/**
 * POST /api/exam-auth
 * Body: { password, device_id }
 *
 * 1 password = 1 device (STRICT). The first device that authenticates with a
 * buyer's password is permanently bound to that order_id. A different device
 * gets 403 and the first device is NOT disturbed.
 *
 * Returns a token embedding { order_id, device_hash, created_at } — the
 * weekly exam schedule is derived from created_at.
 *
 * Per-IP rate limiting (defense in depth): 20 auth attempts per 10 minutes.
 */
import {
  sha256,
  deviceHash,
  ipHash,
  signToken,
  updateState,
  readBody,
  logEvent,
  rateLimit,
  DEVICE_MISMATCH_MSG,
} from "./_exam-lib.js";
import hashes from "./_exam-hashes.json" with { type: "json" };
// _exam-hashes.json: { "<sha256(password)>": { order_id, created_at } } — hashes only, never plaintext.
// Underscore prefix = never routable; it is bundled into the function only.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  try {
    const key = "auth:" + ipHash(req);
    if (!rateLimit(key, 20, 10 * 60 * 1000)) {
      logEvent({ type: "auth_rate_limited", ip_hash: ipHash(req) });
      return res.status(429).json({
        error: "rate_limited",
        message: "Too many attempts. Please wait a few minutes and try again.",
      });
    }
    const { password, device_id } = await readBody(req);
    if (typeof password !== "string" || !password || typeof device_id !== "string" || !device_id) {
      return res.status(400).json({ error: "bad_request", message: "Password is required." });
    }

    const rec = hashes[sha256(password)];
    if (!rec || !rec.order_id) {
      logEvent({ type: "auth_failed", reason: "bad_password", ip_hash: ipHash(req) });
      return res.status(401).json({
        error: "bad_password",
        message: "Incorrect password. Please check the password from your PDF and try again.",
      });
    }
    const orderId = rec.order_id;
    const createdAt = rec.created_at || "";
    const dh = deviceHash(device_id);

    const outcome = await updateState((state) => {
      const b = state.bindings[orderId];
      if (b) {
        if (b.device_hash === dh) return { ok: true, rebound: false };
        return { ok: false, reason: "device_mismatch" };
      }
      // First auth for this order: bind permanently.
      state.bindings[orderId] = {
        device_hash: dh,
        bound_at: new Date().toISOString(),
        ip_hash: ipHash(req),
      };
      return { ok: true, rebound: true };
    }, `exam: bind device for ${orderId}`);

    if (!outcome.ok) {
      logEvent({
        type: "auth_rejected",
        reason: "device_mismatch",
        order_id: orderId,
        ip_hash: ipHash(req),
      });
      return res.status(403).json({ error: "device_mismatch", message: DEVICE_MISMATCH_MSG });
    }

    const now = Date.now();
    const token = signToken({
      order_id: orderId,
      device_hash: dh,
      created_at: createdAt,
      iat: now,
      exp: now + 24 * 3600 * 1000,
    });
    logEvent({ type: "auth_ok", order_id: orderId, rebound: outcome.rebound, ip_hash: ipHash(req) });
    return res.status(200).json({ token });
  } catch (e) {
    console.error("exam-auth error:", e.message);
    return res.status(500).json({ error: "server_error", message: "Please try again in a moment." });
  }
}
