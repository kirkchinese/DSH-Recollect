import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { zh, en } from '../client/locales.mjs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { renderClient } from '../client/build.mjs';
import { canonicalGitRoot, projectSlug } from '../lib/paths.js';
import { apply } from '../index.js';
import { resolveShare, toggleShareProject } from '../lib/share.js';
import { Config, liveConfig } from '../lib/config.js';
import { importRequestSchema, importResponseSchema, statusResponseSchema, TYPERT } from '../lib/remote.js';

const root = resolve('/projects/example');
const other = resolve('/projects/other');
const gitRoot = dir => resolve(dir) === root || resolve(dir).startsWith(root + sep) ? root : undefined;
const expand = dir => dir === '~' ? root : dir.startsWith('~/') ? join(root, dir.slice(2)) : dir;

test('sharing defaults preserve independent DSH memory', () => {
  const memory = liveConfig(Config({})).memory;
  assert.deepEqual(memory.shareProjects, []);
  assert.deepEqual(resolveShare(root, memory, gitRoot), { active: false, via: null, projectRoot: root });
});

test('global sharing includes every project', () => {
  assert.deepEqual(resolveShare(root, { shareWithClaudeCode: true }, gitRoot), { active: true, via: 'global', projectRoot: root });
  assert.equal(resolveShare(other, { shareWithClaudeCode: true }, gitRoot).active, true);
});

test('project sharing matches a root and its subdirectories only', () => {
  assert.deepEqual(resolveShare(root + '/src', { shareProjects: [root] }, gitRoot), { active: true, via: 'project', projectRoot: root });
  assert.equal(resolveShare(other, { shareProjects: [root] }, gitRoot).active, false);
  assert.equal(resolveShare(root, { shareProjects: [root + '/src'] }, gitRoot).active, true);
  assert.equal(resolveShare(root, { shareProjects: ['~/src'] }, gitRoot, expand).active, true);
});

test('fixed directory takes precedence over global and project sharing', () => {
  assert.deepEqual(resolveShare(root, { directory: '/fixed', shareWithClaudeCode: true, shareProjects: [root] }, gitRoot), { active: false, via: 'directory', projectRoot: root });
});

test('non-git projects compare resolved absolute paths', () => {
  assert.deepEqual(resolveShare('ordinary/../folder', { shareProjects: [resolve('folder')] }), { active: true, via: 'project', projectRoot: resolve('folder') });
  assert.equal(resolveShare(other, { shareProjects: [other + '/child'] }).active, false);
});

test('empty and incomplete .git directories are not repository roots', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'recollect-share-git-'));
  assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, '.git'));
  await mkdir(join(dir, 'sub'));
  assert.equal(await canonicalGitRoot(join(dir, 'sub')), null);
  await writeFile(join(dir, '.git', 'config'), '[core]');
  assert.equal(await canonicalGitRoot(dir), null);
  const actual = await canonicalGitRoot(dir);
  assert.equal(resolveShare(dir, {}, () => actual).projectRoot, dir);
});

test('sync and async Git roots reject incomplete repositories and validate worktrees', async t => {
  const f = await hostFixture();
  assert.ok(resolve(f.dir).startsWith(resolve(tmpdir()) + sep));
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const cases = [];
  const candidate = async name => {
    const dir = join(f.dir, name);
    await mkdir(join(dir, 'sub'), { recursive: true });
    return dir;
  };
  const headOnly = await candidate('head-only');
  await mkdir(join(headOnly, '.git'));
  await writeFile(join(headOnly, '.git', 'HEAD'), 'ref: refs/heads/main');
  cases.push(['HEAD only', headOnly, null]);
  const headDirectory = await candidate('head-directory');
  for (const name of ['HEAD', 'objects', 'refs']) await mkdir(join(headDirectory, '.git', name), { recursive: true });
  cases.push(['HEAD directory', headDirectory, null]);
  const missingTarget = await candidate('missing-target');
  await writeFile(join(missingTarget, '.git'), 'gitdir: ../absent');
  cases.push(['missing gitfile target', missingTarget, null]);
  const noHeadTarget = await candidate('no-head-target');
  await mkdir(join(noHeadTarget, 'metadata'));
  await writeFile(join(noHeadTarget, '.git'), 'gitdir: metadata');
  cases.push(['gitfile target without HEAD', noHeadTarget, null]);
  const invalidHead = await candidate('invalid-head');
  for (const name of ['objects', 'refs']) await mkdir(join(invalidHead, '.git', name), { recursive: true });
  await writeFile(join(invalidHead, '.git', 'HEAD'), 'not a ref or object id');
  cases.push(['invalid HEAD', invalidHead, null]);
  const main = await candidate('normal');
  for (const name of ['objects', 'refs']) await mkdir(join(main, '.git', name), { recursive: true });
  await writeFile(join(main, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  cases.push(['normal repository', main, main]);
  for (const width of [40, 64]) {
    const detached = await candidate('detached-' + width);
    for (const name of ['objects', 'refs']) await mkdir(join(detached, '.git', name), { recursive: true });
    await writeFile(join(detached, '.git', 'HEAD'), 'a'.repeat(width) + '\n');
    cases.push(['detached HEAD ' + width, detached, detached]);
  }
  const worktree = await candidate('worktree');
  const metadata = join(main, '.git', 'worktrees', 'topic');
  await mkdir(metadata, { recursive: true });
  await writeFile(join(metadata, 'HEAD'), 'ref: refs/heads/topic\n');
  await writeFile(join(metadata, 'commondir'), '../..\n');
  await writeFile(join(worktree, '.git'), 'gitdir: ' + metadata + '\n');
  cases.push(['normal worktree', worktree, main]);
  for (const [label, dir, expected] of cases) {
    const start = join(dir, 'sub');
    const asyncRoot = await canonicalGitRoot(start);
    const status = await f.remote.status({ cwd: start });
    assert.equal(asyncRoot, expected, label + ' async');
    // The real host calls gitRootSync; an invalid root must fall back to cwd.
    assert.equal(status.projectRoot, expected ?? start, label + ' sync');
    console.log('Git root:', label, '=> async=' + (asyncRoot === null ? 'null' : asyncRoot === main ? 'main' : 'self'), 'sync=' + (status.projectRoot === start ? 'cwd fallback' : status.projectRoot === main ? 'main' : 'self'));
  }
});

test('real Git metadata validates common directories for gitfiles and worktrees', async t => {
  const probe = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (probe.error?.code === 'ENOENT') { t.skip('git executable is unavailable; real repository fixtures cannot be created'); return; }
  assert.equal(probe.status, 0, probe.error?.message ?? probe.stderr);
  const f = await hostFixture();
  // Git for Windows returns long real paths while os.tmpdir() may use an 8.3
  // alias (RUNNER~1). Canonicalize both sides before deriving any fixtures.
  f.dir = await realpath(f.dir);
  // Every command and cleanup target belongs to this newly-created tmp fixture.
  const tempRoot = await realpath(tmpdir());
  assert.ok(resolve(f.dir).startsWith(tempRoot + sep));
  t.after(async () => {
    await rm(f.dir, { recursive: true, force: true });
    assert.equal(await stat(f.dir).catch(() => undefined), undefined);
    console.log('Real Git fixture cleanup: removed');
  });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, { HOME: f.dir, XDG_CONFIG_HOME: join(f.dir, 'config'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(f.dir, 'empty-gitconfig'), GIT_TERMINAL_PROMPT: '0' });
  const git = (cwd, args, expected = 0) => {
    assert.ok(resolve(cwd).startsWith(resolve(f.dir) + sep));
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, expected, args.join(' ') + ': ' + (result.error?.message ?? result.stderr));
    return result.stdout.trim();
  };
  const init = async name => {
    const dir = join(f.dir, name);
    await mkdir(dir);
    git(dir, ['init', '--initial-branch=main']);
    git(dir, ['-c', 'user.name=Recollect Test', '-c', 'user.email=recollect@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture']);
    return dir;
  };
  const fakeGitfile = async dir => {
    await mkdir(join(dir, 'metadata'), { recursive: true });
    await writeFile(join(dir, '.git'), 'gitdir: metadata\n');
    await writeFile(join(dir, 'metadata', 'HEAD'), 'ref: refs/heads/main\n');
  };
  const main = await init('real-main');
  const standalone = join(f.dir, 'standalone');
  await fakeGitfile(standalone);
  const nested = join(main, 'nested');
  await fakeGitfile(nested);
  const worktree = join(f.dir, 'real-worktree');
  const broken = join(f.dir, 'broken-worktree');
  git(main, ['worktree', 'add', '-b', 'topic', worktree]);
  git(main, ['worktree', 'add', '-b', 'broken', broken]);
  const gitDirFor = async cwd => resolve(cwd, (await readFile(join(cwd, '.git'), 'utf8')).trim().slice('gitdir: '.length));
  const worktreeMetadata = await gitDirFor(worktree);
  assert.ok((await readFile(join(worktreeMetadata, 'commondir'), 'utf8')).trim());
  const brokenMetadata = await gitDirFor(broken);
  await writeFile(join(brokenMetadata, 'commondir'), '../../missing-common\n');
  const source = await init('local-source');
  git(main, ['-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'vendor']);
  const submodule = join(main, 'vendor');
  const submoduleMetadata = await gitDirFor(submodule);
  assert.equal(await stat(join(submoduleMetadata, 'commondir')).catch(() => undefined), undefined);
  git(main, ['pack-refs', '--all']);
  assert.ok((await stat(join(main, '.git', 'packed-refs'))).isFile());
  const cases = [
    ['A HEAD-only standalone gitfile', standalone, null, 128],
    ['B invalid nested gitfile finds outer main', nested, main, 128],
    ['C missing worktree common directory', broken, null, 128],
    ['normal packed-refs repository', main, main, 0],
    ['normal worktree with commondir', worktree, main, 0],
    ['normal submodule without commondir', submodule, submodule, 0],
    ['normal git-init repository', source, source, 0],
  ];
  for (const [label, cwd, expected, gitExit] of cases) await t.test(label, async () => {
    git(cwd, ['rev-parse', '--show-toplevel'], gitExit);
    // Start below the gitfile: returning its project is then observably
    // different from the host's no-repository fallback to the requested cwd.
    const start = join(cwd, 'root-check');
    await mkdir(start);
    const asyncRoot = await canonicalGitRoot(start);
    const syncRoot = (await f.remote.status({ cwd: start })).projectRoot;
    assert.equal(asyncRoot, expected, label + ' async');
    assert.equal(syncRoot, expected ?? start, label + ' sync');
    const display = value => value === null ? 'null' : value === main ? 'main' : value === submodule ? 'submodule' : value === source ? 'source' : 'cwd fallback';
    console.log(label + ': git=' + gitExit + ', async=' + display(asyncRoot) + ', sync=' + display(syncRoot));
  });
  await t.test('commondir preserves path whitespace and strips only the line ending', async () => {
    if (process.platform === 'win32') return t.skip('Git for Windows cannot address directory names ending in spaces');
    const spacedCommon = join(f.dir, 'common metadata ');
    try {
      await symlink(join(main, '.git'), spacedCommon, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('directory links are not permitted here');
      throw error;
    }
    await writeFile(join(worktreeMetadata, 'commondir'), spacedCommon + '\n');
    git(worktree, ['rev-parse', '--show-toplevel']);
    assert.equal(await canonicalGitRoot(worktree), main);
    assert.equal((await f.remote.status({ cwd: worktree })).projectRoot, main);
    console.log('Existing commondir ending in a space: git=0, async=main, sync=main');

    // The same padding is not decoration: it names a directory that does not exist.
    await writeFile(join(worktreeMetadata, 'commondir'), '  ' + join(main, '.git') + '  \n');
    git(worktree, ['rev-parse', '--show-toplevel'], 128);
    assert.equal(await canonicalGitRoot(worktree), null);
    assert.equal((await f.remote.status({ cwd: worktree })).projectRoot, worktree);
    console.log('Padded nonexistent commondir: git=128, async=null, sync=cwd fallback');
  });

  await t.test('HEAD refs symlinks survive packed refs and unborn branches', async () => {
    const packed = await init('head-links-packed');
    const unborn = join(f.dir, 'head-links-unborn');
    await mkdir(unborn);
    git(unborn, ['init', '--initial-branch=main']);
    for (const repo of [packed, unborn]) {
      const head = join(repo, '.git', 'HEAD');
      await rm(head);
      try {
        await symlink('refs/heads/main', head);
      } catch (error) {
        if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('file symlinks are not permitted here');
        throw error;
      }
    }
    git(packed, ['pack-refs', '--all', '--prune']);
    for (const repo of [packed, unborn]) {
      git(repo, ['rev-parse', '--show-toplevel']);
      assert.equal(await canonicalGitRoot(repo), repo);
      assert.equal((await f.remote.status({ cwd: repo })).projectRoot, repo);
    }
    console.log('HEAD refs symlink packed/unborn: git=0, async=repo, sync=repo');
  });

  await t.test('HEAD symlink outside refs is not a symbolic ref', async () => {
    const repo = await init('head-links-non-refs');
    await writeFile(join(repo, '.git', 'head-target'), 'ref: refs/heads/main\n');
    const head = join(repo, '.git', 'HEAD');
    await rm(head);
    try {
      await symlink('head-target', head);
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('file symlinks are not permitted here');
      throw error;
    }
    git(repo, ['rev-parse', '--show-toplevel'], 128);
    assert.equal(await canonicalGitRoot(repo), null);
    assert.equal((await f.remote.status({ cwd: repo })).projectRoot, repo);
    console.log('HEAD non-refs symlink: git=128, async=null, sync=cwd fallback');
  });
});

test('toggle adds once and never mutates its input', () => {
  const list = [other];
  assert.deepEqual(toggleShareProject(list, root, true), [other, root]);
  assert.deepEqual(list, [other]);
  assert.deepEqual(toggleShareProject([root], root, true), [root]);
  assert.deepEqual(toggleShareProject([root + '/src'], root, true, expand, gitRoot), [root + '/src']);
});

test('toggle removes every duplicate, subdirectory and home alias', () => {
  const list = [root, root, root + '/src', '~/docs', other];
  const remaining = toggleShareProject(list, root, false, expand, gitRoot);
  assert.deepEqual(remaining, [other]);
  // The browser removes the original entries returned by the status response.
  const entries = list.filter(entry => !remaining.includes(entry));
  assert.deepEqual(list.filter(entry => !entries.includes(entry)), [other]);
  assert.equal(resolveShare(root, { shareProjects: remaining }, gitRoot, expand).active, false);
});

test('remote schemas require explicit dryRun and validate import results', () => {
  assert.deepEqual(importRequestSchema.parse({ dryRun: true }), { dryRun: true });
  assert.deepEqual(importRequestSchema.parse({ cwd: root, dryRun: false }), { cwd: root, dryRun: false });
  for (const invalid of [undefined, {}, { dryRun: 'false' }, { cwd: 7, dryRun: true }]) assert.throws(() => importRequestSchema.parse(invalid));
  const result = { projectRoot: root, from: '/claude', to: '/dsh', dryRun: true, copied: ['a.md'], identical: [], conflicts: [], indexAdded: 1 };
  assert.deepEqual(importResponseSchema.parse(result), result);
  assert.throws(() => importResponseSchema.parse({ ...result, refused: 'invalid' }));
  assert.throws(() => importResponseSchema.parse({ ...result, copied: [1] }));
  assert.throws(() => importResponseSchema.parse({ ...result, indexAdded: -1 }));
  assert.deepEqual(TYPERT.invocations.map(item => item.method), ['status', 'import']);
  assert.equal(TYPERT.package, '@kirkchinese/dsh-recollect');
  assert.deepEqual(TYPERT.invocations.map(item => item.id), ['@kirkchinese/dsh-recollect#recollect/status', '@kirkchinese/dsh-recollect#recollect/import']);
  assert.deepEqual(TYPERT.schemas.map(item => item.name), ['StatusRequest', 'StatusResponse', 'ImportRequest', 'ImportResponse']);
});

test('status schema preserves project sharing and Claude source metadata', () => {
  const status = { cwd: root, projectRoot: root, memoryDir: '/dsh/projects/example', memory: 'on', mode: 'files', share: { active: false, via: null, entries: [] }, claude: { dir: '/claude/projects/example/memory', exists: true, count: 2 }, files: [], total: 0, warn: 0, memories: [], dirs: [root] };
  assert.deepEqual(statusResponseSchema.parse(status), status);
  assert.throws(() => statusResponseSchema.parse({ ...status, projectRoot: undefined }));
});

/** Minimal hook driver for the unbundled panel; no browser dependencies. */
async function panelFixture(overrides = {}) {
  const slots = [];
  const effects = [];
  let cursor = 0;
  const changed = (a, b) => !a || a.length !== b.length || a.some((value, i) => value !== b[i]);
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(value => value !== null && value !== undefined) }),
    useState(value) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof value === 'function' ? value() : value;
      return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
    },
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useCallback(fn, deps) { const i = cursor++; if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect(fn, deps) { const i = cursor++; if (changed(slots[i], deps)) { slots[i] = deps; effects.push(fn); } },
  };
  const exports = {};
  const source = await readFile(new URL('../client/page.js', import.meta.url), 'utf8');
  runInNewContext(source + '\nexports.Panel = StatusPanel;', { require: name => name === 'react' ? React : { Button: 'Button', Switch: 'Switch', Tag: 'Tag' }, PACKAGE: '@kirkchinese/dsh-recollect', ROW_ID: 'recollect', SERVICE: 'recollect', FIELDS: [], LOCALES: {}, exports });
  const data = { cwd: root, projectRoot: root, share: { active: false, via: null, entries: [] }, claude: { dir: '/claude', count: 2, exists: true }, memoryDir: '/dsh', memory: 'on', mode: 'files', files: [], total: 0, memories: [], dirs: [root, other], ...overrides };
  const mutations = [], imports = [];
  const form = { state: { status: 'ready', writable: true, revision: 1, value: { memory: { shareProjects: [] } } }, mutate: async (ops, revision) => { mutations.push({ ops: JSON.parse(JSON.stringify(ops)), revision }); return true; } };
  const props = {
    t: key => key, form,
    status: async () => ({ ok: true, value: data }),
    importMemory: async req => { imports.push(req); return { projectRoot: root, from: '/claude', to: '/dsh', dryRun: req.dryRun, copied: ['new.md'], identical: [], conflicts: ['clash.md'], indexAdded: 1 }; },
  };
  const render = () => { cursor = 0; return exports.Panel(props); };
  const settle = async () => { for (const effect of effects.splice(0)) effect(); await new Promise(setImmediate); return render(); };
  const nodes = (tree, predicate) => {
    if (!tree || typeof tree !== 'object') return [];
    return [...(predicate(tree) ? [tree] : []), ...tree.children.flatMap(child => nodes(child, predicate))];
  };
  const button = (tree, key) => nodes(tree, n => n.type === 'Button' && n.children.includes(key))[0];
  render();
  await settle();
  return { data, form, props, mutations, imports, render, settle, nodes, button };
}

test('panel toggles remove canonical aliases using array mutation paths', async () => {
  const f = await panelFixture({ share: { active: true, via: 'project', entries: [root + '/src', '~/docs'] } });
  f.form.state.value.memory.shareProjects = [root + '/src', '~/docs', other];
  const toggle = f.nodes(f.render(), n => n.type === 'Switch')[0];
  assert.equal(toggle.props.checked, true);
  toggle.props.onChange(false);
  await f.settle();
  assert.deepEqual(f.mutations, [{ ops: [{ op: 'set', path: ['memory', 'shareProjects'], value: [other] }], revision: 1 }]);
});

test('panel previews before confirmation and clears previews on target or revision change', async () => {
  const f = await panelFixture();
  assert.equal(f.button(f.render(), 'status.import.confirm'), undefined);
  f.button(f.render(), 'status.import.preview').props.onClick();
  let tree = await f.settle();
  assert.equal(f.imports.length, 1);
  assert.equal(f.imports[0].dryRun, true);
  assert.ok(f.button(tree, 'status.import.confirm'));
  f.button(tree, 'status.import.confirm').props.onClick();
  tree = await f.settle();
  assert.equal(f.imports[1].dryRun, false);
  assert.equal(f.button(tree, 'status.import.confirm'), undefined);
  f.button(tree, 'status.import.preview').props.onClick();
  tree = await f.settle();
  f.form.state.revision = 2;
  assert.equal(f.button(f.render(), 'status.import.confirm'), undefined);
  tree = await f.settle();
  f.button(tree, 'status.import.preview').props.onClick();
  tree = await f.settle();
  f.nodes(tree, n => n.type === 'button' && n.children.includes(other))[0].props.onClick();
  tree = await f.settle();
  assert.equal(f.button(tree, 'status.import.confirm'), undefined);
});

test('panel enforces global, fixed-directory, read-only and empty-source disabled states', async () => {
  const f = await panelFixture();
  const toggle = () => f.nodes(f.render(), n => n.type === 'Switch')[0];
  f.form.state.value.memory.shareWithClaudeCode = true;
  assert.equal(toggle().props.checked, true);
  assert.equal(toggle().props.disabled, true);
  f.form.state.value.memory.directory = '/fixed';
  assert.equal(toggle().props.disabled, true);
  assert.equal(toggle().props.checked, false);
  f.form.state.value.memory = { shareProjects: [] };
  f.form.state.writable = false;
  assert.equal(toggle().props.disabled, true);
  f.form.state.writable = true;
  f.form.state.status = 'loading';
  assert.equal(toggle().props.disabled, true);
  f.data.claude.count = 0;
  assert.equal(f.button(f.render(), 'status.import.preview').props.disabled, true);
  f.data.claude.count = 2;
  f.data.share.active = true;
  assert.equal(f.button(f.render(), 'status.import.preview').props.disabled, true);
});

test('panel surfaces mutation failures and import refusal without offering confirmation', async () => {
  const f = await panelFixture();
  f.form.mutate = async () => false;
  f.nodes(f.render(), n => n.type === 'Switch')[0].props.onChange(true);
  let tree = await f.settle();
  assert.ok(f.nodes(tree, n => n.props.role === 'alert' && n.children.includes('status.share.failed')).length);
  f.props.importMemory = async req => ({ dryRun: req.dryRun, refused: 'memory-off', copied: [], identical: [], conflicts: [], indexAdded: 0 });
  f.button(f.render(), 'status.import.preview').props.onClick();
  tree = await f.settle();
  assert.ok(f.nodes(tree, n => n.children.includes('status.import.refused.memory-off')).length);
  assert.equal(f.button(tree, 'status.import.confirm'), undefined);
});

test('Chinese and English locale keys match exactly', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
});

/** Capture the real host handlers without starting a Cordis/Web server. */
async function hostFixture(language = 'zh') {
  const dir = await mkdtemp(join(tmpdir(), 'recollect-share-host-'));
  const project = join(dir, 'project'), otherProject = join(dir, 'other');
  await mkdir(join(project, '.git'), { recursive: true });
  await writeFile(join(project, '.git', 'HEAD'), 'ref: refs/heads/main');
  await mkdir(join(project, '.git', 'objects'));
  await mkdir(join(project, '.git', 'refs'));
  await mkdir(join(project, 'src')); await mkdir(otherProject);
  const memoryRoot = join(dir, 'dsh'), claudeHome = join(dir, 'claude');
  const config = Config({ language, memory: { root: memoryRoot, claudeHome }, instructions: { enabled: false } });
  const write = Object.getOwnPropertySymbols(config.memory).find(symbol => String(symbol).includes('volatile.write'));
  const setMemory = patch => config.memory[write]({ ...config.memory.get(), ...patch });
  const agents = [], commands = new Map(), cwdReads = [];
  let mounted;
  const ready = new Promise(resolve => { mounted = resolve; });
  const ctx = {
    logger: { warn: (...args) => assert.fail(args.join(' ')) },
    agents: { list: () => agents },
    workingDirectory: { get: session => { cwdReads.push(session.id); return session.header.cwd; } },
    tools: { guard: () => {} },
    get: () => undefined,
    effect: fn => fn(),
    on: () => {},
    inject: (_names, fn) => fn({ effect: fn => fn(), commands: { register: command => commands.set(command.name, command) } }),
    plugin: Service => { mounted(Object.create(Service.prototype)); },
  };
  apply(ctx, config);
  const remote = await ready;
  const agent = { session: { id: 'main', header: { cwd: project } } };
  agents.push(agent, { session: { id: 'child', header: { cwd: otherProject, origin: 'subagent' } } });
  const source = join(claudeHome, 'projects', projectSlug(project), 'memory');
  const otherSource = join(claudeHome, 'projects', projectSlug(otherProject), 'memory');
  for (const from of [source, otherSource]) {
    await mkdir(from, { recursive: true });
    await writeFile(join(from, 'topic.md'), 'topic');
    await writeFile(join(from, 'MEMORY.md'), '- [Topic](topic.md)\n');
  }
  return { dir, project, otherProject, memoryRoot, claudeHome, source, remote, setMemory, commands, agent, agents, cwdReads };
}

test('real host status and import honor project scope, fallback cwd and live config changes', async () => {
  const f = await hostFixture();
  let status = await f.remote.status({});
  assert.equal(status.cwd, f.project);
  assert.equal(status.projectRoot, f.project);
  assert.equal(status.memoryDir, join(f.memoryRoot, 'projects', projectSlug(f.project)));
  assert.deepEqual(status.share, { active: false, via: null, entries: [] });
  assert.deepEqual(status.claude, { dir: f.source, exists: true, count: 1 });
  statusResponseSchema.parse(status);
  const preview = await f.remote.import({ dryRun: true });
  assert.deepEqual(preview.copied, ['topic.md']);
  assert.equal(preview.indexAdded, 1);
  assert.equal(await readFile(join(preview.to, 'topic.md'), 'utf8').catch(() => undefined), undefined);
  const committed = await f.remote.import({ dryRun: false });
  importResponseSchema.parse(committed);
  assert.equal(await readFile(join(committed.to, 'topic.md'), 'utf8'), 'topic');
  f.setMemory({ shareProjects: [join(f.project, 'src')] });
  status = await f.remote.status({ cwd: f.project });
  assert.equal(status.memoryDir, f.source);
  assert.deepEqual(status.share, { active: true, via: 'project', entries: [join(f.project, 'src')] });
  assert.equal((await f.remote.import({ dryRun: false })).refused, 'shared');
  assert.equal((await f.remote.status({ cwd: f.otherProject })).share.active, false);
  f.setMemory({ directory: join(f.dir, 'fixed'), shareWithClaudeCode: true });
  status = await f.remote.status({});
  assert.equal(status.memoryDir, join(f.dir, 'fixed'));
  assert.equal(status.share.via, 'directory');
  assert.equal((await f.remote.import({ dryRun: true })).refused, undefined);
  f.setMemory({ enabled: false });
  assert.equal((await f.remote.import({ dryRun: true })).refused, 'memory-off');
});

test('memory-import command skips shared project slugs and respects directory priority', async () => {
  const f = await hostFixture();
  const command = input => f.commands.get('memory-import').handler({ agent: f.agent, rawInput: input });
  f.setMemory({ shareProjects: [join(f.project, 'src')] });
  const refused = await command('');
  assert.equal(refused.kind, 'error');
  assert.match(refused.text, /本项目已与 Claude Code 共用/);
  const all = await command('all');
  assert.equal(all.kind, 'success');
  assert.ok(all.text.includes('- ' + projectSlug(f.project) + '：已共用，跳过'));
  assert.equal(await readFile(join(f.memoryRoot, 'projects', projectSlug(f.otherProject), 'topic.md'), 'utf8'), 'topic');
  assert.equal(await readFile(join(f.memoryRoot, 'projects', projectSlug(f.project), 'topic.md'), 'utf8').catch(() => undefined), undefined);
  f.setMemory({ shareWithClaudeCode: true });
  assert.equal((await command('all')).kind, 'error');
  assert.equal((await command('')).kind, 'error');
  f.setMemory({ directory: join(f.dir, 'fixed') });
  assert.equal((await command('--dry-run')).kind, 'success');
});

test('fixed directory overrides shareProjects for all-project preview and import', async () => {
  const f = await hostFixture();
  const fixed = join(f.dir, 'fixed');
  f.setMemory({ directory: fixed, shareProjects: [f.project] });
  // Use a distinct topic so importing the other project cannot mask a skip.
  await writeFile(join(f.source, 'project-only.md'), 'only from shared project');
  const command = input => f.commands.get('memory-import').handler({ agent: f.agent, rawInput: input });
  const preview = await command('all --dry-run');
  assert.equal(preview.kind, 'success');
  assert.doesNotMatch(preview.text, /已共用，跳过/);
  assert.ok(preview.text.includes('- ' + projectSlug(f.project) + ' → ' + fixed + '：复制 2'));
  assert.equal(await readFile(join(fixed, 'project-only.md'), 'utf8').catch(() => undefined), undefined);
  const imported = await command('all');
  assert.equal(imported.kind, 'success');
  assert.doesNotMatch(imported.text, /已共用，跳过/);
  assert.equal(await readFile(join(fixed, 'project-only.md'), 'utf8'), 'only from shared project');
});

test('depth-only children are excluded from default target, live dirs and import refresh', async () => {
  const f = await hostFixture();
  f.agents.push({ session: { id: 'depth-only-child', header: { cwd: f.otherProject, delegationDepth: 1 } } });
  const status = await f.remote.status({});
  assert.equal(status.cwd, f.project);
  assert.deepEqual(status.dirs, [f.project]);
  // All sessions now resolve to the same memory directory. A child reaching
  // info() in refreshImported would read its cwd before setting pendingReason.
  f.setMemory({ directory: join(f.dir, 'fixed') });
  f.cwdReads.length = 0;
  const imported = await f.remote.import({ cwd: f.project, dryRun: false });
  assert.deepEqual(imported.copied, ['topic.md']);
  assert.ok(f.cwdReads.filter(id => id === 'main').length >= 3);
  assert.equal(f.cwdReads.includes('child'), false);
  assert.equal(f.cwdReads.includes('depth-only-child'), false);
});

test('language=en keeps memory-import refusals and shared-project reports in English', async () => {
  const f = await hostFixture('en');
  const command = rawInput => f.commands.get('memory-import').handler({ agent: f.agent, rawInput });
  f.setMemory({ shareProjects: [f.project] });
  assert.equal((await command('')).text, 'This project already shares memory with Claude Code; nothing to import.');
  assert.ok((await command('all --dry-run')).text.includes('- ' + projectSlug(f.project) + ': already shared; skipped'));
  f.setMemory({ shareWithClaudeCode: true });
  assert.equal((await command('all')).text, 'Memory is shared with Claude Code (memory.shareWithClaudeCode); nothing to import.');
  f.setMemory({ shareWithClaudeCode: false, shareProjects: [], enabled: false });
  for (const input of ['', 'all']) {
    const result = await command(input);
    assert.equal(result.kind, 'error');
    assert.equal(result.text, 'Memory is disabled; cannot import.');
  }
});

test('panel invalidates previews as soon as the directory input changes', async () => {
  const f = await panelFixture();
  f.button(f.render(), 'status.import.preview').props.onClick();
  let tree = await f.settle();
  assert.ok(f.button(tree, 'status.import.confirm'));
  f.nodes(tree, n => n.type === 'input')[0].props.onChange({ target: { value: other } });
  tree = f.render();
  assert.equal(f.button(tree, 'status.import.confirm'), undefined);
  assert.equal(f.button(tree, 'status.import.preview').props.disabled, true);
});

test('panel blocks sharing while the edited directory is unconfirmed', async () => {
  const f = await panelFixture();
  f.nodes(f.render(), n => n.type === 'input')[0].props.onChange({ target: { value: other } });
  const toggle = f.nodes(f.render(), n => n.type === 'Switch')[0];
  assert.equal(toggle.props.disabled, true);
  // Calling the handler directly must also be harmless, beyond the UI guard.
  toggle.props.onChange(true);
  await f.settle();
  assert.deepEqual(f.mutations, []);
  console.log('Unconfirmed directory: shareDisabled=' + toggle.props.disabled + ', mutations=' + f.mutations.length);
});

test('panel discards an in-flight preview after a configuration revision change', async () => {
  const f = await panelFixture();
  let finish;
  f.props.importMemory = () => new Promise(resolve => { finish = resolve; });
  f.button(f.render(), 'status.import.preview').props.onClick();
  f.form.state.revision = 2;
  f.render();
  await f.settle();
  finish({ dryRun: true, copied: ['old.md'], identical: [], conflicts: [], indexAdded: 1 });
  const tree = await f.settle();
  assert.equal(f.button(tree, 'status.import.confirm'), undefined);
  assert.equal(f.nodes(tree, n => n.props.role === 'status').length, 0);
});

test('client bundle matches renderClient in memory without writing tracked files', async () => {
  assert.equal(renderClient(), await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'));
});
