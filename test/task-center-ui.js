'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createStubWorld, loadRenderer } = require('./dom-stub');
const { t } = require('../shared/i18n');

const world = createStubWorld();
const { sandbox, window, elements } = world;
const requests = [];
let command;
let fail = false;
let complete;
let closeRadialCalls = 0;
const snapshot = (recent, waitingCount = 0) => ({ recent, sessions: [], waitingCount });
const row = id => ({ id, at: Date.now(), kind: 'done', project: id, focusable: true, read: false });
Object.assign(sandbox, {
  actionPopOpen: false, actionPop: elements('action-pop'), lastStats: snapshot([row('a')]),
  actionableItems: () => [], fitPopup() {}, peekAgentLabel: () => 'Codex',
  PEEK_BUSY_STATES: new Set(), radialOpen: false, askActive: false,
  sessionFocusFeedback(result, onSuccess) {
    if (result?.ok !== true) return false;
    if (onSuccess) onSuccess();
    return true;
  },
  closeRadial() { closeRadialCalls++; sandbox.radialOpen = false; },
  openActionPop(initialTab) { sandbox.actionPopOpen = true; window.AgentPawTaskCenter.opened(initialTab); },
  closeActionPop() { sandbox.actionPopOpen = false; window.AgentPawTaskCenter.closed(); },
});
window.pet.onWorkflowCommand = handler => { command = handler; };
window.pet.markRecentRead = ids => {
  requests.push(Array.from(ids));
  return new Promise(resolve => {
    complete = () => {
      if (!fail) {
        sandbox.lastStats = { ...sandbox.lastStats, recent: sandbox.lastStats.recent.map(item => ids.includes(item.id) ? { ...item, read: true } : item) };
        window.AgentPawTaskCenter.render(sandbox.lastStats);
      }
      resolve({ ok: !fail });
    };
  });
};
let focused = 0, cleared = 0;
window.pet.focusRecent = async () => { focused++; return { ok: true, mode: 'session', agentId: 'codex' }; };
window.pet.clearRecent = async () => { cleared++; return { ok: true }; };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/task-center.js'), 'utf8'), sandbox);
const center = window.AgentPawTaskCenter;
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const click = name => elements('ac-tab-' + name).dispatch('click');

async function checkFocusResults() {
  const w = loadRenderer([
    'shared/i18n.js', 'shared/states.js', 'shared/pet-assets.js', 'shared/pet-insights.js',
    'renderer/pet.js', 'renderer/task-center.js',
  ], testWorld => {
    testWorld.window.pet.onWorkflowCommand = handler => { testWorld.handlers.workflowCommand = handler; };
    testWorld.sandbox.requestAnimationFrame = callback => { callback(); return 0; };
  });
  await flush();
  const session = { sessionId: 'focus-target', project: 'target', agent: 'zcode', state: 'working', focusable: true };
  w.handlers.stats({ ...snapshot([{ ...row('focus-recent'), read: true, agent: 'zcode' }]), sessions: [session], workingCount: 1, idleMs: 0 });
  let focusResult;
  let focusError;
  let openedId;
  const focus = async id => {
    openedId = id;
    if (focusError) throw focusError;
    return focusResult;
  };
  w.window.pet.focusRecent = focus;
  w.window.pet.focusSession = focus;
  const opened = () => vm.runInContext('actionPopOpen', w.sandbox);
  const start = tab => vm.runInContext(`openActionPop('${tab}')`, w.sandbox);
  const action = tab => {
    start(tab);
    const list = w.elements(tab === 'recent' ? 'ac-recent-list' : 'ac-session-list');
    list.children[0].children[2].children[0].dispatch('click');
  };
  const errors = [];
  const verify = (name, fn) => {
    try { fn(); console.log('  PASS', name); }
    catch (error) { errors.push(error); console.error('  FAIL', name, error.message); }
  };
  const failedText = '没能打开这个会话，请在对应 Agent 中手动打开';
  for (const tab of ['recent', 'sessions']) {
    for (const result of [
      { ok: false, mode: 'failed', agentId: 'zcode' },
      undefined, null, true, {},
      { ok: true, mode: 'failed', agentId: 'zcode' },
      { ok: true, mode: 'window' },
    ]) {
      focusResult = result;
      action(tab); await flush();
      verify(`${tab} 失败或非法结果保留任务中心 ${JSON.stringify(result)}`, () => {
        assert.strictEqual(openedId, tab === 'recent' ? 'focus-recent' : 'focus-target');
        assert.strictEqual(opened(), true);
        assert.strictEqual(w.elements('ac-status').textContent, '未能打开会话，请到对应 Agent 中查看');
        assert.strictEqual(w.elements('bubble-text').textContent, failedText);
      });
    }
    focusError = new Error('focus rejected');
    action(tab); await flush();
    verify(`${tab} 请求拒绝保留弹层与错误`, () => {
      assert.strictEqual(opened(), true);
      assert(w.elements('ac-status').textContent);
    });
    focusError = null;
    for (const [agentId, text] of [
      ['zcode', '已打开 ZCode，当前版本需手动选择会话'],
      ['opencode', '已打开 opencode 所在窗口，请手动选择会话'],
    ]) {
      focusResult = { ok: true, mode: 'window', agentId };
      action(tab); await flush();
      verify(`${tab} ${agentId} 窗口提示在关闭弹层后仍可见`, () => {
        assert.strictEqual(opened(), false);
        assert(w.elements('action-pop').classList.contains('hidden'));
        assert(!w.elements('bubble').classList.contains('hidden'));
        assert.strictEqual(w.elements('bubble-text').textContent, text);
        assert(w.calls.filter(([name]) => name === 'setPetSize').at(-1)[1][3] === 'popup', 'window keeps space for the feedback bubble');
      });
    }
    for (const agentId of ['opencode', 'codex', 'generic']) {
      focusResult = { ok: true, mode: 'session', agentId };
      action(tab); await flush();
      verify(`${tab} ${agentId} 协议提交后关闭且不声称加载成功`, () => {
        assert.strictEqual(opened(), false);
        assert(w.elements('bubble').classList.contains('hidden'));
      });
    }
  }
  const focusCalls = [];
  let finishFocus;
  w.window.pet.focusRecent = id => {
    focusCalls.push(['recent', id]);
    return new Promise(resolve => { finishFocus = resolve; });
  };
  w.window.pet.focusSession = async id => {
    focusCalls.push(['sessions', id]);
    return { ok: true, mode: 'session', agentId: 'codex' };
  };
  action('recent');
  w.elements('ac-recent-list').children[0].children[2].children[0].dispatch('click');
  w.elements('ac-tab-sessions').dispatch('click');
  w.elements('ac-session-list').children[0].children[2].children[0].dispatch('click');
  await flush();
  verify('导航及重复点击期间 busy 拦截后续聚焦请求', () => {
    assert.deepStrictEqual(focusCalls, [['recent', 'focus-recent']]);
    assert.strictEqual(opened(), true);
    assert.strictEqual(w.elements('ac-tab-sessions').getAttribute('aria-selected'), 'true');
  });
  finishFocus({ ok: false, mode: 'failed', agentId: 'zcode' });
  await flush();
  verify('在途请求结构化失败后保留当前标签和弹层', () => {
    assert.strictEqual(opened(), true);
    assert.strictEqual(w.elements('ac-tab-sessions').getAttribute('aria-selected'), 'true');
    assert.strictEqual(w.elements('ac-status').textContent, '未能打开会话，请到对应 Agent 中查看');
    assert.strictEqual(w.elements('bubble-text').textContent, failedText);
  });
  w.elements('ac-session-list').children[0].children[2].children[0].dispatch('click');
  await flush();
  verify('失败后 busy 释放允许从当前会话标签重试', () => {
    assert.deepStrictEqual(focusCalls, [['recent', 'focus-recent'], ['sessions', 'focus-target']]);
    assert.strictEqual(opened(), false);
  });
  for (const [agentId, text] of [
    ['zcode', '已打开 ZCode，当前版本需手动选择会话'],
    ['opencode', '已打开 opencode 所在窗口，请手动选择会话'],
  ]) {
    start('sessions');
    w.handlers.workflowCommand({ type: 'focus-result', result: { ok: true, mode: 'window', agentId } });
    verify(`快捷键 ${agentId} 结果复用窗口降级提示`, () => {
      assert.strictEqual(w.elements('bubble-text').textContent, text);
      assert(!w.elements('bubble').classList.contains('hidden'));
    });
  }
  for (const result of [undefined, null, {}, { ok: false, mode: 'failed', agentId: 'zcode' }]) {
    w.elements('bubble').classList.add('hidden');
    w.handlers.workflowCommand({ type: 'focus-result', result });
    verify('快捷键失败及非法结果使用相同错误气泡', () => {
      assert.strictEqual(w.elements('bubble-text').textContent, failedText);
      assert(!w.elements('bubble').classList.contains('hidden'));
    });
  }
  w.elements('bubble').classList.add('hidden');
  w.handlers.workflowCommand({ type: 'focus-result', result: { ok: true, mode: 'session', agentId: 'opencode' } });
  verify('快捷键会话协议提交不显示虚假成功提示', () => assert(w.elements('bubble').classList.contains('hidden')));
  for (const ignored of [null, undefined, {}, { type: 'unknown' }]) w.handlers.workflowCommand(ignored);
  vm.runInContext('closeActionPop()', w.sandbox);
  w.handlers.workflowCommand('peek');
  verify('原 peek 字符串命令仍打开速览', () => assert.strictEqual(vm.runInContext('peekOpen', w.sandbox), true));
  w.handlers.workflowCommand('actions');
  verify('原 actions 字符串命令仍打开任务中心', () => {
    assert.strictEqual(opened(), true);
    assert.strictEqual(w.elements('ac-tab-actions').getAttribute('aria-selected'), 'true');
  });
  assert.strictEqual(errors.length, 0, `${errors.length} structured focus checks failed`);
}

(async () => {
  center.render(sandbox.lastStats);
  await flush();
  assert.equal(requests.length, 0, 'hidden rendering never reads history');
  assert.equal(t('sess.more', { count: 3 }), '另有 3 个会话，打开会话列表');
  sandbox.openActionPop('sessions');
  await flush();
  assert.equal(elements('ac-tab-sessions').getAttribute('aria-selected'), 'true', 'opening sessions selects sessions without reading recent');
  assert.equal(requests.length, 0, 'opening sessions does not acknowledge recent history');
  click('recent'); click('recent');
  await flush();
  assert.deepEqual(requests, [['a']], 'opening recent acknowledges once even with a repeated click');
  sandbox.lastStats = snapshot([row('b'), row('a')]);
  center.render(sandbox.lastStats);
  await flush();
  assert.equal(requests.length, 1, 'new arrivals do not trigger automatic reads');
  complete(); await flush();
  assert.equal(sandbox.lastStats.recent[0].read, false, 'in-flight acknowledgement excludes later records');
  assert.equal(sandbox.lastStats.recent[1].read, true);
  click('sessions'); await flush();
  assert.equal(requests.length, 1, 'sessions tab does not read recent history');
  elements('ac-tab-sessions').dispatch('keydown', { key: 'ArrowLeft', preventDefault() {} });
  await flush();
  assert.deepEqual(requests[1], ['b'], 'keyboard navigation also acknowledges history');
  complete(); await flush();
  sandbox.closeActionPop();
  sandbox.lastStats = snapshot([row('c')], 1);
  sandbox.openActionPop(); await flush();
  assert.equal(elements('ac-tab-actions').getAttribute('aria-selected'), 'true');
  assert.equal(requests.length, 2, 'opening pending actions does not clear history');
  click('recent'); await flush(); complete(); await flush();
  assert.equal(sandbox.lastStats.waitingCount, 1, 'reading history never resolves pending work');
  assert.equal(elements('ac-tab-actions').textContent, '待处理 1');
  sandbox.closeActionPop();
  sandbox.lastStats = snapshot([row('d')]);
  command('actions'); await flush();
  assert.equal(requests.length, 3, 'actions shortcut does not acknowledge the intermediate default recent tab');
  click('recent'); sandbox.closeActionPop(); await flush();
  assert.equal(requests.length, 3, 'closing before acknowledgement cancels it');
  sandbox.openActionPop(); await flush();
  fail = true; complete(); await flush();
  assert.equal(sandbox.lastStats.recent[0].read, false, 'failed persistence preserves unread state');
  assert(elements('ac-status').textContent.includes('保存失败'));
  click('sessions'); click('recent'); await flush();
  fail = false; complete(); await flush();
  assert.equal(sandbox.lastStats.recent[0].read, true, 're-entering retries failed persistence');
  assert.equal(elements('ac-status').textContent, '', 'successful retry clears its error');
  // Existing commands remain usable even while an automatic read is in flight.
  sandbox.lastStats = snapshot([row('e')]); center.render(sandbox.lastStats);
  click('recent'); await flush();
  const card = elements('ac-recent-list').children[0];
  const controls = card.children[2];
  assert.equal(controls.children.length, 1, 'only the session action remains in a history card');
  controls.children[0].dispatch('click'); await flush();
  assert.equal(focused, 1); assert.equal(sandbox.actionPopOpen, false);
  complete(); await flush();
  elements('ac-clear-recent').dispatch('click'); await flush();
  assert.equal(cleared, 1, 'clear remains available');

  sandbox.lastStats = snapshot([row('overflow')], 2);
  sandbox.radialOpen = true;
  const requestCount = requests.length;
  center.openSessions();
  assert.equal(sandbox.actionPopOpen, true, 'overflow opens the action center synchronously');
  assert.equal(sandbox.radialOpen, false, 'overflow closes the radial menu');
  assert.equal(closeRadialCalls, 1);
  assert.equal(elements('ac-tab-sessions').getAttribute('aria-selected'), 'true');
  await flush();
  assert.equal(requests.length, requestCount, 'overflow does not read history or resolve pending work');
  assert.equal(sandbox.lastStats.waitingCount, 2);
  assert.equal(sandbox.lastStats.recent[0].read, false);
  click('recent');
  center.openSessions();
  await flush();
  assert.equal(elements('ac-tab-sessions').getAttribute('aria-selected'), 'true', 'overflow switches an already open center to sessions');
  assert.equal(requests.length, requestCount, 'sessions selection cancels a queued recent acknowledgement');
  sandbox.closeActionPop();
  sandbox.lastStats = snapshot([row('default')]);
  sandbox.radialOpen = true;
  const open = sandbox.openActionPop;
  sandbox.openActionPop = initialTab => {
    assert.equal(elements('ac-tab-sessions').getAttribute('aria-selected'), 'true', 'sessions is selected before opening the popup');
    assert.equal(sandbox.radialOpen, false, 'radial closes before the action center opens');
    assert.equal(initialTab, 'sessions', 'overflow passes sessions as the preferred opening tab');
    open(initialTab);
  };
  center.openSessions();
  sandbox.openActionPop = open;
  await flush();
  assert.equal(requests.length, requestCount, 'overflow overrides the default recent tab');
  sandbox.closeActionPop();
  sandbox.openActionPop('unexpected');
  await flush();
  assert.equal(elements('ac-tab-recent').getAttribute('aria-selected'), 'true', 'unsupported preferred tabs retain default selection');
  assert.equal(requests.length, requestCount + 1);
  complete(); await flush();
  await checkFocusResults();
  console.log('Task center automatic read, sessions overflow, navigation, failure and structured focus checks passed');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
