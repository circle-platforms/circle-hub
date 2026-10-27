// matchNeed: which bed fits the need — device counts and types, the build (exact name or two names of one base
// build), leases and the earliest-free time, ordering and the wording "Hub 记录里空闲（未排除本地操作）".
// Synthetic data only (bed-*, Rel_FAMX_10_6_1_* names, leases on bed/<bed>/<device> keys).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchNeed, unmatchedBuildExit, type Installed, type LeaseEntry } from './match.ts';
import type { ManifestBed } from './manifest.ts';

const NOW = '2026-10-22T08:00:00.000Z';

/** bed-a: 2 load balancers, 1 router, 2 clients, 1 server. bed-b: 1 load balancer, 1 client, no router. */
const beds: ManifestBed[] = [
  {
    name: 'bed-a',
    devices: [
      { name: 'afamx0', type: 'load-balancer', product: null, ipv4: [], ipv6: [] },
      { name: 'afamx1', type: 'load-balancer', product: null, ipv4: [], ipv6: [] },
      { name: 'router0', type: 'router', product: null, ipv4: [], ipv6: [] },
      { name: 'client0', type: 'client', product: null, ipv4: [], ipv6: [] },
      { name: 'client1', type: 'client', product: null, ipv4: [], ipv6: [] },
      { name: 'server0', type: 'server', product: null, ipv4: [], ipv6: [] },
    ],
    services: [],
    reserved: [],
    baseline: [],
  },
  {
    name: 'bed-b',
    devices: [
      { name: 'lb0', type: 'load-balancer', product: null, ipv4: [], ipv6: [] },
      { name: 'cli0', type: 'client', product: null, ipv4: [], ipv6: [] },
    ],
    services: [],
    reserved: [],
    baseline: [],
  },
];

const noInstalled: Record<string, Installed> = {};
const noLeases: Record<string, LeaseEntry> = {};
const need = { devices: [{ type: 'load-balancer', count: 1 }, { type: 'router', count: 1 }], hours: 2 };

describe('matchNeed without a build requirement', () => {
  it('both beds match on devices? no: bed-b has no router; the matching bed is idle with the Hub-records wording', () => {
    const answer = matchNeed(beds, need, noInstalled, {}, noLeases, NOW);
    const a = answer.find((b) => b.bed === 'bed-a')!;
    const b = answer.find((b) => b.bed === 'bed-b')!;
    assert.equal(a.devicesOk, true);
    assert.match(a.conclusion, /^Hub 记录里空闲（未排除本地操作）$/);
    assert.equal(b.devicesOk, false);
    assert.match(b.conclusion, /需要 1 台路由器，台架里有 0 台/);
  });
  it('a needed device leased until 10:30: the bed matches with that earliest-free time', () => {
    const leases = { 'bed/bed-a/router0': { until: '2026-10-22T10:30:00.000Z' } };
    const answer = matchNeed(beds, need, noInstalled, {}, leases, NOW);
    const a = answer.find((b) => b.bed === 'bed-a')!;
    assert.equal(a.devicesOk, true);
    assert.equal(a.earliestFree, '2026-10-22T10:30:00.000Z');
    assert.match(a.conclusion, /^Hub 记录里最早 2026-10-22T10:30:00\.000Z 空闲（未排除本地操作）$/);
  });
  it('the pick prefers free devices: a leased spare load balancer does not make the bed busy; leases of unneeded types are ignored', () => {
    const leases = {
      'bed/bed-a/afamx0': { until: '2026-10-22T09:00:00.000Z' }, // afamx1 is free and picked instead
      'bed/bed-a/server0': { until: '2026-10-23T09:00:00.000Z' }, // server is not a needed type
    };
    const answer = matchNeed(beds, need, noInstalled, {}, leases, NOW);
    const a = answer.find((b) => b.bed === 'bed-a')!;
    assert.equal(a.earliestFree, null);
    assert.match(a.conclusion, /^Hub 记录里空闲（未排除本地操作）$/);
  });
  it('an expired lease counts as free', () => {
    const leases = { 'bed/bed-a/router0': { until: '2026-10-21T10:30:00.000Z' } };
    const answer = matchNeed(beds, need, noInstalled, {}, leases, NOW);
    assert.equal(answer.find((b) => b.bed === 'bed-a')!.earliestFree, null);
  });
  it('a bed without the needed device counts says what is missing', () => {
    const bigger = { devices: [{ type: 'load-balancer', count: 1 }, { type: 'router', count: 2 }], hours: 1 };
    const answer = matchNeed(beds, bigger, noInstalled, {}, noLeases, NOW);
    assert.match(answer.find((b) => b.bed === 'bed-a')!.conclusion, /需要 2 台路由器，台架里有 1 台/);
    assert.match(answer.find((b) => b.bed === 'bed-b')!.conclusion, /需要 2 台路由器，台架里有 0 台/);
  });
});

describe('matchNeed with a build requirement', () => {
  const buildNeed = { devices: [{ type: 'load-balancer', count: 1 }], build: 'Rel_FAMX_10_6_1_8', hours: 2 };
  it('the exact build on the picked device: match, with the source', () => {
    const installed: Record<string, Installed> = { 'bed/bed-a/afamx0': { build: 'Rel_FAMX_10_6_1_8', source: 'observed', at: '2026-10-20T00:00:00.000Z' } };
    const answer = matchNeed(beds, buildNeed, installed, {}, noLeases, NOW);
    assert.equal(answer.find((b) => b.bed === 'bed-a')!.buildOk, 'match');
    assert.equal(answer.find((b) => b.bed === 'bed-a')!.buildSource, 'observed');
  });
  it('two names of one base build are the same build (FAMY name based on the FAMX build)', () => {
    const installed: Record<string, Installed> = { 'bed/bed-a/afamx0': { build: 'Rel_FAMY_10_6_1_8', source: 'declared', at: '2026-10-20T00:00:00.000Z' } };
    const builds = { 'Rel_FAMY_10_6_1_8': 'Rel_FAMX_10_6_1_8' };
    const answer = matchNeed(beds, buildNeed, installed, builds, noLeases, NOW);
    assert.equal(answer.find((b) => b.bed === 'bed-a')!.buildOk, 'match');
    assert.equal(answer.find((b) => b.bed === 'bed-a')!.buildSource, 'declared');
  });
  it('a different base build: mismatch, the conclusion says 需要升级', () => {
    const installed: Record<string, Installed> = { 'bed/bed-a/afamx0': { build: 'Rel_FAMX_10_6_1_9', source: 'declared', at: '2026-10-20T00:00:00.000Z' } };
    const answer = matchNeed(beds, buildNeed, installed, {}, noLeases, NOW);
    assert.equal(answer.find((b) => b.bed === 'bed-a')!.buildOk, 'mismatch');
    assert.match(answer.find((b) => b.bed === 'bed-a')!.conclusion, /需要升级/);
  });
  it('a declared record is shown as declared and unchecked (声明，未核对), on a match and on a mismatch', () => {
    const match = matchNeed(beds, buildNeed, { 'bed/bed-a/afamx0': { build: 'Rel_FAMX_10_6_1_8', source: 'declared', at: '2026-10-20T00:00:00.000Z' } }, {}, noLeases, NOW);
    assert.match(match.find((b) => b.bed === 'bed-a')!.conclusion, /构建一致（Rel_FAMX_10_6_1_8，声明，未核对）/);
    const mismatch = matchNeed(beds, buildNeed, { 'bed/bed-a/afamx0': { build: 'Rel_FAMX_10_6_1_9', source: 'declared', at: '2026-10-20T00:00:00.000Z' } }, {}, noLeases, NOW);
    assert.match(mismatch.find((b) => b.bed === 'bed-a')!.conclusion, /构建不一致（装的是 Rel_FAMX_10_6_1_9，需要升级到 Rel_FAMX_10_6_1_8，声明，未核对）/);
  });
  it('no install record at all: unknown, never mismatch; source none', () => {
    const answer = matchNeed(beds, buildNeed, noInstalled, {}, noLeases, NOW);
    const a = answer.find((b) => b.bed === 'bed-a')!;
    assert.equal(a.buildOk, 'unknown');
    assert.equal(a.buildSource, 'none');
    assert.doesNotMatch(a.conclusion, /需要升级/);
  });
  it('no bed matches the required build: unknown names the version line, each deciding device and the exit; per-bed fields stay', () => {
    const need = { devices: [{ type: 'load-balancer', count: 1 }], build: 'Rel_FAMX_10_6_1_9' };
    const installed: Record<string, Installed> = { 'bed/bed-a/afamx0': { build: 'Rel_FAMX_10_6_1_8', source: 'declared', at: '2026-10-20T00:00:00.000Z' } };
    const matches = matchNeed(beds, need, installed, {}, noLeases, NOW);
    assert.equal(matches.find((row) => row.bed === 'bed-a')!.buildOk, 'mismatch');
    assert.equal(matches.find((row) => row.bed === 'bed-b')!.buildOk, 'unknown');
    const gap = unmatchedBuildExit(beds, need, installed, {}, noLeases, NOW, matches);
    assert.ok(gap);
    assert.equal(gap.verdict, 'unknown');
    assert.match(gap.missing, /没有任何台架的在装构建匹配版本线 Rel_FAMX_10_6_1_9/);
    assert.match(gap.missing, /bed-a\/afamx0 装的是 Rel_FAMX_10_6_1_8/);
    assert.match(gap.missing, /缺在装构建记录：bed-b\/lb0/);
    assert.equal(gap.fix, '管理员在清单登记在装构建，或把某台升级到该构建后重试');
    const matched = matchNeed(beds, { ...need, build: 'Rel_FAMX_10_6_1_8' }, installed, {}, noLeases, NOW);
    assert.equal(unmatchedBuildExit(beds, { ...need, build: 'Rel_FAMX_10_6_1_8' }, installed, {}, noLeases, NOW, matched), null);
  });
  it('the install record of a leased spare does not decide: the pick is the free device', () => {
    const installed: Record<string, Installed> = { 'bed/bed-a/afamx1': { build: 'Rel_FAMX_10_6_1_9', source: 'declared', at: '2026-10-20T00:00:00.000Z' } };
    const leases = { 'bed/bed-a/afamx1': { until: '2026-10-22T09:00:00.000Z' } };
    const answer = matchNeed(beds, buildNeed, installed, {}, leases, NOW);
    assert.equal(answer.find((b) => b.bed === 'bed-a')!.buildOk, 'unknown', 'afamx0 (free) has no record; afamx1 is leased');
  });
});

describe('matchNeed ordering', () => {
  it('free and matching first (fewer spare devices among them), then earliest free time, then by name', () => {
    const all: ManifestBed[] = [
      { name: 'bed-c', devices: [beds[0].devices[0], beds[0].devices[2]], services: [], reserved: [], baseline: [] },
      ...beds,
    ];
    const leases = { 'bed/bed-b/lb0': { until: '2026-10-22T09:00:00.000Z' } };
    const answer = matchNeed(all, need, noInstalled, {}, leases, NOW);
    // bed-c: matching and idle, no spare; bed-a: matching and idle with spares; bed-b: no router (last).
    assert.deepEqual(answer.map((b) => b.bed), ['bed-c', 'bed-a', 'bed-b']);
  });
});
