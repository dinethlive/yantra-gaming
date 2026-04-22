import { describe, expect, it } from 'bun:test';
import {
  KEY_ID_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyPayload,
} from '@yantra/wallet-spec';
import { createSession, SessionCreationError } from '../src/index.js';

const RGS_ENDPOINT = 'https://rgs.yantra.example/v1/session';
const API_KEY_ID = 'kid_test_0001';
const API_SECRET = 'test-secret-32-bytes-of-entropy--';
const NOW_SECONDS = 1_745_400_000;

const OK_RESPONSE = {
  sessionId: '5bb80000-0000-4000-8000-000000000000',
  sessionToken: 'eyJhbGciOi.stub.token',
  launchUrl:
    'https://rgs.yantra.example/game/yantra/v1/?sessionToken=eyJhbGciOi.stub.token',
  expiresAt: '2026-04-23T09:00:00Z',
  serverSeedHash: 'a1'.repeat(32),
};

function makeMockFetch(handler: (req: Request) => Promise<Response> | Response) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const req = new Request(url, init);
    return handler(req);
  };
}

describe('createSession', () => {
  it('sends an HMAC-signed POST with the canonical headers', async () => {
    let received: Request | null = null;
    const mockFetch = makeMockFetch(async (req) => {
      received = req;
      return new Response(JSON.stringify(OK_RESPONSE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await createSession({
      endpoint: RGS_ENDPOINT,
      apiKeyId: API_KEY_ID,
      apiSecret: API_SECRET,
      payload: {
        operatorId: 'op_test',
        playerRef: 'player-1',
        gameCode: 'yantra',
        currency: 'LKR',
        lang: 'si',
        jurisdiction: 'LK',
      },
      fetch: mockFetch as unknown as typeof fetch,
      nowSeconds: () => NOW_SECONDS,
    });

    expect(received).not.toBeNull();
    const req = received as unknown as Request;
    expect(req.method).toBe('POST');
    expect(req.headers.get(KEY_ID_HEADER)).toBe(API_KEY_ID);
    expect(req.headers.get(TIMESTAMP_HEADER)).toBe(NOW_SECONDS.toString());
    expect(req.headers.get(SIGNATURE_HEADER)).toBeTruthy();

    // The signature must verify against the raw body using the same secret + path.
    const rawBody = await req.text();
    const ok = verifyPayload({
      secret: API_SECRET,
      method: 'POST',
      path: '/v1/session',
      timestamp: NOW_SECONDS,
      body: rawBody,
      signature: req.headers.get(SIGNATURE_HEADER)!,
      nowSeconds: NOW_SECONDS,
    });
    expect(ok).toBe(true);
  });

  it('auto-generates a requestUuid and includes it in the body and result', async () => {
    let receivedBody: string = '';
    const mockFetch = makeMockFetch(async (req) => {
      receivedBody = await req.text();
      return new Response(JSON.stringify(OK_RESPONSE), { status: 200 });
    });

    const result = await createSession({
      endpoint: RGS_ENDPOINT,
      apiKeyId: API_KEY_ID,
      apiSecret: API_SECRET,
      payload: {
        operatorId: 'op_test',
        playerRef: 'player-1',
        gameCode: 'yantra',
        currency: 'LKR',
        lang: 'si',
        jurisdiction: 'LK',
      },
      fetch: mockFetch as unknown as typeof fetch,
      nowSeconds: () => NOW_SECONDS,
    });

    expect(result.requestUuid).toMatch(/^[0-9a-f-]{36}$/);
    const parsed = JSON.parse(receivedBody);
    expect(parsed.requestUuid).toBe(result.requestUuid);
  });

  it('honors a caller-supplied requestUuid', async () => {
    const REQ_UUID = '11111111-2222-4333-8444-555555555555';
    let receivedBody: string = '';
    const mockFetch = makeMockFetch(async (req) => {
      receivedBody = await req.text();
      return new Response(JSON.stringify(OK_RESPONSE), { status: 200 });
    });

    const result = await createSession({
      endpoint: RGS_ENDPOINT,
      apiKeyId: API_KEY_ID,
      apiSecret: API_SECRET,
      requestUuid: REQ_UUID,
      payload: {
        operatorId: 'op_test',
        playerRef: 'player-1',
        gameCode: 'yantra',
        currency: 'LKR',
        lang: 'si',
        jurisdiction: 'LK',
      },
      fetch: mockFetch as unknown as typeof fetch,
      nowSeconds: () => NOW_SECONDS,
    });

    expect(result.requestUuid).toBe(REQ_UUID);
    expect(JSON.parse(receivedBody).requestUuid).toBe(REQ_UUID);
  });

  it('maps 5xx to a retryable SessionCreationError', async () => {
    const mockFetch = makeMockFetch(() =>
      new Response('{"error":"boom"}', { status: 502 }),
    );

    try {
      await createSession({
        endpoint: RGS_ENDPOINT,
        apiKeyId: API_KEY_ID,
        apiSecret: API_SECRET,
        payload: {
          operatorId: 'op_test',
          playerRef: 'player-1',
          gameCode: 'yantra',
          currency: 'LKR',
          lang: 'si',
          jurisdiction: 'LK',
        },
        fetch: mockFetch as unknown as typeof fetch,
        nowSeconds: () => NOW_SECONDS,
      });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionCreationError);
      const e = err as SessionCreationError;
      expect(e.code).toBe('RGS_SERVER_ERROR');
      expect(e.retryable).toBe(true);
      expect(e.httpStatus).toBe(502);
    }
  });

  it('maps 4xx to a non-retryable SessionCreationError', async () => {
    const mockFetch = makeMockFetch(() =>
      new Response('{"error":"invalid_signature"}', { status: 401 }),
    );

    try {
      await createSession({
        endpoint: RGS_ENDPOINT,
        apiKeyId: API_KEY_ID,
        apiSecret: API_SECRET,
        payload: {
          operatorId: 'op_test',
          playerRef: 'player-1',
          gameCode: 'yantra',
          currency: 'LKR',
          lang: 'si',
          jurisdiction: 'LK',
        },
        fetch: mockFetch as unknown as typeof fetch,
        nowSeconds: () => NOW_SECONDS,
      });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionCreationError);
      const e = err as SessionCreationError;
      expect(e.code).toBe('RGS_REJECTED');
      expect(e.retryable).toBe(false);
      expect(e.httpStatus).toBe(401);
    }
  });

  it('rejects an incomplete response as non-retryable', async () => {
    const mockFetch = makeMockFetch(
      () =>
        new Response(JSON.stringify({ sessionId: 'only-one-field' }), {
          status: 200,
        }),
    );

    try {
      await createSession({
        endpoint: RGS_ENDPOINT,
        apiKeyId: API_KEY_ID,
        apiSecret: API_SECRET,
        payload: {
          operatorId: 'op_test',
          playerRef: 'player-1',
          gameCode: 'yantra',
          currency: 'LKR',
          lang: 'si',
          jurisdiction: 'LK',
        },
        fetch: mockFetch as unknown as typeof fetch,
        nowSeconds: () => NOW_SECONDS,
      });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionCreationError);
      const e = err as SessionCreationError;
      expect(e.code).toBe('INVALID_RESPONSE');
      expect(e.retryable).toBe(false);
    }
  });

  it('returns the parsed response on success', async () => {
    const mockFetch = makeMockFetch(
      () => new Response(JSON.stringify(OK_RESPONSE), { status: 200 }),
    );
    const result = await createSession({
      endpoint: RGS_ENDPOINT,
      apiKeyId: API_KEY_ID,
      apiSecret: API_SECRET,
      payload: {
        operatorId: 'op_test',
        playerRef: 'player-1',
        gameCode: 'yantra',
        currency: 'LKR',
        lang: 'si',
        jurisdiction: 'LK',
      },
      fetch: mockFetch as unknown as typeof fetch,
      nowSeconds: () => NOW_SECONDS,
    });

    expect(result.sessionId).toBe(OK_RESPONSE.sessionId);
    expect(result.launchUrl).toBe(OK_RESPONSE.launchUrl);
    expect(result.serverSeedHash).toBe(OK_RESPONSE.serverSeedHash);
  });
});
