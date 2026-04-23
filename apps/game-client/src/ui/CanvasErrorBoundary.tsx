import { Component, type ErrorInfo, type ReactNode } from 'react';
import { withTranslation, type WithTranslation } from 'react-i18next';
import './CanvasErrorBoundary.css';

interface Props extends WithTranslation {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render/mount errors from GameCanvas + its PixiJS scene so a
 * WebGL context failure doesn't crash the whole iframe. Shows a branded
 * fallback with a reload button.
 */
class CanvasErrorBoundaryBase extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[CanvasErrorBoundary]', error, info);
  }

  private handleReload = () => {
    window.location.reload();
  };

  override render() {
    const { error } = this.state;
    const { t, children } = this.props;

    if (!error) return children;

    const message = error.message || '';
    const isWebGL = /webgl|context|canvas|pixi/i.test(message);

    return (
      <div className="canvas-error" role="alert">
        <div className="canvas-error__panel">
          <div className="canvas-error__icon" aria-hidden="true">
            <svg
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <title>Canvas error</title>
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <h3 className="canvas-error__title">
            {isWebGL ? t('canvasError.webglTitle') : t('canvasError.title')}
          </h3>
          <p className="canvas-error__message">
            {isWebGL ? t('canvasError.webglMessage') : t('canvasError.message')}
          </p>
          {message && <code className="canvas-error__detail">{message}</code>}
          <button type="button" className="canvas-error__btn" onClick={this.handleReload}>
            {t('canvasError.reload')}
          </button>
        </div>
      </div>
    );
  }
}

export const CanvasErrorBoundary = withTranslation()(CanvasErrorBoundaryBase);
