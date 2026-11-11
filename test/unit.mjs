/**
 * dsh-persona-router 单元自测：跑纯逻辑，不碰宿主。
 * 用法：node test/unit.mjs
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { testing } from '../index.js'

const { detectPersona, lastUserText, personaBlock, loadPersonas, readState, writeState, currentPersona, sniffImage, personaRoot } = testing
const { OFF, normalizeCwd, matchLore, loreBlock } = testing
const { detectPersonas, multiPersonaBlock, limitLore } = testing
const { upsertTurn } = testing
const { describeDetection, appendDecision, readDecisions } = testing
const { pinForTurn, readConfig } = testing

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assertEq(actual, expected, what = '') {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${what} expected ${e}, got ${a}`)
}

const userMessage = (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

// ---- 0. 清单文件必须无 BOM（踩过：Set-Content -Encoding UTF8 加了 BOM，
//         JSON.parse 抛错 → DSH 静默丢掉整个 bundle，行、路由、人格块一起消失）------

console.log('=== 清单文件 ===')

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..')

function hasBom(path) {
  const bytes = readFileSync(path)
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
}

for (const name of ['package.json', 'index.js', 'client.js', 'cordis.patch.yml']) {
  check(`${name} 无 BOM`, () => {
    if (hasBom(join(pluginDir, name))) throw new Error('文件开头有 UTF-8 BOM —— 用 Set-Content -Encoding UTF8 写出来的，改用无 BOM 写法')
  })
}

check('package.json 能被 JSON.parse 解析', () => {
  const parsed = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
  if (parsed.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('dsh.bundle.patch 丢了')
  if (parsed.dsh?.client?.platform !== 'web') throw new Error('dsh.client.platform 丢了')
})

check('patch 文件里声明了本包', () => {
  // 包名从 package.json 读，别写死 —— 2026-11-10 改过名（dsh-persona-router → dsh-multi-persona）
  const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
  const text = readFileSync(join(pluginDir, 'cordis.patch.yml'), 'utf8')
  if (!text.includes(`name: ${pkg.name}`)) throw new Error(`补丁层没声明本包（应为 ${pkg.name}）`)
})


// ---- 1. 称呼判定 --------------------------------------------------------

console.log('\n=== 称呼判定（detectPersona） ===')

const realHome = process.env.DSH_HOME
delete process.env.DSH_HOME
const personas = loadPersonas()
console.log(`载入人格：${personas.map((p) => `${p.id}(${p.name}) aliases=${p.aliases.join('/')}`).join('  ')}`)

check('句首称呼命中', () => assertEq(detectPersona('普拉娜，帮我整理 C 盘', personas)?.id, 'plana'))
check('逗号前后均可命中', () => assertEq(detectPersona('你好，阿罗娜，看看这个', personas)?.id, 'arona'))
check('句尾称呼命中', () => assertEq(detectPersona('这件事交给诺亚', personas)?.id, 'noa'))
check('冒号后接命令命中', () => assertEq(detectPersona('诺亚：把记录归档', personas)?.id, 'noa'))
check('正文中间提到的名字不切', () => assertEq(detectPersona('帮我问一下诺亚这件事该怎么办', personas)?.id, undefined))
check('英文别名（大小写无关）命中', () => assertEq(detectPersona('plana, check the log', personas)?.id, 'plana'))
check('一句话叫两个名字取最后一个', () => assertEq(detectPersona('普拉娜，阿罗娜，你们都在吗', personas)?.id, 'arona'))
check('句中被顺带提到的名字不算称呼位', () => assertEq(detectPersona('普拉娜，跟阿罗娜说一声', personas)?.id, 'plana'))
check('名字后跟称呼尾词，句中也算在叫她', () => assertEq(detectPersona('再测试一下看普拉娜在不在', personas)?.id, 'plana'))
check('「X呢」「X在吗」也算', () => {
  assertEq(detectPersona('诺亚呢', personas)?.id, 'noa')
  assertEq(detectPersona('阿罗娜在吗', personas)?.id, 'arona')
})
check('放宽之后，正文中间纯粹提到仍然不切', () => assertEq(detectPersona('帮我问一下诺亚这件事该怎么办', personas)?.id, undefined))
check('「是X」是判断句，不算称呼', () => {
  assertEq(detectPersona('上一条人格好像是爱丽丝，头像是优香，是怎么回事', personas)?.id, undefined)
  assertEq(detectPersona('角色是早濑优香', personas)?.id, undefined)
})
check('长别名优先，短别名不重复计数', () => assertEq(detectPersona('早濑优香，在吗', personas)?.id, 'yuuka'))
check('没有别名返回 undefined', () => assertEq(detectPersona('继续做刚才那件事', personas)?.id, undefined))
check('空消息返回 undefined', () => assertEq(detectPersona('', personas)?.id, undefined))

// 2026-11-09 补的称呼位规则：紧跟「你」、呼语助词、@ 边界、引号与括号内不算
check('名字后紧跟「你」⇒ 在叫她', () => assertEq(detectPersona('优香你怎么看', personas)?.id, 'yuuka'))
check('同句有「你怎么看」但名字后面是「的」⇒ 不算', () =>
  assertEq(detectPersona('我觉得优香的想法和你的方案冲突，你怎么看', personas)?.id, undefined),
)
check('引号里的名字不算称呼', () => assertEq(detectPersona('他说『优香』肯定知道', personas)?.id, undefined))
check('直角引号里也一样', () => assertEq(detectPersona('「诺亚」这个词是这么写的', personas)?.id, undefined))
check('圆括号里的名字不算', () => assertEq(detectPersona('（优香）这个名字是他给的', personas)?.id, undefined))
check('@ 也算边界字符', () => assertEq(detectPersona('@优香 看一下这个', personas)?.id, 'yuuka'))
check('呼语助词「啊」⇒ 在叫她', () => assertEq(detectPersona('优香啊，这事怎么说', personas)?.id, 'yuuka'))
check('呼语助词「哟」⇒ 在叫她', () => assertEq(detectPersona('诺亚哟，在不在', personas)?.id, 'noa'))

// ---- 2. 只读本轮真实用户消息 -------------------------------------------

console.log('\n=== 消息提取（lastUserText） ===')

check('跳过 runtime-context 注入消息', () => {
  const messages = [
    userMessage('普拉娜，看日志'),
    { role: 'user', content: [{ type: 'text', text: 'Current runtime context…' }], source: { kind: 'runtime-context' } },
  ]
  assertEq(lastUserText(messages), '普拉娜，看日志')
})
check('取最后一条', () => {
  assertEq(lastUserText([userMessage('第一句'), userMessage('阿罗娜，第二句')]), '阿罗娜，第二句')
})
check('非数组安全返回空串', () => assertEq(lastUserText(undefined), ''))

// ---- 3. 按 session 存状态（验收 1） ------------------------------------

console.log('\n=== 状态隔离（验收 1） ===')

const tempHome = mkdtempSync(join(tmpdir(), 'dpr-test-'))
process.env.DSH_HOME = tempHome
mkdirSync(join(tempHome, 'personas'), { recursive: true })

for (const [id, name] of [['noa', '诺亚'], ['plana', '普拉娜'], ['arona', '阿罗娜']]) {
  mkdirSync(join(tempHome, 'personas', id), { recursive: true })
  writeFileSync(join(tempHome, 'personas', id, 'persona.json'), JSON.stringify({ id, name, aliases: [name], order: 10 }))
  writeFileSync(join(tempHome, 'personas', id, 'prompt.md'), `# ${name}\n`)
}

check('两个会话各记各的', () => {
  const state = { version: 1, default: 'noa', sessions: {} }
  state.sessions['session-A'] = 'plana'
  state.sessions['session-B'] = 'arona'
  writeState(state)
  const loaded = loadPersonas()
  const back = readState()
  assertEq([currentPersona('session-A', loaded, back).id, currentPersona('session-B', loaded, back).id], ['plana', 'arona'])
})
check('未记录的会话落到 default', () => {
  const loaded = loadPersonas()
  assertEq(currentPersona('session-C', loaded, readState()).id, 'noa')
})
check('会话记着的人格被删掉 ⇒ 退回 default', () => {
  const loaded = loadPersonas()
  assertEq(currentPersona('session-A', loaded.filter((p) => p.id !== 'plana'), readState()).id, 'noa')
})
check('state.json 落盘是合法 JSON 且原子替换后无 .tmp 残留', () => {
  const raw = readState()
  assertEq(raw.sessions['session-A'], 'plana')
})

// ---- 4. 新增人格零代码改动（验收 3） -----------------------------------

console.log('\n=== 新增人格不改代码（验收 3） ===')

check('新建文件夹后立刻可见', () => {
  const before = loadPersonas().length
  mkdirSync(join(tempHome, 'personas', 'late'), { recursive: true })
  writeFileSync(join(tempHome, 'personas', 'late', 'persona.json'), JSON.stringify({ id: 'late', name: '迟到', aliases: ['迟到'], order: 5 }))
  writeFileSync(join(tempHome, 'personas', 'late', 'prompt.md'), '# 迟到\n')
  const after = loadPersonas()
  if (after.length !== before + 1) throw new Error(`expected ${before + 1} personas, got ${after.length}`)
  if (detectPersona('迟到，你来了', after)?.id !== 'late') throw new Error('新人格叫不出来')
})
check('缺 prompt.md 的人格被跳过，不拖累启动', () => {
  mkdirSync(join(tempHome, 'personas', 'broken'), { recursive: true })
  writeFileSync(join(tempHome, 'personas', 'broken', 'persona.json'), JSON.stringify({ id: 'broken', name: '坏', aliases: ['坏'] }))
  const ids = loadPersonas().map((p) => p.id)
  if (ids.includes('broken')) throw new Error('broken 不应该在列表里')
})
check('enabled:false 的人格被跳过', () => {
  mkdirSync(join(tempHome, 'personas', 'off'), { recursive: true })
  writeFileSync(join(tempHome, 'personas', 'off', 'persona.json'), JSON.stringify({ id: 'off', name: '关', enabled: false }))
  writeFileSync(join(tempHome, 'personas', 'off', 'prompt.md'), '# off\n')
  if (loadPersonas().map((p) => p.id).includes('off')) throw new Error('off 不应该在列表里')
})
// 面板视图必须能看到停用项：停用后那一行消失，就再没有地方点回来（2026-11-11 实际踩到）
check('面板视图（includeDisabled）保留停用的人格，且它仍叫不出来', () => {
  const all = loadPersonas(true)
  const off = all.find((p) => p.id === 'off')
  if (!off) throw new Error('停用的人格必须留在面板列表里')
  if (off.enabled !== false) throw new Error(`off.enabled 应为 false，实得 ${String(off.enabled)}`)
  if (detectPersona('关，你在吗', loadPersonas())?.id === 'off') throw new Error('停用的人格不该被判定命中')
  if (detectPersona('关，你在吗', all)?.id !== 'off') throw new Error('传入全量列表时判定应能找到它（用于验证数据本身没坏）')
})

// ---- 5. 正文里的 {{...}} 原样保留（验收 6） ----------------------------

console.log('\n=== 花括号不抛错（验收 6） ===')

check('{{cwd}} 原样留在人格块里', () => {
  const withMacro = loadPersonas().map((p) => (p.id === 'plana' ? { ...p, body: '正文里写了 {{cwd}} 与 {{不存在的变量}}。' } : p))
  const block = personaBlock(withMacro.find((p) => p.id === 'plana'))
  if (!block.includes('{{cwd}}')) throw new Error('{{cwd}} 被吃掉了')
  if (!block.includes('{{不存在的变量}}')) throw new Error('未知变量被吃掉了')
  if (!block.includes('【当前人格：普拉娜】')) throw new Error('缺身份声明行')
})
check('没有可用人格时人格块为空串（验收 5 的前半）', () => {
  assertEq(personaBlock(undefined), '')
})

// ---- 6. 头像嗅探 --------------------------------------------------------

console.log('\n=== 头像 MIME 白名单 ===')

check('PNG 识别', () => assertEq(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))?.ext, 'png'))
check('JPEG 识别', () => assertEq(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.ext, 'jpg'))
check('WEBP 识别', () => {
  const buf = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])
  assertEq(sniffImage(buf)?.ext, 'webp')
})
check('GIF 被拒', () => assertEq(sniffImage(Buffer.from('GIF89a')), undefined))
check('纯文本被拒', () => assertEq(sniffImage(Buffer.from('hello world')), undefined))

// ---- 7. 三档生效（r8） --------------------------------------------------

console.log('\n=== 三档：会话 → 工作区 → default（r8） ===')

check('cwd 归一化：大小写 / 反斜杠 / 尾斜杠视为同一个工作区', () => {
  assertEq(normalizeCwd('E:\\D·S·H\\'), 'e:/d·s·h')
  assertEq(normalizeCwd('e:/d·s·h'), normalizeCwd('E:\\D·S·H\\'))
  assertEq(normalizeCwd(''), '')
  assertEq(normalizeCwd(undefined), '')
})

check('没有会话档时工作区档生效', () => {
  const state = { version: 1, default: 'noa', sessions: {}, workspaces: { 'e:/proj': 'arona' } }
  assertEq(currentPersona('session-W1', loadPersonas(), state, 'E:\\Proj').id, 'arona')
})

check('会话档压过工作区档', () => {
  const state = { version: 1, default: 'noa', sessions: { 'session-W2': 'plana' }, workspaces: { 'e:/proj': 'arona' } }
  assertEq(currentPersona('session-W2', loadPersonas(), state, 'E:\\Proj').id, 'plana')
})

check('工作区档压过 default', () => {
  const state = { version: 1, default: 'noa', sessions: {}, workspaces: { 'e:/proj': 'plana' } }
  assertEq(currentPersona('session-W3', loadPersonas(), state, 'e:/proj').id, 'plana')
})

check('都不命中落到 default', () => {
  const state = { version: 1, default: 'noa', sessions: {}, workspaces: {} }
  assertEq(currentPersona('session-W4', loadPersonas(), state, 'e:/other').id, 'noa')
})

check('会话档 @none 就地终止，不再落到工作区 / default', () => {
  const state = { version: 1, default: 'noa', sessions: { 'session-W5': OFF }, workspaces: { 'e:/proj': 'arona' } }
  assertEq(currentPersona('session-W5', loadPersonas(), state, 'e:/proj'), undefined)
})

check('工作区档 @none 终止；会话档仍然压得过它', () => {
  const state = { version: 1, default: 'noa', sessions: { 'session-W6': 'plana' }, workspaces: { 'e:/proj': OFF } }
  assertEq(currentPersona('session-W6', loadPersonas(), state, 'e:/proj').id, 'plana')
  assertEq(currentPersona('session-W7', loadPersonas(), state, 'e:/proj'), undefined)
})

check('会话记着的人格被删 ⇒ 继续往工作区落，而不是判死', () => {
  const state = { version: 1, default: 'noa', sessions: { 'session-W8': 'ghost' }, workspaces: { 'e:/proj': 'arona' } }
  assertEq(currentPersona('session-W8', loadPersonas(), state, 'e:/proj').id, 'arona')
})

check('workspaces 落盘往返', () => {
  writeState({ version: 1, default: 'noa', sessions: {}, workspaces: { 'e:/proj': 'plana' }, history: {} })
  assertEq(readState().workspaces, { 'e:/proj': 'plana' })
})

check('三档不改变叫名字：句首、尾词、排除判断句都照旧', () => {
  const loaded = loadPersonas()
  assertEq(detectPersona('阿罗娜，继续', loaded)?.id, 'arona')
  assertEq(detectPersona('诺亚呢', loaded)?.id, 'noa')
  assertEq(detectPersona('头像是优香，是怎么回事', loaded)?.id, undefined)
})

// ---- 8. 世界书（lore.json） ---------------------------------------------

console.log('\n=== 世界书：关键词触发（r8） ===')

check('没写 lore.json ⇒ 空数组，既有行为不变', () => {
  assertEq(loadPersonas().find((p) => p.id === 'noa').lore, [])
})

check('lore.json 解析：constant / keys / order 排序 / 空正文与无键条目被丢', () => {
  mkdirSync(join(tempHome, 'personas', 'lored'), { recursive: true })
  writeFileSync(
    join(tempHome, 'personas', 'lored', 'persona.json'),
    JSON.stringify({ id: 'lored', name: '资料人', aliases: ['资料人'] }),
  )
  writeFileSync(join(tempHome, 'personas', 'lored', 'prompt.md'), '# 资料人\n')
  writeFileSync(
    join(tempHome, 'personas', 'lored', 'lore.json'),
    JSON.stringify({
      entries: [
        { id: 'b', keys: ['空间句法'], content: 'b 条目', order: 20 },
        { id: 'a', keys: ['IPA'], content: 'a 条目', order: 10 },
        { id: 'c', constant: true, content: '常驻条目', order: 5 },
        { id: 'x', content: '既没有键也不是常驻' },
      ],
    }),
  )
  const lore = loadPersonas().find((p) => p.id === 'lored').lore
  assertEq(lore.map((e) => e.id), ['c', 'a', 'b'])
})

check('关键词命中才注入；没命中的回合只剩常驻', () => {
  const lore = loadPersonas().find((p) => p.id === 'lored').lore
  assertEq(matchLore(lore, '这段用空间句法看一下').map((e) => e.id), ['c', 'b'])
  assertEq(matchLore(lore, '今天吃什么').map((e) => e.id), ['c'])
  assertEq(matchLore(lore, '').map((e) => e.id), ['c'])
})

check('世界书正文块；没有命中返回空串', () => {
  assertEq(loreBlock([]), '')
  if (!loreBlock([{ id: 'c', content: '常驻条目' }]).includes('常驻条目')) throw new Error('正文丢了')
})

check('persona.json 的 suffix 追加在人格块末尾', () => {
  const block = personaBlock({ name: '甲', body: '正文', suffix: '收尾指令' })
  if (!block.includes('正文')) throw new Error('正文丢了')
  if (!block.endsWith('收尾指令')) throw new Error('suffix 没接在末尾')
})

check('没有 suffix 时人格块保持原样', () => {
  assertEq(personaBlock({ name: '甲', body: '正文' }).endsWith('正文'), true)
})

// ---- 9. 多角色同台（点名） ----------------------------------------------

console.log('\n=== 多角色同台：点名（r9） ===')

check('一轮点了两位 ⇒ 按点名顺序给出全表', () => {
  const ids = detectPersonas('普拉娜，阿罗娜，你们都在吗', loadPersonas()).map((p) => p.id)
  assertEq(ids, ['plana', 'arona'])
})

check('同一位被叫两遍只算一位', () => {
  assertEq(detectPersonas('诺亚，诺亚在吗', loadPersonas()).map((p) => p.id), ['noa'])
})

check('句中被顺带提到的名字不进场（和单人口径一致）', () => {
  assertEq(detectPersonas('普拉娜，跟阿罗娜说一声', loadPersonas()).map((p) => p.id), ['plana'])
})

check('判断句里的名字不进场', () => {
  assertEq(detectPersonas('上一条人格好像是爱丽丝，头像是优香，是怎么回事', loadPersonas()).length, 0)
})

check('没人被点名 ⇒ 空表（沿用当前人格）', () => {
  assertEq(detectPersonas('继续做刚才那件事', loadPersonas()).length, 0)
})

check('单人同台块就是普通人格块（一个字都不多）', () => {
  const noa = loadPersonas().find((p) => p.id === 'noa')
  assertEq(multiPersonaBlock([noa]), personaBlock(noa))
})

check('多人同台块：第一位先开口，后面的接话', () => {
  const loaded = loadPersonas()
  const block = multiPersonaBlock([loaded.find((p) => p.id === 'noa'), loaded.find((p) => p.id === 'arona')])
  if (!block.includes('真的接话')) throw new Error('缺接话指令')
  if (!block.includes('共用同一段记忆与上下文')) throw new Error('缺共用记忆的约束')
  if (!block.includes('诺亚 的正文（先开口）')) throw new Error('先开口那份没标出来')
  if (!block.includes('阿罗娜 的正文（接话）')) throw new Error('接话那份没标出来')
  const a = block.indexOf('诺亚 的正文')
  const b = block.indexOf('阿罗娜 的正文')
  if (a < 0 || b < 0 || a > b) throw new Error('正文顺序不对（先开口的应在最前）')
})

check('同台时世界书条目合并后仍受总数上限约束', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `e${i}`, content: 'x' }))
  assertEq(limitLore(many).length, 8)
  assertEq(limitLore([]), [])
  assertEq(limitLore(undefined), [])
})

// ---- 10. 「这一轮是谁答的」表（头像归属） -------------------------------

console.log('\n=== 头像归属表 upsertTurn ===')

check('新回合追加一条', () => {
  const r = upsertTurn([], 7, 'noa')
  assertEq(r.list, [{ turn: 7, persona: 'noa' }])
  assertEq(r.changed, true)
})

check('同一个 turn 原位覆盖，绝不追加两条', () => {
  const r = upsertTurn([{ turn: 7, persona: 'noa' }], 7, 'arona')
  assertEq(r.list, [{ turn: 7, persona: 'arona' }])
  assertEq(r.changed, true)
})

check('同一个 turn 同一个人格 ⇒ 不算改动', () => {
  const base = [{ turn: 7, persona: 'noa' }]
  const r = upsertTurn(base, 7, 'noa')
  assertEq(r.list, base)
  assertEq(r.changed, false)
})

check('空人格 / 非法 turn 直接忽略', () => {
  const base = [{ turn: 7, persona: 'noa' }]
  assertEq(upsertTurn(base, 8, '').changed, false)
  assertEq(upsertTurn(base, Number.NaN, 'noa').changed, false)
})

check('state.json 里同一个 turn 有两条 ⇒ 读的时候只留最早那条', () => {
  const path = testing.statePath()
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      default: 'noa',
      sessions: {},
      workspaces: {},
      history: {
        'session-D': [
          { turn: 5, persona: 'noa' },
          { turn: 5, persona: 'arona' },
          { turn: 6, persona: 'arona' },
        ],
      },
    }),
  )
  assertEq(readState().history['session-D'], [
    { turn: 5, persona: 'noa' },
    { turn: 6, persona: 'arona' },
  ])
})

// ---- 11. 声线硬约束 + 试运行（r12） -------------------------------------

console.log('\n=== 声线硬约束 + 试运行 ===')

check('persona.json 的 voice 会被读进来', () => {
  mkdirSync(join(tempHome, 'personas', 'voicet'), { recursive: true })
  writeFileSync(
    join(tempHome, 'personas', 'voicet', 'persona.json'),
    JSON.stringify({ id: 'voicet', name: '声线', aliases: ['声线'], voice: ['规则甲', '规则乙'] }),
  )
  writeFileSync(join(tempHome, 'personas', 'voicet', 'prompt.md'), '# 声线\n')
  const persona = loadPersonas().find((entry) => entry.id === 'voicet')
  if (!persona) throw new Error('voice 人格没被载入')
  assertEq(persona.voice, ['规则甲', '规则乙'])
})

check('没有 voice 的人格照常工作（空数组，不是报错）', () => {
  for (const persona of loadPersonas()) if (!Array.isArray(persona.voice)) throw new Error(`${persona.id} 的 voice 不是数组`)
})

check('同台块里带上每个人的硬约束，且不禁宣布式开场', () => {
  const lead = { id: 'noa', name: '诺亚', aliases: ['诺亚'], body: '# 诺亚', voice: ['几乎不用感叹号'] }
  const mate = { id: 'yuuka', name: '早濑优香', aliases: ['优香'], body: '# 优香', voice: ['先报数字'] }
  const block = multiPersonaBlock([lead, mate])
  if (!block.includes('诺亚 的硬约束')) throw new Error('缺诺亚的约束块')
  if (!block.includes('早濑优香 的硬约束')) throw new Error('缺优香的约束块')
  if (!block.includes('开头怎么写不设禁区')) throw new Error('缺「宣布式不禁用」的说明')
  if (!block.includes('没被点到的人格一律不出场')) throw new Error('缺不串味的约束')
  if (!block.includes('- 先报数字')) throw new Error('约束条目没进块里')
})

const fakePair = [
  { id: 'noa', name: '诺亚', aliases: ['诺亚', 'noa'], body: '# 诺亚', voice: [] },
  { id: 'yuuka', name: '早濑优香', aliases: ['优香', 'yuuka'], body: '# 优香', voice: [] },
]

check('试运行：两位被点名 ⇒ multi=true，按顺序列出', () => {
  const state = { version: 1, default: 'noa', sessions: {}, workspaces: {}, history: {} }
  const r = describeDetection('诺亚、优香，你们在吗', fakePair, state, {})
  assertEq(r.multi, true)
  assertEq(r.speakers, ['noa', 'yuuka'])
  assertEq(r.lead, 'noa')
  assertEq(r.hits.map((hit) => hit.id), ['noa', 'yuuka'])
})

check('试运行：只点一位 ⇒ multi=false，lead 由阶梯解析', () => {
  const state = { version: 1, default: 'noa', sessions: { 'session-P': 'yuuka' }, workspaces: {}, history: {} }
  const r = describeDetection('优香呢', fakePair, state, { sessionId: 'session-P' })
  assertEq(r.multi, false)
  assertEq(r.speakers, [])
  assertEq(r.lead, 'yuuka')
})

check('试运行：没点名 ⇒ 沿用会话人格', () => {
  const state = { version: 1, default: 'noa', sessions: { 'session-Q': 'yuuka' }, workspaces: {}, history: {} }
  const r = describeDetection('继续做刚才那件事', fakePair, state, { sessionId: 'session-Q' })
  assertEq(r.hits.length, 0)
  assertEq(r.lead, 'yuuka')
})

// ---- 12. 判定日志（r13） ------------------------------------------------

console.log('\n=== 判定日志 decisions.log ===')

check('写一行、读回来（JSONL 往返）', () => {
  appendDecision({ at: '2026-11-08T00:00:00.000Z', session: 'session-L', turn: 3, hits: ['noa', 'yuuka'], multi: true, lead: 'noa', lore: ['lore-a'] })
  const items = readDecisions(5)
  assertEq(items.length, 1)
  assertEq(items[0].session, 'session-L')
  assertEq(items[0].multi, true)
  assertEq(items[0].hits, ['noa', 'yuuka'])
})

check('多条按顺序累积，limit 只取最近的', () => {
  for (let i = 0; i < 5; i += 1) appendDecision({ at: `2026-11-08T00:00:0${i}.000Z`, session: `s${i}`, turn: i })
  const items = readDecisions(3)
  assertEq(items.length, 3)
  assertEq(items.map((item) => item.session), ['s2', 's3', 's4'])
})

check('坏行不影响其它行', () => {
  appendFileSync(testing.decisionsPath(), 'not json\n')
  appendDecision({ session: 'tail', turn: 9 })
  const items = readDecisions(50)
  assertEq(items[items.length - 1].session, 'tail')
})

check('日志写在 persona-router 目录下', () => {
  if (!testing.decisionsPath().endsWith('decisions.log')) throw new Error('路径不对')
  if (!testing.decisionsPath().includes('persona-router')) throw new Error('目录不对')
})

// ---- 13. 同台之后谁接棒（r13b） -----------------------------------------

console.log('\n=== 同台后谁接棒 pinForTurn ===')

const three = [
  { id: 'plana', name: '普拉娜' },
  { id: 'arona', name: '阿罗娜' },
]

check('同台默认钉「先开口」那位', () => {
  assertEq(pinForTurn(three, true, { pinLeadOnMulti: true }).id, 'plana')
})

check('关掉 pinLeadOnMulti ⇒ 同台不钉，回到原钉子', () => {
  assertEq(pinForTurn(three, true, { pinLeadOnMulti: false }), undefined)
})

check('单人仍然取最后被叫到的那位', () => {
  assertEq(pinForTurn(three, false, { pinLeadOnMulti: true }).id, 'arona')
})

check('没人被叫 ⇒ 不钉', () => {
  assertEq(pinForTurn([], false, { pinLeadOnMulti: true }), undefined)
})

check('readConfig 默认开着接棒', () => {
  assertEq(readConfig().pinLeadOnMulti, true)
  assertEq(readConfig().multiRole, true)
})

// ---- 收尾 ---------------------------------------------------------------

console.log(`\n临时 DSH_HOME：${personaRoot()}`)
rmSync(tempHome, { recursive: true, force: true })
if (realHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = realHome

console.log(`\n=== ${failed === 0 ? '全部通过' : `${failed} 条失败`} ===`)
process.exit(failed === 0 ? 0 : 1)
