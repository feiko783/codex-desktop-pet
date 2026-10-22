'use strict';

const assert = require('assert');
const { codexThreadUrl, openChamberSessionUrl, focusSession, selectDesktopPid } = require('../backend/focus');
const adapter = require('../backend/adapter');

async function run() {
  assert.strictEqual(
    codexThreadUrl({ id: '019fe5c2-6cb3-7713-8feb-846d1882fcb6', agentId: 'codex' }),
    'codex://threads/019fe5c2-6cb3-7713-8feb-846d1882fcb6',
    'Codex sessions should map to their exact Desktop thread deep link',
  );
  assert.strictEqual(codexThreadUrl({ id: 'bad/path', agentId: 'codex' }), null);
  assert.strictEqual(codexThreadUrl({ id: 'abc', agentId: 'claude-code' }), null);
  assert.strictEqual(typeof openChamberSessionUrl, 'function', 'OpenChamber needs a validated session URL builder');
  assert.strictEqual(openChamberSessionUrl({ id: 'ses_task-123', agentId: 'opencode' }),
    'openchamber://session/ses_task-123');
  for (const id of ['', 'bad/path', 'id?message=other', 'id#fragment', 'id%2Fother', 'id\n', 'a'.repeat(129), 123, {}]) {
    assert.strictEqual(openChamberSessionUrl({ id, agentId: 'opencode' }), null, 'untrusted IDs cannot change protocol structure');
  }
  assert.strictEqual(openChamberSessionUrl({ id: 'ses_123', agentId: 'zcode' }), null);

  const opened = [];
  const codexResult = await focusSession(
    { id: 'thread-123', agentId: 'codex', sourcePid: null },
    {
      openExternal: async (url) => opened.push(url),
      activatePids: async () => { throw new Error('PID fallback should not run'); },
    },
  );
  assert.deepStrictEqual(codexResult, { ok: true, mode: 'session', agentId: 'codex' });
  assert.deepStrictEqual(opened, ['codex://threads/thread-123']);

  let fallbackPids = null;
  const fallbackResult = await focusSession(
    { id: 'thread-456', agentId: 'codex', sourcePid: 42, pidChain: [42, 84] },
    {
      openExternal: async () => { throw new Error('protocol unavailable'); },
      activatePids: async (pids) => { fallbackPids = pids; return 84; },
    },
  );
  assert.deepStrictEqual(fallbackResult, { ok: true, mode: 'window', agentId: 'codex' });
  assert.deepStrictEqual(fallbackPids, [42, 84], 'protocol failure should preserve deduplicated PID fallback');

  let terminalPids = null;
  const terminalResult = await focusSession(
    { id: 'claude-1', agentId: 'claude-code', sourcePid: 10, pidChain: [20, 10] },
    { activatePids: async (pids) => { terminalPids = pids; return false; } },
  );
  assert.deepStrictEqual(terminalResult, { ok: false, mode: 'failed', agentId: 'claude-code' });
  assert.deepStrictEqual(terminalPids, [10, 20], 'non-Codex sessions should keep the existing PID focus path');

  const processes = [
    { pid: 10, parentPid: 20, name: 'opencode', window: false },
    { pid: 20, parentPid: 1, name: 'OpenChamber', window: true },
    { pid: 30, parentPid: 1, name: 'OpenChamber', window: true },
    { pid: 40, parentPid: 50, name: 'ZCode', window: false },
    { pid: 50, parentPid: 1, name: 'ZCode', window: true },
  ];
  assert.strictEqual(selectDesktopPid('opencode', [10], processes), 20, 'use the OpenChamber ancestor of the opencode service');
  assert.strictEqual(selectDesktopPid('opencode', [], processes), null, 'ambiguous desktop windows must not be chosen arbitrarily');
  assert.strictEqual(selectDesktopPid('zcode', [40], processes), 50, 'ZCode worker resolves to its UI ancestor');
  assert.strictEqual(selectDesktopPid('zcode', [], processes), 50, 'history-only session can use a unique existing ZCode window');
  assert.strictEqual(selectDesktopPid('opencode', [], processes.filter(p => p.pid !== 20 && p.pid !== 30)), null);
  assert.strictEqual(selectDesktopPid('opencode', [50], processes), null, 'unrelated window is never an OpenChamber target');
  assert.strictEqual(selectDesktopPid('opencode', [99999], processes), null, 'stale PID cannot disambiguate multiple windows');
  assert.strictEqual(selectDesktopPid('opencode', [], [{ pid: 30, name: 'OpenChamber', window: false }]), null,
    'window discovery excludes another user or desktop session');
  assert.strictEqual(selectDesktopPid('opencode', [10], [
    { pid: 10, parentPid: 11, name: 'opencode', window: false },
    { pid: 11, parentPid: 10, name: 'node', window: false },
  ]), null, 'cyclic parent chain terminates without a target');
  let desktopAgent;
  assert.deepStrictEqual(await focusSession({ agentId: 'zcode' }, {
    openExternal: async () => { throw new Error('ZCode has no supported session protocol'); },
    activateDesktop: async (agent, pids) => { desktopAgent = agent; assert.deepStrictEqual(pids, []); return { pid: 50, focused: true }; },
    activatePids: async () => { throw new Error('desktop success must skip generic PID fallback'); },
  }), { ok: true, mode: 'window', agentId: 'zcode' });
  assert.strictEqual(desktopAgent, 'zcode');
  assert.deepStrictEqual(await focusSession({ agentId: 'opencode', sourcePid: 10 }, {
    activateDesktop: async () => { throw new Error('query failed'); },
    activatePids: async () => false,
  }), { ok: false, mode: 'failed', agentId: 'opencode' }, 'desktop query failure must degrade gracefully');
  let cliPids;
  assert.deepStrictEqual(await focusSession({ agentId: 'opencode', sourcePid: 10, pidChain: [20] }, {
    activateDesktop: async () => false,
    activatePids: async pids => { cliPids = pids; return 20; },
  }), { ok: true, mode: 'window', agentId: 'opencode' }, 'standalone OpenCode keeps terminal PID focus when no desktop is found');
  assert.deepStrictEqual(cliPids, [10, 20]);
  assert.deepStrictEqual(await focusSession(null, { activatePids: async () => true }),
    { ok: false, mode: 'failed', agentId: '' });

  const navigations = [], order = [];
  for (const id of ['ses_first', 'ses_second']) {
    assert.deepStrictEqual(await focusSession({ id, agentId: 'opencode', sourcePid: 10 }, {
      activateDesktop: async (agent, pids) => { order.push('window'); assert.strictEqual(agent, 'opencode'); assert.deepStrictEqual(pids, [10]); return { pid: 20, focused: true }; },
      openExternal: async url => { order.push('session'); navigations.push(url); },
      activatePids: async () => { throw new Error('desktop navigation must not raise a terminal'); },
    }), { ok: true, mode: 'session', agentId: 'opencode' });
  }
  assert.deepStrictEqual(navigations, ['openchamber://session/ses_first', 'openchamber://session/ses_second'],
    'different sessions in one service must produce different navigation requests');
  assert.deepStrictEqual(order, ['window', 'session', 'window', 'session']);
  assert.deepStrictEqual(await focusSession({ id: 'ses_first', agentId: 'opencode' }, {
    activateDesktop: async () => ({ pid: 20, focused: true }),
    openExternal: async () => { throw new Error('protocol missing'); },
  }), { ok: true, mode: 'window', agentId: 'opencode' }, 'protocol failure preserves the already focused window');
  for (const id of [undefined, 'bad/path']) {
    assert.deepStrictEqual(await focusSession({ id, agentId: 'opencode' }, {
      activateDesktop: async () => ({ pid: 20, focused: true }),
      openExternal: async () => assert.fail('invalid session ID must not be dispatched'),
    }), { ok: true, mode: 'window', agentId: 'opencode' });
  }
  assert.deepStrictEqual(await focusSession({ id: 'ses_background', agentId: 'opencode' }, {
    activateDesktop: async () => ({ pid: 20, focused: false }),
    openExternal: async url => navigations.push(url),
  }), { ok: true, mode: 'session', agentId: 'opencode' }, 'an existing window can receive a session link when Windows denies foreground focus');
  assert.strictEqual(navigations.at(-1), 'openchamber://session/ses_background');
  assert.deepStrictEqual(await focusSession({ id: 'ses_background', agentId: 'opencode' }, {
    activateDesktop: async () => ({ pid: 20, focused: false }),
    openExternal: async () => { throw new Error('protocol missing'); },
  }), { ok: false, mode: 'failed', agentId: 'opencode' }, 'failed protocol plus denied focus must not report window success');
  assert.deepStrictEqual(await focusSession({ agentId: 'zcode' }, {
    activateDesktop: async () => ({ pid: 50, focused: false }),
  }), { ok: false, mode: 'failed', agentId: 'zcode' });
  assert.deepStrictEqual(await focusSession({ id: 'ses_first', agentId: 'opencode' }, {
    activateDesktop: async () => null,
    openExternal: async () => assert.fail('no existing window: do not launch OpenChamber'),
  }), { ok: false, mode: 'failed', agentId: 'opencode' });
  assert.deepStrictEqual(await focusSession({ agentId: 'claude-code', sourcePid: 10 }, {
    activatePids: async () => { throw new Error('process unavailable'); },
  }), { ok: false, mode: 'failed', agentId: 'claude-code' });

  const stats = adapter.buildPetStats({
    active: null,
    sessions: [
      { id: 'codex-1', agentId: 'codex', state: 'working', updatedAt: Date.now() },
      { id: 'claude-1', agentId: 'claude-code', state: 'working', sourcePid: 100, updatedAt: Date.now() },
      { id: 'trae-1', agentId: 'trae', state: 'working', pidChain: [200], updatedAt: Date.now() },
      { id: 'workbuddy-1', agentId: 'workbuddy', state: 'working', sourcePid: 300, updatedAt: Date.now() },
      { id: 'opencode-1', agentId: 'opencode', state: 'working', updatedAt: Date.now() },
      { id: 'zcode-1', agentId: 'zcode', state: 'working', updatedAt: Date.now() },
    ],
  }, [], null, {});
  const focusable = Object.fromEntries(stats.sessions.map((s) => [s.agent, s.focusable]));
  assert.deepStrictEqual(focusable, {
    codex: true,
    claude: true,
    trae: true,
    workbuddy: true,
    opencode: true,
    zcode: true,
  }, 'desktop-backed sessions can attempt existing-window discovery');

  console.log('Session focus checks passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
