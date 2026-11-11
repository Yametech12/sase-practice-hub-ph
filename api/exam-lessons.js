/**
 * POST /api/exam-lessons
 * Body: { token }
 *
 * Paid-only Civil Service VIDEO LESSONS list (owner order Nov 11, 2026).
 *
 * Auth model (same pattern as exam-list):
 *  - A valid signed token is required; no token, no list. The lesson titles
 *    and URLs are NEVER present in any public page or static file response.
 *  - The token's track must be "cse". A SASE token gets 403 track_mismatch:
 *    CSE lessons are part of the Civil Service product only.
 *  - The token's device must still be bound to the order (max-3 rule),
 *    exactly like every other exam endpoint.
 *
 * Data: exam/cse-lessons.json via loadCseLessons() (study-path order).
 * Response: { track: "cse", lessons: [ {section, topic, title, channel,
 * video_id, url, why} ] }. The UI groups by section and streams through a
 * youtube-nocookie embed; nothing here is downloadable by design.
 */
import {
  verifyToken,
  loadState,
  readBody,
  trackOf,
  loadCseLessons,
  deviceMismatchMsg,
  TRACK_CSE,
  bindingHasDevice,
} from "./_exam-lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  try {
    const { token } = await readBody(req);
    const p = verifyToken(token);
    if (!p) {
      return res.status(401).json({ error: "bad_token", message: "Session expired. Please log in again." });
    }
    const track = trackOf(p);
    if (track !== TRACK_CSE) {
      return res.status(403).json({
        error: "track_mismatch",
        message: "Video lessons are part of the Civil Service reviewer. SASE accounts do not include them.",
      });
    }
    const { state } = await loadState();
    const b = state.bindings[p.order_id];
    if (!bindingHasDevice(b, p.device_hash)) {
      return res.status(403).json({ error: "device_mismatch", message: deviceMismatchMsg(track) });
    }
    return res.status(200).json({ track, lessons: loadCseLessons() });
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), type: "lessons_error", message: String(e && e.message) }));
    return res.status(500).json({ error: "server_error" });
  }
}
