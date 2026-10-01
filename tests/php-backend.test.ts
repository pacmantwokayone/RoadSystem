// Integration: the real HttpRoadStore against the reference PHP backend (docs/backend) running on
// PHP's built-in server with SQLite. Skipped automatically where PHP/pdo_sqlite is unavailable.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpRoadStore } from '../src/store/httpStore';
import type { RoadsDocument } from '../src/network/types';

const phpOk = (() => {
  const r = spawnSync('php', ['-r', 'echo extension_loaded("pdo_sqlite") ? "1" : "0";'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === '1';
})();

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });

async function startPhp(dir: string, env: Record<string, string>): Promise<{ proc: ChildProcess; base: string }> {
  const port = await freePort();
  const proc = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', 'docs/backend'], {
    env: { ...process.env, PHP_CLI_SERVER_WORKERS: '4', ROADS_DB_DSN: `sqlite:${join(dir, 'roads.sqlite')}`, ...env },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${base}/roads-save.php?location=ping`); return { proc, base }; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  proc.kill();
  throw new Error('php server did not start');
}

const doc = (name: string): RoadsDocument => ({
  version: 1,
  roads: [{ id: name, name, profile: 'hauptstrasse', points: [{ x: 0, y: 1, z: 2 }, { x: 10, y: 1, z: 2, mode: 'bridge' }] }],
});

describe.skipIf(!phpOk)('HttpRoadStore ↔ reference PHP backend', () => {
  let dir: string;
  let rw: { proc: ChildProcess; base: string };
  let ro: { proc: ChildProcess; base: string };
  let store: HttpRoadStore;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'roads-php-'));
    rw = await startPhp(dir, { ROADS_ENV: 'test', ROADS_ALLOW_ALL: '1' });
    ro = await startPhp(dir, {}); // same database, no editor rights
    store = new HttpRoadStore({ base: rw.base, fetch: globalThis.fetch });
  }, 30000);

  afterAll(() => {
    rw?.proc.kill(); ro?.proc.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('nothing stored yet → load returns null (404 is not an error)', async () => {
    expect(await store.loadRoads('eiger')).toBeNull();
    expect(await store.loadLibrary()).toBeNull();
  });

  it('save → load round trip with revisions', async () => {
    expect(await store.saveRoads('eiger', doc('a'))).toEqual({ ok: true, revision: 1 });
    const loaded = await store.loadRoads('eiger');
    expect(loaded!.revision).toBe(1);
    expect(loaded!.roads[0].points[1].mode).toBe('bridge'); // attributes survive the server
    expect(await store.saveRoads('eiger', doc('b'), 1)).toEqual({ ok: true, revision: 2 });
    expect((await store.loadRoads('eiger'))!.roads[0].id).toBe('b');
  });

  it('junction nodes round-trip with the roads', async () => {
    const withNode: RoadsDocument = {
      version: 1,
      roads: [
        { id: 'a', name: 'a', profile: 'hauptstrasse', points: [{ x: 0, y: 1, z: 0 }, { x: 10, y: 1, z: 0 }], endNode: 'n' },
        { id: 'b', name: 'b', profile: 'hauptstrasse', points: [{ x: 10, y: 1, z: 0 }, { x: 20, y: 1, z: 0 }], startNode: 'n' },
      ],
      nodes: [{ id: 'n', x: 10, y: 1, z: 0, radius: 8 }],
    };
    expect(await store.saveRoads('nodes', withNode)).toEqual({ ok: true, revision: 1 });
    const back = await store.loadRoads('nodes');
    expect(back!.nodes).toEqual([{ id: 'n', x: 10, y: 1, z: 0, radius: 8 }]);
    expect(back!.roads[0].endNode).toBe('n');
    const bad = (await fetch(`${rw.base}/roads-save.php`, { method: 'POST', body: JSON.stringify({ location: 'x', roads: [], nodes: [{ id: 'n', x: 'oops' }] }) })).status;
    expect(bad).toBe(400);
  });

  it('a stale base revision is a 409 conflict carrying the server revision; nothing is overwritten', async () => {
    const r = await store.saveRoads('eiger', doc('mine'), 1);
    expect(r).toEqual({ ok: false, conflict: true, serverRevision: 2 });
    expect((await store.loadRoads('eiger'))!.roads[0].id).toBe('b');
    // explicit overwrite (no base revision) succeeds — what the editor does after the user confirms
    expect(await store.saveRoads('eiger', doc('forced'))).toEqual({ ok: true, revision: 3 });
  });

  it('locations are independent', async () => {
    expect(await store.saveRoads('jungfrau', doc('j'))).toEqual({ ok: true, revision: 1 });
    expect((await store.loadRoads('eiger'))!.roads[0].id).toBe('forced');
  });

  it('concurrent saves from the same base revision: exactly one wins', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => store.saveRoads('race', doc(`r${i}`))));
    // all six are first-saves without base → they all succeed sequentially; now race WITH a base revision
    expect(results.filter((r) => r.ok).length).toBeGreaterThan(0);
    const base = (await store.loadRoads('race'))!.revision!;
    const race = await Promise.all(Array.from({ length: 6 }, (_, i) => store.saveRoads('race', doc(`x${i}`), base)));
    expect(race.filter((r) => r.ok)).toHaveLength(1);
    expect(race.filter((r) => !r.ok && r.conflict)).toHaveLength(5);
    expect((await store.loadRoads('race'))!.revision).toBe(base + 1);
  });

  it('library round trip and conflict', async () => {
    expect(await store.saveLibrary({ version: 1, profiles: { kanton: 'export default (p, R) => R.profile("k")' } })).toEqual({ ok: true, revision: 1 });
    const lib = await store.loadLibrary();
    expect(lib!.profiles.kanton).toContain('R.profile');
    expect(await store.saveLibrary({ version: 1, profiles: {} }, 0)).toEqual({ ok: false, conflict: true, serverRevision: 1 });
  });

  it('materials travel with the library document and are validated like profiles', async () => {
    const lib = await store.loadLibrary();
    const rev = lib!.revision!;
    const r = await store.saveLibrary({ version: 1, profiles: lib!.profiles, materials: { kantonsrot: 'export default (M) => M.paint({ color: 0xaa2222, tileM: 1, noise: 0 })' } }, rev);
    expect(r.ok).toBe(true);
    const back = await store.loadLibrary();
    expect(back!.materials!.kantonsrot).toContain('M.paint');
    const bad = (await fetch(`${rw.base}/roadlib-save.php`, { method: 'POST', body: JSON.stringify({ profiles: {}, materials: { '../x': 'code' } }) })).status;
    expect(bad).toBe(400);
  });

  it('bridge types travel with the library document, and the road keeps its bridge fields', async () => {
    const lib = await store.loadLibrary();
    const rev = lib!.revision!;
    const src = "export default (p, B) => B.bridge('x').deck({ thickness: 1.1 }).railing('parapet');";
    const r = await store.saveLibrary({ version: 1, profiles: lib!.profiles, materials: lib!.materials, bridges: { meinesteg: src } }, rev);
    expect(r.ok).toBe(true);
    const back = await store.loadLibrary();
    expect(back!.bridges!.meinesteg).toBe(src);
    expect(back!.materials!.kantonsrot).toContain('M.paint'); // earlier parts of the document are untouched
    const bad = (await fetch(`${rw.base}/roadlib-save.php`, { method: 'POST', body: JSON.stringify({ profiles: {}, bridges: { '../x': 'code' } }) })).status;
    expect(bad).toBe(400);
    const road = { id: 'b1', name: 'b1', profile: 'hauptstrasse', bridge: 'meinesteg', bridgeParams: { maxSpan: 20 }, points: [{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0, mode: 'bridge' }, { x: 200, y: 0, z: 0, mode: 'bridge' }, { x: 300, y: 0, z: 0 }] };
    const saved = await store.saveRoads('brtest', { version: 1, roads: [road] } as never);
    expect(saved.ok).toBe(true);
    const loaded = await store.loadRoads('brtest');
    expect(loaded!.roads[0].bridge).toBe('meinesteg');
    expect(loaded!.roads[0].bridgeParams).toEqual({ maxSpan: 20 });
    expect(loaded!.roads[0].points[1].mode).toBe('bridge');
  });

  it('rejects invalid input', async () => {
    const bad = async (body: unknown): Promise<number> => (await fetch(`${rw.base}/roads-save.php`, { method: 'POST', body: JSON.stringify(body) })).status;
    expect(await bad({ location: '../etc/passwd', roads: [] })).toBe(400);
    expect(await bad({ location: 'x', roads: 'nope' })).toBe(400);
    expect(await bad({ location: 'x', roads: [{ id: 5, points: [] }] })).toBe(400);
    const badName = (await fetch(`${rw.base}/roadlib-save.php`, { method: 'POST', body: JSON.stringify({ profiles: { '../x': 'code' } }) })).status;
    expect(badName).toBe(400);
    expect((await fetch(`${rw.base}/roads-save.php?location=..%2Fx`)).status).toBe(400);
  });

  it('writes are refused without editor rights (profiles are executable code); reads stay public', async () => {
    const denied = new HttpRoadStore({ base: ro.base, fetch: globalThis.fetch });
    expect(await denied.saveRoads('eiger', doc('hacker'), 3)).toEqual({ ok: false, conflict: false, error: 'HTTP 403' });
    expect(await denied.saveLibrary({ version: 1, profiles: { x: 'evil()' } })).toEqual({ ok: false, conflict: false, error: 'HTTP 403' });
    expect((await denied.loadRoads('eiger'))!.roads[0].id).toBe('forced');
  });
});
