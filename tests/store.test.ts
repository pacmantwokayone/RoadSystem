import { describe, it, expect } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import { StorageStore, type StorageLike } from '../src/store/storageStore';
import { HttpRoadStore } from '../src/store/httpStore';
import { sanitizeRoadsDocument } from '../src/network/doc';
import type { RoadsDocument } from '../src/network/types';
import type { RoadStore } from '../src/store/types';

const doc = (name = 'a'): RoadsDocument => ({
  version: 1,
  roads: [{ id: name, name, profile: 'hauptstrasse', points: [{ x: 0, y: 1, z: 2 }, { x: 10, y: 1, z: 2 }] }],
});

function revisionContract(make: () => RoadStore): void {
  it('first save yields revision 1, later saves increment', async () => {
    const s = make();
    expect(await s.loadRoads('loc')).toBeNull();
    const r1 = await s.saveRoads('loc', doc());
    expect(r1).toEqual({ ok: true, revision: 1 });
    const r2 = await s.saveRoads('loc', doc('b'), 1);
    expect(r2).toEqual({ ok: true, revision: 2 });
    const loaded = await s.loadRoads('loc');
    expect(loaded!.revision).toBe(2);
    expect(loaded!.roads[0].id).toBe('b');
  });

  it('a save based on a stale revision is a conflict and does not overwrite', async () => {
    const s = make();
    await s.saveRoads('loc', doc('a'));            // rev 1
    await s.saveRoads('loc', doc('b'), 1);         // rev 2 (someone else)
    const stale = await s.saveRoads('loc', doc('mine'), 1);
    expect(stale).toEqual({ ok: false, conflict: true, serverRevision: 2 });
    expect((await s.loadRoads('loc'))!.roads[0].id).toBe('b');
  });

  it('locations are independent; library has its own revision', async () => {
    const s = make();
    await s.saveRoads('one', doc('a'));
    expect(await s.loadRoads('two')).toBeNull();
    expect(await s.saveLibrary({ version: 1, profiles: { x: 'src' } })).toEqual({ ok: true, revision: 1 });
    expect(await s.saveLibrary({ version: 1, profiles: { x: 'src2' } }, 0)).toEqual({ ok: false, conflict: true, serverRevision: 1 });
    expect((await s.loadLibrary())!.profiles.x).toBe('src');
  });
}

describe('MemoryStore', () => { revisionContract(() => new MemoryStore()); });

describe('StorageStore', () => {
  const mem = (): StorageLike => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
  };
  revisionContract(() => new StorageStore(mem()));

  it('survives corrupt storage content', async () => {
    const s = new StorageStore({ getItem: () => '{not json', setItem: () => undefined });
    expect(await s.loadRoads('x')).toBeNull();
  });

  it('reports storage errors (quota) instead of throwing', async () => {
    const s = new StorageStore({ getItem: () => null, setItem: () => { throw new Error('quota'); } });
    expect(await s.saveRoads('x', doc())).toEqual({ ok: false, conflict: false, error: 'quota' });
  });
});

describe('HttpRoadStore (rivers-style PHP endpoints)', () => {
  type Call = { url: string; init?: RequestInit };
  function fake(handler: (c: Call) => { status?: number; body?: unknown } | 'throw'): { f: typeof fetch; calls: Call[] } {
    const calls: Call[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      const c = { url: String(url), init };
      calls.push(c);
      const r = handler(c);
      if (r === 'throw') throw new Error('offline');
      const status = r.status ?? 200;
      return { ok: status >= 200 && status < 300, status, json: async () => { if (r.body === undefined) throw new Error('no body'); return r.body; } } as Response;
    }) as unknown as typeof fetch;
    return { f, calls };
  }

  it('loads the static json first, falls back to the php endpoint, then null', async () => {
    const { f, calls } = fake((c) => (c.url.includes('roads-save.php') ? { body: doc() } : { status: 404 }));
    const s = new HttpRoadStore({ base: 'api', fetch: f });
    const d = await s.loadRoads('eiger');
    expect(d!.roads.length).toBe(1);
    expect(calls[0].url).toMatch(/^api\/roads-eiger\.json\?nc=/);
    expect(calls[1].url).toMatch(/^api\/roads-save\.php\?location=eiger&nc=/);

    const none = new HttpRoadStore({ base: 'api', fetch: fake(() => 'throw').f });
    expect(await none.loadRoads('eiger')).toBeNull();
  });

  it('POSTs { location, roads, baseRevision } like rivers-save.php and reads the revision back', async () => {
    const { f, calls } = fake(() => ({ body: { ok: true, revision: 7 } }));
    const s = new HttpRoadStore({ base: 'api', fetch: f });
    const r = await s.saveRoads('eiger', doc(), 6);
    expect(r).toEqual({ ok: true, revision: 7 });
    expect(calls[0].url).toBe('api/roads-save.php');
    expect(calls[0].init!.method).toBe('POST');
    expect(JSON.parse(calls[0].init!.body as string)).toMatchObject({ location: 'eiger', baseRevision: 6 });
  });

  it('works against a server that ignores revisions (200 without body)', async () => {
    const s = new HttpRoadStore({ base: 'api', fetch: fake(() => ({})).f });
    expect(await s.saveRoads('x', doc(), 3)).toEqual({ ok: true, revision: 4 });
  });

  it('maps 409 to a conflict (with the server revision) and other failures to errors', async () => {
    const s409 = new HttpRoadStore({ base: 'api', fetch: fake(() => ({ status: 409, body: { revision: 9 } })).f });
    expect(await s409.saveRoads('x', doc(), 3)).toEqual({ ok: false, conflict: true, serverRevision: 9 });
    const s500 = new HttpRoadStore({ base: 'api', fetch: fake(() => ({ status: 500 })).f });
    expect(await s500.saveRoads('x', doc())).toEqual({ ok: false, conflict: false, error: 'HTTP 500' });
    const off = new HttpRoadStore({ base: 'api', fetch: fake(() => 'throw').f });
    expect(await off.saveRoads('x', doc())).toEqual({ ok: false, conflict: false, error: 'offline' });
  });

  it('library endpoints', async () => {
    const { f, calls } = fake((c) => (c.init?.method === 'POST' ? { body: { revision: 2 } } : { body: { profiles: { a: 'src', b: 5 }, revision: 1 } }));
    const s = new HttpRoadStore({ base: 'api', fetch: f });
    expect((await s.loadLibrary())!.profiles).toEqual({ a: 'src' }); // non-string sources dropped
    expect(await s.saveLibrary({ version: 1, profiles: { a: 'x' } }, 1)).toEqual({ ok: true, revision: 2 });
    expect(calls.at(-1)!.url).toBe('api/roadlib-save.php');
  });
});

describe('sanitizeRoadsDocument', () => {
  it('drops garbage, clamps attributes, dedupes ids and keeps valid data', () => {
    const d = sanitizeRoadsDocument({
      revision: 3.7,
      roads: [
        { id: 'a', name: 'ok', profile: 'flurstrasse', params: { w: 3, evil: { x: 1 }, g: true }, points: [
          { x: 0, y: 0, z: 0, widthScale: 99, mode: 'bridge', elev: 'fixed', banking: 9 },
          { x: 1, y: 'x', z: 0 },
          { x: 5, y: 0, z: 5, mode: 'nonsense' },
        ] },
        { id: 'a', points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }] },
        { id: 'short', points: [{ x: 0, y: 0, z: 0 }] },
        'junk', null,
      ],
    });
    expect(d.revision).toBe(3);
    expect(d.roads.map((r) => r.id)).toEqual(['a', 'a_']);
    const p = d.roads[0].points;
    expect(p.length).toBe(2); // the point with a string y was dropped
    expect(p[0]).toMatchObject({ widthScale: 10, mode: 'bridge', elev: 'fixed', banking: 0.5 });
    expect(p[1].mode).toBeUndefined();
    expect(d.roads[0].params).toEqual({ w: 3, g: true });
    expect(d.roads[1].profile).toBe('hauptstrasse');
  });

  it('accepts nothing / non-objects', () => {
    expect(sanitizeRoadsDocument(null).roads).toEqual([]);
    expect(sanitizeRoadsDocument('x').roads).toEqual([]);
  });
});
