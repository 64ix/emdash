import { describe, expect, it } from 'vitest';
import type { SqlDb } from '../src/db';
import { handle } from '../src/index';
import { ensureSchema } from '../src/schema';
import { MemoryD1 } from './memory-d1';

const T0 = 1_800_000_000_000;

async function makeDb(): Promise<SqlDb> {
  const db = new MemoryD1();
  await ensureSchema(db);
  return db;
}

function request(method: string, path: string, body: unknown, token?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return new Request(`https://relay.local${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function post(db: SqlDb, path: string, body: unknown, token?: string, now: number = T0) {
  const response = await handle(request('POST', path, body, token), db, now);
  return { status: response.status, body: await response.json() };
}

async function createSpace(db: SqlDb) {
  const result = await post(db, '/v1/space', { name: undefined }, undefined, T0);
  expect(result.status).toBe(200);
  return result.body as { space_id: string; device_token: string };
}

describe('scratch: heavier concurrency stress', () => {
  it('100 trials x 12 concurrent single-mutation pushes: no rejection, always unique/gapless/ordered', async () => {
    let anyRejected = false;
    let anyGap = false;
    for (let trial = 0; trial < 100; trial++) {
      const db = await makeDb();
      const space = await createSpace(db);
      const N = 12;
      const pushOnce = (pk: string) =>
        post(
          db,
          '/v1/sync/push',
          { mutations: [{ table: 't', pk, body: pk, op: 'upsert' }] },
          space.device_token
        );
      const settled = await Promise.allSettled(
        Array.from({ length: N }, (_, i) => pushOnce(`k${i}`))
      );
      const rejected = settled.filter((r) => r.status === 'rejected');
      if (rejected.length > 0) {
        anyRejected = true;
        // eslint-disable-next-line no-console
        console.log(
          `trial ${trial} REJECTIONS:`,
          rejected.map((r) => (r as PromiseRejectedResult).reason?.message)
        );
      }
      const versions = settled
        .filter(
          (r): r is PromiseFulfilledResult<{ status: number; body: unknown }> =>
            r.status === 'fulfilled'
        )
        .map((r) => (r.value.body as { results: { version: number }[] }).results[0].version)
        .sort((a, b) => a - b);
      const expected = Array.from({ length: versions.length }, (_, i) => i + 1);
      if (JSON.stringify(versions) !== JSON.stringify(expected)) {
        anyGap = true;
        // eslint-disable-next-line no-console
        console.log(`trial ${trial} GAP/DUP:`, JSON.stringify(versions));
      }
    }
    // eslint-disable-next-line no-console
    console.log('anyRejected:', anyRejected, 'anyGap:', anyGap);
    expect(anyRejected).toBe(false);
    expect(anyGap).toBe(false);
  });

  it('20 trials x 6 concurrent multi-mutation (3 each) pushes: no rejection', async () => {
    let anyRejected = false;
    for (let trial = 0; trial < 20; trial++) {
      const db = await makeDb();
      const space = await createSpace(db);
      const pushMany = (prefix: string) =>
        post(
          db,
          '/v1/sync/push',
          {
            mutations: [
              { table: 't', pk: `${prefix}-1`, body: '1', op: 'upsert' },
              { table: 't', pk: `${prefix}-2`, body: '2', op: 'upsert' },
              { table: 't', pk: `${prefix}-3`, body: '3', op: 'upsert' },
            ],
          },
          space.device_token
        );
      const settled = await Promise.allSettled(
        ['a', 'b', 'c', 'd', 'e', 'f'].map((p) => pushMany(p))
      );
      const rejected = settled.filter((r) => r.status === 'rejected');
      if (rejected.length > 0) {
        anyRejected = true;
        // eslint-disable-next-line no-console
        console.log(
          `multi trial ${trial} REJECTIONS:`,
          rejected.map((r) => (r as PromiseRejectedResult).reason?.message)
        );
      }
    }
    // eslint-disable-next-line no-console
    console.log('multi anyRejected:', anyRejected);
    expect(anyRejected).toBe(false);
  });
});
