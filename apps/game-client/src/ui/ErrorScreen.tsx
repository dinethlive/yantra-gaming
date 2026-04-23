import type React from 'react';

interface ErrorScreenProps {
  title?: string;
  message?: string;
}

/**
 * Minimal error screen for invalid/expired session. Shown when launch
 * params are missing or malformed, or when the operator terminates the
 * session from the parent frame. We deliberately give no "retry" — the
 * operator's casino is the only place that can mint a new session.
 */
export const ErrorScreen: React.FC<ErrorScreenProps> = ({
  title = 'Session expired',
  message = 'Return to your casino to start a new session.',
}) => {
  return (
    <div className="error-screen">
      <div className="error-screen__card">
        <div className="error-screen__icon" aria-hidden="true">!</div>
        <h1 className="error-screen__title">{title}</h1>
        <p className="error-screen__message">{message}</p>
      </div>
    </div>
  );
};
