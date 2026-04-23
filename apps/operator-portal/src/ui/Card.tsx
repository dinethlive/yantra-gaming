import type { ReactNode } from 'react';

interface Props {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  dense?: boolean;
}

export default function Card({ title, subtitle, actions, children, dense }: Props) {
  return (
    <section className={`card${dense ? ' card--dense' : ''}`}>
      {(title || actions) && (
        <header className="card__header">
          <div>
            {title ? <h2 className="card__title">{title}</h2> : null}
            {subtitle ? <p className="card__sub">{subtitle}</p> : null}
          </div>
          {actions ? <div className="card__actions">{actions}</div> : null}
        </header>
      )}
      <div className="card__body">{children}</div>
    </section>
  );
}

export function StubBanner() {
  return (
    <div className="stub-banner" role="status">
      This endpoint is a stub. Data shown is placeholder until the rgs-server
      implements it.
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="error-banner" role="alert">
      {message}
    </div>
  );
}
