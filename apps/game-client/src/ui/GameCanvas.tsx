import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { GameApp } from '../game/GameApp';
import { GameController } from '../game/GameController';

/**
 * Mounts the PixiJS canvas in a <div> and tears it down on unmount.
 * The scene itself (GameApp + GameController) is copied verbatim from the
 * B2C app — certified IP, do not edit.
 */
export const GameCanvas: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<GameApp | null>(null);
  const controllerRef = useRef<GameController | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let destroyed = false;

    (async () => {
      try {
        const app = new GameApp();
        await app.init(container);
        if (destroyed) {
          app.destroy();
          return;
        }
        appRef.current = app;

        const controller = new GameController(app);
        controller.init();
        controllerRef.current = controller;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!destroyed) setInitError(msg);
      }
    })();

    return () => {
      destroyed = true;
      controllerRef.current?.destroy();
      appRef.current?.destroy();
      controllerRef.current = null;
      appRef.current = null;
    };
  }, []);

  if (initError) {
    return <div className="game-canvas__error">Canvas failed to initialise: {initError}</div>;
  }

  return <div ref={containerRef} className="game-canvas" />;
};
