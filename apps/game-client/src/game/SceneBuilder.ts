import gsap from 'gsap';
import { Container, Graphics } from 'pixi.js';
import type { GameApp } from './GameApp';

/**
 * Procedurally builds a premium atmospheric scene.
 * Dark brick wall with warm overhead lighting, worn stone floor.
 * Rebuilds on resize for full responsiveness.
 */
export class SceneBuilder {
  private gameApp: GameApp;
  private bulb: Container | null = null;
  private dustParticles: Graphics[] = [];
  private animationTimeline: gsap.core.Timeline | null = null;
  private dustTweens: gsap.core.Tween[] = [];

  constructor(gameApp: GameApp) {
    this.gameApp = gameApp;
  }

  build(): void {
    this.rebuild();

    /* Rebuild scene when canvas resizes */
    this.gameApp.onResize(() => this.rebuild());
  }

  private rebuild(): void {
    this.cleanup();

    const w = this.gameApp.width;
    const h = this.gameApp.height;
    const bg = this.gameApp.layers.background;

    this.drawBackground(bg, w, h);
    this.drawBrickWall(bg, w, h);
    this.drawFloor(bg, w, h);
    this.drawWallFloorEdge(bg, w, h);
    this.drawLighting(bg, w, h);
    this.spawnAmbientDust(w, h);
  }

  /** Deep dark background base */
  private drawBackground(parent: Container, w: number, h: number): void {
    const g = new Graphics();
    g.rect(0, 0, w, h);
    g.fill({ color: 0x05050a });
    parent.addChild(g);
  }

  /** Realistic dark brick wall — upper 58% */
  private drawBrickWall(parent: Container, w: number, h: number): void {
    const wallH = h * 0.58;
    const container = new Container();

    /* Wall base — warm dark brown */
    const base = new Graphics();
    base.rect(0, 0, w, wallH);
    base.fill({ color: 0x1c1410 });
    container.addChild(base);

    /* Scale brick size to canvas — target ~25 bricks wide */
    const brickW = Math.max(36, Math.round(w / 25));
    const brickH = Math.round(brickW * 0.44);
    const gap = Math.max(2, Math.round(brickW * 0.06));

    /* Brick palette — earthy reds/browns like a real worn wall */
    const brickPalette = [
      0x2a1a12, 0x301e14, 0x261610, 0x321f15, 0x281812, 0x2e1c13, 0x241510, 0x34211a, 0x201210,
      0x2c1a14,
    ];

    for (let row = 0; row * (brickH + gap) < wallH; row++) {
      const offsetX = row % 2 === 0 ? 0 : brickW * 0.5;
      for (let col = -1; col * (brickW + gap) < w + brickW; col++) {
        const x = col * (brickW + gap) + offsetX;
        const y = row * (brickH + gap);

        const brick = new Graphics();
        const baseColor = brickPalette[Math.floor(Math.random() * brickPalette.length)];

        /* Per-brick brightness variation */
        const brightness = 0.85 + Math.random() * 0.3;
        const r = Math.min(255, Math.floor(((baseColor >> 16) & 0xff) * brightness));
        const gv = Math.min(255, Math.floor(((baseColor >> 8) & 0xff) * brightness));
        const b = Math.min(255, Math.floor((baseColor & 0xff) * brightness));
        const color = (r << 16) | (gv << 8) | b;

        brick.roundRect(x, y, brickW, brickH, 1);
        brick.fill({ color, alpha: 0.7 + Math.random() * 0.3 });
        container.addChild(brick);
      }
    }

    /* Mortar lines — slightly lighter than base */
    const mortar = new Graphics();
    mortar.rect(0, 0, w, wallH);
    mortar.fill({ color: 0x110e0a, alpha: 0.15 });
    container.addChild(mortar);

    /* Weathering/grime — irregular dark patches */
    const grime = new Graphics();
    const grimeCount = Math.max(15, Math.round((w * h) / 20000));
    for (let i = 0; i < grimeCount; i++) {
      const gx = Math.random() * w;
      const gy = Math.random() * wallH;
      const gr = 15 + Math.random() * (w * 0.06);
      grime.circle(gx, gy, gr);
      grime.fill({ color: 0x000000, alpha: 0.04 + Math.random() * 0.08 });
    }
    container.addChild(grime);

    /* Water stain streaks — subtle vertical lines */
    for (let i = 0; i < 4; i++) {
      const stain = new Graphics();
      const sx = w * 0.15 + Math.random() * w * 0.7;
      const sy = Math.random() * wallH * 0.3;
      const sh = wallH * 0.3 + Math.random() * wallH * 0.5;
      stain.rect(sx, sy, 2 + Math.random() * 4, sh);
      stain.fill({ color: 0x0a0806, alpha: 0.06 + Math.random() * 0.06 });
      container.addChild(stain);
    }

    parent.addChild(container);
  }

  /** Worn stone/concrete floor — lower 42% */
  private drawFloor(parent: Container, w: number, h: number): void {
    const floorY = h * 0.58;
    const floorH = h * 0.42;
    const container = new Container();
    container.y = floorY;

    /* Floor base — dark cool stone */
    const base = new Graphics();
    base.rect(0, 0, w, floorH);
    base.fill({ color: 0x12100e });
    container.addChild(base);

    /* Perspective: floor gets slightly lighter toward the bottom (closer to viewer) */
    const near = new Graphics();
    near.rect(0, floorH * 0.5, w, floorH * 0.5);
    near.fill({ color: 0x1a1816, alpha: 0.25 });
    container.addChild(near);

    /* Stone tile pattern */
    const tileW = Math.max(60, Math.round(w / 10));
    const tileH = Math.max(40, Math.round(tileW * 0.65));
    const tileGap = 2;

    for (let row = 0; row * (tileH + tileGap) < floorH; row++) {
      const offsetX = row % 2 === 0 ? 0 : tileW * 0.5;
      for (let col = -1; col * (tileW + tileGap) < w + tileW; col++) {
        const x = col * (tileW + tileGap) + offsetX;
        const y = row * (tileH + tileGap);

        const variation = 0.9 + Math.random() * 0.2;
        const rv = Math.floor(0x14 * variation);
        const gv = Math.floor(0x12 * variation);
        const bv = Math.floor(0x10 * variation);
        const color = (rv << 16) | (gv << 8) | bv;

        const tile = new Graphics();
        tile.roundRect(x, y, tileW, tileH, 1);
        tile.fill({ color, alpha: 0.3 + Math.random() * 0.15 });
        container.addChild(tile);
      }
    }

    /* Scuff marks and wear */
    const scuffCount = Math.max(8, Math.round(w / 80));
    for (let i = 0; i < scuffCount; i++) {
      const scuff = new Graphics();
      const sx = Math.random() * w;
      const sy = Math.random() * floorH;
      const sw = 20 + Math.random() * 60;
      const sh = 4 + Math.random() * 12;
      scuff.roundRect(sx, sy, sw, sh, 2);
      scuff.fill({ color: 0x0a0908, alpha: 0.1 + Math.random() * 0.15 });
      container.addChild(scuff);
    }

    parent.addChild(container);
  }

  /** Shadow line where wall meets floor */
  private drawWallFloorEdge(parent: Container, w: number, h: number): void {
    const edgeY = h * 0.58;

    /* Dark shadow line */
    const shadow = new Graphics();
    shadow.rect(0, edgeY - 2, w, 6);
    shadow.fill({ color: 0x000000, alpha: 0.4 });
    parent.addChild(shadow);

    /* Subtle baseboard highlight */
    const highlight = new Graphics();
    highlight.rect(0, edgeY - 1, w, 1);
    highlight.fill({ color: 0x2a2420, alpha: 0.3 });
    parent.addChild(highlight);
  }

  /** Overhead warm lighting — hanging bulb with cone of light */
  private drawLighting(parent: Container, w: number, h: number): void {
    const bulbContainer = new Container();
    bulbContainer.x = w * 0.5;
    bulbContainer.y = 0;
    bulbContainer.pivot.set(0, 0);

    /* Wire */
    const wire = new Graphics();
    wire.moveTo(0, 0);
    wire.lineTo(0, Math.min(55, h * 0.08));
    wire.stroke({ color: 0x2a2a2a, width: 2 });
    bulbContainer.addChild(wire);

    /* Bulb fitting */
    const fitting = new Graphics();
    const bulbY = Math.min(55, h * 0.08);
    fitting.rect(-4, bulbY - 4, 8, 8);
    fitting.fill({ color: 0x3a3430 });
    bulbContainer.addChild(fitting);

    /* Warm bulb */
    const bulb = new Graphics();
    bulb.circle(0, bulbY + 8, 6);
    bulb.fill({ color: 0xffe0a0, alpha: 0.95 });
    bulbContainer.addChild(bulb);

    /* Inner glow — small hot white */
    const core = new Graphics();
    core.circle(0, bulbY + 8, 3);
    core.fill({ color: 0xffffff, alpha: 0.2 });
    bulbContainer.addChild(core);

    /* Concentric warm halos — scaled to canvas */
    const halos = [
      { radius: w * 0.04, alpha: 0.08 },
      { radius: w * 0.1, alpha: 0.04 },
      { radius: w * 0.22, alpha: 0.02 },
      { radius: w * 0.4, alpha: 0.008 },
    ];

    for (const halo of halos) {
      const g = new Graphics();
      g.circle(0, bulbY + 8, halo.radius);
      g.fill({ color: 0xffd866, alpha: halo.alpha });
      bulbContainer.addChild(g);
    }

    /* Light cone — warm trapezoid from bulb to floor */
    const coneSpread = w * 0.3;
    const cone = new Graphics();
    cone.moveTo(-6, bulbY + 14);
    cone.lineTo(-coneSpread, h * 0.92);
    cone.lineTo(coneSpread, h * 0.92);
    cone.lineTo(6, bulbY + 14);
    cone.closePath();
    cone.fill({ color: 0xffd866, alpha: 0.015 });
    bulbContainer.addChild(cone);

    /* Floor light pool — warm glow on the floor surface */
    const pool = new Graphics();
    const poolW = w * 0.5;
    const poolH = h * 0.12;
    pool.ellipse(0, h * 0.68, poolW, poolH);
    pool.fill({ color: 0xffd866, alpha: 0.018 });
    bulbContainer.addChild(pool);

    /* Wall light wash — warm glow on wall behind bulb */
    const wallWash = new Graphics();
    wallWash.circle(0, h * 0.3, w * 0.25);
    wallWash.fill({ color: 0xffe0a0, alpha: 0.012 });
    bulbContainer.addChild(wallWash);

    parent.addChild(bulbContainer);
    this.bulb = bulbContainer;

    /* Subtle sway animation */
    this.animationTimeline = gsap.timeline({ repeat: -1, yoyo: true });
    this.animationTimeline.to(bulbContainer, {
      rotation: 0.02,
      duration: 3,
      ease: 'sine.inOut',
    });
    this.animationTimeline.to(bulbContainer, {
      rotation: -0.02,
      duration: 3,
      ease: 'sine.inOut',
    });
  }

  /** Ambient floating dust in warm light */
  private spawnAmbientDust(w: number, h: number): void {
    const particles = this.gameApp.layers.particles;
    const count = Math.max(12, Math.round((w * h) / 40000));

    for (let i = 0; i < count; i++) {
      const dust = new Graphics();
      const size = 0.8 + Math.random() * 1.8;
      dust.circle(0, 0, size);
      dust.fill({ color: 0xffd866, alpha: 0.06 + Math.random() * 0.1 });
      dust.x = Math.random() * w;
      dust.y = h * 0.15 + Math.random() * h * 0.6;
      particles.addChild(dust);
      this.dustParticles.push(dust);

      const tween = gsap.to(dust, {
        x: dust.x + (Math.random() - 0.5) * 80,
        y: dust.y - 20 - Math.random() * 50,
        alpha: 0,
        duration: 5 + Math.random() * 7,
        ease: 'none',
        repeat: -1,
        onRepeat: () => {
          dust.x = Math.random() * w;
          dust.y = h * 0.25 + Math.random() * h * 0.55;
          dust.alpha = 0.06 + Math.random() * 0.1;
        },
      });
      this.dustTweens.push(tween);
    }
  }

  /** Clean up all graphics and animations */
  private cleanup(): void {
    if (this.animationTimeline) {
      this.animationTimeline.kill();
      this.animationTimeline = null;
    }
    for (const t of this.dustTweens) t.kill();
    this.dustTweens = [];
    this.dustParticles = [];
    this.bulb = null;

    /* Remove all children from background layer */
    this.gameApp.layers.background.removeChildren();

    /* Remove dust particles from particles layer (keep pooled particles) */
    for (const dust of this.dustParticles) {
      if (dust.parent) dust.parent.removeChild(dust);
    }
  }

  destroy(): void {
    this.cleanup();
  }
}
