import { Container, Graphics } from 'pixi.js';

/**
 * Builds a procedural hand graphic for the dice throw animation.
 * Returns a Container with alpha=0 (caller animates it in).
 */
export function createHand(dieSize: number): Container {
  const s = dieSize;
  const hand = new Container();

  /* ── Proportions ── */
  const palmW = s * 0.95;
  const palmH = s * 0.48;

  /* Finger defs: x-offset (fraction of palmW from center), length, base width, tip width */
  const fingers = [
    { ox: -0.29, len: s * 0.52, bw: palmW * 0.19, tw: palmW * 0.145 }, // index
    { ox: -0.1, len: s * 0.62, bw: palmW * 0.2, tw: palmW * 0.155 }, // middle
    { ox: 0.1, len: s * 0.57, bw: palmW * 0.19, tw: palmW * 0.145 }, // ring
    { ox: 0.28, len: s * 0.43, bw: palmW * 0.17, tw: palmW * 0.125 }, // pinky
  ];

  /* ── Colors (warm casino lighting) ── */
  const SKIN = 0xd4a574;
  const SKIN_LIT = 0xf1c27d;
  const SKIN_DARK = 0x8d5524;
  const SKIN_DEEP = 0x6b3a20;
  const CREASE = 0x8b4513;
  const NAIL = 0xe8c4b0;
  const NAIL_HI = 0xffe0cc;

  /* ── Path helpers ── */
  const drawFinger = (g: Graphics, cx: number, fh: number, bw: number, tw: number) => {
    const b = bw * 0.08;
    g.moveTo(cx - bw / 2, 0);
    g.bezierCurveTo(
      cx - bw / 2 - b,
      -fh * 0.33,
      cx - tw / 2 - b * 0.5,
      -fh * 0.67,
      cx - tw / 2,
      -fh,
    );
    g.quadraticCurveTo(cx, -fh - tw * 0.38, cx + tw / 2, -fh);
    g.bezierCurveTo(cx + tw / 2 + b * 0.5, -fh * 0.67, cx + bw / 2 + b, -fh * 0.33, cx + bw / 2, 0);
    g.closePath();
  };

  const drawPalm = (g: Graphics) => {
    const hw = palmW / 2;
    const r = s * 0.04;
    g.moveTo(-hw * 0.92, 0);
    g.bezierCurveTo(-hw - 1, palmH * 0.25, -hw, palmH * 0.6, -hw + r, palmH);
    g.quadraticCurveTo(-hw * 0.2, palmH + r, 0, palmH + r * 0.5);
    g.quadraticCurveTo(hw * 0.2, palmH + r, hw - r, palmH);
    g.bezierCurveTo(hw, palmH * 0.6, hw + 1, palmH * 0.25, hw * 0.92, 0);
    g.closePath();
  };

  const drawThumb = (g: Graphics) => {
    const tw = palmW * 0.19;
    const th = palmH * 0.72;
    const tx = -palmW / 2 - tw * 0.35;
    const ty = palmH * 0.12;
    g.moveTo(tx + tw * 0.5, ty);
    g.bezierCurveTo(
      tx - tw * 0.05,
      ty + th * 0.35,
      tx - tw * 0.1,
      ty + th * 0.65,
      tx + tw * 0.15,
      ty + th,
    );
    g.quadraticCurveTo(tx + tw * 0.5, ty + th + tw * 0.28, tx + tw * 0.85, ty + th);
    g.bezierCurveTo(
      tx + tw * 1.05,
      ty + th * 0.55,
      tx + tw * 0.9,
      ty + th * 0.15,
      tx + tw * 0.5,
      ty,
    );
    g.closePath();
  };

  /* ═══ Layer 1: Drop shadow ═══ */
  const shadowG = new Graphics();
  const sh = s * 0.035;
  shadowG.x = sh;
  shadowG.y = sh;
  drawPalm(shadowG);
  shadowG.fill({ color: 0x000000, alpha: 0.3 });
  for (const f of fingers) {
    drawFinger(shadowG, f.ox * palmW, f.len, f.bw, f.tw);
    shadowG.fill({ color: 0x000000, alpha: 0.25 });
  }
  drawThumb(shadowG);
  shadowG.fill({ color: 0x000000, alpha: 0.22 });
  hand.addChild(shadowG);

  /* ═══ Layer 2: Dark edge outline (slightly thicker) ═══ */
  const edgeG = new Graphics();
  drawPalm(edgeG);
  edgeG.stroke({ color: SKIN_DEEP, width: 3 });
  for (const f of fingers) {
    drawFinger(edgeG, f.ox * palmW, f.len, f.bw, f.tw);
    edgeG.stroke({ color: SKIN_DEEP, width: 2.5 });
  }
  drawThumb(edgeG);
  edgeG.stroke({ color: SKIN_DEEP, width: 2.5 });
  hand.addChild(edgeG);

  /* ═══ Layer 3: Base skin fill ═══ */
  const skinG = new Graphics();
  drawPalm(skinG);
  skinG.fill({ color: SKIN });
  skinG.stroke({ color: SKIN_DARK, width: 1.2 });
  for (const f of fingers) {
    drawFinger(skinG, f.ox * palmW, f.len, f.bw, f.tw);
    skinG.fill({ color: SKIN });
    skinG.stroke({ color: SKIN_DARK, width: 1.0 });
  }
  drawThumb(skinG);
  skinG.fill({ color: SKIN });
  skinG.stroke({ color: SKIN_DARK, width: 1.0 });
  hand.addChild(skinG);

  /* ═══ Layer 4: Center highlights (cylindrical 3D look) ═══ */
  const hiG = new Graphics();
  for (const f of fingers) {
    const cx = f.ox * palmW;
    const sw = f.tw * 0.35;
    hiG.moveTo(cx, -2);
    hiG.bezierCurveTo(cx - sw * 0.15, -f.len * 0.33, cx + sw * 0.15, -f.len * 0.67, cx, -f.len + 5);
    hiG.stroke({ color: SKIN_LIT, width: sw, alpha: 0.3 });
  }
  hiG.ellipse(0, palmH * 0.45, palmW * 0.18, palmH * 0.2);
  hiG.fill({ color: SKIN_LIT, alpha: 0.2 });
  hand.addChild(hiG);

  /* ═══ Layer 5: Crease details ═══ */
  const crG = new Graphics();
  for (const f of fingers) {
    const cx = f.ox * palmW;
    const jw = f.bw * 0.65;
    for (const jFrac of [0.32, 0.58]) {
      const jy = -f.len * jFrac;
      crG.moveTo(cx - jw / 2, jy);
      crG.quadraticCurveTo(cx, jy + 1.5, cx + jw / 2, jy);
      crG.stroke({ color: CREASE, width: 0.7, alpha: 0.3 });
    }
  }
  /* Palm lines */
  crG.moveTo(-palmW * 0.33, palmH * 0.22);
  crG.bezierCurveTo(
    -palmW * 0.08,
    palmH * 0.32,
    palmW * 0.05,
    palmH * 0.28,
    palmW * 0.28,
    palmH * 0.18,
  );
  crG.stroke({ color: CREASE, width: 0.7, alpha: 0.25 });
  crG.moveTo(-palmW * 0.38, palmH * 0.48);
  crG.bezierCurveTo(
    -palmW * 0.12,
    palmH * 0.58,
    palmW * 0.08,
    palmH * 0.53,
    palmW * 0.32,
    palmH * 0.42,
  );
  crG.stroke({ color: CREASE, width: 0.6, alpha: 0.2 });
  hand.addChild(crG);

  /* ═══ Layer 6: Fingernails ═══ */
  const nG = new Graphics();
  for (const f of fingers) {
    const cx = f.ox * palmW;
    const nw = f.tw * 0.55;
    const nh = nw * 0.6;
    const ny = -f.len + 3;
    nG.roundRect(cx - nw / 2, ny, nw, nh, nw * 0.25);
    nG.fill({ color: NAIL, alpha: 0.65 });
    nG.arc(cx, ny + nh * 0.35, nw * 0.3, Math.PI, 0);
    nG.stroke({ color: NAIL_HI, width: 0.5, alpha: 0.45 });
  }
  hand.addChild(nG);

  hand.pivot.set(0, -palmH * 0.3);
  hand.alpha = 0;
  return hand;
}
