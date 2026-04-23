// Server-rendered HTML for the mock casino lobby. No bundler, no React.
// This is a dev harness — deliberately ugly-enough to not be mistaken for
// a product surface.

import { fromMicro } from '@yantra/wallet-spec';

export interface LobbyPlayer {
  playerRef: string;
  balanceMicro: bigint;
}

export interface LobbyViewModel {
  operatorId: string;
  apiKeyId: string;
  rgsBaseUrl: string;
  gameClientBaseUrl: string;
  currency: string;
  players: LobbyPlayer[];
  /** Non-null when we just handled a /lobby/launch error. */
  error?: { playerRef: string; message: string; detail?: unknown };
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderLobby(vm: LobbyViewModel): string {
  const rows = vm.players
    .map(
      (p) => `
      <tr>
        <td><code>${esc(p.playerRef)}</code></td>
        <td class="num">${esc(fromMicro(p.balanceMicro))} ${esc(vm.currency)}</td>
        <td>
          <form method="POST" action="/lobby/launch" class="launch-form">
            <input type="hidden" name="playerRef" value="${esc(p.playerRef)}" />
            <button type="submit">Launch Yantra</button>
          </form>
        </td>
      </tr>`,
    )
    .join('');

  const errorBlock = vm.error
    ? `<section class="error">
        <h3>Launch failed for <code>${esc(vm.error.playerRef)}</code></h3>
        <p>${esc(vm.error.message)}</p>
        ${
          vm.error.detail
            ? `<pre>${esc(JSON.stringify(vm.error.detail, null, 2))}</pre>`
            : ''
        }
      </section>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Mock Operator · Yantra Gaming</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
      background: #0b0d10; color: #e5e7eb;
    }
    main { max-width: 900px; margin: 0 auto; padding: 32px 24px 64px; }
    h1 { margin: 0 0 4px; font-size: 22px; letter-spacing: -0.01em; }
    .sub { color: #9ca3af; margin: 0 0 24px; }
    dl.meta {
      display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px;
      background: #111418; border: 1px solid #1f2937; border-radius: 8px;
      padding: 16px; margin: 0 0 24px;
    }
    dl.meta dt { color: #9ca3af; }
    dl.meta dd { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    table {
      width: 100%; border-collapse: collapse;
      background: #111418; border: 1px solid #1f2937; border-radius: 8px;
      overflow: hidden;
    }
    th, td { padding: 12px 14px; text-align: left; border-bottom: 1px solid #1f2937; }
    tr:last-child td { border-bottom: 0; }
    th { background: #0f1217; color: #9ca3af; font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
    td.num { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #d1fae5; }
    button {
      background: #10b981; color: #052e1e; border: 0; border-radius: 6px;
      padding: 8px 14px; font-weight: 600; cursor: pointer;
    }
    button:hover { background: #34d399; }
    .error {
      margin: 16px 0 0; padding: 12px 16px;
      background: #2a0f12; border: 1px solid #7f1d1d; border-radius: 8px;
      color: #fecaca;
    }
    .error pre { background: #1a0a0c; padding: 12px; border-radius: 6px; overflow: auto; }
    footer { margin-top: 32px; color: #6b7280; font-size: 12px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    a { color: #93c5fd; }
  </style>
</head>
<body>
  <main>
    <h1>Mock Operator Lobby</h1>
    <p class="sub">Dev-only harness. Impersonates a B2C casino so Yantra can be demoed end-to-end without a real operator.</p>

    <dl class="meta">
      <dt>Operator ID</dt><dd>${esc(vm.operatorId)}</dd>
      <dt>API key ID</dt><dd>${esc(vm.apiKeyId)}</dd>
      <dt>RGS base</dt><dd><a href="${esc(vm.rgsBaseUrl)}" target="_blank" rel="noreferrer">${esc(vm.rgsBaseUrl)}</a></dd>
      <dt>Game client</dt><dd><a href="${esc(vm.gameClientBaseUrl)}" target="_blank" rel="noreferrer">${esc(vm.gameClientBaseUrl)}</a></dd>
    </dl>

    <table>
      <thead>
        <tr><th>Player ref</th><th>Balance</th><th></th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    ${errorBlock}

    <footer>
      Wallet debug: <a href="/wallet/debug/balances">/wallet/debug/balances</a> ·
      Health: <a href="/healthz">/healthz</a>
    </footer>
  </main>
</body>
</html>`;
}
