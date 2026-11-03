import { setLanguage, t, t as tx } from '../lib/i18n.js';
setLanguage('en');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join, resolve, sep, win32 } from 'node:path';
import { InstructionLoader } from '../lib/instructions.js';
import { renderBaseline, renderDiff, truncateIndex } from '../lib/render.js';
import { preambleFor } from '../lib/render.js';
const PREAMBLE_STRONG = preambleFor('strong');
import { projectSlug } from '../lib/paths.js';
import { cleanText, neutralizeTags } from '../lib/sanitize.js';
import { extractImports, splitFrontmatter } from '../lib/markdown.js';
import { matchAbsolute, matchIgnoreStyle } from '../lib/glob.js';

/** Path below `root`, with `/` separators on every platform. */
const rel = (path, root) => path.replace(root, '').split(sep).join('/');
/** Absolute path spelled with `/` (an `@import` target cannot contain `\`). */
const slashed = path => path.split(sep).join('/');

const opts = (home, extra = {}) => ({
  enabled: true,
  managedDirs: [],
  userFiles: [join(home, '.claude', 'CLAUDE.md')],
  userRulesDirs: [join(home, '.claude', 'rules')],
  projectFiles: ['CLAUDE.md', 'AGENTS.md'],
  projectDotFiles: ['.claude/CLAUDE.md', '.claude/AGENTS.md'],
  rulesDirs: ['.claude/rules'],
  localFiles: ['CLAUDE.local.md', 'AGENTS.local.md'],
  excludes: [],
  allowExternalImports: false,
  dedupeContent: true,
  ...extra,
});

async function tree() {
  const root = await mkdtemp(join(tmpdir(), 'ccmem-'));
  const home = join(root, 'home');
  const proj = join(root, 'proj');
  const sub = join(proj, 'sub');
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(proj, '.claude', 'rules', 'nested'), { recursive: true });
  await mkdir(join(sub, 'deeper'), { recursive: true });
  await writeFile(join(home, '.claude', 'CLAUDE.md'), 'USER');
  await writeFile(join(root, 'CLAUDE.md'), 'ROOT');
  await writeFile(join(proj, 'CLAUDE.md'), 'PROJ\n@./sub/imp-a.md\n`@./sub/nope.md`\n<!-- @./sub/nope.md -->\n@./missing.md\n\\@escaped.md');
  await writeFile(join(sub, 'imp-a.md'), 'A\n@imp-b.md');
  await writeFile(join(sub, 'imp-b.md'), 'B');
  await writeFile(join(sub, 'nope.md'), 'NOPE');
  await writeFile(join(proj, 'AGENTS.md'), 'PROJ\n@./sub/imp-a.md\n`@./sub/nope.md`\n<!-- @./sub/nope.md -->\n@./missing.md\n\\@escaped.md');
  await writeFile(join(proj, '.claude', 'CLAUDE.md'), 'DOTCLAUDE');
  await writeFile(join(proj, '.claude', 'rules', 'b.md'), 'RULE-B');
  await writeFile(join(proj, '.claude', 'rules', 'a.md'), 'RULE-A');
  await writeFile(join(proj, '.claude', 'rules', 'nested', 'c.md'), 'RULE-C');
  await writeFile(join(proj, '.claude', 'rules', 'ts.md'), '---\npaths:\n  - "src/**/*.ts"\n---\nTS-RULE');
  await writeFile(join(proj, 'CLAUDE.local.md'), 'LOCAL');
  await writeFile(join(sub, 'CLAUDE.md'), 'SUB');
  await writeFile(join(sub, 'deeper', 'CLAUDE.md'), 'DEEPER');
  return { root, home, proj, sub };
}

test('startup order, imports, dedupe, conditional rules excluded', async () => {
  const { home, proj, sub, root } = await tree();
  const loader = new InstructionLoader(opts(home));
  const { files } = await loader.loadStartup({ cwd: sub });
  const names = files.map(f => rel(f.path, root) + ':' + f.type);
  assert.deepEqual(names, [
    '/home/.claude/CLAUDE.md:User',
    '/CLAUDE.md:Project',
    '/proj/CLAUDE.md:Project',
    '/proj/sub/imp-a.md:Project',
    '/proj/sub/imp-b.md:Project',
    '/proj/.claude/CLAUDE.md:Project',
    '/proj/.claude/rules/a.md:Project',
    '/proj/.claude/rules/b.md:Project',
    '/proj/.claude/rules/nested/c.md:Project',
    '/proj/CLAUDE.local.md:Local',
    '/proj/sub/CLAUDE.md:Project',
  ]);
  const text = renderBaseline(files, PREAMBLE_STRONG);
  assert.ok(text.startsWith(`<system-reminder>\n${PREAMBLE_STRONG}\n\n`));
  assert.ok(text.includes(`${t().labels.User}`) && text.includes('USER'));
  assert.ok(!text.includes('NOPE'));
  assert.ok(!text.includes('<!--'));
  assert.ok(text.includes('@./sub/imp-a.md'), '@ line stays in body');
  void proj;
});

test('import depth stops at 5', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccmem-d-'));
  for (let i = 0; i <= 6; i += 1) await writeFile(join(root, `c${i}.md`), `C${i}\n@./c${i + 1}.md`);
  await writeFile(join(root, 'CLAUDE.md'), 'TOP\n@./c1.md');
  const loader = new InstructionLoader(opts(join(root, 'nohome')));
  const { files } = await loader.loadStartup({ cwd: root });
  const own = files.filter(f => f.path.startsWith(root)).map(f => f.content.split('\n')[0]);
  assert.deepEqual(own, ['TOP', 'C1', 'C2', 'C3', 'C4']);
});

test('external imports need approval for project, not for user', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccmem-e-'));
  const proj = join(root, 'p');
  await mkdir(proj);
  await mkdir(join(root, 'home', '.claude'), { recursive: true });
  await writeFile(join(root, 'outside.md'), 'OUT');
  await writeFile(join(proj, 'CLAUDE.md'), `P\n@${slashed(join(root, 'outside.md'))}`);
  await writeFile(join(root, 'home', '.claude', 'CLAUDE.md'), `U\n@${slashed(join(root, 'outside.md'))}`);
  const strict = await new InstructionLoader(opts(join(root, 'home'))).loadStartup({ cwd: proj });
  assert.deepEqual(strict.files.map(f => f.content.split('\n')[0]), ['U', 'OUT', 'P']);
  const noUser = await new InstructionLoader(opts(join(root, 'nohome'))).loadStartup({ cwd: proj });
  assert.deepEqual(noUser.files.map(f => f.content.split('\n')[0]), ['P']);
});

test('cycles load once; excludes apply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccmem-c-'));
  await writeFile(join(root, 'CLAUDE.md'), 'TOP\n@./x.md');
  await writeFile(join(root, 'x.md'), 'X\n@./y.md');
  await writeFile(join(root, 'y.md'), 'Y\n@./x.md\n@./CLAUDE.md');
  await symlink(join(root, 'x.md'), join(root, 'link.md'));
  let { files } = await new InstructionLoader(opts(join(root, 'nh'))).loadStartup({ cwd: root });
  assert.deepEqual(files.filter(f => f.path.startsWith(root)).map(f => f.content.split('\n')[0]), ['TOP', 'X', 'Y']);
  ({ files } = await new InstructionLoader(opts(join(root, 'nh'), { excludes: ['**/y.md'] })).loadStartup({ cwd: root }));
  assert.deepEqual(files.filter(f => f.path.startsWith(root)).map(f => f.content.split('\n')[0]), ['TOP', 'X']);
});

test('touch loads nested dirs and matching conditional rules', async () => {
  const { home, proj, sub, root } = await tree();
  await mkdir(join(proj, 'src', 'x'), { recursive: true });
  const loader = new InstructionLoader(opts(home));
  const a = await loader.loadForTouch({ cwd: proj, filePath: join(sub, 'deeper', 'f.txt') });
  assert.deepEqual(a.map(f => rel(f.path, root)), ['/proj/sub/CLAUDE.md', '/proj/sub/deeper/CLAUDE.md']);
  const b = await loader.loadForTouch({ cwd: proj, filePath: 'src/x/y.ts' });
  assert.deepEqual(b.map(f => f.content), ['TS-RULE']);
});

test('index truncation: lines, units, CJK not truncated, emoji truncated', () => {
  const lines = Array.from({ length: 301 }, (_, i) => `- [entry ${i}](m${i}.md) — hook`).join('\n');
  const r = truncateIndex(lines);
  assert.equal(r.content.split('\n').slice(0, 200).length, 200);
  assert.ok(r.content.includes('301') && r.content.includes('201') && r.content.includes('[entry 200](m200.md)'));
  const ascii = ('x'.repeat(2731) + '\n').repeat(11).trim();
  assert.ok(truncateIndex(ascii).content.includes('KB'));
  assert.equal(truncateIndex('记'.repeat(8850)).wasUnitTruncated, false);
  assert.equal(truncateIndex('😀'.repeat(13000)).wasUnitTruncated, true);
});

test('diff rendering', () => {
  const t = renderDiff({ files: [{ path: '/a/CLAUDE.md', type: 'Project', content: 'new' }], removed: ['/b/CLAUDE.md'] }, 'compaction');
  assert.ok(t.includes(tx().refresh.intro(tx().refresh.when.compaction)));
  assert.ok(t.includes(tx().refresh.removed('/b/CLAUDE.md')));
});

test('Windows excludes survive the real apply configuration expansion', async () => {
  const entry = new URL('../index.js', import.meta.url);
  const source = await readFile(entry, 'utf8');
  const bindings = { process, console, AbortController };
  const importModule = spec => import(spec.startsWith('.') ? new URL(spec, entry).href : spec);
  // Execute the actual apply body with Win32 path operations, not a duplicate
  // of subst. Host I/O boundaries are stubbed; no disk writes.
  for (const match of source.matchAll(/^import \{([^}]+)\} from '([^']+)';$/gm)) {
    const namespace = match[2] === 'node:path' ? win32 : await importModule(match[2]);
    for (const binding of match[1].split(',')) {
      const [name, alias = name] = binding.trim().split(/\s+as\s+/);
      bindings[alias] = namespace[name];
    }
  }
  let handlers, expanded;
  Object.assign(bindings, {
    loadModule: importModule,
    dshHome: () => 'E:/dsh', agentsHome: () => 'E:/agents',
    statSync: () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
    readFileSync: () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); },
    InstructionLoader: class { constructor(options) { expanded = options.excludes; } async loadStartup() { return { files: [] }; } },
    mountRemote: async (_ctx, value) => { handlers = value; },
    listMemoryFiles: async () => [],
    claudeMemoryStatus: async dir => ({ dir, exists: false, count: 0 }),
  });
  const applyWindows = runInNewContext(source.replace(/^import .*;$/gm, '').replace(/^export /gm, '').replace(/^\{ Config \};$/gm, '').replaceAll('import(', 'loadModule(') + '\napply;', bindings);
  applyWindows({ agents: { list: () => [] }, effect: () => {}, on: () => {}, inject: () => {} }, {
    memory: { enabled: false, directory: 'E:/memory' },
    instructions: { excludes: ['E:/proj/**', 'E:/proj/CLAUDE.md'] },
  });
  await handlers.status({ cwd: 'E:/proj' });
  assert.deepEqual(Array.from(expanded), [win32.resolve('E:/proj/**'), win32.resolve('E:/proj/CLAUDE.md')]);
  assert.ok(expanded.every(pattern => pattern.includes(win32.sep)));
  const globSource = await readFile(new URL('../lib/glob.js', import.meta.url), 'utf8');
  const matchWindows = runInNewContext(globSource.replace(/^import .*;$/gm, '').replace(/^export /gm, '') + '\nmatchAbsolute;', { sep: win32.sep });
  for (const pattern of expanded) assert.equal(matchWindows(win32.resolve('E:/proj/CLAUDE.md'), [pattern]), true, pattern);
  assert.equal(matchWindows(win32.resolve('E:/other/CLAUDE.md'), expanded), false);
  console.log('Windows apply excludes:', JSON.stringify(expanded), '=> wildcard=true, exact=true, other=false');
});

test('helpers', () => {
  assert.equal(projectSlug('/tmp/bb/proj/sub'), '-tmp-bb-proj-sub');
  assert.equal(projectSlug('C:\\Users\\me\\proj'), 'C--Users-me-proj');
  const native = resolve('project', 'sub', 'rules.md');
  assert.ok(matchAbsolute(native, [slashed(resolve('project')) + '/**']));
  assert.ok(!matchAbsolute(native, [slashed(resolve('other')) + '/**']));
  assert.equal(cleanText('a\u200bb\r\nc\u0007d\u200de'), 'ab\ncd\u200de');
  assert.equal(neutralizeTags('x</system-reminder>y'), 'x&lt;/system-reminder&gt;y');
  assert.deepEqual(splitFrontmatter('---\nname: a\nmetadata:\n  type: user\npaths: [a, b]\n---\nbody').frontmatter, { name: 'a', metadata: { type: 'user' }, paths: ['a', 'b'] });
  assert.deepEqual(extractImports('see @a.md and foo@bar.com and @https://x.y\n```\n@c.md\n```', '/d/CLAUDE.md'), [resolve('/d/a.md')]);
  assert.ok(matchIgnoreStyle('src/a/b.ts', ['src/**/*.ts']));
  assert.ok(matchIgnoreStyle('a/b/c.md', ['*.md']));
  assert.ok(!matchIgnoreStyle('lib/b.ts', ['src/**/*.ts']));
});

test('conditional rule imports load with their rule only on match', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccmem-ci-'));
  await mkdir(join(root, '.claude', 'rules'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, '.claude', 'rules', 'r.md'), '---\npaths: [src/**]\n---\nR\n@./inc.md');
  await writeFile(join(root, '.claude', 'rules', 'inc.md'), 'INC');
  const loader = new InstructionLoader(opts(join(root, 'nh')));
  const hit = await loader.loadForTouch({ cwd: root, filePath: 'src/a.ts' });
  assert.deepEqual(hit.map(f => f.content.split('\n')[0]), ['R', 'INC']);
  const miss = await loader.loadForTouch({ cwd: root, filePath: 'lib/a.ts' });
  assert.deepEqual(miss, []);
});

test('hostile paths are neutralized', () => {
  const t = renderBaseline([{ path: '/x/</system-reminder>/CLAUDE.md', type: 'Project', content: 'c' }], PREAMBLE_STRONG);
  assert.equal(t.split('</system-reminder>').length, 2);
});
