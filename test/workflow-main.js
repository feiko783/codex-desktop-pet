'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { IPC } = require('../shared/ipc-channels');
const workflowPreferences = require('../shared/workflow-preferences');
const { createTaskCenter, projectKey } = require('../backend/task-center');
const { createWorkflowShortcuts, nextAttention } = require('../backend/workflow-shortcuts');
const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const source = main.slice(main.indexOf('function routeTaskEvent('), main.indexOf('function bootBackend('));
assert(source.includes('function registerWorkflowIpc()'));
const settings = { id: 2 }, pet = { id: 1 }, foreign = { id: 99 };
const handlers = new Map(), bindings = new Map(), messages = [];
const row = { sessionId: 'task-a', agent: 'codex', project: 'secret project', projectKey: projectKey({ cwd: 'D:/secret' }),
  state: 'waiting', focusable: true, updatedAt: 1 };
let saved = { privacyMode: false, notifications: workflowPreferences.notifications(), shortcuts: workflowPreferences.shortcuts() };
let visible = true;
let focusResult = { ok: true, mode: 'session', agentId: 'codex' };
const focusedSessions = [];
const taskCenter = createTaskCenter();
taskCenter.sync({ sessions: [row], actions: [] }, saved.notifications);
taskCenter.record({ ...row, kind: 'done', eventKey: 'one', ts: Date.now() });
const context = {
  IPC, workflowPreferences, createWorkflowShortcuts, nextAttention, taskCenter,
  workflowShortcuts: null, lastAttentionSessionId: '', lastStats: { sessions: [row] },
  config: { get: () => saved, save: patch => { saved = { ...saved, ...patch }; } },
  settingsWin: { isDestroyed: () => false, isFocused: () => false, webContents: settings },
  stateOfSender: sender => sender === pet ? {} : null,
  ipcMain: { handle: (key, fn) => handlers.set(key, fn) },
  sendWin: (_, key, payload) => messages.push({ key, payload }),
  sendPet: (key, payload) => messages.push({ key, payload }),
  emitStats() {}, t: () => '私密项目',
  core: { getSession: id => id === row.sessionId ? { id, agentId: 'codex' } : null },
  focusSession: async (session) => { focusedSessions.push(session); return session ? focusResult : { ok: false, mode: 'failed', agentId: '' }; },
  shell: { openExternal() {} },
  showPet: () => { visible = true; },
  firstAlivePetWin: () => ({ isVisible: () => visible }),
  petVisibility: { hide: () => { visible = false; } },
  applyPetVisibility() {}, refreshTrayMenu() {},
  globalShortcut: { register: (key, fn) => { bindings.set(key, fn); return true; }, unregister: key => bindings.delete(key) },
};
vm.createContext(context); vm.runInContext(source, context);
context.registerWorkflowIpc(); context.startWorkflowShortcuts();
const focusStart = main.indexOf('  ipcMain.handle(IPC.FOCUS_SESSION,');
vm.runInContext(main.slice(focusStart, main.indexOf('  // Dynamic sizing:', focusStart)), context);
const invoke = (key, sender, ...args) => handlers.get(key)({ sender }, ...args);
(async () => {
  assert.equal(invoke(IPC.GET_WORKFLOW_PREFERENCES, foreign), null);
  assert.equal(invoke(IPC.SET_WORKFLOW_PREFERENCES, pet, {}).ok, false);
  assert.equal(invoke(IPC.UPDATE_SESSION_PREFERENCES, foreign, row.sessionId, { alias: 'x', pinned: true }).ok, false);
  assert.equal(invoke(IPC.SET_WORKFLOW_PREFERENCES, settings, { notifications: { mode: 'attention', mutedAgents: ['codex'] } }).ok, true);
  assert.equal(saved.notifications.mode, 'attention');
  assert.deepEqual(Array.from(saved.notifications.mutedAgents), ['codex']);
  assert.equal(invoke(IPC.UPDATE_SESSION_PREFERENCES, pet, row.sessionId, { alias: 'private alias', pinned: true, muted: true }).ok, true);
  assert.equal(saved.notifications.mutedProjects[0].label, row.project);
  saved.privacyMode = true;
  const masked = invoke(IPC.GET_WORKFLOW_PREFERENCES, settings);
  assert.equal(masked.notifications.mutedProjects[0].label, '私密项目');
  assert.equal(invoke(IPC.UPDATE_SESSION_PREFERENCES, pet, row.sessionId, { alias: '', pinned: false }).ok, true);
  assert.equal(taskCenter.lookup(row.sessionId).alias, 'private alias', 'pin changes in privacy mode preserve the hidden alias');
  invoke(IPC.SET_WORKFLOW_PREFERENCES, settings, { notifications: masked.notifications });
  assert.equal(saved.notifications.mutedProjects[0].label, row.project, 'masked labels cannot replace stored project names');
  invoke(IPC.SET_WORKFLOW_PREFERENCES, settings, { unmuteProject: row.projectKey });
  assert.equal(saved.notifications.mutedProjects.length, 0);
  const recent = taskCenter.sync({ sessions: [row], actions: [] }, saved.notifications).recent[0];
  focusResult = { ok: false, mode: 'failed', agentId: 'codex' };
  assert.deepEqual(await invoke(IPC.FOCUS_RECENT, pet, recent.id), focusResult);
  assert.equal(taskCenter.recentEntry(recent.id).read, false, 'failed navigation does not acknowledge unseen work');
  focusResult = { ok: true, mode: 'window', agentId: 'codex' };
  assert.deepEqual(await invoke(IPC.FOCUS_RECENT, pet, recent.id), focusResult);
  assert.equal(taskCenter.recentEntry(recent.id).read, true);
  assert.equal((await invoke(IPC.FOCUS_RECENT, foreign, recent.id)).ok, false);
  assert.deepEqual(await invoke(IPC.FOCUS_SESSION, pet, row.sessionId), focusResult);
  const focusCalls = focusedSessions.length;
  assert.equal((await invoke(IPC.FOCUS_SESSION, foreign, row.sessionId)).ok, false);
  assert.equal((await invoke(IPC.FOCUS_SESSION, pet, {})).ok, false);
  assert.equal(focusedSessions.length, focusCalls, 'foreign senders and malformed IDs cannot launch navigation');
  assert.equal((await invoke(IPC.FOCUS_SESSION, pet, 'unknown')).ok, false);
  invoke(IPC.SET_WORKFLOW_PREFERENCES, settings, { shortcuts: { peek: 'Ctrl+Shift+P', next: 'Ctrl+Shift+J', toggle: 'Ctrl+Shift+H' } });
  bindings.get('Ctrl+Shift+H')(); assert.equal(visible, false);
  bindings.get('Ctrl+Shift+H')(); assert.equal(visible, true);
  bindings.get('Ctrl+Shift+P')(); assert.equal(messages.at(-1).payload, 'peek');
  visible = false;
  focusResult = { ok: true, mode: 'window', agentId: 'zcode' };
  await bindings.get('Ctrl+Shift+J')(); assert.equal(context.lastAttentionSessionId, row.sessionId);
  assert.equal(visible, true, 'window fallback feedback must be visible when the pet was hidden');
  assert.deepEqual(messages.at(-1), { key: IPC.WORKFLOW_COMMAND, payload: { type: 'focus-result', result: focusResult } });
  visible = false;
  focusResult = { ok: true, mode: 'session', agentId: 'opencode' };
  await bindings.get('Ctrl+Shift+J')();
  assert.equal(visible, false, 'silent session dispatch does not reveal a hidden pet');
  focusResult = { ok: false, mode: 'failed', agentId: 'codex' };
  await bindings.get('Ctrl+Shift+J')();
  assert.equal(messages.at(-2).payload, 'actions', 'failed shortcut navigation opens the action center');
  assert.deepEqual(messages.at(-1).payload, { type: 'focus-result', result: focusResult });
  assert.equal(invoke(IPC.CLEAR_RECENT, foreign).ok, false);
  assert.equal(invoke(IPC.CLEAR_RECENT, pet).ok, true);
  console.log('Workflow main IPC, privacy, navigation and shortcut integration checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
