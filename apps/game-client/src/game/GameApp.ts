import { Application, Container } from 'pixi.js';

/**
 * PixiJS Application wrapper for the KETAPOLA game canvas.
 * Uses PixiJS v8 async init pattern with full resize support.
 */
export class GameApp {
  public app: Application;
  public layers: {
    background: Container;
    scene: Container;
    dice: Container;
    particles: Container;
    ui: Container;
  };

  private _ready = false;
  private _onResize: (() => void)[] = [];
  private _resizeObserver: ResizeObserver | null = null;
  private _container: HTMLElement | null = null;
  private _lastCbWidth = 0;
  private _lastCbHeight = 0;

  constructor() {
    this.app = new Application();
    this.layers = {
      background: new Container(),
      scene: new Container(),
      dice: new Container(),
      particles: new Container(),
      ui: new Container(),
    };
  }

  async init(container: HTMLElement): Promise<void> {
    this._container = container;

    await this.app.init({
      background: 0x08080f,
      resizeTo: container,
      preference: 'webgl',
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio, 2),
    });

    container.appendChild(this.app.canvas);

    /* Add layers in draw-order */
    this.app.stage.addChild(this.layers.background);
    this.app.stage.addChild(this.layers.scene);
    this.app.stage.addChild(this.layers.dice);
    this.app.stage.addChild(this.layers.particles);
    this.app.stage.addChild(this.layers.ui);

    /* Track initial dimensions for threshold check */
    this._lastCbWidth = this.app.screen.width;
    this._lastCbHeight = this.app.screen.height;

    /* Watch for container size changes.
       Always sync PixiJS resolution, but only fire rebuild callbacks
       when the size changed by more than a few pixels. This prevents
       the scene from being destroyed and recreated due to minor layout
       shifts (e.g. bet-panel font-size change on mobile). */
    this._resizeObserver = new ResizeObserver(() => {
      this.app.resize();
      const w = this.app.screen.width;
      const h = this.app.screen.height;
      if (Math.abs(w - this._lastCbWidth) < 5 && Math.abs(h - this._lastCbHeight) < 5) {
        return;
      }
      this._lastCbWidth = w;
      this._lastCbHeight = h;
      for (const cb of this._onResize) cb();
    });
    this._resizeObserver.observe(container);

    this._ready = true;
  }

  /** Register a callback to run on resize */
  onResize(callback: () => void): void {
    this._onResize.push(callback);
  }

  get ready(): boolean {
    return this._ready;
  }

  get width(): number {
    return this.app.screen.width;
  }

  get height(): number {
    return this.app.screen.height;
  }

  destroy(): void {
    this._ready = false;
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    this._onResize = [];
    this.app.destroy(true, { children: true });
  }
}
