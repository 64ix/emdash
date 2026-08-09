import { eq } from 'drizzle-orm';
import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { kv } from '@main/db/schema';

// Stop client.ts from opening the real Electron DB at import time; the
// device-identity module's KV reads/writes hit the fixture DB instead.
const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

import { getOrCreateDeviceIdentity } from './device-identity';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('device identity', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('creates and persists a UUID deviceId in the machine-local device namespace', async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;

    const identity = await getOrCreateDeviceIdentity();

    expect(identity.deviceId).toMatch(UUID_RE);
    expect(identity.deviceName).toBeTruthy();

    const [idRow] = await fixture.db.select().from(kv).where(eq(kv.key, 'device:id'));
    const [nameRow] = await fixture.db.select().from(kv).where(eq(kv.key, 'device:name'));
    expect(idRow?.value).toBe(JSON.stringify(identity.deviceId));
    expect(nameRow?.value).toBe(JSON.stringify(identity.deviceName));
  });

  it('is stable across calls (no re-creation once persisted)', async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;

    const first = await getOrCreateDeviceIdentity();
    const second = await getOrCreateDeviceIdentity();

    expect(second.deviceId).toBe(first.deviceId);
    expect(second.deviceName).toBe(first.deviceName);
  });

  it('does not touch the telemetry instanceId namespace', async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;

    await getOrCreateDeviceIdentity();

    const telemetryRows = await fixture.db.select().from(kv).where(eq(kv.key, 'telemetry:instanceId'));
    expect(telemetryRows).toHaveLength(0);
  });
});
