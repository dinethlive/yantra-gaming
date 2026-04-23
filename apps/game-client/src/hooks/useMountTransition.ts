import { useEffect, useState } from 'react';

type Stage = 'entering' | 'entered' | 'exiting';

/**
 * Keeps a component mounted during its exit animation.
 * Returns `shouldRender` (whether to render at all) and `stage` (CSS class hint).
 */
export function useMountTransition(isOpen: boolean, exitMs = 300) {
  const [shouldRender, setShouldRender] = useState(isOpen);
  const [stage, setStage] = useState<Stage>(isOpen ? 'entered' : 'exiting');

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      setStage('entering');
      const raf = requestAnimationFrame(() => setStage('entered'));
      return () => cancelAnimationFrame(raf);
    }
    setStage('exiting');
    const timer = setTimeout(() => setShouldRender(false), exitMs);
    return () => clearTimeout(timer);
  }, [isOpen, exitMs]);

  return { shouldRender, stage };
}
