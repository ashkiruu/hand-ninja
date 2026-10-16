import type { Point3 } from "./landmarkerOptions";

// Plausibility check for MediaPipe hand landmarks.
//
// In VIDEO mode MediaPipe tracks the hand region from frame to frame and only
// re-runs palm detection when it loses confidence. When a hand moves away
// quickly, the tracked region can drift onto the face or body and the model
// still returns 21 points: a malformed "hand" that would put the blade in the
// wrong place. Real hands have consistent proportions and don't change size
// abruptly, so those frames are easy to reject.

/** Distance between two landmarks in height units (x scaled by the frame's aspect ratio). */
function dist(lm: Point3[], a: number, b: number, aspect: number) {
  return Math.hypot((lm[a].x - lm[b].x) * aspect, lm[a].y - lm[b].y);
}

const FINGERS = [
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
];

/** Overall hand size: the largest palm dimension (robust to the palm turning sideways). */
export function handScale(lm: Point3[], aspect: number) {
  return Math.max(dist(lm, 0, 9, aspect), dist(lm, 5, 17, aspect), dist(lm, 0, 5, aspect), dist(lm, 0, 17, aspect));
}

export interface SanityState {
  scale: number;
  t: number;
}

/**
 * Returns a reason string if the skeleton is implausible, or null if it looks
 * like a real hand. `prev` is the last accepted hand (for the size-jump check).
 */
export function implausible(lm: Point3[], aspect: number, t: number, prev: SanityState | null): string | null {
  if (lm.length < 21) return "incomplete";

  let outside = 0;
  for (const p of lm) if (p.x < -0.2 || p.x > 1.2 || p.y < -0.2 || p.y > 1.2) outside++;
  if (outside > 5) return "outside frame";

  const scale = handScale(lm, aspect);
  // A hand filling most of the frame height, or a few pixels wide, isn't a real tracked hand.
  if (scale < 0.025) return "too small";
  if (scale > 0.85) return "too large";

  // Fingers are at most ~1.1x the palm in reality. Foreshortening can shrink the
  // palm, so allow a wide margin, but a drifted skeleton has long, broken fingers.
  for (const f of FINGERS) {
    const len = dist(lm, f[0], f[1], aspect) + dist(lm, f[1], f[2], aspect) + dist(lm, f[2], f[3], aspect);
    if (len > 2.6 * scale) return "finger too long";
  }

  // A real hand can't change apparent size by ~2x in a fraction of a second.
  if (prev && t - prev.t < 250) {
    const r = scale / prev.scale;
    if (r > 1.9 || r < 1 / 1.9) return "size jump";
  }
  return null;
}
