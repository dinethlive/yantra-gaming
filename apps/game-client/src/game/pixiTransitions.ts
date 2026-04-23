import gsap from 'gsap';
import type { Container } from 'pixi.js';

/** Fade alpha → 0, then set visible = false. Returns a promise for chaining. */
export function pixiFadeOut(target: Container, duration = 0.25): Promise<void> {
  return new Promise((resolve) => {
    gsap.to(target, {
      alpha: 0,
      duration,
      ease: 'power2.out',
      onComplete: () => {
        target.visible = false;
        resolve();
      },
    });
  });
}

/** Set visible = true, alpha = 0, then fade alpha → 1. */
export function pixiFadeIn(target: Container, duration = 0.25): void {
  target.visible = true;
  target.alpha = 0;
  gsap.to(target, { alpha: 1, duration, ease: 'power2.out' });
}
