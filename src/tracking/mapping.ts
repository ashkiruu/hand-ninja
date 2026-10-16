// Coordinate mapping between the webcam frame and the screen.
//
// The camera feed is drawn mirrored (selfie view) and scaled to *cover* the
// screen, then zoomed by `reach`. Hand landmarks go through exactly the same
// transform, so the blade sits right on top of the player's fingertip in the
// background video. A reach > 1 also means the player doesn't have to stretch
// to the edges of the camera's view (where tracking is weakest) to reach the
// edges of the screen.

export interface CoverScale {
  x: number;
  y: number;
}

export function coverScale(videoAspect: number, screenAspect: number, reach: number): CoverScale {
  return {
    x: Math.max(1, videoAspect / screenAspect) * reach,
    y: Math.max(1, screenAspect / videoAspect) * reach,
  };
}

/**
 * Raw normalized video coords (u right, v down, NOT mirrored) → "height units":
 * origin at screen center, y up, 1 unit = screen height. Multiply by the
 * world-space view height to get world coordinates.
 */
export function videoToHeightUnits(
  u: number,
  v: number,
  scale: CoverScale,
  screenAspect: number,
  out: { x: number; y: number },
) {
  const sx = 0.5 + (1 - u - 0.5) * scale.x; // mirrored, 0..1 across the screen
  const sy = 0.5 + (v - 0.5) * scale.y; // 0..1 down the screen
  out.x = (sx - 0.5) * screenAspect;
  out.y = 0.5 - sy;
  return out;
}

/** Pixel coords (CSS px) → height units. */
export function pixelsToHeightUnits(px: number, py: number, w: number, h: number, out: { x: number; y: number }) {
  out.x = (px / w - 0.5) * (w / h);
  out.y = 0.5 - py / h;
  return out;
}
