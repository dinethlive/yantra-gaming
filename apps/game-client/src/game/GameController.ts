import gsap from 'gsap';
import { type RoundState, useGameStore } from '../store/gameStore';
import { CanvasHUD } from './CanvasHUD';
import { DiceManager } from './DiceManager';
import type { GameApp } from './GameApp';
import { ParticleSystem } from './ParticleSystem';
import { SceneBuilder } from './SceneBuilder';
import { SoundManager } from './SoundManager';

/**
 * Orchestrates the PixiJS game scene.
 * Connects the visual engine to the Zustand game state.
 */
export class GameController {
  private gameApp: GameApp;
  private scene: SceneBuilder;
  private diceManager: DiceManager;
  private particles: ParticleSystem;
  private hud: CanvasHUD;
  private unsubscribe: (() => void) | null = null;
  private prevState: RoundState = 'WAITING_FOR_BET';
  private isRolling = false;

  constructor(gameApp: GameApp) {
    this.gameApp = gameApp;
    this.particles = new ParticleSystem(gameApp.layers.particles, 120);
    this.scene = new SceneBuilder(gameApp);
    this.diceManager = new DiceManager(gameApp, this.particles);
    this.hud = new CanvasHUD(gameApp);
  }

  init(): void {
    /* Build the scene */
    this.scene.build();
    this.diceManager.init();
    this.hud.init();

    /* Reposition dice + HUD on resize (scene rebuilds itself) */
    this.gameApp.onResize(() => {
      this.diceManager.reposition();
      this.hud.reposition();
    });

    /* Init sound */
    SoundManager.init();
    SoundManager.startAmbience();

    /* Subscribe only to roundState changes */
    this.unsubscribe = useGameStore.subscribe((state) => {
      if (state.roundState !== this.prevState) {
        this.onStateChange(state.roundState, state);
      }
    });

    /* Sync current state */
    const currentState = useGameStore.getState();
    if (currentState.roundState === 'RESULT' && currentState.dieValue) {
      this.diceManager.setValue(currentState.dieValue);
    }
  }

  private async onStateChange(
    newState: RoundState,
    store: ReturnType<typeof useGameStore.getState>,
  ): Promise<void> {
    if (newState === this.prevState) return;
    const _oldState = this.prevState;
    this.prevState = newState;

    switch (newState) {
      case 'BETTING_OPEN':
        this.onBettingOpen();
        break;

      case 'ROLLING':
        await this.onRolling();
        break;

      case 'RESULT':
        this.onResult(store);
        break;

      case 'COOLDOWN':
        this.onCooldown();
        break;
    }
  }

  private onBettingOpen(): void {
    this.isRolling = false;
    /* Restore scene brightness for new round */
    gsap.to(this.gameApp.layers.background, { alpha: 1, duration: 0.4, ease: 'sine.out' });
    /* Always reset dice to idle — animation plays every round */
    this.diceManager.resetToIdle();
  }

  private async onRolling(): Promise<void> {
    if (this.isRolling) return;
    this.isRolling = true;

    await this.diceManager.playRoll();
  }

  private onResult(store: ReturnType<typeof useGameStore.getState>): void {
    const playerSide = store.currentBet?.side ?? null;

    if (store.dieValue) {
      /* Reveal the actual result on the die with flash + win/lose effect */
      this.diceManager.revealResult(store.dieValue, store.outcomeSide || 'LOW', playerSide);
    }

    /* Only play win/lose sounds when player has a bet */
    if (playerSide === store.outcomeSide) {
      SoundManager.play('win');
    } else if (playerSide !== null) {
      SoundManager.play('lose');
    }

    this.isRolling = false;
  }

  private onCooldown(): void {
    /* Subtle scene dim — visual breathing between rounds */
    gsap.to(this.gameApp.layers.background, { alpha: 0.7, duration: 0.5, ease: 'sine.out' });
  }

  /** Called when a bet is placed */
  onBetPlaced(): void {
    SoundManager.play('bet_placed');
  }

  /** Called on countdown ticks */
  onCountdownTick(): void {
    SoundManager.play('countdown_tick');
  }

  destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
    this.scene.destroy();
    this.diceManager.destroy();
    this.hud.destroy();
    this.particles.destroy();
    SoundManager.stopAmbience();
  }
}
