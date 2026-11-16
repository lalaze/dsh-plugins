import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidatesOf } from '../src/machines.js';
import { parseIds, statusOf, whoisOf } from '../src/tailscale.js';

// Shapes as `tailscale status --json` and `whois --json` print them (1.9x); ids are 17 digits, past 2^53.
const STATUS = `{
  "BackendState": "Running",
  "Self": { "ID": "n4u86tzd6121CNTRL", "HostName": "lalaze的Mac mini", "DNSName": "lalazemac-mini.tailcec3d.ts.net.", "OS": "macOS", "TailscaleIPs": ["100.96.195.115", "fd7a:115c:a1e0::8035:c373"], "UserID": 15042353428159710, "Online": true },
  "Peer": {
    "a": { "ID": "nA", "HostName": "air", "DNSName": "lalazemacbook-air.tailcec3d.ts.net.", "OS": "macOS", "TailscaleIPs": ["100.125.78.115"], "UserID": 15042353428159710, "Online": true, "LastSeen": "0001-01-01T00:00:00Z", "Tags": null },
    "b": { "ID": "nB", "HostName": "phone", "DNSName": "xiaomi-15.tailcec3d.ts.net.", "OS": "android", "TailscaleIPs": ["100.126.125.107"], "UserID": 15042353428159710, "Online": true },
    "c": { "ID": "nC", "HostName": "openwrt", "DNSName": "openwrt.tailcec3d.ts.net.", "OS": "linux", "TailscaleIPs": ["100.74.97.31"], "UserID": 10684018700872918, "Online": true, "Tags": ["tag:router"] },
    "d": { "ID": "nD", "HostName": "other", "DNSName": "other.tailcec3d.ts.net.", "OS": "linux", "TailscaleIPs": ["100.1.1.1"], "UserID": 15042353428159711, "Online": true },
    "e": { "ID": "nE", "HostName": "DESKTOP", "DNSName": "desktop.tailcec3d.ts.net.", "OS": "windows", "TailscaleIPs": ["100.95.54.120"], "UserID": 15042353428159710, "Online": false, "LastSeen": "2026-10-19T02:24:42.1Z" }
  }
}`;

test('17-digit user ids keep every digit', () => {
  assert.equal((parseIds('{"UserID": 15042353428159711}') as { UserID: string }).UserID, '15042353428159711');
  const status = statusOf(STATUS);
  assert.equal(status.self.userId, '15042353428159710');
  assert.equal(status.peers.find(node => node.id === 'nD')!.userId, '15042353428159711');
  assert.notEqual(status.self.userId, status.peers.find(node => node.id === 'nD')!.userId);
});

test('status: names from MagicDNS, tags, last seen', () => {
  const status = statusOf(STATUS);
  assert.equal(status.running, true);
  assert.equal(status.self.name, 'lalazemac-mini');
  assert.equal(status.self.dnsName, 'lalazemac-mini.tailcec3d.ts.net');
  assert.equal(status.peers.find(node => node.id === 'nC')!.tagged, true);
  assert.equal(status.peers.find(node => node.id === 'nA')!.lastSeen, undefined);
  assert.equal(status.peers.find(node => node.id === 'nE')!.lastSeen, Date.parse('2026-10-19T02:24:42.1Z'));
});

test('candidates: only the same user\'s untagged computers, on the shared port, plus configured ones', () => {
  const list = candidatesOf(statusOf(STATUS), 7390, ['100.9.9.9:7390', 'http://100.125.78.115:7390/'], true);
  assert.deepEqual(list.map(candidate => [candidate.url, candidate.source, candidate.online]), [
    ['http://100.9.9.9:7390', 'static', true],
    ['http://100.125.78.115:7390', 'static', true],
    ['http://100.95.54.120:7390', 'tailnet', false],
  ]);
  assert.deepEqual(candidatesOf(statusOf(STATUS), 7390, [], false), []);
});

test('whois: the owner of a person\'s device, nothing for a tagged one', () => {
  assert.deepEqual(whoisOf('{"Node":{"ID":5637400046092310,"Name":"lalazemacbook-air.tailcec3d.ts.net.","User":15042353428159710},"UserProfile":{"ID":15042353428159710,"LoginName":"someone@example.com"}}'),
    { userId: '15042353428159710', node: 'lalazemacbook-air' });
  assert.equal(whoisOf('{"Node":{"ID":1,"Name":"openwrt.x.ts.net.","User":10684018700872918,"Tags":["tag:router"]},"UserProfile":{"ID":10684018700872918,"LoginName":"tagged-devices"}}'), undefined);
});
