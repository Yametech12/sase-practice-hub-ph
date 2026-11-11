/**
 * POST /api/exam-lessons
 * Body: { token }
 *
 * Paid-only VIDEO LESSONS list for BOTH tracks (CSE added Nov 11, 2026;
 * SASE added Nov 11, 2026 on owner order, same paid-only pattern).
 *
 * Auth model (same pattern as exam-list):
 *  - A valid signed token is required; no token, no list. The lesson titles
 *    and URLs are NEVER present in any public page or static file response.
 *  - The token's track decides WHICH library is served: a SASE token gets
 *    the SASE lessons (api/_data/sase-lessons.json) and a CSE token gets the
 *    CSE lessons (api/_data/cse-lessons.json). The two libraries never cross:
 *    each response carries only its own track's lessons.
 *  - The token's device must still be bound to the order (max-3 rule),
 *    exactly like every other exam endpoint.
 *
 * Response: { track, lessons: [ {section, topic, title, channel,
 * video_id, url, why} ] }. The UI groups by section and streams through a
 * youtube-nocookie embed; nothing here is downloadable by design.
 */
import {
  verifyToken,
  loadState,
  readBody,
  trackOf,
  loadLessonsForTrack,
  deviceMismatchMsg,
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
    const { state } = await loadState();
    const b = state.bindings[p.order_id];
    if (!bindingHasDevice(b, p.device_hash)) {
      return res.status(403).json({ error: "device_mismatch", message: deviceMismatchMsg(track) });
    }
    return res.status(200).json({ track, lessons: loadLessonsForTrack(track) });
  } catch (e) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), type: "lessons_error", message: String(e && e.message) }));
    return res.status(500).json({ error: "server_error" });
  }
}
