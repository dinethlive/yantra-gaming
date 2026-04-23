import gsap from 'gsap';
import { Container, Graphics, Text } from 'pixi.js';
import { type BetSide, type RoundState, useGameStore } from '../store/gameStore';
import type { GameApp } from './GameApp';
import { pixiFadeOut } from './pixiTransitions';

const GOLD = 0xc9a84c;
const GOLD_LIGHT = 0xe8d48b;
const LOW_COLOR = 0x4ab3f4;
const HIGH_COLOR = 0xf4844a;
const MUTED = 0x8a8a9a;

/**
 * On-canvas HUD that displays timer countdown and round result
 * above the dice. Renders into the GameApp `ui` layer.
 */
export class CanvasHUD {
  private gameApp: GameApp;
  private container: Container;
  private unsubscribe: (() => void) | null = null;

  /* ── Timer ── */
  private timerGroup: Container;
  private timerRingBg: Graphics;
  private timerRingFill: Graphics;
  private timerNumber: Text;

  /* ── State label (ROLLING / COOLDOWN) ── */
  private stateLabel: Text;

  /* ── Result ── */
  private resultGroup: Container;
  private resultPill: Graphics;
  private resultSideText: Text;
  private resultSum: Text;

  private prevState: RoundState = 'WAITING_FOR_BET';
  private ringRadius = 36;

  constructor(gameApp: GameApp) {
    this.gameApp = gameApp;
    this.container = new Container();
    this.container.label = 'canvasHUD';

    /* ── Timer group ── */
    this.timerGroup = new Container();
    this.timerGroup.visible = false;

    this.timerRingBg = new Graphics();
    this.timerRingFill = new Graphics();

    this.timerNumber = new Text({
      text: '',
      style: {
        fontFamily: '"Oswald", "Bebas Neue", sans-serif',
        fontSize: 42,
        fontWeight: 'bold',
        fill: GOLD_LIGHT,
      },
    });
    this.timerNumber.anchor.set(0.5);

    this.timerGroup.addChild(this.timerRingBg, this.timerRingFill, this.timerNumber);

    /* ── State label ── */
    this.stateLabel = new Text({
      text: '',
      style: {
        fontFamily: '"Oswald", "Bebas Neue", sans-serif',
        fontSize: 28,
        fontWeight: 'bold',
        fill: GOLD,
        letterSpacing: 4,
      },
    });
    this.stateLabel.anchor.set(0.5);
    this.stateLabel.visible = false;

    /* ── Result group ── */
    this.resultGroup = new Container();
    this.resultGroup.visible = false;

    this.resultPill = new Graphics();
    this.resultSideText = new Text({
      text: '',
      style: {
        fontFamily: '"Oswald", "Bebas Neue", sans-serif',
        fontSize: 20,
        fontWeight: 'bold',
        fill: 0xffffff,
        letterSpacing: 3,
      },
    });
    this.resultSideText.anchor.set(0.5);

    this.resultSum = new Text({
      text: '',
      style: {
        fontFamily: '"Oswald", "Bebas Neue", sans-serif',
        fontSize: 52,
        fontWeight: 'bold',
        fill: GOLD_LIGHT,
      },
    });
    this.resultSum.anchor.set(0.5);

    this.resultGroup.addChild(this.resultPill, this.resultSideText, this.resultSum);

    /* ── Assemble ── */
    this.container.addChild(this.timerGroup, this.stateLabel, this.resultGroup);
  }

  init(): void {
    this.gameApp.layers.ui.addChild(this.container);
    this.reposition();

    this.unsubscribe = useGameStore.subscribe((state) => {
      this.update(state);
    });

    /* Sync with current state */
    this.update(useGameStore.getState());
  }

  /* ══════════════════════════════════════════════════════════════
     Positioning — centers above the dice (which sits at y=0.62h)
     ══════════════════════════════════════════════════════════════ */

  reposition(): void {
    const w = this.gameApp.width;
    const h = this.gameApp.height;
    const cx = w * 0.5;
    const hudY = h * 0.28;

    /* Scale ring radius to canvas */
    this.ringRadius = Math.max(28, Math.min(44, w * 0.04));

    /* Timer */
    this.timerGroup.x = cx;
    this.timerGroup.y = hudY;
    this.drawTimerRingBg();

    /* State label */
    this.stateLabel.x = cx;
    this.stateLabel.y = hudY;
    this.stateLabel.style.fontSize = Math.max(20, Math.min(28, w * 0.025));

    /* Result */
    this.resultGroup.x = cx;
    this.resultGroup.y = hudY;

    /* Timer text size */
    this.timerNumber.style.fontSize = Math.max(28, Math.min(42, this.ringRadius * 1.1));

    /* Result text sizes */
    this.resultSideText.style.fontSize = Math.max(16, Math.min(22, w * 0.018));
    this.resultSum.style.fontSize = Math.max(36, Math.min(52, w * 0.045));
  }

  /* ══════════════════════════════════════════════════════════════
     State update — called on every store change
     ══════════════════════════════════════════════════════════════ */

  private update(state: ReturnType<typeof useGameStore.getState>): void {
    const { roundState, timeRemaining, bettingDuration, outcomeSide, outcomeSum } = state;

    /* Timer */
    if (roundState === 'BETTING_OPEN') {
      this.showTimer(timeRemaining, bettingDuration);
    } else if (this.timerGroup.visible && this.timerGroup.alpha > 0) {
      pixiFadeOut(this.timerGroup, 0.2);
    }

    /* State text */
    if (roundState === 'ROLLING') {
      this.showState('ROLLING', GOLD);
    } else if (roundState === 'COOLDOWN') {
      this.showState('NEXT ROUND', MUTED);
    } else if (this.stateLabel.visible && this.stateLabel.alpha > 0) {
      pixiFadeOut(this.stateLabel, 0.2);
    }

    /* Result */
    if (roundState === 'RESULT' && outcomeSum != null && outcomeSide != null) {
      this.showResult(outcomeSide, outcomeSum);
    } else if (roundState !== 'RESULT' && this.resultGroup.visible && this.resultGroup.alpha > 0) {
      pixiFadeOut(this.resultGroup, 0.25);
    }

    /* Transition animations */
    if (roundState !== this.prevState) {
      this.onTransition(this.prevState, roundState);
      this.prevState = roundState;
    }
  }

  /* ══════════════════════════════════════════════════════════════
     Timer — circular ring + large number
     ══════════════════════════════════════════════════════════════ */

  private drawTimerRingBg(): void {
    const g = this.timerRingBg;
    g.clear();
    g.circle(0, 0, this.ringRadius);
    g.stroke({ color: 0x2a2a3a, width: 4, alpha: 0.6 });
  }

  private drawTimerArc(progress: number): void {
    const g = this.timerRingFill;
    g.clear();
    if (progress <= 0) return;

    const r = this.ringRadius;
    const start = -Math.PI / 2;
    const end = start + Math.PI * 2 * Math.min(1, progress);

    g.arc(0, 0, r, start, end);
    g.stroke({ color: GOLD, width: 4 });
  }

  private showTimer(remaining: number, total: number): void {
    this.timerGroup.visible = true;
    const progress = total > 0 ? remaining / total : 0;
    this.drawTimerArc(progress);

    const display = Math.ceil(remaining);
    const newText = display > 0 ? String(display) : '0';
    if (this.timerNumber.text !== newText) {
      this.timerNumber.text = newText;
      gsap.fromTo(
        this.timerNumber.scale,
        { x: 1.15, y: 1.15 },
        { x: 1, y: 1, duration: 0.2, ease: 'power2.out' },
      );
    }

    /* Urgency color — red when <= 3s */
    if (remaining <= 3) {
      this.timerNumber.style.fill = 0xf44a4a;
      this.timerRingFill.clear();
      const r = this.ringRadius;
      const start = -Math.PI / 2;
      const end = start + Math.PI * 2 * Math.min(1, progress);
      this.timerRingFill.arc(0, 0, r, start, end);
      this.timerRingFill.stroke({ color: 0xf44a4a, width: 4 });
    } else {
      this.timerNumber.style.fill = GOLD_LIGHT;
    }
  }

  /* ══════════════════════════════════════════════════════════════
     State label (ROLLING / NEXT ROUND)
     ══════════════════════════════════════════════════════════════ */

  private showState(label: string, color: number): void {
    this.stateLabel.visible = true;
    this.stateLabel.text = label;
    this.stateLabel.style.fill = color;
  }

  /* ══════════════════════════════════════════════════════════════
     Result — colored pill badge + large sum number
     ══════════════════════════════════════════════════════════════ */

  private showResult(side: BetSide, sum: number): void {
    this.resultGroup.visible = true;
    const isLow = side === 'LOW';
    const sideColor = isLow ? LOW_COLOR : HIGH_COLOR;

    /* Side text */
    this.resultSideText.text = side;
    this.resultSideText.y = -28;

    /* Pill background behind side text */
    const tw = this.resultSideText.width + 28;
    const th = this.resultSideText.height + 10;
    this.resultPill.clear();
    this.resultPill.roundRect(-tw / 2, -28 - th / 2, tw, th, th / 2);
    this.resultPill.fill({ color: sideColor, alpha: 0.2 });
    this.resultPill.stroke({ color: sideColor, width: 1.5, alpha: 0.6 });

    /* Sum number below — scale pop on reveal */
    this.resultSum.text = String(sum);
    this.resultSum.y = 16;
    gsap.fromTo(
      this.resultSum.scale,
      { x: 0.8, y: 0.8 },
      { x: 1, y: 1, duration: 0.3, ease: 'back.out(1.5)' },
    );
  }

  /* ══════════════════════════════════════════════════════════════
     Transitions — fade/scale animations between states
     ══════════════════════════════════════════════════════════════ */

  private onTransition(_from: RoundState, to: RoundState): void {
    if (to === 'BETTING_OPEN') {
      this.fadeIn(this.timerGroup);
    } else if (to === 'ROLLING') {
      this.fadeIn(this.stateLabel);
      this.startPulse(this.stateLabel);
    } else if (to === 'RESULT') {
      this.popIn(this.resultGroup);
    } else if (to === 'COOLDOWN') {
      this.fadeIn(this.stateLabel);
    }
  }

  private fadeIn(target: Container): void {
    target.alpha = 0;
    gsap.to(target, { alpha: 1, duration: 0.3, ease: 'power2.out' });
  }

  private popIn(target: Container): void {
    target.alpha = 0;
    target.scale.set(0.7);
    gsap.to(target, { alpha: 1, duration: 0.25, ease: 'power2.out' });
    gsap.to(target.scale, { x: 1, y: 1, duration: 0.35, ease: 'back.out(1.5)' });
  }

  private startPulse(target: Container): void {
    gsap.to(target, {
      alpha: 0.5,
      duration: 0.6,
      yoyo: true,
      repeat: -1,
      ease: 'sine.inOut',
    });
  }

  /* ══════════════════════════════════════════════════════════════
     Cleanup
     ══════════════════════════════════════════════════════════════ */

  destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    gsap.killTweensOf(this.stateLabel);
    gsap.killTweensOf(this.timerGroup);
    gsap.killTweensOf(this.resultGroup);
    gsap.killTweensOf(this.resultGroup.scale);
    this.container.destroy({ children: true });
  }
}
