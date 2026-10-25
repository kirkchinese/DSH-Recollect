const types = ['user', 'feedback', 'project', 'reference'];
const dirSentence = mode => mode === 'tools'
  ? '该目录已存在；不要创建或检查它。只能用 memory_write / memory_edit 写入，内置文件工具在本会话中无法访问此目录。'
  : '该目录已存在；不要创建或检查它，直接用 write / edit 写入。';
const examples = {
  user: [
    ['我负责博物馆的无障碍导览，熟悉展陈但不熟悉前端。', 'user：负责无障碍导览；解释界面实现时从展陈流程出发。'],
    ['我是急诊护士，做统计项目时希望先看到临床意义，再看公式。', 'user：有临床背景；统计解释先交代实际意义。'],
    ['我每周要给社区志愿者做一次简短培训。', 'user：负责志愿者培训；建议材料以可讲述、可演练为主。']
  ],
  feedback: [
    ['别先做整套幻灯片；先给我一页讲稿确认语气，因为志愿者培训的受众变化很大。', 'feedback：培训材料先确认一页讲稿。Why：受众常变。How to apply：扩写前先取得语气确认。'],
    ['这次你先列风险再提采购建议很合适，以后器材采购也这样。', 'feedback：采购建议先列风险。Why：用户认可先审风险这一非显然顺序。How to apply：以后器材采购沿用。'],
    ['我问“真的要每天导出吗”是因为团队只在周五核对账本。', 'feedback：账本导出建议默认按每周核对节奏。Why：团队周五核对。How to apply：提出频率前先核实实际工作周期。']
  ],
  project: [
    ['我们在 2027 年 3 月 18 日试运行新的借阅流程，志愿者先试两周。', 'project：借阅流程于 2027-03-18 试运行两周；先考虑志愿者反馈。'],
    ['下周三必须交场馆疏散图，因为消防审核要留十天。', 'project：换算“下周三”为绝对日期后记录疏散图交付节点；消防审核需十天。'],
    ['这次口述史整理优先取得受访者复核，不要急着公开。', 'project：公开前先由受访者复核；保护叙述准确性。']
  ],
  reference: [
    ['活动报名异常都登记在内部表单 Event Intake，不在邮件里追。', 'reference：Event Intake 是活动报名异常的权威登记处。'],
    ['夜间温室读数看仪表板 Greenhouse Night；那是值班员交接依据。', 'reference：Greenhouse Night 仪表板用于夜间交接读数。'],
    ['策展反馈汇总在团队频道 #exhibit-notes。', 'reference：#exhibit-notes 是策展反馈汇总位置。']
  ]
};
function guidance({ title, dir, mode = 'files', readOnly = false, extraGuidelines = [] }) {
  const heading = title === 'Persistent Agent Memory' ? '智能体持久记忆' : '持久记忆';
  const out = [`# ${heading}`, '', '## 位置与使用方式', `这是位于 ${dir} 的文件式持久记忆。${readOnly ? '本会话只能读取，不能保存、编辑或删除记忆。' : dirSentence(mode)}`];
  if (!readOnly) out.push('', '## 长期职责', '跨越多次对话主动建立完整且有用的认识：用户是谁、承担什么责任、偏好怎样协作、哪些做法应避免或重复、其工作的背景与目标。积累记忆是持续职责，不是可选的收尾工作。', '', '## 明确请求立即处理', '用户说“记住”时，立即选择最合适的类型保存；用户说“忘记”时，找到对应记忆并删除。不要留待以后处理。');
  if (readOnly) out.push('', '## 索引与文件标识', 'MEMORY.md 是记忆索引；每个主题文件可由 frontmatter 的 name、description、metadata.type 识别，type 取 user、feedback、project 或 reference。本会话仅可利用这些信息定位和读取，不得执行保存步骤。');
  out.push('', '## 记忆类型');
  const blocks = [
    ['user', '记录用户角色、目标、职责、专业能力与协作偏好。获得与共同工作有关的信息时保存；用它按用户背景调整解释和建议，例如面对专家与初学者采用不同深度。保持有帮助的措辞，不评价人格，不记录无关细节。'],
    ['feedback', '记录用户对做事方式的指导：既包括“别这么做”的纠正，也包括认可非显然做法的确认。确认往往含蓄，不能只存纠正，否则会逐渐过度谨慎。用户明确纠正、说明偏好、肯定某种特殊取舍时保存；用其中原因判断以后遇到的边界情况。正文依次写规则、**Why:** 原因、**How to apply:** 适用情境。'],
    ['project', '记录无法从代码或 git 历史直接得知的在进行的目标、决定、期限与事故。知道谁在做什么、为什么、何时完成时保存；用于理解任务优先级和约束。信息会变化，记录相对日期前必须换算成绝对日期。正文依次写事实、**Why:** 动机或约束、**How to apply:** 对今后建议的影响。'],
    ['reference', '记录外部系统的入口及用途，例如问题跟踪器、仪表板、文档和讨论频道。得知某处是资料或反馈的可靠位置时保存；用户提到外部信息时据此定位，再查看最新内容。']
  ];
  for (const [type, detail] of blocks) {
    out.push('', `### ${type}`, detail, '示例：');
    for (const [u, a] of examples[type]) out.push(`- user: ${u} / assistant: [saves ${a}]`);
  }
  out.push('', '## 不应保存什么', '以下内容即使用户要求也不要作为记忆保存：可从仓库读取的代码结构、惯例、架构和文件路径；git 历史、变更列表与修改者；修复步骤（以代码和提交为准）；已写在 CLAUDE.md 或 AGENTS.md 指令文件里的内容；当前对话的临时任务状态。若要求保存 PR 清单等可重建记录，应追问其中有什么令人意外或不易从记录看出的认识，只保存这一持久洞见。');
  if (!readOnly) out.push('', '## 如何保存', '第一步：先查有无可更新的同主题记忆，避免重复；每个事实写入一个有描述性的独立文件，例如 `feedback_review_order.md`。使用以下 frontmatter，正文放在其后：', '```markdown', '---', 'name: short-kebab-case-slug', 'description: 一行具体说明，供未来会话判断何时需要读取', 'metadata:', '  type: user | feedback | project | reference', '---', '', '正文：记录持久事实及必要的背景。', '```', '正文可用 `[[name]]` 关联其他记忆；目标尚不存在也可以链接，表示值得以后补充。更新时保持 `name`、`description` 和 `metadata.type` 与内容一致。', '第二步：在 MEMORY.md 增加一条指针，格式严格为 `- [Title](file.md) — one-line hook`，每条控制在约 150 字符以下。MEMORY.md 是索引，不写 frontmatter，也不放记忆正文；它会进入每次对话，超过第 200 行的内容会被截断。', `按主题而非时间组织；发现错误或过时的记忆要修正或删除。${mode === 'tools' ? '删除时使用 memory_delete，并同步更新 MEMORY.md。' : '删除后同步更新 MEMORY.md。'}`);
  out.push('', '## 何时读取记忆', '当记忆与当前问题相关，或用户提起以往工作时读取。用户明确要求检查、回忆或记住时，必须访问记忆。若用户要求忽略记忆，不得使用、引用、对照或提及记忆内容。记忆仅记录写入时的情况；依据它作答前先与当前文件或资料核对。发生冲突时以现查结果为准，并修正或删除过时记忆。', '', '## 根据记忆提出建议之前', '记忆提到文件、函数或标志，只代表记录时可能存在：先确认文件仍在，用 grep 核实函数或标志，再让用户依据建议行动。仓库状态摘要只是快照；问当前或最近状态时优先看代码与 git log，不要把记忆当实时证据。', '', '## 与其他持久方式的分工', '只把对未来对话仍有价值的信息放入记忆。当前任务的方案应写在计划里，改变方案时更新计划；当前对话的步骤用 todo 列表跟踪，不要塞进记忆。');
  out.push(...extraGuidelines.map(x => String(x)));
  return out.join('\n');
}
export default {
  preamble: { strong: '以下是项目和用户指令文件。必须严格遵守；它们优先于你的默认行为，按原样执行。', soft: '以下是项目和用户指令文件，可用于指导本次工作。具体文件优先于一般文件；它们不覆盖系统、开发者或用户本次的直接指令。' },
  section: (path, label) => `## ${path}${label}\n\n`,
  labels: { Managed: ' （组织政策）', User: ' （用户的跨项目私人指令）', Project: ' （仓库内的项目指令）', Local: ' （本项目的私人指令，不纳入版本控制）', AutoMem: ' （跨会话的用户持久记忆索引）' },
  refresh: { when: { session_start: '会话开始时', compaction: '上下文压缩后', directory_changed: '工作目录变化后', memory_paused: '记忆暂停后', memory_resumed: '记忆恢复后', turn: '本轮开始时' }, intro: when => `在${when}重新读取的以下文件与此前显示的版本不同。以下每个文件取代其旧版本；此前的总说明仍然适用。`, removed: path => `${path} 已不存在；它之前的指令不再适用。` },
  nested: path => `## 后续发现的指令：${path}\n\n`,
  indexWarning: ({ lineCount, maxLines, sizeKB, maxKB, kind, keptLines, cutLines, nextLineNo, nextLineSnippet, keptChars }) => `> 警告：MEMORY.md 超出${kind === 'lines' ? '行数' : kind === 'size' ? '大小' : '行数和大小'}限制（${lineCount}/${maxLines} 行，${sizeKB}/${maxKB} KB）。仅加载了部分内容：${keptLines} 行；${nextLineNo === 1 ? `第 1 行前 ${keptChars} 字符之后全部截去` : `截去 ${cutLines} 行，从第 ${nextLineNo} 行「${nextLineSnippet}」开始`}。每条索引占一行，控制在约 200 字符以内，细节移至主题文件。`,
  guidance, directorySentence: dirSentence,
  agent: { scope: { user: '- user：适用于每个项目，只记录通用经验。', project: '- project：通过版本控制与团队共享，内容须针对本项目。', local: '- local：不进入版本控制，内容可针对本项目和这台机器。' }, indexHeading: '## MEMORY.md', indexEmpty: '索引目前为空；保存的记忆将出现在这里。', indexRefused: '索引未加载：它或其所在目录是链接、特殊文件，或位于工作副本之外。将此记忆视为只读，不要写入该目录。' },
  rememberPrompt: text => `请将以下内容立即保存到持久记忆，选用最合适的类型；若已有覆盖它的记忆则更新，不要重复，并保持 MEMORY.md 索引同步：\n${text}`,
  recall: { preamble: '以下记忆因可能相关而检索到；只有确实适用于当前问题时才使用。', age: days => `此记忆写于 ${days} 天前；它是当时的观察而非实时状态。有关代码的断言可能过期，请先核实再当作事实陈述。`, header: path => `记忆：${path}：`, truncated: (byBytes, path) => `此文件已截短（${byBytes ? '4096 字节限制' : '仅展示前 200 行'}）；可用 read 读取 ${path} 的全文。`, selectorSystem: '给定带类型、文件名、修改时间、描述的记忆文件列表，以及后续用户问题。每个问题最多选 5 个明显有助于回答的文件名；不确定就不选，空列表也可以。对于 user 和 project 类型尤其严格：依据问题实际主题匹配，不要只因为用户资料出现相同字词就选。不要重新选择本次对话先前已返回的文件。只输出 JSON：{"selected_memories": ["<filename>", ...]}。', selectorQuery: query => `请选择与以下问题相关的记忆：\n${query}` },
  lint: { indexOver: ({path,size,cap,target}) => `错误：${path} 写入成功，但索引大小 ${size} 超过读取上限 ${cap}，后续条目加载时会被静默丢弃。现在重写到 ${target} 以下：每条一行，细节移入主题文件，合并或删除过时条目。`, indexNear: ({path,size,cap,target}) => `${path} 已接近上限（${size}/${cap}）；现在精简至 ${target} 以下。`, fileOver: ({path,size,cap,shown,target}) => `错误：${path} 写入成功，但大小 ${size} 超过召回上限 ${cap}；其他会话只能看到前 ${shown}，后文不可见。现在压缩至 ${target} 以下：每文件一项事实，拆分不同事实，概括日志而非续写；不要创建 -2 续篇。`, fileNear: ({path,size,cap,target}) => `${path} 接近召回上限（${size}/${cap}）；只保留一项事实并压到 ${target} 以下。`, continuation: ({file,base,cap}) => `${file} 看起来是 ${base}.md 的续篇。召回逐文件独立处理，且各自仅显示 ${cap}，连载通常找不到。把持久事实合回 ${base}.md，或以单独事实命名并写专门描述。`, noDescription: '文件缺少 frontmatter 的 description，召回无法可靠选中；请补齐完整 frontmatter。', longDescription: n => `description 长达 ${n} 字符；缩成约 150 字符的一行具体说明，指出文件回答什么问题。` },
  tools: { list: '按路径排序列出记忆文件，可指定路径前缀，显示大小和更新时间；用 memory_read 查看内容。', read: '读取记忆目录中的单个文件，路径例如 /MEMORY.md。', write: '以完整内容创建或覆盖记忆文件；遗漏的旧行会被删除。仅保存持久知识，遵循系统提示的持久记忆规则，并随后更新 MEMORY.md。拒绝保存秘密。用户纠正你、指出你缺少的持久知识（包括“改成这样”的修改或怀疑式提问）时，当轮保存或更新其背后的偏好；“这次”“暂时”表示一次性范围。了解环境中的长期事实时也要保存。必须在处理纠正的同一回复内完成，而非日后再做。', edit: '在记忆文件中替换完全匹配的文字；除非 replace_all 为真，匹配必须唯一。', delete: '删除错误、已取代或用户要求忘记的记忆文件，并从 MEMORY.md 移除指针。', params: { path_prefix: '可选的目录内路径前缀，用于筛选列出的文件。', path: '记忆目录内的文件路径，用于列出、读取、写入、编辑或删除。', content: '文件完整内容；覆盖写入时未包含的行会消失。', old_string: '要替换的精确原文。', new_string: '用于替换的新文字。', replace_all: '是否替换全部匹配；否则只接受唯一匹配。' }, err: { empty: '不能保存空内容；如需移除记忆，请使用 memory_delete。', tooLarge: (bytes,cap) => `内容 ${bytes} 字节超过上限 ${cap}。`, secrets: labels => `禁止在记忆中保存凭据或其他秘密：${labels}。`, notFound: path => `未找到记忆文件：${path}。`, notUnique: (count,path) => `${path} 中有 ${count} 个匹配；请提供唯一原文或启用 replace_all。`, editTooLarge: (path,cap) => `编辑后的 ${path} 超过大小上限 ${cap}。`, paused: '记忆当前暂停，不能写入。', readOnly: '本会话记忆只读，不能写入。' }, ok: { created: (path,bytes) => `已创建 ${path}（${bytes} 字节）。`, updated: (path,bytes) => `已更新 ${path}（${bytes} 字节）。`, edited: (path,count) => `已编辑 ${path}（${count} 处）。`, deleted: path => `已删除 ${path}。` } },
  extract: { prompt: ({messageCount,manifest,tools,toolsMode}) => `你是记忆提取助手。只看最近约 ${messageCount} 条消息，据此更新持久记忆。可用工具：${tools}；其他工具一律禁用。步骤预算很小：edit 和覆盖 write 前必须先 read（${toolsMode ? '用 memory_read' : '用 read'}）；把所有读取放在同一个并行步骤，所有写入放在下一步骤，不要交错。只根据这些消息行动，不做额外调查或核实：禁止查代码、grep 源码或使用 git。${manifest ? `\n现有记忆文件：\n${manifest}\n优先更新现有文件，避免重复。` : ''}\n明确的记住或忘记请求按系统提示的规则立即处理；使用其中的类型、不应保存清单及 frontmatter 格式。如果没有值得保存的内容，仅回复：Nothing to save.`, tools: toolsMode => toolsMode ? '仅可用 read、grep、glob、只读 bash，以及 memory_list、memory_read、memory_write、memory_edit、memory_delete。' : '仅可用 read、grep、glob、只读 bash（ls/find/cat/stat/wc/head/tail 等）；write/edit 仅限记忆目录中的 .md 文件，bash rm 仅能删除其中的 .md 文件，且除 -f 外不得使用其他参数。', nothing: 'Nothing to save.' },
  dream: { prompt: ({memoryDir,sessionsDir,sessionIds,toolsMode,tools}) => `# 记忆整理\n反思现有记忆与近期所得，将其归并为耐久、易检索的知识，以便未来会话迅速理解背景。\n记忆目录：${memoryDir}。${dirSentence(toolsMode ? 'tools' : 'files')}\n会话记录目录：${sessionsDir}。记录是大型 JSONL，可能是 session.v4.jsonl，也可能是不能在此读取的 .jsonl.zstd；仅作窄范围搜索，切勿读取整个文件。\n## 阶段一：了解现状\n列出记忆目录，阅读 MEMORY.md，浏览主题文件，以改进现有文件为先。\n## 阶段二：收集线索\n先查与当前代码矛盾的过时记忆，再按具体疑点窄范围搜索会话记录；例如 grep -rn --include="*.jsonl" '具体线索' '${sessionsDir}' | tail -50。只追查已有理由认为重要的事实。\n## 阶段三：归并\n按系统提示的持久记忆格式更新或编写顶层文件；合并近似文件，把相对日期换为绝对日期，删除证伪的事实。\n## 阶段四：清理索引\nMEMORY.md 保持少于 200 行、约 25 KB 以下；它只是索引，每条用 - [Title](file.md) — one-line hook 格式且约 150 字符内。删除过时或被取代的指针；超过约 200 字符的条目将细节移到主题文件；添加重要新记忆并消除矛盾。\n## 与指令文件协调\nCLAUDE.md / AGENTS.md 指令已在上下文。若 feedback 或 project 记忆与指令文件在同一流程上矛盾，以已纳入仓库的指令为准：删除或修正记忆，保留有用原因。若记忆明确更新且明确纠正文件，不要改指令文件；标注冲突、待核实，并在摘要说明。补充细节或有理由的收窄不算冲突；单说“用户纠正过我”不足以证明比文件新。\n最后简要汇报合并、更新、删减的内容，若无需改动则直说。\n工具限制：${tools}；其他任何写入方式均被拒绝。\n上次整理以来的会话（${sessionIds.length}）：\n${sessionIds.map(id=>`- ${id}`).join('\n')}` },
  memoryUpdate: ({source,count,paths}) => { const who = source === 'extract' ? '后台提取' : '后台整理'; const summary = count === 0 ? `${who}更新了记忆索引` : `${who}保存了 ${count} 条记忆`; return { summary: summary.slice(0,119), text: `<system-reminder>\n后台${source === 'extract' ? '提取' : '整理'}已更新记忆目录：${summary}。变更文件：${paths.join(', ') || 'MEMORY.md'}。这是环境上下文，除非用户询问或与当前任务直接相关，否则不要向用户叙述。\n</system-reminder>` }; },
  guardDenied: '记忆助手只能读取文件，并通过允许的工具修改记忆目录中的 .md 文件。',
  commands: { memory: {description:'查看记忆状态与内容。'}, pause: {description:'暂停或恢复记忆。'}, remember: {description:'保存一项持久记忆。',hint:'输入要记住的内容。'}, dream: {description:'整理并精简持久记忆。'}, pausedOn:'已暂停记忆。', pausedOff:'已恢复记忆。', rememberUsage:'用法：/remember <要记住的内容>', rememberQueued:'已提交记忆请求。', memoryOff:'记忆功能未启用。', dreamDisabled:'记忆整理不可用。', dreamFailed: msg => `记忆整理失败：${msg}`, status: ({memory,mode,dir,recall,extract,dream,files,total,warn}) => `记忆：${memory}；模式：${mode}\n目录：${dir}\n召回：${recall}；提取：${extract}；整理：${dream}\n文件：${total} 个${files.length ? `\n${files.map(f=>`- ${f.type}: ${f.path} (${f.chars} 字符)`).join('\n')}` : ''}${warn ? `\n警告：${warn}` : ''}` }
};
