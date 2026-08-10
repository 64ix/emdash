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

describe('scratch: concurrent pushers, stress', () => {
  for (let trial = 0; trial < 10; trial++) {
    it(`trial ${trial}: N concurrent single-mutation pushes`, async () => {
      const db = await makeDb();
      const space = await createSpace(db);
      const N = 8;

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
      const statuses = settled.map((r) => (r.status === 'fulfilled' ? r.value.status : 'REJECTED'));
      const versions = settled
        .filter((r): r is PromiseFulfilledResult<{ status: number; body: unknown }> =>
          r.status === 'fulfilled'
        )
        .map(
          (r) =>
            (r.value.body as { results: { version: number }[] }).results[0].version
        );
      // eslint-disable-next-line no-console
      console.log(`trial ${trial} statuses:`, JSON.stringify(statuses));
      // eslint-disable-next-line no-console
      console.log(`trial ${trial} versions:`, JSON.stringify(versions.slice().sort((a, b) => a - b)));
      if (rejected.length > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `trial ${trial} rejection reasons:`,
          rejected.map((r) => (r as PromiseRejectedResult).reason?.message ?? String((r as PromiseRejectedResult).reason))
        );
      }
    });
  }

  it('concurrent multi-mutation pushes (internal loop calls batch() 3x per push)', async () => {
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

    const settled = await Promise.allSettled([pushMany('a'), pushMany('b'), pushMany('c')]);
    const statuses = settled.map((r) => (r.status === 'fulfilled' ? r.value.status : 'REJECTED'));
    // eslint-disable-next-line no-console
    console.log('multi-mutation statuses:', JSON.stringify(statuses));
    for (const r of settled) {
      if (r.status === 'rejected') {
        // eslint-disable-next-line no-console
        console.log('multi-mutation rejection:', r.reason);
      } else {
        // eslint-disable-next-line no-console
        console.log('multi-mutation result:', JSON.stringify(r.value.body));
      }
    }
  });
});
