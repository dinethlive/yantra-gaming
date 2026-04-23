import gsap from 'gsap';
import { type Container, Graphics } from 'pixi.js';

interface Particle {
  graphic: Graphics;
  active: boolean;
}

/**
 * Simple object-pooled particle system using PixiJS Graphics.
 * Provides impact debris, win sparkles, and ambient dust.
 */
export class ParticleSystem {
  private container: Container;
  private pool: Particle[] = [];
  private poolSize: number;

  constructor(container: Container, poolSize: number = 100) {
    this.container = container;
    this.poolSize = poolSize;
    this.initPool();
  }

  private initPool(): void {
    for (let i = 0; i < this.poolSize; i++) {
      const g = new Graphics();
      g.circle(0, 0, 3);
      g.fill({ color: 0xffffff });
      g.visible = false;
      this.container.addChild(g);
      this.pool.push({ graphic: g, active: false });
    }
  }

  private acquire(): Particle | null {
    const p = this.pool.find((p) => !p.active);
    if (!p) return null;
    p.active = true;
    p.graphic.visible = true;
    return p;
  }

  private release(particle: Particle): void {
    particle.active = false;
    particle.graphic.visible = false;
    particle.graphic.alpha = 1;
    particle.graphic.scale.set(1);
  }

  /** Impact debris burst — small dark chunks flying from a point */
  burstImpact(x: number, y: number, count: number = 15): void {
    for (let i = 0; i < count; i++) {
      const p = this.acquire();
      if (!p) break;

      const g = p.graphic;
      g.clear();
      const size = 1.5 + Math.random() * 3;
      g.rect(-size / 2, -size / 2, size, size);

      /* brownish debris colors */
      const colors = [0x3a2a1a, 0x4a3a2a, 0x2a2018, 0x5a4a3a, 0x1a1410];
      g.fill({ color: colors[Math.floor(Math.random() * colors.length)] });

      g.x = x;
      g.y = y;
      g.alpha = 0.8;
      g.rotation = Math.random() * Math.PI * 2;

      const angle = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 100;
      const dx = Math.cos(angle) * speed;
      const dy = Math.sin(angle) * speed + 30; /* gravity bias downward */

      gsap.to(g, {
        x: x + dx,
        y: y + dy,
        alpha: 0,
        rotation: g.rotation + (Math.random() - 0.5) * 4,
        duration: 0.4 + Math.random() * 0.4,
        ease: 'power2.out',
        onComplete: () => this.release(p),
      });
    }
  }

  /** Win burst — gold sparkles radiating from center */
  burstWin(x: number, y: number, count: number = 25): void {
    for (let i = 0; i < count; i++) {
      const p = this.acquire();
      if (!p) break;

      const g = p.graphic;
      g.clear();

      /* star-like shape for sparkle */
      const size = 2 + Math.random() * 4;
      g.circle(0, 0, size);

      const goldColors = [0xc9a84c, 0xe8c96a, 0xffd866, 0xffe4a0];
      g.fill({ color: goldColors[Math.floor(Math.random() * goldColors.length)] });

      g.x = x;
      g.y = y;
      g.alpha = 1;
      g.scale.set(0.5);

      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
      const speed = 60 + Math.random() * 140;
      const dx = Math.cos(angle) * speed;
      const dy = Math.sin(angle) * speed;

      gsap.to(g, {
        x: x + dx,
        y: y + dy,
        alpha: 0,
        duration: 0.6 + Math.random() * 0.6,
        ease: 'power2.out',
      });

      gsap.to(g.scale, {
        x: 1.5 + Math.random(),
        y: 1.5 + Math.random(),
        duration: 0.3,
        yoyo: true,
        repeat: 1,
        ease: 'sine.inOut',
        onComplete: () => this.release(p),
      });
    }
  }

  /** Single ambient dust particle (used externally if needed) */
  spawnDust(x: number, y: number): void {
    const p = this.acquire();
    if (!p) return;

    const g = p.graphic;
    g.clear();
    g.circle(0, 0, 1 + Math.random() * 1.5);
    g.fill({ color: 0xffd866, alpha: 0.1 });

    g.x = x;
    g.y = y;
    g.alpha = 0.1;

    gsap.to(g, {
      x: x + (Math.random() - 0.5) * 60,
      y: y - 20 - Math.random() * 40,
      alpha: 0,
      duration: 3 + Math.random() * 4,
      ease: 'none',
      onComplete: () => this.release(p),
    });
  }

  destroy(): void {
    for (const p of this.pool) {
      gsap.killTweensOf(p.graphic);
      gsap.killTweensOf(p.graphic.scale);
    }
    this.pool = [];
  }
}
