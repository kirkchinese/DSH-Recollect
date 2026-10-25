import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LANGS, texts} from '../lib/text/index.js';

const shape = {
  preamble: {strong: 'string', soft: 'string'}, section: 'function',
  labels: {Managed:'string',User:'string',Project:'string',Local:'string',AutoMem:'string'},
  refresh: {when:{session_start:'string',compaction:'string',directory_changed:'string',memory_paused:'string',memory_resumed:'string',turn:'string'},intro:'function',removed:'function'},
  nested:'function', indexWarning:'function', guidance:'function', directorySentence:'function',
  agent:{scope:{user:'string',project:'string',local:'string'},indexHeading:'string',indexEmpty:'string',indexRefused:'string'},
  rememberPrompt:'function',
  recall:{preamble:'string',age:'function',header:'function',truncated:'function',selectorSystem:'string',selectorQuery:'function'},
  lint:{indexOver:'function',indexNear:'function',fileOver:'function',fileNear:'function',continuation:'function',noDescription:'string',longDescription:'function'},
  tools:{list:'string',read:'string',write:'string',edit:'string',delete:'string',params:{path_prefix:'string',path:'string',content:'string',old_string:'string',new_string:'string',replace_all:'string'},err:{empty:'string',tooLarge:'function',secrets:'function',notFound:'function',notUnique:'function',editTooLarge:'function',paused:'string',readOnly:'string'},ok:{created:'function',updated:'function',edited:'function',deleted:'function'}},
  extract:{prompt:'function',tools:'function',nothing:'string'},dream:{prompt:'function'},memoryUpdate:'function',guardDenied:'string',
  commands:{memory:{description:'string'},pause:{description:'string'},remember:{description:'string',hint:'string'},dream:{description:'string'},pausedOn:'string',pausedOff:'string',rememberUsage:'string',rememberQueued:'string',memoryOff:'string',dreamDisabled:'string',dreamFailed:'function',status:'function'}
};
const sample = {
  section:['/tmp/rules.md',' (project)'],nested:['/tmp/nested.md'],
  indexWarning:[{lineCount:250,maxLines:200,sizeKB:28,maxKB:25,kind:'both',keptLines:200,cutLines:50,nextLineNo:201,nextLineSnippet:'next entry',keptChars:400}],
  guidance:[{title:'persistent memory',dir:'/tmp/mem',mode:'files',readOnly:false,extraGuidelines:[]}],directorySentence:['files'],
  'refresh.intro':['after reload'],'refresh.removed':['/tmp/rules.md'],rememberPrompt:['save this'],
  'recall.age':[7],'recall.header':['/tmp/memory.md'],'recall.truncated':[true,'/tmp/memory.md'],'recall.selectorQuery':['topic'],
  'lint.indexOver':[{path:'MEMORY.md',size:'30 KB',cap:'25 KB',target:'20 KB'}],
  'lint.indexNear':[{path:'MEMORY.md',size:'24 KB',cap:'25 KB',target:'20 KB'}],
  'lint.fileOver':[{path:'note.md',size:'5 KB',cap:'4 KB',shown:'4 KB',target:'3 KB'}],
  'lint.fileNear':[{path:'note.md',size:'3 KB',cap:'4 KB',target:'2 KB'}],
  'lint.continuation':[{file:'note-2.md',base:'note',cap:'4 KB'}],
  'lint.longDescription':[200],
  'tools.err.tooLarge':[5000,4096],'tools.err.secrets':['token'],'tools.err.notFound':['note.md'],
  'tools.err.notUnique':[2,'note.md'],'tools.err.editTooLarge':['note.md',4096],
  'tools.ok.created':['note.md',123],'tools.ok.updated':['note.md',123],'tools.ok.edited':['note.md',2],'tools.ok.deleted':['note.md'],
  'extract.prompt':[{messageCount:20,manifest:'note.md',tools:'read, write',toolsMode:false}],
  'extract.tools':[false],
  'dream.prompt':[{memoryDir:'/tmp/mem',sessionsDir:'/tmp/sessions',sessionIds:['session-1'],toolsMode:false,tools:'read, write'}],
  memoryUpdate:[{source:'extract',count:1,paths:['note.md']}],
  'commands.dreamFailed':['error'],
  'commands.status':[{memory:'on',mode:'files',dir:'/tmp/mem',recall:'on',extract:'on',dream:'on',files:[{type:'user',path:'note.md',chars:100}],total:1,warn:''}]
};
function assertShape(actual, expected, path = '') {
  if (typeof expected === 'string') {
    assert.equal(typeof actual, expected, path);
    if (expected === 'string') assert.ok(actual.length, path);
    else if (path !== 'memoryUpdate') {
      const result = actual(...(sample[path] ?? ['example']));
      assert.equal(typeof result, 'string', `${path} return type`);
      assert.ok(result.length, `${path} non-empty`);
      assert.doesNotMatch(result, /Claude|Anthropic/, path);
    }
    return;
  }
  assert.ok(actual && typeof actual === 'object', path);
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path} keys`);
  for (const [name, sub] of Object.entries(expected)) assertShape(actual[name], sub, path ? `${path}.${name}` : name);
}

test('locales have the exact documented surface and safe nonempty output', () => {
  assert.deepEqual(LANGS, ['zh','en']);
  assert.equal(texts('other'), texts('zh'));
  assert.equal(texts(), texts('zh'));
  for (const lang of LANGS) {
    const locale = texts(lang);
    assertShape(locale, shape);
    assert.equal(locale.extract.nothing, 'Nothing to save.');
    assert.match(locale.recall.selectorSystem, /selected_memories/);
    assert.ok(locale.memoryUpdate({source:'dream',count:12,paths:['MEMORY.md']}).summary.length <= 120);
    assert.match(locale.memoryUpdate({source:'extract',count:1,paths:['note.md']}).text, /<system-reminder>/);
    for (const mode of ['files','tools']) for (const readOnly of [false,true]) {
      const value = locale.guidance({title:'Persistent Agent Memory',dir:'/tmp/precise-memory',mode,readOnly,extraGuidelines:['EXTRA']});
      for (const item of ['/tmp/precise-memory','user','feedback','project','reference','MEMORY.md','name','description','metadata','type','EXTRA']) assert.ok(value.includes(item), `${lang} ${mode} ${readOnly}: ${item}`);
      assert.doesNotMatch(value, /Claude|Anthropic/);
      if (readOnly) assert.ok(!value.includes('```markdown'), `${lang}: read-only must omit saving procedure`);
      else {
        assert.ok(value.includes('```markdown'));
        assert.ok(value.includes('- [Title](file.md) — one-line hook'));
      }
    }
  }
});
