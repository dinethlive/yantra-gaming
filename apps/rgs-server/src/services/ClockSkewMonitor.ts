import dgram from 'node:dgram';
import { logger } from '../logger.js';
import { clockSkewMs } from '../telemetry/index.js';

// ──────────────────────────────────────────────────────────────────────────
// Clock-skew monitor.
//
// Round phase timestamps (bettingOpen → rolling → result → settled) are
// derived from Date.now(). A compromised or drifted wall clock forges the
// audit trail — a regulator's first forensic question is "was the server's
// clock authoritative when this round was served?"
//
// The monitor pings an NTP server (by default pool.ntp.org) and emits:
//   * clock_skew_ms gauge (Prometheus scrape)
//   * a WARN log if |skew| > 250 ms, the rough ceiling before a player's
//     "bet accepted at HH:MM:SS" could be mis-reported in a dispute
//   * an ERROR log if |skew| > 2000 ms, which is beyond any tolerance
//
// Deliberately does NOT call settimeofday() — we want to detect drift,
// not silently correct it. Ops is expected to run chrony/ntpd and use
// this as a "did ntp fail" canary.
//
// Pure Node UDP — no dependency on the host clock command.

interface NtpQueryResult {
  offsetMs: number;   // +ve = local ahead of server, -ve = local behind
  roundTripMs: number;
  serverStratum: number;
}

const NTP_SERVER = process.env.NTP_SERVER ?? 'pool.ntp.org';
const NTP_PORT = 123;
const NTP_TIMEOUT_MS = 3_000;
const WARN_THRESHOLD_MS = Number(process.env.CLOCK_SKEW_WARN_MS ?? 250);
const ERROR_THRESHOLD_MS = Number(process.env.CLOCK_SKEW_ERROR_MS ?? 2_000);
const POLL_INTERVAL_MS = Number(process.env.CLOCK_SKEW_POLL_MS ?? 15 * 60_000);

// NTP epoch (1900-01-01) vs Unix epoch (1970-01-01)
const NTP_UNIX_EPOCH_OFFSET = 2_208_988_800;

function ntpTimestampToMs(seconds: number, fractionalSeconds: number): number {
  const unixSec = seconds - NTP_UNIX_EPOCH_OFFSET;
  const msFractional = (fractionalSeconds / 0x1_0000_0000) * 1000;
  return unixSec * 1000 + msFractional;
}

async function queryNtp(): Promise<NtpQueryResult> {
  return new Promise<NtpQueryResult>((resolve, reject) => {
    const client = dgram.createSocket('udp4');
    const packet = Buffer.alloc(48);
    // LI=0, VN=4, Mode=3 (client) → 0x23
    packet[0] = 0x23;

    const originateMs = Date.now();
    const timeout = setTimeout(() => {
      client.close();
      reject(new Error('ntp_timeout'));
    }, NTP_TIMEOUT_MS);

    client.once('error', (err) => {
      clearTimeout(timeout);
      client.close();
      reject(err);
    });

    client.once('message', (msg) => {
      const destMs = Date.now();
      clearTimeout(timeout);
      client.close();

      if (msg.length < 48) {
        reject(new Error('ntp_short_reply'));
        return;
      }

      const stratum = msg.readUInt8(1);
      const rxSec = msg.readUInt32BE(32);
      const rxFrac = msg.readUInt32BE(36);
      const txSec = msg.readUInt32BE(40);
      const txFrac = msg.readUInt32BE(44);

      const serverReceiveMs = ntpTimestampToMs(rxSec, rxFrac);
      const serverTransmitMs = ntpTimestampToMs(txSec, txFrac);

      // Standard SNTP offset formula:
      //   offset = ((rx - originate) + (tx - dest)) / 2
      const offsetMs =
        ((serverReceiveMs - originateMs) + (serverTransmitMs - destMs)) / 2;
      const roundTripMs = (destMs - originateMs) - (serverTransmitMs - serverReceiveMs);

      resolve({
        offsetMs,
        roundTripMs,
        serverStratum: stratum,
      });
    });

    client.send(packet, 0, packet.length, NTP_PORT, NTP_SERVER, (err) => {
      if (err) {
        clearTimeout(timeout);
        client.close();
        reject(err);
      }
    });
  });
}

class ClockSkewMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastOffsetMs: number | null = null;
  private lastCheckAt: number | null = null;

  async tick(): Promise<void> {
    try {
      const res = await queryNtp();
      this.lastOffsetMs = res.offsetMs;
      this.lastCheckAt = Date.now();
      clockSkewMs.set({ server: NTP_SERVER }, res.offsetMs);
      const magnitude = Math.abs(res.offsetMs);
      if (magnitude > ERROR_THRESHOLD_MS) {
        logger.error('clock_skew_critical', {
          offsetMs: res.offsetMs,
          roundTripMs: res.roundTripMs,
          server: NTP_SERVER,
          stratum: res.serverStratum,
        });
      } else if (magnitude > WARN_THRESHOLD_MS) {
        logger.warn('clock_skew_high', {
          offsetMs: res.offsetMs,
          roundTripMs: res.roundTripMs,
          server: NTP_SERVER,
          stratum: res.serverStratum,
        });
      } else {
        logger.info('clock_skew_ok', {
          offsetMs: res.offsetMs,
          roundTripMs: res.roundTripMs,
          server: NTP_SERVER,
          stratum: res.serverStratum,
        });
      }
    } catch (err) {
      // NTP unreachable is ops-alertable but must not crash the monitor.
      logger.warn('clock_skew_check_failed', {
        err: (err as Error).message,
        server: NTP_SERVER,
      });
    }
  }

  start(): void {
    if (this.timer) return;
    // First tick fires after the poll interval — running it at boot would
    // block the startup log line for several seconds when NTP is slow.
    // In dev, operators usually disable via CLOCK_SKEW_DISABLED=1.
    if (process.env.CLOCK_SKEW_DISABLED === '1') {
      logger.info('clock_skew_monitor_disabled');
      return;
    }
    this.timer = setInterval(() => { void this.tick(); }, POLL_INTERVAL_MS);
    // run once shortly after boot so a bad clock is caught on day 1
    setTimeout(() => { void this.tick(); }, 15_000).unref();
    logger.info('clock_skew_monitor_started', {
      server: NTP_SERVER,
      pollMs: POLL_INTERVAL_MS,
      warnMs: WARN_THRESHOLD_MS,
      errorMs: ERROR_THRESHOLD_MS,
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): { offsetMs: number | null; lastCheckAt: number | null; server: string } {
    return {
      offsetMs: this.lastOffsetMs,
      lastCheckAt: this.lastCheckAt,
      server: NTP_SERVER,
    };
  }
}

export const clockSkewMonitor = new ClockSkewMonitor();
