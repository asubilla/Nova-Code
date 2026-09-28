import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyNovaVersionPayload,
  discoverLocalInstances,
  isNovaHealthPayload,
  listLoopbackListeningPorts,
  parseListeningPorts,
  probeLocalCandidate,
} from './instance-discovery.mjs';

const netstatWindows = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:57123        0.0.0.0:0              LISTENING       4321
  TCP    0.0.0.0:45999          0.0.0.0:0              LISTENING       6468
  TCP    127.0.0.1:57123        127.0.0.1:50413        TIME_WAIT       0
  TCP    192.168.1.10:135       0.0.0.0:0              LISTENING       888
  UDP    0.0.0.0:5353           *:*                                    1234
`;

const ssLinux = `
LISTEN 0 512 127.0.0.1:4096 0.0.0.0:*
LISTEN 0 512 127.0.0.1:631 0.0.0.0:*
LISTEN 0 128 *:22 *:*
`;

const netstatMac = `
tcp4  0  0  127.0.0.1.57199  *.*  LISTEN
tcp4  0  0  *.631            *.*  LISTEN
tcp4 10  0  127.0.0.1.57199  127.0.0.1.52000  ESTABLISHED
`;

test('parseListeningPorts reads Windows netstat rows and ignores non-listening sockets', () => {
  assert.deepEqual(parseListeningPorts(netstatWindows), [45999, 57123]);
});

test('parseListeningPorts reads ss output including wildcard binds', () => {
  assert.deepEqual(parseListeningPorts(ssLinux), [22, 631, 4096].sort((a, b) => a - b));
});

test('parseListeningPorts reads the macOS dot-separated form', () => {
  assert.deepEqual(parseListeningPorts(netstatMac), [631, 57199]);
});

test('parseListeningPorts survives garbage input', () => {
  assert.deepEqual(parseListeningPorts(''), []);
  assert.deepEqual(parseListeningPorts(undefined), []);
  assert.deepEqual(parseListeningPorts('LISTEN 0 0 nothing-here'), []);
});

test('classifyNovaVersionPayload mirrors the host probe policy', () => {
  assert.equal(classifyNovaVersionPayload({
    status: 'ok',
    compatibility: { capabilities: ['api.runtime-url.v1'], apiVersion: 1, minClientApiVersion: 1 },
  }), 'ok');
  assert.equal(classifyNovaVersionPayload({
    status: 'ok',
    compatibility: { capabilities: [], apiVersion: 1, minClientApiVersion: 1 },
  }), 'incompatible');
  assert.equal(classifyNovaVersionPayload({
    status: 'ok',
    compatibility: { capabilities: ['api.runtime-url.v1'], apiVersion: 2, minClientApiVersion: 1 },
  }), 'update-recommended');
  assert.equal(classifyNovaVersionPayload({ status: 'ok', novacodeVersion: '1.0.0' }), 'incompatible');
  assert.equal(classifyNovaVersionPayload({ status: 'ok', name: 'something-else' }), null);
  assert.equal(classifyNovaVersionPayload(null), null);
  assert.equal(classifyNovaVersionPayload('ok'), null);
});

test('isNovaHealthPayload only accepts the Nova Code health envelope', () => {
  assert.equal(isNovaHealthPayload({ status: 'ok', runtime: 'opencode' }), true);
  assert.equal(isNovaHealthPayload({ status: 'ok', novacodeVersion: '1.2.3' }), true);
  assert.equal(isNovaHealthPayload({ status: 'ok' }), false);
  assert.equal(isNovaHealthPayload({ ready: true }), false);
});

const jsonResponse = (status, payload, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  json: async () => payload,
});

test('probeLocalCandidate identifies a Nova Code server via /api/version', async () => {
  const result = await probeLocalCandidate(57123, {
    fetchImpl: async (url) => url.endsWith('/api/version')
      ? jsonResponse(200, {
        status: 'ok',
        novacodeVersion: '1.24.2',
        compatibility: { capabilities: ['api.runtime-url.v1'], apiVersion: 1, minClientApiVersion: 1 },
      })
      : jsonResponse(404, null),
  });
  assert.equal(result?.kind, 'novacode');
  assert.equal(result?.status, 'ok');
  assert.equal(result?.url, 'http://127.0.0.1:57123');
});

test('probeLocalCandidate identifies a standalone official OpenCode server', async () => {
  const challenge = { 'www-authenticate': 'Basic realm="Secure Area"' };
  const result = await probeLocalCandidate(45999, {
    fetchImpl: async () => jsonResponse(401, null, challenge),
  });
  assert.equal(result?.kind, 'opencode');
  assert.equal(result?.status, 'auth');
});

test('probeLocalCandidate falls back to /health for auth-gated Nova Code servers', async () => {
  const result = await probeLocalCandidate(57123, {
    fetchImpl: async (url) => url.endsWith('/api/version')
      ? jsonResponse(401, { error: 'unauthorized' })
      : jsonResponse(200, { status: 'ok', novacodeVersion: '1.24.2', runtime: 'opencode' }),
  });
  assert.equal(result?.kind, 'novacode');
});

test('probeLocalCandidate ignores unrelated local services', async () => {
  const result = await probeLocalCandidate(631, {
    fetchImpl: async () => jsonResponse(404, null),
  });
  assert.equal(result, null);
});

test('probeLocalCandidate treats connection failures as not ours', async () => {
  const result = await probeLocalCandidate(12345, {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(result, null);
});

test('discoverLocalInstances always probes static ports and caps the pool', async () => {
  const probed = [];
  const result = await discoverLocalInstances({
    listPorts: async () => ({ ok: true, ports: [7001, 7002] }),
    probe: async (port) => {
      probed.push(port);
      return port === 57123
        ? { port, url: `http://127.0.0.1:${port}`, kind: 'novacode', status: 'ok', latencyMs: 1 }
        : null;
    },
  });
  assert.equal(result.ok, true);
  assert.ok(probed.includes(57123), 'static port must be probed');
  assert.ok(probed.includes(7001), 'scanned ports must be probed');
  assert.equal(result.instances.length, 1);
});

test('discoverLocalInstances reports a failed port listing without throwing', async () => {
  const result = await discoverLocalInstances({
    listPorts: async () => { throw new Error('no netstat'); },
    probe: async () => null,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.instances, []);
});

test('listLoopbackListeningPorts surfaces listing failures as ok:false', async () => {
  const failed = await listLoopbackListeningPorts({
    platform: 'linux',
    exec: async () => { throw new Error('ENOENT'); },
  });
  assert.deepEqual(failed, { ok: false, ports: [] });

  const listed = await listLoopbackListeningPorts({
    platform: 'linux',
    exec: async () => ssLinux,
  });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.ports, [22, 631, 4096].sort((a, b) => a - b));
});
