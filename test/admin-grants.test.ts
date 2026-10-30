import { describe, expect, it } from 'vitest';
import {
  parseGrantLimits,
  parseGrantSelectors,
  resolveGrantSubjects,
  type GrantResolveDeps,
} from '../src/services/admin-grants.js';

const APP = 'cli_admin_grants_test';

function fakeDeps(overrides: Partial<GrantResolveDeps> = {}): GrantResolveDeps {
  return {
    listChatMembers: async (_app, chatId) => {
      if (chatId === 'oc_team') return [{ openId: 'ou_a', name: 'A' }, { openId: 'ou_b', name: 'B' }];
      throw new Error('Bot is not in the chat');
    },
    resolveUsers: async (_app, raw) => ({
      map: new Map(raw.filter(u => u === 'b@example.com').map(u => [u, 'ou_b'])),
      definitiveMisses: raw.filter(u => u === 'gone@example.com'),
    }),
    lookupProfile: async (_app, openId) => {
      if (openId === 'ou_foreign') return { status: 'cross_app' };
      if (openId === 'ou_bot') return { status: 'not_visible' };
      if (openId === 'ou_flaky') return { status: 'error' };
      return { status: 'ok', profile: { name: `name-${openId}` } };
    },
    now: () => 1_000_000,
    ...overrides,
  };
}

describe('admin grants: request parsing', () => {
  it('accepts chats, emails / union ids and literal open ids', () => {
    expect(parseGrantSelectors({ chats: ['oc_team', 'oc_team'], users: ['a@example.com', 'on_1'], openIds: ['ou_x'] }))
      .toEqual({ ok: true, selectors: { chats: ['oc_team'], users: ['a@example.com', 'on_1'], openIds: ['ou_x'] } });
  });

  it('rejects empty, malformed and oversized selections', () => {
    expect(parseGrantSelectors(undefined)).toMatchObject({ ok: false, error: 'subjects_required' });
    expect(parseGrantSelectors({ chats: [] })).toMatchObject({ ok: false, error: 'subjects_required' });
    expect(parseGrantSelectors({ chats: 'oc_team' })).toMatchObject({ ok: false, error: 'invalid_subjects' });
    expect(parseGrantSelectors({ chats: ['team'] })).toMatchObject({ ok: false, error: 'invalid_chat_id' });
    expect(parseGrantSelectors({ users: ['not-an-email'] })).toMatchObject({ ok: false, error: 'invalid_user' });
    expect(parseGrantSelectors({ openIds: ['on_1'] })).toMatchObject({ ok: false, error: 'invalid_open_id' });
    expect(parseGrantSelectors({ chats: Array.from({ length: 21 }, (_, i) => `oc_${i}`) }))
      .toMatchObject({ ok: false, error: 'too_many_subjects' });
    expect(parseGrantSelectors({ users: Array.from({ length: 2001 }, (_, i) => `u${i}@example.com`) }))
      .toMatchObject({ ok: false, error: 'too_many_subjects' });
  });

  it('points an ou_ given as a user to openIds, where it is checked against this app', () => {
    expect(parseGrantSelectors({ users: ['ou_copied'] })).toMatchObject({ ok: false, error: 'open_id_in_users' });
  });

  it('defaults to a permanent, unlimited grant and bounds explicit limits', () => {
    expect(parseGrantLimits({})).toEqual({ ok: true });
    expect(parseGrantLimits({ durationMs: 'permanent', quota: 'unlimited' })).toEqual({ ok: true });
    expect(parseGrantLimits({ durationMs: 3_600_000, quota: 20 })).toEqual({ ok: true, durationMs: 3_600_000, quota: 20 });
    expect(parseGrantLimits({ durationMs: 10 })).toMatchObject({ ok: false, error: 'invalid_duration' });
    expect(parseGrantLimits({ durationMs: '1h' })).toMatchObject({ ok: false, error: 'invalid_duration' });
    expect(parseGrantLimits({ quota: 0 })).toMatchObject({ ok: false, error: 'invalid_quota' });
    expect(parseGrantLimits({ quota: 1001 })).toMatchObject({ ok: false, error: 'invalid_quota' });
  });
});

describe('admin grants: resolving people with this bot app', () => {
  it('merges chat members, emails and open ids into one list keyed by open id', async () => {
    const { subjects, unresolved } = await resolveGrantSubjects(APP, {
      chats: ['oc_team'], users: ['b@example.com'], openIds: ['ou_c', 'ou_bot'],
    }, fakeDeps(), { verifyOpenIds: true });
    expect(subjects).toEqual([
      { openId: 'ou_a', name: 'A', sources: ['chat:oc_team'] },
      { openId: 'ou_b', name: 'B', sources: ['chat:oc_team', 'user:b@example.com'] },
      { openId: 'ou_c', name: 'name-ou_c', sources: ['openId:ou_c'] },
      // Outside the contact scope (or a bot) is still a valid id of this app.
      { openId: 'ou_bot', sources: ['openId:ou_bot'] },
    ]);
    expect(unresolved).toEqual([]);
  });

  it('reports what could not be resolved instead of dropping it silently', async () => {
    const { subjects, unresolved } = await resolveGrantSubjects(APP, {
      chats: ['oc_elsewhere'], users: ['gone@example.com'], openIds: ['ou_foreign', 'ou_flaky'],
    }, fakeDeps(), { verifyOpenIds: true });
    expect(subjects).toEqual([]);
    expect(unresolved).toEqual([
      { input: 'oc_elsewhere', reason: 'chat_members_unavailable', detail: 'Bot is not in the chat' },
      { input: 'gone@example.com', reason: 'user_not_found' },
      { input: 'ou_foreign', reason: 'cross_app_open_id' },
      { input: 'ou_flaky', reason: 'lookup_failed' },
    ]);
  });

  it('tells a transient email lookup failure apart from a user that does not exist', async () => {
    const { unresolved } = await resolveGrantSubjects(APP, { chats: [], users: ['x@example.com'], openIds: [] },
      fakeDeps({ resolveUsers: async () => ({ map: new Map(), definitiveMisses: [], errored: true }) }),
      { verifyOpenIds: true });
    expect(unresolved).toEqual([{ input: 'x@example.com', reason: 'lookup_failed' }]);
  });

  it('takes literal open ids as given when removing, so invalid entries can be deleted', async () => {
    const lookups: string[] = [];
    const { subjects } = await resolveGrantSubjects(APP, { chats: [], users: [], openIds: ['ou_foreign'] },
      fakeDeps({ lookupProfile: async (_app, id) => { lookups.push(id); return { status: 'cross_app' }; } }),
      { verifyOpenIds: false });
    expect(subjects).toEqual([{ openId: 'ou_foreign', sources: ['openId:ou_foreign'] }]);
    expect(lookups).toEqual([]);
  });
});
