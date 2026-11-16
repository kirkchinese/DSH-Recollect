import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderClient } from '../client/build.mjs';
import { execFileSync } from 'node:child_process';
import { FIELDS, FREE_CLAUDE_FIELDS } from '../client/fields.mjs';
import { zh, en } from '../client/locales.mjs';
import { Config as PromptConfig } from '../lib/entry-free-claude.js';
import { Config as MemoryConfig, liveConfig } from '../lib/config.js';

const root = new URL('../', import.meta.url);
const checkSyntax = url => execFileSync(process.execPath, ['--check', fileURLToPath(url)]);
const bundle = () => readFileSync(new URL('lib/client.js', root), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(source = bundle()) {
  const slots = [], mutations = [], requested = [], forms = new Map(), instances = new Map();
  let current, cursor;
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } }; },
    useState(initial) {
      const instance = current, index = cursor++;
      if (!(index in instance)) instance[index] = typeof initial === 'function' ? initial() : initial;
      return [instance[index], value => { instance[index] = typeof value === 'function' ? value(instance[index]) : value; }];
    },
    useSyncExternalStore(_subscribe, snapshot) { return snapshot(); },
  };
  const P = Object.fromEntries(['Switch', 'SegmentedControl', 'SettingsValueField', 'SettingsForm', 'Button', 'Tag'].map(name => [name, name]));
  const defaults = { 'free-claude': PromptConfig({}).get(), recollect: JSON.parse(JSON.stringify(liveConfig(MemoryConfig({})))) };
  const get = rowId => {
    requested.push(rowId);
    if (!forms.has(rowId)) forms.set(rowId, {
      state: { status: 'ready', writable: true, revision: 7, value: { ...defaults[rowId] }, base: { ...defaults[rowId] }, user: {} },
      subscribe() { return () => {}; }, getSnapshot() { return this.state; },
      async mutate(ops, revision) { mutations.push({ rowId, ops: plain(ops), revision }); return true; },
    });
    return forms.get(rowId);
  };
  let plugin;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(module) { plugin = module.factory(name => name === 'react' ? React : P); } } } });
  const ctx = {
    locale: { bind: () => key => en[key] ?? key, register() { return () => {}; } },
    slots: { inject(_name, fn) { return fn(); }, register(meta, Component) { slots.push({ meta, Component }); return () => {}; } },
    configForms: { get }, effect(fn) { return fn(); }, remote: { async $mount() { throw Error('not mounted'); } },
  };
  await plugin.apply(ctx);
  const expand = (node, path = 'root') => {
    if (node == null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((item, i) => expand(item, path + '/' + (item?.props?.key ?? i)));
    if (typeof node.type === 'function') {
      const id = path + '/' + node.type.name;
      if (!instances.has(id)) instances.set(id, []);
      current = instances.get(id); cursor = 0;
      return expand(node.type(node.props), id);
    }
    return { ...node, props: { ...node.props, children: expand(node.props.children, path + '/children') } };
  };
  const render = (slot, extra = {}) => expand(React.createElement(slot.Component, { t: key => en[key] ?? key, ...slot.meta.inject?.(), ...extra }), slot.meta.id ?? slot.meta.key);
  return { slots, mutations, forms, requested, render };
}
function nodes(tree, type) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(n => nodes(n, type));
  return [...(tree.type === type ? [tree] : []), ...nodes(tree.props.children, type)];
}

const setting = (f, id = 'free-claude') => f.slots.find(s => s.meta.name === 'settings.section' && s.meta.id === id);

test('Free Claude has a separate settings section and exact component row paths', async () => {
  const f = await fixture(), slot = setting(f);
  assert.deepEqual(f.requested.sort(), ['free-claude', 'recollect']);
  assert.equal(slot.meta.label(), 'Free Claude');
  assert.equal(setting(f, 'recollect').meta.label(), 'Memory');
  let tree = f.render(slot);
  assert.equal(nodes(tree, 'SettingsForm').length, 1);
  assert.ok(nodes(tree, 'p').some(n => n.props.children === en['freeClaude.disclaimer']));
  for (const field of FREE_CLAUDE_FIELDS) {
    tree = f.render(slot);
    const type = field.kind === 'bool' ? 'Switch' : 'SettingsValueField';
    const control = nodes(tree, type).find(n => n.props.label === en['f.' + field.path]);
    assert.ok(control, field.path);
    const value = field.kind === 'bool' ? false : 20000000;
    if (field.kind === 'bool') control.props.onChange(value);
    else control.props.onEdit(String(value));
    tree = f.render(slot);
    assert.equal(nodes(tree, 'SettingsForm')[0].props.state.dirty, true);
    nodes(tree, 'SettingsForm')[0].props.onSave();
    await tick();
    assert.deepEqual(f.mutations.at(-1), { rowId: 'free-claude', ops: [{ op: 'set', path: [field.path], value }], revision: 7 });
    assert.equal(nodes(f.render(slot), 'SettingsForm')[0].props.state.dirty, false);
  }
});

test('plugin row exposes the same four controls and memory form stays independent', async () => {
  const f = await fixture();
  const row = f.slots.find(s => s.meta.key === '@kirkchinese/dsh-recollect/free-claude#free-claude');
  assert.ok(row);
  const configForm = f.forms.get('free-claude');
  const tree = f.render(row, { view: 'page', form: { state: configForm.state, mutate: (...a) => configForm.mutate(...a) } });
  assert.equal(nodes(tree, 'Switch').length, 3);
  assert.equal(nodes(tree, 'SettingsValueField').length, 1);
  const memory = f.render(setting(f, 'recollect'));
  assert.equal(nodes(memory, 'Switch').length, FIELDS.filter(f => f.kind === 'bool').length);
  assert.equal(nodes(memory, 'SettingsForm').length, 1);
  assert.ok(nodes(memory, 'Switch').some(n => n.props.label === en['f.memory.shareWithClaudeCode']));
  assert.ok(nodes(memory, 'SettingsValueField').some(n => n.props.label === en['f.memory.shareProjects']));
  assert.ok(!nodes(memory, 'p').some(n => n.props.children === en['freeClaude.disclaimer']));
});

test('Free Claude form retains reset, validation, unavailable and read-only behavior', async () => {
  const f = await fixture(), slot = setting(f), form = f.forms.get('free-claude');
  form.state.user = { totalTokensBudget: 1234 };
  let tree = f.render(slot);
  nodes(tree, 'SettingsValueField')[0].props.onReset();
  nodes(f.render(slot), 'SettingsForm')[0].props.onSave();
  await tick();
  assert.deepEqual(f.mutations.at(-1).ops, [{ op: 'unset', path: ['totalTokensBudget'] }]);
  tree = f.render(slot);
  nodes(tree, 'SettingsValueField')[0].props.onEdit('not a number');
  assert.equal(nodes(f.render(slot), 'SettingsForm')[0].props.state.invalid, true);
  form.state.writable = false;
  assert.ok(nodes(f.render(slot), 'Switch').every(n => n.props.disabled));
  form.state.status = 'unavailable';
  assert.equal(nodes(f.render(slot), 'SettingsForm')[0].props.state.available, false);
});

test('syntax check accepts file URLs whose paths contain spaces', t => {
  const dir = mkdtempSync(join(tmpdir(), 'recollect space path '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'client bundle.js'), url = pathToFileURL(file);
  writeFileSync(file, bundle());
  assert.ok(url.href.includes('%20'));
  assert.doesNotThrow(() => checkSyntax(url));
  t.diagnostic('M4 node --check: space-containing file URL decoded successfully');
});

test('generated bundle matches renderClient, passes syntax, and locales cover every field', () => {
  assert.equal(bundle(), renderClient());
  checkSyntax(new URL('lib/client.js', root));
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const field of [...FIELDS, ...FREE_CLAUDE_FIELDS]) {
    for (const prefix of ['f.', 'h.']) assert.equal(typeof en[prefix + field.path], 'string');
    for (const option of field.options ?? []) assert.equal(typeof en['o.' + field.path + '.' + option], 'string');
  }
  assert.deepEqual(FREE_CLAUDE_FIELDS.map(f => f.path), ['enabled', 'toolGuidance', 'totalTokens', 'totalTokensBudget']);
});
