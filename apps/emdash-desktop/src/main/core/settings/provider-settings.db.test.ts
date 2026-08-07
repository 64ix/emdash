import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { providerOverrideSettings } from './provider-settings-service';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

describe('providerOverrideSettings persistence', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('persists and reads back per-provider default model and effort', async () => {
    await providerOverrideSettings.updateItem('opencode', {
      defaultModel: 'gpt-5-codex',
      defaultEffort: 'high',
    });

    const item = await providerOverrideSettings.getItem('opencode');
    expect(item?.defaultModel).toBe('gpt-5-codex');
    expect(item?.defaultEffort).toBe('high');
  });

  it('reports per-provider overrides and supports reset to defaults', async () => {
    await providerOverrideSettings.updateItem('opencode', {
      defaultModel: 'gpt-5-codex',
      defaultEffort: 'high',
    });

    const meta = await providerOverrideSettings.getItemWithMeta('opencode');
    expect(meta.overrides).toEqual({ defaultModel: 'gpt-5-codex', defaultEffort: 'high' });

    await providerOverrideSettings.resetItem('opencode');
    expect(await providerOverrideSettings.getItem('opencode')).toBeUndefined();
  });

  it('keeps other providers unaffected', async () => {
    await providerOverrideSettings.updateItem('opencode', { defaultModel: 'gpt-5-codex' });

    const claude = await providerOverrideSettings.getItem('claude');
    expect(claude?.defaultModel).toBeUndefined();
    expect(claude?.defaultEffort).toBeUndefined();
  });

  it('round-trips coexisting legacy fields and defaults', async () => {
    await providerOverrideSettings.updateItem('opencode', {
      extraArgs: '--verbose',
      defaultModel: 'gpt-5-codex',
    });

    const item = await providerOverrideSettings.getItem('opencode');
    expect(item).toEqual({
      extraArgs: '--verbose',
      defaultModel: 'gpt-5-codex',
    });
  });
});
