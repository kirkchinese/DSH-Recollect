import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndex, addDocument, removeDocument, rank, relevanceFloor, tokenize, stem } from '../lib/bm25.js';

const doc = (path, filename, text) => ({ path: `/memory/${path}`, filename, text });

test('Porter 1980 stemming examples', () => {
  for (const word of ['connection', 'connected', 'connecting']) assert.equal(stem(word), 'connect');
  assert.equal(stem('caresses'), 'caress');
  assert.equal(stem('ponies'), 'poni');
  assert.equal(stem('relational'), 'relat');
});

test('Unicode normalization, camelCase and letter/digit boundaries retain joined forms', () => {
  const terms = tokenize('café fetchData2 parseHTTPResponse RéSUMÉ');
  for (const term of ['cafe', 'fetch', 'data', '2', 'fetchdata2', 'pars', 'http', 'respons', 'parsehttprespons', 'resum']) assert.ok(terms.includes(term), term);
});

test('technology names map to searchable identifiers', () => {
  assert.deepEqual(tokenize('C++ C# .NET'), ['cpp', 'csharp', 'dotnet']);
  const index = createIndex([doc('a.md', 'a.md', 'Use C++ and C# on .NET')]);
  for (const query of ['C++', 'C#', '.NET']) assert.equal(rank(index, query, 1)[0].path, '/memory/a.md');
});

test('CJK runs emit overlapping bigrams and match inside longer runs', () => {
  assert.deepEqual(tokenize('只在周五部署'), ['只在', '在周', '周五', '五部', '部署']);
  assert.deepEqual(tokenize('中'), ['中']);
  const index = createIndex([doc('deploy.md', 'deploy.md', '只在周五部署')]);
  assert.equal(rank(index, '部署', 1)[0].path, '/memory/deploy.md');
});

test('BM25F emphasizes filename, YAML values and headings over body alone', () => {
  const index = createIndex([
    doc('filename.md', 'deployment-notes.md', 'unrelated'),
    doc('yaml.md', 'otherwise.md', '---\nname: Operations\ndescription: deployment steps\nmetadata:\n  type: project\n---\nunrelated'),
    doc('head.md', 'misc.md', '# Deployment\nOther content'),
    doc('body.md', 'miscellaneous.md', 'deployment'),
  ]);
  const results = rank(index, 'deployment', 10);
  assert.equal(results.length, 4);
  const score = path => results.find(item => item.path === `/memory/${path}`).score;
  assert.ok(score('filename.md') > score('body.md'));
  assert.ok(score('yaml.md') > score('body.md'));
  assert.ok(score('head.md') > score('body.md'));
});

test('fenced headings remain in body, not heading field', () => {
  const index = createIndex([
    doc('fenced.md', 'misc.md', '```md\n# deployment\n```'),
    doc('heading.md', 'misc.md', '# deployment'),
  ]);
  assert.equal(rank(index, 'deployment', 2)[0].path, '/memory/heading.md');
});

test('replacement removes old postings and removal clears a document', () => {
  const index = createIndex([doc('one.md', 'one.md', 'apricot')]);
  addDocument(index, doc('one.md', 'one.md', 'kumquat'));
  assert.equal(index.docs.size, 1);
  assert.deepEqual(rank(index, 'apricot', 10), []);
  assert.equal(rank(index, 'kumquat', 1)[0].path, '/memory/one.md');
  removeDocument(index, '/memory/one.md');
  assert.equal(index.docs.size, 0);
  assert.deepEqual(rank(index, 'kumquat', 10), []);
});

test('quoted phrases receive adjacency bonus in the same field', () => {
  const index = createIndex([
    doc('adjacent.md', 'misc.md', 'alpha beta'),
    doc('apart.md', 'misc.md', 'alpha x beta'),
  ]);
  assert.equal(rank(index, '"alpha beta"', 2)[0].path, '/memory/adjacent.md');
  assert.ok(rank(index, '"alpha beta"', 2)[0].score > rank(index, 'alpha beta', 2)[0].score);
});

test('query limit and truncation retain tail', () => {
  const index = createIndex([doc('tail.md', 'tail.md', 'rareendterm')]);
  assert.equal(rank(index, 'x'.repeat(5000) + ' rareendterm', 1)[0].path, '/memory/tail.md');
  assert.deepEqual(rank(index, 'rareendterm', 0), []);
});

test('relevance floor suppresses single rare body hit in larger corpora', () => {
  assert.equal(relevanceFloor(15), 0);
  const index = createIndex(Array.from({ length: 16 }, (_, i) => doc(`${i}.md`, `${i}.md`, i === 0 ? 'uniquebody' : 'other')));
  assert.ok(relevanceFloor(index.docs.size) > 0);
  assert.ok(rank(index, 'uniquebody', 1)[0].score < relevanceFloor(index.docs.size));
});
