import gsap from 'gsap';
import { BlurFilter, type Container, Graphics } from 'pixi.js';
import { calcDieSize, createDieContainer, drawPips } from './DiceRenderer';
import type { DiceState } from './diceConstants';
import type { GameApp } from './GameApp';
import { createHand } from './HandBuilder';
import type { ParticleSystem } from './ParticleSystem';
import { pixiFadeIn } from './pixiTransitions';
import { SoundManager } from './SoundManager';

/**
 * Single die with premium hand-throw animation.
 * The throw animation and result reveal are DECOUPLED:
 *  - playRoll() does the physical throw (pips hidden throughout)
 *  - revealResult() shows the final face when server result arrives
 */
export class DiceManager {
  private gameApp: GameApp;
  private particles: ParticleSystem;
  private die: Container | null = null;
  private pipsContainer: Container | null = null;
  private diceState: DiceState = 'IDLE';
  private currentValue = 0;
  private rollTimeline: gsap.core.Timeline | null = null;
  private idleTween: gsap.core.Tween | null = null;
  private waitingTween: gsap.core.Tween | null = null;

  private get dieSize(): number {
    return calcDieSize(this.gameApp.width);
  }

  constructor(gameApp: GameApp, particles: ParticleSystem) {
    this.gameApp = gameApp;
    this.particles = particles;
  }

  init(): void {
    const w = this.gameApp.width;
    const h = this.gameApp.height;
    const { die, pipsContainer } = createDieContainer(this.dieSize, w * 0.5, h * 0.62);
    this.gameApp.layers.dice.addChild(die);
    this.die = die;
    this.pipsContainer = pipsContainer;
    drawPips(pipsContainer, 9, this.dieSize);
    this.startIdleAnimation();
  }

  /* ══════════════════════════════════════════════════════════════
     Idle / Waiting animations
     ══════════════════════════════════════════════════════════════ */

  private startIdleAnimation(): void {
    if (!this.die) return;
    this.idleTween = gsap.to(this.die, {
      y: this.die.y - 5,
      duration: 1.8,
      ease: 'sine.inOut',
      yoyo: true,
      repeat: -1,
    });
    this.diceState = 'IDLE';
  }

  private stopIdleAnimation(): void {
    if (this.idleTween) {
      this.idleTween.kill();
      this.idleTween = null;
    }
  }

  /** Subtle gold glow while waiting for server result — die stays completely still */
  private startWaitingGlow(): void {
    if (!this.die) return;
    this.diceState = 'WAITING';

    const glow = new Graphics();
    glow.circle(0, 0, this.dieSize * 0.65);
    glow.fill({ color: 0xc9a84c, alpha: 0 });
    glow.label = 'waitingGlow';
    this.die.addChild(glow);

    this.waitingTween = gsap.to(glow, {
      alpha: 0.12,
      duration: 0.6,
      yoyo: true,
      repeat: -1,
      ease: 'sine.inOut',
    });
  }

  private stopWaitingGlow(): void {
    if (this.waitingTween) {
      this.waitingTween.kill();
      this.waitingTween = null;
    }
    if (!this.die) return;
    const glow = this.die.children.find((c) => c.label === 'waitingGlow');
    if (glow) this.die.removeChild(glow);
  }

  /* ══════════════════════════════════════════════════════════════
     THROW ANIMATION (physical only — no face reveal)
     ══════════════════════════════════════════════════════════════ */

  async playRoll(): Promise<void> {
    if (!this.die || !this.pipsContainer) return;
    this.stopIdleAnimation();
    this.diceState = 'ROLLING';

    const w = this.gameApp.width;
    const h = this.gameApp.height;
    const die = this.die;
    const pips = this.pipsContainer;
    const diceLayer = this.gameApp.layers.dice;

    const settleX = w * 0.5;
    const settleY = h * 0.62;

    if (this.rollTimeline) this.rollTimeline.kill();
    const tl = gsap.timeline();
    this.rollTimeline = tl;

    /* ── Create hand ── */
    const hand = createHand(this.dieSize);
    hand.x = w * 0.72;
    hand.y = h * 0.92;
    hand.scale.set(0.8);
    diceLayer.addChild(hand);

    /* ── Phase 1: Hand appears, glides to die (0.00–0.40s) ── */
    tl.to(
      hand,
      {
        alpha: 0.92,
        x: die.x,
        y: die.y + this.dieSize * 0.3,
        scale: 1,
        duration: 0.4,
        ease: 'power2.out',
      },
      0,
    );

    /* ── Phase 2: Wind-back with anticipation (0.40–1.10s) ── */
    const throwX = w * 0.15;
    const throwY = h * 0.8;

    /* Slow draw-back */
    tl.to(
      die,
      {
        x: throwX,
        y: throwY,
        rotation: -0.3,
        scale: 0.82,
        duration: 0.55,
        ease: 'power1.in',
      },
      0.4,
    );
    tl.to(
      hand,
      {
        x: throwX,
        y: throwY + this.dieSize * 0.3,
        rotation: -0.35,
        duration: 0.55,
        ease: 'power1.in',
      },
      0.4,
    );

    /* Brief hold at peak (micro-pause for anticipation) */
    tl.to(die, { scale: 0.8, duration: 0.15, ease: 'sine.out' }, 0.95);

    /* ── Phase 3: Release — hand flicks forward (1.10s) ── */
    tl.to(
      hand,
      {
        x: w * 0.4,
        y: h * 0.6,
        rotation: 0.3,
        alpha: 0,
        duration: 0.2,
        ease: 'power3.out',
      },
      1.1,
    );
    tl.call(
      () => {
        diceLayer.removeChild(hand);
        hand.destroy();
      },
      [],
      1.35,
    );

    /* Hide pips, add blur at release */
    const blur = new BlurFilter({ strength: 0, quality: 2 });
    tl.add(gsap.to(pips, { alpha: 0, duration: 0.1, ease: 'power2.out' }), 1.0);
    tl.call(
      () => {
        pips.visible = false;
        pips.alpha = 1;
        die.filters = [blur];
        SoundManager.play('dice_roll');
      },
      [],
      1.1,
    );

    /* ── Phase 4: Arc flight to wall (1.10–2.00s) ── */
    const P0x = throwX,
      P0y = throwY;
    const P1x = w * 0.32,
      P1y = -h * 0.05; /* high arc apex */
    const P2x = w * 0.5 + (Math.random() - 0.5) * 30;
    const P2y = h * 0.26; /* wall impact zone */
    const flightDur = 0.9;

    const arc = { t: 0 };
    tl.to(
      arc,
      {
        t: 1,
        duration: flightDur,
        ease: 'none',
        onUpdate: () => {
          const t = arc.t,
            mt = 1 - t;
          die.x = mt * mt * P0x + 2 * mt * t * P1x + t * t * P2x;
          die.y = mt * mt * P0y + 2 * mt * t * P1y + t * t * P2y;
        },
      },
      1.1,
    );

    /* Tumble: scale oscillations (more cycles over longer flight) */
    const tumbleDur = flightDur / 10;
    tl.to(
      die.scale,
      { x: 0.7, duration: tumbleDur, yoyo: true, repeat: 9, ease: 'sine.inOut' },
      1.1,
    );
    tl.to(
      die.scale,
      { y: 1.15, duration: tumbleDur, yoyo: true, repeat: 9, ease: 'sine.inOut' },
      1.1,
    );

    /* Rotation: multiple full spins */
    tl.to(die, { rotation: Math.PI * 3, duration: flightDur, ease: 'power1.out' }, 1.1);

    /* Blur: ramp up then ease off toward impact */
    tl.to(blur, { strength: 8, duration: flightDur * 0.35, ease: 'sine.in' }, 1.1);
    tl.to(
      blur,
      { strength: 3, duration: flightDur * 0.65, ease: 'sine.out' },
      1.1 + flightDur * 0.35,
    );

    /* Die grows slightly as it "approaches" the wall (perspective) */
    tl.to(die, { scale: 1.15, duration: flightDur, ease: 'power1.in' }, 1.1);

    /* ── Phase 5: Wall impact (2.00s) ── */
    const impactT = 1.1 + flightDur;
    tl.call(
      () => {
        this.diceState = 'IMPACT';
        die.filters = [];
        die.scale.set(1.12);

        this.particles.burstImpact(P2x, P2y, 25);
        SoundManager.play('impact');

        const stage = this.gameApp.app.stage;
        gsap.to(stage, {
          x: 7,
          duration: 0.03,
          yoyo: true,
          repeat: 6,
          onComplete: () => {
            stage.x = 0;
            stage.y = 0;
          },
        });
        gsap.to(stage, { y: 5, duration: 0.04, yoyo: true, repeat: 5 });
      },
      [],
      impactT,
    );

    /* ── Phase 6: Rebound off wall — die kicks back (2.00–2.30s) ── */
    const reboundX = P2x + (Math.random() - 0.5) * w * 0.12;
    const reboundY = h * 0.42;
    tl.to(
      die,
      {
        x: reboundX,
        y: reboundY,
        scale: 1.0,
        rotation: die.rotation + Math.PI * 0.6,
        duration: 0.35,
        ease: 'power2.out',
      },
      impactT + 0.05,
    );

    /* Small rebound tumble */
    tl.to(
      die.scale,
      {
        x: 0.85,
        duration: 0.08,
        yoyo: true,
        repeat: 1,
        ease: 'sine.inOut',
      },
      impactT + 0.05,
    );

    /* ── Phase 7: Fall to floor with gravity (2.35–2.90s) ── */
    const fallStart = impactT + 0.4;
    tl.to(
      die,
      {
        x: settleX + (Math.random() - 0.5) * 20,
        y: settleY,
        duration: 0.55,
        ease: 'power2.in' /* accelerating = gravity */,
      },
      fallStart,
    );
    tl.to(
      die,
      {
        rotation: die.rotation + Math.PI * 0.4,
        duration: 0.55,
        ease: 'power1.out',
      },
      fallStart,
    );

    /* ── Phase 8: Floor bounce — realistic multi-bounce (2.90–3.50s) ── */
    const bounceStart = fallStart + 0.55;

    /* First bounce — biggest */
    tl.to(
      die,
      {
        y: settleY - h * 0.06,
        scale: 1.04,
        duration: 0.15,
        ease: 'power2.out',
      },
      bounceStart,
    );
    tl.to(
      die,
      {
        y: settleY,
        scale: 1.0,
        duration: 0.15,
        ease: 'power2.in',
      },
      bounceStart + 0.15,
    );

    /* Second bounce — smaller */
    tl.to(
      die,
      {
        y: settleY - h * 0.025,
        duration: 0.12,
        ease: 'power2.out',
      },
      bounceStart + 0.3,
    );
    tl.to(
      die,
      {
        y: settleY,
        duration: 0.12,
        ease: 'power2.in',
      },
      bounceStart + 0.42,
    );

    /* Third bounce — tiny settle */
    tl.to(
      die,
      {
        y: settleY - h * 0.008,
        duration: 0.08,
        ease: 'sine.out',
      },
      bounceStart + 0.54,
    );
    tl.to(
      die,
      {
        y: settleY,
        rotation: (Math.random() - 0.5) * 0.12,
        scale: 1,
        duration: 0.08,
        ease: 'sine.in',
      },
      bounceStart + 0.62,
    );

    /* ── Phase 9: Die at rest — subtle glow while waiting for server result ── */
    const waitStart = bounceStart + 0.75;
    tl.call(
      () => {
        this.startWaitingGlow();
      },
      [],
      waitStart,
    );

    return new Promise((resolve) => {
      tl.eventCallback('onComplete', resolve);
    });
  }

  /* ══════════════════════════════════════════════════════════════
     RESULT REVEAL (called when server result arrives)
     ══════════════════════════════════════════════════════════════ */

  revealResult(
    value: number,
    winningSide: 'LOW' | 'HIGH',
    playerBetSide: 'LOW' | 'HIGH' | null,
  ): void {
    if (!this.die || !this.pipsContainer) return;

    this.stopWaitingGlow();

    /* If result arrived while still in throw animation, settle immediately */
    if (this.rollTimeline) {
      this.rollTimeline.kill();
      this.rollTimeline = null;
      this.die.filters = [];
      gsap.killTweensOf(this.die);
      gsap.killTweensOf(this.die.scale);
      gsap.to(this.die, {
        x: this.gameApp.width * 0.5,
        y: this.gameApp.height * 0.62,
        scale: 1,
        rotation: 0,
        duration: 0.3,
        ease: 'power2.out',
      });
    }

    this.diceState = 'SETTLE';
    this.currentValue = value;

    /* Show the final face directly — no cycling */
    drawPips(this.pipsContainer, value, this.dieSize);
    pixiFadeIn(this.pipsContainer, 0.2);

    /* White flash reveal */
    const flash = new Graphics();
    flash.circle(0, 0, this.dieSize * 0.6);
    flash.fill({ color: 0xffffff, alpha: 0 });
    flash.label = 'revealFlash';
    this.die.addChild(flash);

    gsap.to(flash, {
      alpha: 0.5,
      duration: 0.1,
      yoyo: true,
      repeat: 1,
      ease: 'sine.inOut',
      onComplete: () => {
        if (this.die) this.die.removeChild(flash);
      },
    });

    /* Scale punch */
    gsap.to(this.die.scale, {
      x: 1.08,
      y: 1.08,
      duration: 0.08,
      yoyo: true,
      repeat: 1,
      ease: 'power2.out',
    });

    /* Win/Lose effect after a beat — die stays showing result until next round */
    gsap.delayedCall(0.3, () => {
      if (playerBetSide === winningSide) {
        this.playWinGlow();
      } else if (playerBetSide !== null) {
        this.playLoseEffect();
      }
    });
  }

  /* ══════════════════════════════════════════════════════════════
     Win / Lose effects
     ══════════════════════════════════════════════════════════════ */

  private playWinGlow(): void {
    if (!this.die) return;
    this.diceState = 'WIN_GLOW';

    const glow = new Graphics();
    glow.circle(0, 0, this.dieSize * 0.8);
    glow.fill({ color: 0xc9a84c, alpha: 0 });
    glow.label = 'winGlow';
    this.die.addChild(glow);

    gsap.to(glow, {
      alpha: 0.25,
      duration: 0.4,
      yoyo: true,
      repeat: 3,
      ease: 'sine.inOut',
      onComplete: () => {
        if (this.die) this.die.removeChild(glow);
      },
    });

    this.particles.burstWin(this.gameApp.width * 0.5, this.gameApp.height * 0.62, 30);
  }

  private playLoseEffect(): void {
    if (!this.die) return;

    const flash = new Graphics();
    flash.circle(0, 0, this.dieSize * 0.8);
    flash.fill({ color: 0xf44a4a, alpha: 0 });
    flash.label = 'loseFlash';
    this.die.addChild(flash);

    gsap.to(flash, {
      alpha: 0.15,
      duration: 0.3,
      yoyo: true,
      repeat: 1,
      ease: 'sine.inOut',
      onComplete: () => {
        if (this.die) this.die.removeChild(flash);
      },
    });
  }

  /* ══════════════════════════════════════════════════════════════
     Reset / Reposition / Utility
     ══════════════════════════════════════════════════════════════ */

  resetToIdle(): void {
    if (!this.die) return;
    if (this.diceState === 'IDLE') return;

    this.stopWaitingGlow();

    /* Kill any active tweens on the die to prevent conflicts */
    gsap.killTweensOf(this.die);
    gsap.killTweensOf(this.die.scale);
    this.die.filters = [];

    /* Fade out leftover effect children (glow/flash) before removing */
    for (let i = this.die.children.length - 1; i >= 0; i--) {
      const c = this.die.children[i];
      if (c.label === 'winGlow' || c.label === 'loseFlash' || c.label === 'revealFlash') {
        gsap.killTweensOf(c);
        const die = this.die;
        gsap.to(c, {
          alpha: 0,
          duration: 0.2,
          ease: 'power2.in',
          onComplete: () => {
            if (die) die.removeChild(c);
          },
        });
      }
    }

    this.diceState = 'IDLE';
    gsap.to(this.die, {
      x: this.gameApp.width * 0.5,
      y: this.gameApp.height * 0.62,
      scale: 1,
      rotation: 0,
      duration: 0.6,
      ease: 'power2.out',
      onComplete: () => this.startIdleAnimation(),
    });
  }

  reposition(): void {
    if (!this.die || this.diceState !== 'IDLE') return;
    /* Kill any in-flight tweens (e.g. resetToIdle animation) to prevent
       the old tween from fighting the new position after a resize */
    gsap.killTweensOf(this.die);
    gsap.killTweensOf(this.die.scale);
    this.stopIdleAnimation();
    this.die.x = this.gameApp.width * 0.5;
    this.die.y = this.gameApp.height * 0.62;
    this.die.scale.set(1);
    this.die.rotation = 0;
    this.startIdleAnimation();
  }

  setValue(value: number): void {
    this.currentValue = value;
    if (this.pipsContainer) {
      drawPips(this.pipsContainer, value, this.dieSize);
      this.pipsContainer.visible = true;
    }
  }

  destroy(): void {
    this.stopIdleAnimation();
    this.stopWaitingGlow();
    if (this.rollTimeline) this.rollTimeline.kill();
    if (this.die) {
      this.die.filters = [];
      gsap.killTweensOf(this.die);
      gsap.killTweensOf(this.die.scale);
    }
  }
}
