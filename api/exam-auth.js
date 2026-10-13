/**
 * POST /api/exam-auth
 * Body: { password, device_id }
 *
 * 1 password = up to 3 devices. The first 3 devices that authenticate with a
 * buyer's password are bound to that order_id. A 4th distinct device gets 403
 * and the bound devices are NOT disturbed.
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
  bindingDevices,
  MAX_DEVICES_PER_PASSWORD,
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
    // Per-password bucket: caps guesses against ANY single password at 30/10 min
    // regardless of IP rotation. Legitimate users (a few attempts) never hit it.
    if (!rateLimit("auth:pw:" + sha256(password), 30, 10 * 60 * 1000)) {
      logEvent({ type: "auth_rate_limited", reason: "per_password", ip_hash: ipHash(req) });
      return res.status(429).json({ error: "rate_limited", message: "Too many attempts. Please wait a few minutes and try again." });
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
    // Fail LOUDLY on a bad created_at: minting a token with a missing/garbage
    // created_at produces a token every endpoint immediately 401s (infinite
    // login loop) or a schedule that never unlocks. This is a server config
    // error, not a buyer error — 500, not a dead token.
    const createdAt = rec.created_at;
    const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
    if (typeof createdAt !== "string" || !ISO_RE.test(createdAt) || Number.isNaN(Date.parse(createdAt))) {
      logEvent({ type: "auth_config_error", reason: "bad_created_at", order_id: orderId });
      return res.status(500).json({ error: "server_error", message: "Account setup incomplete. Please message SASE Practice Hub PH." });
    }
    const dh = deviceHash(device_id);

    const outcome = await updateState((state) => {
      const b = state.bindings[orderId];
      const list = bindingDevices(b);
      if (list.some((x) => x.device_hash === dh)) return { ok: true, rebound: false };
      if (list.length >= MAX_DEVICES_PER_PASSWORD) return { ok: false, reason: "device_limit" };
      // Bind this as an additional device (also lazy-migrates legacy bindings).
      list.push({
        device_hash: dh,
        bound_at: new Date().toISOString(),
        ip_hash: ipHash(req),
      });
      state.bindings[orderId] = { devices: list };
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
