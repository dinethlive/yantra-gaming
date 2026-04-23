import { Container, Graphics } from 'pixi.js';
import { FACE_NEIGHBORS, getPipPositions, LOW_FACES } from './diceConstants';

type FaceSide = 'front' | 'top' | 'right';

/** Calculates responsive die size based on canvas width */
export function calcDieSize(canvasWidth: number): number {
  return Math.max(90, Math.min(140, canvasWidth * 0.11));
}

/** Builds the isometric die container (front face + right face + top face + gold ring) */
export function createDieContainer(
  size: number,
  cx: number,
  cy: number,
): { die: Container; pipsContainer: Container } {
  const iso = Math.round(size * 0.28);
  const die = new Container();

  const front = new Graphics();
  front.roundRect(0, 10, size, size, 6);
  front.fill({ color: 0x141018 });
  front.stroke({ color: 0x2a2a3a, width: 1.5 });
  die.addChild(front);

  const right = new Graphics();
  right.moveTo(size, 10);
  right.lineTo(size + iso, 10 - iso * 0.5);
  right.lineTo(size + iso, size + 10 - iso * 0.5);
  right.lineTo(size, size + 10);
  right.closePath();
  right.fill({ color: 0x0e0a12 });
  right.stroke({ color: 0x1e1e30, width: 1 });
  die.addChild(right);

  const top = new Graphics();
  top.moveTo(0, 10);
  top.lineTo(iso, 10 - iso * 0.5);
  top.lineTo(size + iso, 10 - iso * 0.5);
  top.lineTo(size, 10);
  top.closePath();
  top.fill({ color: 0x1c1828 });
  top.stroke({ color: 0x2a2a40, width: 1 });
  die.addChild(top);

  const ring = new Graphics();
  ring.roundRect(-2, 8, size + 4, size + 4, 8);
  ring.stroke({ color: 0xc9a84c, width: 2, alpha: 0.3 });
  die.addChild(ring);

  const pipsContainer = new Container();
  pipsContainer.label = 'pips';
  die.addChild(pipsContainer);

  die.pivot.set(size * 0.5 + iso * 0.5, size * 0.5 + 5);
  die.x = cx;
  die.y = cy;

  return { die, pipsContainer };
}

/**
 * Draws pip dots on all three visible faces of the isometric die.
 * Front shows the actual value; top + right show deterministic neighbor
 * values (FACE_NEIGHBORS) projected onto their parallelogram faces, so the
 * die reads as a real 3D object. All pips live in the same container —
 * they appear and disappear together, so there are no sudden swaps.
 *
 * Pip shape on the top + right faces is an ellipse whose minor axis is
 * foreshortened along that face's depth direction. The depth axis of either
 * face projects to a screen vector V = (±iso, ∓iso/2) of length iso·√1.25,
 * so a true circle on the face plane becomes an ellipse roughly 0.31× the
 * size of the equivalent front-face pip in the depth direction.
 */
export function drawPips(pipsContainer: Container, value: number, dieSize: number): void {
  pipsContainer.removeChildren();

  const iso = Math.round(dieSize * 0.28);

  drawFacePips(pipsContainer, value, dieSize, 'front', iso);

  const neighbors = FACE_NEIGHBORS[value];
  if (neighbors) {
    drawFacePips(pipsContainer, neighbors.top, dieSize, 'top', iso);
    drawFacePips(pipsContainer, neighbors.right, dieSize, 'right', iso);
  }
}

function drawFacePips(
  container: Container,
  value: number,
  dieSize: number,
  face: FaceSide,
  iso: number,
): void {
  const positions = getPipPositions(value);
  const isLow = LOW_FACES.includes(value);
  const ringColor = isLow ? 0x4ab3f4 : 0xf4844a;
  const dotColor = isLow ? 0x6cc8ff : 0xff9e6c;

  const { rx, ry } = computePipAxes(value, dieSize, iso, face, positions);
  const alpha = face === 'front' ? 1.0 : 0.78;
  const ringWidth = Math.max(face === 'front' ? 1.4 : 0.85, Math.min(rx, ry) * 0.34);

  for (const [fx, fy] of positions) {
    const [cx, cy] = mapToFace(fx, fy, face, dieSize, iso);

    const ring = new Graphics();
    if (face === 'front') {
      ring.circle(cx, cy, rx);
    } else {
      ring.ellipse(cx, cy, rx, ry);
    }
    ring.stroke({ color: ringColor, width: ringWidth, alpha });
    container.addChild(ring);

    const dot = new Graphics();
    if (face === 'front') {
      dot.circle(cx, cy, rx * 0.45);
    } else {
      dot.ellipse(cx, cy, rx * 0.45, ry * 0.45);
    }
    dot.fill({ color: dotColor, alpha });
    container.addChild(dot);
  }
}

/**
 * Returns the (rx, ry) ellipse semi-axes for a single pip on the given face.
 *
 *  - Front face: a true circle (rx == ry) sized by `frontPipRadius`.
 *  - Top face:   horizontal axis ≈ front-radius, vertical axis foreshortened
 *                to fit the pattern's depth-direction (fy) gap in screen px.
 *  - Right face: vertical axis ≈ front-radius, horizontal axis foreshortened
 *                to fit the pattern's depth-direction (fx) gap in screen px.
 *
 * Sizing is derived from the pattern's actual minimum gap on each axis (via
 * `patternMinGap`), so it scales correctly for every value 3 → 18 without a
 * per-value lookup table.
 */
function computePipAxes(
  value: number,
  dieSize: number,
  iso: number,
  face: FaceSide,
  positions: [number, number][],
): { rx: number; ry: number } {
  const frontR = frontPipRadius(value, dieSize);
  if (face === 'front') return { rx: frontR, ry: frontR };

  /* Visible length of the depth axis V = (±iso, ∓iso/2) in screen pixels. */
  const depthLen = iso * Math.sqrt(1.25);
  const fxGap = patternMinGap(positions, 0);
  const fyGap = patternMinGap(positions, 1);

  if (face === 'top') {
    /* fx → width (dieSize), fy → depth.
     * The front edge of the top face is a horizontal line at y=10, so the
     * relevant margin before the pip overflows is the Y-component of the
     * depth vector: fyGap × (iso/2).  Using the full depth-vector length
     * (depthLen = iso√1.25) would make ry ~13% larger than the available
     * y-margin, causing all pip rows to clip past the front edge. */
    const widthR = Math.min(frontR, fxGap * dieSize * 0.4);
    const depthR = Math.max(0.9, fyGap * (iso * 0.5) * 0.7);
    return { rx: widthR, ry: depthR };
  }

  /* right: fx → depth (depthLen), fy → vertical (dieSize) */
  const depthR = Math.max(1.4, fxGap * depthLen * 0.4);
  const widthR = Math.min(frontR, fyGap * dieSize * 0.4);
  return { rx: depthR, ry: widthR };
}

function frontPipRadius(value: number, dieSize: number): number {
  if (value <= 3) return dieSize * 0.09;
  if (value <= 6) return dieSize * 0.075;
  if (value <= 9) return dieSize * 0.065;
  if (value <= 12) return dieSize * 0.055;
  return dieSize * 0.048;
}

/** Smallest gap (in unit coords) along the given axis: distance from the
 *  face edge to the first/last pip, or between any two adjacent pip centres. */
function patternMinGap(positions: [number, number][], axis: 0 | 1): number {
  const coords = Array.from(new Set(positions.map((p) => p[axis]))).sort((a, b) => a - b);
  let min = coords[0];
  min = Math.min(min, 1 - coords[coords.length - 1]);
  for (let i = 1; i < coords.length; i++) {
    min = Math.min(min, coords[i] - coords[i - 1]);
  }
  return min;
}

/** Map (fx, fy) in face-local unit coords [0,1] onto the chosen face's
 *  parallelogram. The same affine the face polygons are drawn with. */
function mapToFace(
  fx: number,
  fy: number,
  face: FaceSide,
  dieSize: number,
  iso: number,
): [number, number] {
  switch (face) {
    case 'front':
      return [fx * dieSize, fy * dieSize + 10];
    case 'top':
      /* fy=0 maps to the back edge, fy=1 to the front edge of the top face. */
      return [(1 - fy) * iso + fx * dieSize, 10 - (1 - fy) * iso * 0.5];
    case 'right':
      /* fx=0 maps to the front (viewer) edge, fx=1 to the back edge. */
      return [dieSize + fx * iso, 10 + fy * dieSize - fx * iso * 0.5];
  }
}
