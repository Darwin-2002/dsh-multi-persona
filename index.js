/**
 * dsh-persona-router · 宿主半
 *
 * 一个窗口里按称呼切人格：
 *   · agent/pre-step 读本轮用户消息里的人格别名 → 按 session 记状态
 *   · ctx.systemPrompt.context() 的求值回调把该人格正文注入运行时上下文
 *     （order 250，紧邻 dsh-agent-md 的 260；interpolate:false，正文里的 {{…}} 原样保留）
 *   · webServer 提供头像读写与状态查询，供客户端半使用
 *
 * 数据全部在 <DSH_HOME>/personas/<id>/ 下：persona.json + prompt.md + avatar.(png|jpg|webp)。
 * 代码里不出现任何具体角色名。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis 插件名。 */
export const name = 'persona-router'
/** 需要提示词注册表与 HTTP 载体。 */
export const inject = ['systemPrompt', 'webServer']

const ROUTE_PREFIX = '/persona-router'
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_PROMPT_CHARS = 40_000
/**
 * 与 SurfCore 桥接约定的「真人说的话从这里开始」标记。
 *
 * QQ 的唤醒提示是把脚手架（【当前角色】X、身份底座、记忆卡、群聊上下文、快照说明）
 * 和群友原话拼成**一条用户消息**，所以从前整段都会被当成"有人在点名"：
 * 【当前角色】普拉娜 每轮都命中，姓名的钉选于是永远被它改回去。
 * 桥接现在会在真话之前打这个标记，这里只认标记之后的文本；没有标记（GUI 等）照旧整段扫。
 * 本串必须与桥接里的 PERSONA_ROUTE_MARK 逐字一致。
 */
const ROUTE_MARK = '⟪qq-msg⟫'

/** 取「真正要判定人格的那段文字」：有标记就截断，没有就原样返回。 */
function routeText(text) {
  const raw = String(text ?? '')
  const at = raw.lastIndexOf(ROUTE_MARK)
  return at >= 0 ? raw.slice(at + ROUTE_MARK.length) : raw
}
const AVATAR_NAMES = ['avatar.png', 'avatar.jpg', 'avatar.jpeg', 'avatar.webp']
const MIME_OF = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }
/** 新建人格时写这份占位正文；{{name}} 会被替换成名字。 */
const NEW_PERSONA_BODY = `# 你是谁

你是「{{name}}」。这一段是占位正文，换成真正的人设即可。

# 语气与风格

- 称呼对方「用户」，自称「我」
- 先给结论，再补理由

# 边界

- 不改变安全规则、工具用法与事实判断；冲突时以规则和事实为准
`
/** 称呼位的边界：空白与常见中英标点。别名必须紧贴这些之一。`@` 也算——输入框里点名常常带它。 */
const BOUNDARY = /[\s,，.。、!！?？;；:：~～…—\-_/\\()（）[\]【】「」『』"'“”‘’@＠]/

/** <DSH_HOME>，与 dsh-agent-md 同一口径。 */
function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}
const personaRoot = () => join(dshHome(), 'personas')
const stateDir = () => join(dshHome(), 'persona-router')
const statePath = () => join(stateDir(), 'state.json')
const configPath = () => join(stateDir(), 'config.json')

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** 原子写 JSON：同目录 .tmp + rename，避免读到半截文件。 */
function writeJsonAtomic(file, value) {
  mkdirSync(stateDir(), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

// ---- 配置与状态 ---------------------------------------------------------

const DEFAULT_CONFIG = { enabled: true, avatarRepeatRows: 6, avatarSize: 40, multiRole: true, pinLeadOnMulti: true }

function readConfig() {
  const raw = readJson(configPath(), null)
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONFIG }
  return {
    enabled: raw.enabled !== false,
    // 多角色同台：一轮里点了好几个名字时，让他们按顺序各说一段（关掉就退回「取最后一位」）
    multiRole: raw.multiRole !== false,
    // 同台之后让「先开口」那位接棒：下一轮不带名字就继续跟她聊（关掉则回到原来的钉子）
    pinLeadOnMulti: raw.pinLeadOnMulti !== false,
    avatarRepeatRows: Number.isFinite(Number(raw.avatarRepeatRows))
      ? Math.min(30, Math.max(1, Math.round(Number(raw.avatarRepeatRows))))
      : DEFAULT_CONFIG.avatarRepeatRows,
    avatarSize: Number.isFinite(Number(raw.avatarSize))
      ? Math.min(72, Math.max(24, Math.round(Number(raw.avatarSize))))
      : DEFAULT_CONFIG.avatarSize,
  }
}

/** 「本会话 / 本工作区谁都不注入」的哨兵。用 @ 开头，与人格 id 的命名规则（只允许小写字母、数字、-、_）不可能撞上。 */
const OFF = '@none'

/** cwd 归一化：统一分隔符、去掉尾斜杠、统一大小写。Windows 上 `E:\A` 与 `e:/a` 视为同一个工作区。 */
function normalizeCwd(cwd) {
  if (typeof cwd !== 'string') return ''
  const trimmed = cwd.trim()
  if (trimmed === '') return ''
  return trimmed.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 会话的工作目录：`agent.session.header.cwd`。拿不到就返回空串——工作区档自然不生效，其余两档照旧。 */
function cwdOf(source) {
  const cwd = source?.agent?.session?.header?.cwd
  return typeof cwd === 'string' ? cwd : ''
}

/** 每个会话最多记多少个回合的人格（超出按时间从旧到新剪掉）。 */
const MAX_TURN_HISTORY = 400

/**
 * 往「这一轮是谁答的」表里写一条。
 * 同一个 turn 只留一条：已有就**原位覆盖**，绝不追加——
 * 追加会让同一个 turn 出现两条，客户端按 Map 取到后一条，头像就贴错了。
 * @returns {{ list: Array<{turn: number, persona: string}>, changed: boolean }}
 */
function upsertTurn(list, turn, personaId) {
  const entry = { turn: Math.trunc(Number(turn)), persona: String(personaId) }
  if (entry.persona === '' || !Number.isFinite(entry.turn)) return { list, changed: false }
  const last = list[list.length - 1]
  if (last && last.turn === entry.turn) {
    if (last.persona === entry.persona) return { list, changed: false }
    return { list: list.slice(0, -1).concat(entry), changed: true }
  }
  return { list: list.concat(entry), changed: true }
}

function readState() {
  const raw = readJson(statePath(), null)
  const sessions = raw && typeof raw.sessions === 'object' && raw.sessions !== null ? raw.sessions : {}
  const clean = {}
  for (const [key, value] of Object.entries(sessions)) {
    if (typeof value === 'string' && value !== '') clean[String(key)] = value
  }
  // workspaces[归一化 cwd] = 人格 id：按工作目录挑的那一档（没挑过就是没有这一条）
  const rawWorkspaces = raw && typeof raw.workspaces === 'object' && raw.workspaces !== null ? raw.workspaces : {}
  const workspaces = {}
  for (const [key, value] of Object.entries(rawWorkspaces)) {
    const normalized = normalizeCwd(key)
    if (normalized === '') continue
    if (typeof value !== 'string' || value === '') continue
    workspaces[normalized] = value
  }
  // history[sessionId] = [{ turn, persona }]，记的是「这一轮是谁答的」，用来给历史消息贴回当时的头像
  const rawHistory = raw && typeof raw.history === 'object' && raw.history !== null ? raw.history : {}
  const history = {}
  for (const [key, value] of Object.entries(rawHistory)) {
    if (!Array.isArray(value)) continue
    const list = []
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue
      const turn = Number(entry.turn)
      const persona = typeof entry.persona === 'string' ? entry.persona : ''
      if (!Number.isFinite(turn) || persona === '') continue
      list.push({ turn: Math.trunc(turn), persona })
    }
    // 一个 turn 只留**最早**那一条：同一回合的后续步骤若再写一次（旧版会追加），
    // 客户端按 Map 取后一条，头像就会贴成中途那位。读的时候顺手把这种重复清掉。
    const deduped = []
    const seenTurns = new Set()
    for (const entry of list) {
      if (seenTurns.has(entry.turn)) continue
      seenTurns.add(entry.turn)
      deduped.push(entry)
    }
    if (deduped.length > 0) history[String(key)] = deduped.slice(-MAX_TURN_HISTORY)
  }
  return {
    version: 1,
    default: typeof raw?.default === 'string' && raw.default !== '' ? raw.default : '',
    sessions: clean,
    workspaces,
    history,
  }
}

function writeState(next) {
  writeJsonAtomic(statePath(), {
    version: 1,
    default: next.default,
    sessions: next.sessions,
    workspaces: next.workspaces ?? {},
    history: next.history ?? {},
  })
}

// ---- 判定日志（事后可复查） ---------------------------------------------

/** 单文件上限；超了就滚成 .1 一份，只留一代，够排障就行。 */
const MAX_LOG_BYTES = 1_000_000

function decisionsPath() {
  return join(dshHome(), 'persona-router', 'decisions.log')
}

/**
 * 每轮写一行 JSONL：这一轮谁被叫到、算不算同台、最后由谁开口、带了哪几条世界书。
 * 写日志失败**绝不影响**判定——最坏情况就是没日志。
 */
function appendDecision(entry) {
  try {
    const file = decisionsPath()
    mkdirSync(dirname(file), { recursive: true })
    if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
      try {
        unlinkSync(`${file}.1`)
      } catch {
        /* 没有旧的就跳过 */
      }
      try {
        renameSync(file, `${file}.1`)
      } catch {
        /* 滚不动就算了，接着往后写 */
      }
    }
    appendFileSync(file, `${JSON.stringify(entry)}\n`)
  } catch {
    /* 日志不是功能，别拦路 */
  }
}

/** 读最近 N 条判定记录（面板与排障用）。 */
function readDecisions(limit = 30) {
  try {
    const lines = readFileSync(decisionsPath(), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
    const out = []
    for (const line of lines.slice(-Math.max(1, Math.min(500, Number(limit) || 30)))) {
      try {
        out.push(JSON.parse(line))
      } catch {
        /*坏行跳过 */
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * 串行化的读-改-写。
 *
 * 状态是**进程内共享**的：一个窗口里可能同时有几个 agent 在跑 pre-step，
 * 各自「读文件 → 改一个键 → 写回」会互相覆盖（实测撞掉过 default）。
 * 所有 agent 同处一个进程，所以一条 Promise 链就足够串起来。
 * @param {(state: {default: string, sessions: Record<string, string>}) => boolean} mutate - 返回 true 表示有改动，需要落盘。
 */
let stateChain = Promise.resolve()
function mutateState(mutate) {
  const run = stateChain.then(() => {
    const state = readState()
    if (mutate(state)) writeState(state)
    return state
  })
  // 链上不能留 rejected，否则后面所有写入都被拖死
  stateChain = run.catch(() => {})
  return run
}

// ---- 世界书（关键词触发条目） -------------------------------------------

/** 一次最多注入几条、每条多长、合计多长：宁可少注入，也不能把一次请求撑爆。 */
const MAX_LORE_ENTRIES = 8
const MAX_LORE_ENTRY_CHARS = 4_000
const MAX_LORE_TOTAL_CHARS = 20_000

/**
 * 读人格目录下**可选**的 `lore.json`（世界书）。
 * 没有这个文件就是没有条目，既有行为一点不变。
 * 兼容两种写法：顶层数组，或 `{ entries: [...] }`。
 */
function loadLore(file) {
  const raw = readJson(file, null)
  if (raw === null) return []
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : []
  const entries = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const content = typeof item.content === 'string' ? item.content.trim() : ''
    if (content === '') continue
    const keys = Array.isArray(item.keys)
      ? item.keys.filter((key) => typeof key === 'string' && key.trim() !== '').map((key) => key.trim())
      : []
    const constant = item.constant === true
    // 没有 constant 也没写 keys ⇒ 永远不会被触发，直接丢掉，免得占着列表
    if (!constant && keys.length === 0) continue
    entries.push({
      id: typeof item.id === 'string' && item.id !== '' ? item.id : `lore-${entries.length + 1}`,
      keys,
      content: content.length > MAX_LORE_ENTRY_CHARS ? content.slice(0, MAX_LORE_ENTRY_CHARS) : content,
      order: Number.isFinite(Number(item.order)) ? Number(item.order) : 100,
      constant,
    })
  }
  entries.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  return entries
}

/** 本轮该注入哪几条：`constant` 常驻；其余条目只要有键出现在本轮用户消息里。 */
function matchLore(entries, text) {
  if (!Array.isArray(entries) || entries.length === 0) return []
  const hay = typeof text === 'string' ? text.toLowerCase() : ''
  const picked = []
  let total = 0
  for (const entry of entries) {
    const hit = entry.constant || entry.keys.some((key) => hay.includes(key.toLowerCase()))
    if (!hit) continue
    if (picked.length >= MAX_LORE_ENTRIES) break
    if (total + entry.content.length > MAX_LORE_TOTAL_CHARS) continue
    picked.push(entry)
    total += entry.content.length
  }
  return picked
}

/** 世界书的正文块。没有命中条目就返回空串，段落会被自动丢弃。 */
function loreBlock(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return ''
  return [
    '【补充资料】以下条目与本轮对话相关，只在需要时使用，不要主动复述这段说明。',
    '',
    entries.map((entry) => entry.content).join('\n\n'),
  ].join('\n')
}

/** 多位同台时，把各人格挑出的条目先并起来，再统一按上限裁一次。 */
function limitLore(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return []
  const merged = []
  let total = 0
  for (const entry of entries) {
    if (merged.length >= MAX_LORE_ENTRIES) break
    if (total + entry.content.length > MAX_LORE_TOTAL_CHARS) continue
    merged.push(entry)
    total += entry.content.length
  }
  return merged
}

// ---- 人格扫描 -----------------------------------------------------------

let cache = { signature: '', personas: [] }

function findAvatarFile(dir) {
  for (const candidate of AVATAR_NAMES) {
    const file = join(dir, candidate)
    if (existsSync(file)) return file
  }
  return ''
}

function extOf(file) {
  return file.split('.').pop().toLowerCase().replace('jpeg', 'jpg')
}

// ---- 用户（老师）头像 ---------------------------------------------------
//
// 与人格头像同一套写法（固定文件名 + mtime 当版本号），只是主人只有一个。
// 参考了壁纸引擎的 mascot-avatar 路由：POST 收原始字节、按文件头认格式、上限 8MB、
// 换图时先把同族的旧文件删掉（否则新图画进去了、屏上还是旧图）。

/** 用户头像的候选文件名，按优先级排。 */
const USER_AVATAR_NAMES = ['user-avatar.png', 'user-avatar.jpg', 'user-avatar.jpeg', 'user-avatar.webp']

/** 放在 persona-router 自己的目录下，和 state.json / decisions.log 作伴。 */
function userAvatarDir() {
  return join(dshHome(), 'persona-router')
}

function findUserAvatar() {
  if (typeof existsSync !== 'function') return ''
  for (const candidate of USER_AVATAR_NAMES) {
    const file = join(userAvatarDir(), candidate)
    if (existsSync(file)) return file
  }
  return ''
}

/** /state 里给客户端的那一小块：没有就 null，有就报格式与版本（版本= mtime，换图即换值）。 */
function userAvatarView() {
  const file = findUserAvatar()
  if (file === '') return null
  return { ext: extOf(file), version: Math.round(mtimeOf(file)) }
}

/**
 * 扫描 personas 目录。每次调用都会比一次文件签名：目录内容、三份文件的 mtime 都没变就直接用缓存，
 * 所以热路径上只花几次 statSync。
 *
 * includeDisabled=false（默认）只回能用的那几个——判定、注入、当前人格全靠它，
 * 停用的人格必须在这里就被挡住，才不会被叫到。
 * 面板要的是 TRUE：停用的人格也得留在列表里，否则那一行消失，就再没有地方把它点回来。
 */
function loadPersonas(includeDisabled = false) {
  const pick = (list) => (includeDisabled ? list : list.filter((persona) => persona.enabled !== false))
  const root = personaRoot()
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    cache = { signature: 'missing', personas: [] }
    return pick(cache.personas)
  }
  const ids = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  const parts = [ids.join(',')]
  for (const id of ids) {
    const dir = join(root, id)
    parts.push(
      [
        id,
        mtimeOf(join(dir, 'persona.json')),
        mtimeOf(join(dir, 'prompt.md')),
        mtimeOf(join(dir, 'lore.json')),
        ...AVATAR_NAMES.map((f) => mtimeOf(join(dir, f))),
      ].join(':'),
    )
  }
  const signature = parts.join('|')
  if (signature === cache.signature) return pick(cache.personas)

  const personas = []
  for (const id of ids) {
    const dir = join(root, id)
    const meta = readJson(join(dir, 'persona.json'), null)
    // 缺 persona.json ⇒ 跳过（不是人格目录）；缺 prompt.md ⇒ 跳过后仍要能启动，记一条告警。
    // enabled:false 不再在这里截断，只落成字段——截断由末尾的 pick() 统一做。
    if (!meta || typeof meta !== 'object') continue
    let body = ''
    try {
      body = readFileSync(join(dir, 'prompt.md'), 'utf8')
    } catch {
      console.warn(`[persona-router] 人格 "${id}" 缺 prompt.md，已跳过`)
      continue
    }
    if (body.trim() === '') {
      console.warn(`[persona-router] 人格 "${id}" 的 prompt.md 是空的，已跳过`)
      continue
    }
    const avatarFile = findAvatarFile(dir)
    const aliases = Array.isArray(meta.aliases)
      ? meta.aliases.filter((a) => typeof a === 'string' && a.trim() !== '').map((a) => a.trim())
      : []
    if (typeof meta.name === 'string' && meta.name.trim() !== '' && !aliases.includes(meta.name)) {
      aliases.push(meta.name.trim())
    }
    if (!aliases.includes(id)) aliases.push(id)
    personas.push({
      id,
      name: typeof meta.name === 'string' && meta.name.trim() !== '' ? meta.name.trim() : id,
      aliases,
      color: typeof meta.color === 'string' && meta.color.trim() !== '' ? meta.color.trim() : '#8AB4F8',
      order: Number.isFinite(Number(meta.order)) ? Number(meta.order) : 1000,
      enabled: meta.enabled !== false,
      body: body.length > MAX_PROMPT_CHARS ? `${body.slice(0, MAX_PROMPT_CHARS)}\n\n（人格正文过长已截断。）` : body,
      // persona.json 里可选的后缀指令：跟在正文后面注入，对齐角色卡的 post_history_instructions
      suffix: typeof meta.suffix === 'string' ? meta.suffix.trim() : '',
      // 声线硬约束：同台时每条挂在正文后面，防止几份人设互相串味（代码里不写任何角色名）
      voice: Array.isArray(meta.voice)
        ? meta.voice.filter((rule) => typeof rule === 'string' && rule.trim() !== '').map((rule) => rule.trim()).slice(0, 6)
        : [],
      // 世界书：人格目录下可选的 lore.json，关键词命中才注入
      lore: loadLore(join(dir, 'lore.json')),
      avatar: avatarFile === '' ? '' : extOf(avatarFile),
      avatarVersion: avatarFile === '' ? 0 : Math.round(mtimeOf(avatarFile)),
    })
  }
  personas.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  cache = { signature, personas }
  return pick(personas)
}

/** 对外暴露的人格视图（不含正文）。面板要编辑别名与启用状态，所以这两项也必须带上。 */
function publicView(persona) {
  return {
    id: persona.id,
    name: persona.name,
    aliases: persona.aliases,
    color: persona.color,
    order: persona.order,
    enabled: persona.enabled !== false,
    avatar: persona.avatar,
    avatarVersion: persona.avatarVersion,
  }
}

function findPersona(ids, personas) {
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') continue
    const hit = personas.find((p) => p.id === id)
    if (hit) return hit
  }
  return undefined
}

/**
 * 解析某会话当前的人格，阶梯：**会话 → 工作区 → default → 第一个可用**。
 *
 * - 会话档记着 `OFF`（`@none`）时**就地终止**，不再往工作区 / default 回落
 *   ——这是「本会话谁都别注入」，与「没选过」是两件事。
 * - 记着的人格被删 / 停用时继续往下一层落，而不是把整条链判死。
 * - 叫名字切换仍然最优先：那一手在 pre-step 里直接把 id 钉进会话档，这里只负责读。
 */
function currentPersona(sessionId, personas, state, cwd) {
  const sid = sessionId === '' || sessionId === undefined || sessionId === null ? '' : String(sessionId)
  if (sid !== '') {
    const pick = state?.sessions?.[sid]
    if (pick === OFF) return undefined
    if (typeof pick === 'string' && pick !== '') {
      const hit = findPersona([pick], personas)
      if (hit) return hit
    }
  }
  const workspaceKey = normalizeCwd(cwd)
  if (workspaceKey !== '') {
    const pick = state?.workspaces?.[workspaceKey]
    if (pick === OFF) return undefined
    if (typeof pick === 'string' && pick !== '') {
      const hit = findPersona([pick], personas)
      if (hit) return hit
    }
  }
  return findPersona([state?.default], personas) ?? personas[0]
}

/**
 * 试运行：给一句话，算出「会命中谁、算不算同台、最后由谁开口」。不落盘、不真发消息。
 * 面板与命令行都用它排障——省掉「改配置→重启→发消息试」的来回。
 */
function describeDetection(rawText, personas, state, runtime = {}) {
  const multiRole = readConfig().multiRole
  const hits = detectPersonaHits(rawText, personas)
  const multi = multiRole && hits.length > 1
  const lead = multi ? hits[0].persona : currentPersona(runtime.sessionId ?? '', personas, state, runtime.cwd ?? '')
  return {
    hits: hits.map((hit) => ({ id: hit.persona.id, name: hit.persona.name, alias: hit.alias, at: hit.at })),
    multi,
    speakers: multi ? hits.map((hit) => hit.persona.id) : [],
    lead: lead ? lead.id : '',
    leadName: lead ? lead.name : '',
  }
}

// ---- 称呼判定 -----------------------------------------------------------

function isBoundaryChar(ch) {
  return ch === undefined || BOUNDARY.test(ch)
}

/**
 * 称呼尾词：名字后面紧跟这些，就算「在叫她」，哪怕名字被夹在句子中间。
 * 例：「再测试一下看普拉娜在不在」——左边是「看」、右边是「在」，本身不成边界，
 * 但「在不在」就是在喊她，所以放行。
 */
const ADDRESS_SUFFIXES = ['在不在', '在吗', '在么', '在哪', '呢', '呀']

/**
 * 判断句的系词：别名紧挨着「是 / 为」时，那是**在说她**，不是叫她。
 * 例：「头像是优香，是怎么回事」「也就是爱丽丝。」——这两句里的名字都不该触发切换。
 */
function isCopula(ch) {
  return ch === '是' || ch === '为'
}

/**
 * 成对引号与括号：里面的名字一律不算叫唤——那是引用、书名或旁注，不是在喊人。
 * 只认**配对成功**的；落单的括号不参与，宁可少管，也不要把半句话吞掉。
 */
const QUOTE_PAIRS = [
  ['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'],
  ['（', '）'], ['(', ')'], ['【', '】'], ['《', '》'],
]
const QUOTE_CLOSERS = new Map(QUOTE_PAIRS)

/** 返回所有成对引号/括号覆盖的区间 [start, end)，含引号本身。 */
function quotedRanges(text) {
  const ranges = []
  const stack = []
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const closer = QUOTE_CLOSERS.get(ch)
    if (closer !== undefined) {
      stack.push([closer, i])
      continue
    }
    const top = stack[stack.length - 1]
    if (top !== undefined && ch === top[0]) {
      stack.pop()
      ranges.push([top[1], i + 1])
    }
  }
  return ranges
}

/** 名字后面（允许隔一个标点）紧跟「你」，就是在跟对方说话：「优香你怎么看」。 */
const ADDRESS_PRONOUN = /^[\s,，.。、!！?？~～]?你/

/** 呼语助词：名字后面直接跟这些，是在喊人（「优香啊」「诺亚哟」）。 */
const ADDRESS_PARTICLES = '啊呀哟哦喂酱呦'

/**
 * 在本轮用户消息里找**所有**称呼位上的别名，按出现位置从早到晚排（同一位只留一次）。
 * 判定规则与 detectPersona 完全同一套——只认称呼位，不做模糊匹配。
 */
function detectPersonaHits(rawText, personas, trace) {
  if (typeof rawText !== 'string' || rawText === '') return []
  const text = rawText.toLowerCase()
  const quoted = quotedRanges(text)
  const hits = []
  for (const persona of personas) {
    // 长别名优先：短别名套在长别名里面（「早濑优香」里的「优香」）不重复计数
    const spans = []
    let best
    for (const alias of [...persona.aliases].sort((a, b) => b.length - a.length)) {
      const needle = alias.toLowerCase()
      if (needle === '') continue
      let from = 0
      for (;;) {
        const at = text.indexOf(needle, from)
        if (at < 0) break
        const after = at + needle.length
        const prev = at > 0 ? text[at - 1] : undefined
        const next = after < text.length ? text[after] : undefined
        const tail = text.slice(after)
        const nested = spans.some(([start, end]) => at >= start && at + needle.length <= end)
        const inQuote = !nested && quoted.some(([start, end]) => at >= start && at < end)
        const suffix = ADDRESS_SUFFIXES.find((s) => tail.startsWith(s))
        const pronoun = ADDRESS_PRONOUN.test(tail)
        const particle = next !== undefined && ADDRESS_PARTICLES.includes(next)
        const copula = isCopula(prev)
        const addressing = Boolean(suffix) || pronoun || particle
        const counted =
          !nested && !inQuote && !copula && (isBoundaryChar(prev) || isBoundaryChar(next) || addressing)
        if (trace) {
          trace.push({
            alias,
            at,
            prev,
            next,
            counted,
            nested,
            inQuote,
            copula,
            leftOk: isBoundaryChar(prev),
            rightOk: isBoundaryChar(next),
            suffix: suffix ?? '',
            pronoun,
            particle,
          })
        }
        if (nested) { from = at + 1; continue }
        if (inQuote) { from = at + 1; continue }
        spans.push([at, at + needle.length])
        if (counted) {
          const score = at * 1000 + needle.length
          if (best === undefined || score >= best.score) best = { score, at, alias, persona }
        }
        from = at + 1
      }
    }
    if (best !== undefined) hits.push(best)
  }
  hits.sort((a, b) => a.at - b.at || a.score - b.score)
  const seen = new Set()
  const ordered = []
  for (const hit of hits) {
    if (seen.has(hit.persona.id)) continue
    seen.add(hit.persona.id)
    ordered.push(hit)
  }
  return ordered
}

/** 只要人格本身时用它（返回按点名顺序排好的表）。 */
function detectPersonas(rawText, personas) {
  return detectPersonaHits(rawText, personas).map((hit) => hit.persona)
}

/**
 * 诊断用：把每个候选别名的判定理由原样吐出来。
 * 规则只写在 detectPersonaHits 里一处，这里的 trace 也跟着它走——避免解释器和真判定各写一套。
 */
function explainAliases(rawText, personas) {
  const trace = []
  detectPersonaHits(rawText, personas, trace)
  return trace
}

/**
 * 这一轮该把谁钉进会话（决定「下一轮不带名字时谁接着答」）。
 * - 单人：取最后被叫到的那位（老规矩）
 * - 同台：默认取**先开口**那位（pinLeadOnMulti，可关）；关掉就不钉，下一轮回原钉子
 */
function pinForTurn(hits, multi, config) {
  if (!Array.isArray(hits) || hits.length === 0) return undefined
  if (multi) return config?.pinLeadOnMulti !== false ? hits[0] : undefined
  return hits[hits.length - 1]
}

/**
 * 旧口径：一条消息里叫了好几个名字时，取**位置最靠后**的那位（最近一次称呼）。
 * 单人回答与面板诊断都还用它；多角色同台改用 detectPersonas 拿全表。
 */
function detectPersona(rawText, personas) {
  const list = detectPersonas(rawText, personas)
  return list.length === 0 ? undefined : list[list.length - 1]
}

/** 取一条消息的可读正文。 */
function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** 本轮最后一条真实用户消息的正文（跳过运行时上下文这类注入出来的 user 消息）。 */
function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message || message.role !== 'user') continue
    if (message.source?.kind === 'runtime-context') continue
    const text = textOf(message)
    if (text.trim() !== '') return text
  }
  return ''
}

/**
 * 多角色同台的提示词块。
 * 形态：**第一位主答，后面的顺带带一句**——不是几位各写一大段并列。
 * 单人时直接退回 personaBlock，保证单人行为一字不变。
 */
const MAX_MULTI_CHARS = 40_000

function multiPersonaBlock(speakers) {
  if (!Array.isArray(speakers) || speakers.length === 0) return ''
  if (speakers.length === 1) return personaBlock(speakers[0])
  const lead = speakers[0]
  const others = speakers.slice(1)
  const names = speakers.map((persona) => persona.name)
  const othersNames = others.map((persona) => persona.name).join('、')
  const budget = Math.max(2_000, Math.floor(MAX_MULTI_CHARS / speakers.length))
  const lines = [
    `【本轮同台人格：${names.join('、')}】`,
    '',
    `老师这一轮点了这几位：${names.join('、')}。请让他们**真的接话**——共用同一段记忆与上下文，不各开一份。`,
    `顺序：${lead.name} 先回应老师，${othersNames} 接着她的话说下去。`,
    '接话要有内容：可以同意、可以不同意、可以补一句她漏掉的，但要指明是在回应她的哪一句，不要只顺着夸。',
    '每人一段，段首用「【名字】」单独起一行；不替没被点到的人说话，也不把几段合成一段。',
    '共用记忆：不要各自复述老师的话，也不要装作不知道前面说过什么。',
    '开头怎么写不设禁区：宣布式、观察式、反问式都可以，但用词、句长、标点必须像**这个人自己**。',
    '不互相串味：没被点到的人格一律不出场，也不要用她的口癖或称呼方式。',
    `篇幅：${lead.name} 那段按本人平常长度；${othersNames} 一到三句就够，除非确有正事要说。`,
    '',
  ]
  for (const persona of speakers) {
    const body = persona.body.length > budget ? `${persona.body.slice(0, budget)}\n\n（这份正文过长已截断。）` : persona.body
    const role = persona === lead ? '先开口' : '接话'
    lines.push(`===== ${persona.name} 的正文（${role}）=====`, '', body, '')
    if (Array.isArray(persona.voice) && persona.voice.length > 0) {
      lines.push(`${persona.name} 的硬约束（说话前先对一遍）：`)
      for (const rule of persona.voice) lines.push(`- ${rule}`)
      lines.push('')
    }
    if (typeof persona.suffix === 'string' && persona.suffix !== '') lines.push(persona.suffix, '')
  }
  return lines.join('\n')
}
function personaBlock(persona) {
  if (!persona) return ''
  const lines = [
    `【当前人格：${persona.name}】`,
    '',
    '以下是本会话当前扮演的人格正文，请完全按它演。',
    '它与全局底座里「兜底人格」一节冲突时，以本节为准；本节存在时，那一整节作废。',
    '',
    persona.body,
  ]
  // 可选的 persona.json `suffix`：写在正文之后，相当于角色卡的 post_history_instructions
  if (typeof persona.suffix === 'string' && persona.suffix !== '') {
    lines.push('', persona.suffix)
  }
  return lines.join('\n')
}

// ---- 头像读写 -----------------------------------------------------------

function sniffImage(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { ext: 'png', mime: MIME_OF.png }
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: 'jpg', mime: MIME_OF.jpg }
  }
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    return { ext: 'webp', mime: MIME_OF.webp }
  }
  return undefined
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { code: 'E_TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 客户端上报：浏览器把实际生效的头像层状态写回来，宿主可查（自检与排障用）。 */
const clientReports = new Map()

/**
 * 世界书命中缓存：sessionId → 本轮该注入的条目。
 * 条目依赖「本轮用户消息」，而提示词回调里拿不到消息列表，所以由 pre-step 挑好放这里。
 * 每个回合 pre-step 都会覆盖它；pre-step 没跑（非 agent 路径）时这里留着上一次的结果，
 * 最坏情况是多注入一段上一轮的资料——不会误切人格，也不会拦路。
 */
const loreHits = new Map()

/**
 * 多角色同台：sessionId → 本轮被点名的几位（按点名顺序，只有 ≥2 位才算同台）。
 * 提示词回调据此把几份正文拼成一块；不在这张表里或只有一位时，走原来的单人格。
 */
const multiHits = new Map()

/**
 * sessionId → 最近一次见到的工作目录。
 * 浏览器半只拿得到 sessionId、拿不到 cwd；没有这张表，工作区档生效时
 * `/state` 与真正的注入就会对不上（头像和人格各说各话）。pre-step 每轮顺手记一次。
 */
const sessionCwds = new Map()

/**
 * 挂载本插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 */
export function apply(ctx, config = {}) {
  const pluginConfig = { ...DEFAULT_CONFIG, ...(config && typeof config === 'object' ? config : {}) }
  const isEnabled = () => pluginConfig.enabled !== false && readConfig().enabled !== false

  // ---- 1. 人格注入 ----
  ctx.effect(
    () =>
      ctx.systemPrompt.context({
        name: 'persona-router:persona',
        // 250：紧挨 dsh-agent-md 的 260 之前（两个段名不同，互不遮蔽）
        order: 250,
        // 人格正文由用户书写，里面的 {{…}} 必须原样保留，否则 renderContextSections 会抛错并让整次请求失败
        interpolate: false,
        text: (context) => {
          if (!isEnabled()) return ''
          const personas = loadPersonas()
          if (personas.length === 0) return ''
          const sessionId = String(context?.agent?.session?.id ?? context?.agent?.id ?? '')
          // 多角色同台：本轮被点了好几位，就把几份正文拼成一块，让他们按顺序各说一段
          const multiIds = multiHits.get(sessionId) ?? []
          if (multiIds.length > 1) {
            const speakers = multiIds.map((id) => personas.find((persona) => persona.id === id)).filter(Boolean)
            if (speakers.length > 1) return multiPersonaBlock(speakers)
          }
          const persona = currentPersona(sessionId, personas, readState(), cwdOf(context))
          return personaBlock(persona)
        },
      }),
    'persona-router: persona context',
  )

  // ---- 1b. 世界书注入 ----
  // 条目由 pre-step 按「本会话当前人格 + 本轮用户消息」挑好放在 loreHits 里；
  // 这里只负责把它拼成一段。没有命中的条目、没写 lore.json 的人格 ⇒ 空串，段落自动消失。
  ctx.effect(
    () =>
      ctx.systemPrompt.context({
        name: 'persona-router:lore',
        // 251：紧跟在人格块之后，让模型先读到「你是谁」再读到「这份资料」
        order: 251,
        interpolate: false,
        text: (context) => {
          if (!isEnabled()) return ''
          const sessionId = String(context?.agent?.session?.id ?? context?.agent?.id ?? '')
          return loreBlock(loreHits.get(sessionId) ?? [])
        },
      }),
    'persona-router: lore context',
  )

  // ---- 2. 切换判定 ----
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      if (isEnabled()) {
        const personas = loadPersonas()
        const sessionId = String(payload?.agent?.id ?? '')
        const cwd = cwdOf(payload)
        if (personas.length > 0 && sessionId !== '') {
          const text = routeText(lastUserText(payload.messages))
          const hits = detectPersonas(text, personas)
          const config = readConfig()
          // 一轮里点了好几位 ⇒ 同台；只有一位（或关了 multiRole）⇒ 老规矩，取最后一位
          const multi = config.multiRole && hits.length > 1
          const speakers = multi ? hits : []
          // 同台之后谁来接棒：默认让「先开口」那位钉进会话，下一轮不带名字就继续跟她聊。
          // 关掉 pinLeadOnMulti 就退回旧行为：同台只演那一轮，下一轮回到原来的钉子。
          const hit = pinForTurn(hits, multi, config)
          // 两个会话的 pre-step 可能同时到：读-改-写必须串行，否则后写的会覆盖先写的
          const resolved = await mutateState((state) => {
            let changed = false
            if (state.default === '') {
              state.default = personas[0].id
              changed = true
            }
            const previous = state.sessions[sessionId]
            if (hit) {
              // 叫名字**永远第一优先**：直接钉进本会话，压过工作区档与 default
              if (previous !== hit.id) {
                state.sessions[sessionId] = hit.id
                changed = true
              }
            } else if (
              previous !== undefined &&
              previous !== OFF &&
              !personas.some((p) => p.id === previous)
            ) {
              // 记着的人格已被删 / 停用 ⇒ 清掉这条，让阶梯重新解析（工作区档因此能接手）。
              // 注意：不把「解析结果」写回会话档——写回去就成了永久钉住，工作区档再改也追不上。
              delete state.sessions[sessionId]
              changed = true
            }
            // 「这一轮是谁答的」——给历史消息贴回当时的头像用。
            // payload.turn 与聊天行的 data-chat-turn 同源，所以客户端能对上号。
            // 两处讲究：
            //   ① 同台那一轮要记**主答**（speakers[0]），不能记阶梯解析出来的单人，否则头像贴错；
            //   ② 同一回合里工具调用之后的步骤没有新的用户消息，不许改写这一轮的归属。
            const turn = Number(payload?.turn)
            const effectiveId = multi
              ? speakers[0]?.id ?? ''
              : currentPersona(sessionId, personas, state, cwd)?.id ?? ''
            if (text.trim() !== '' && Number.isFinite(turn) && effectiveId !== '') {
              const history = state.history ?? {}
              const list = Array.isArray(history[sessionId]) ? history[sessionId] : []
              const result = upsertTurn(list, turn, effectiveId)
              if (result.changed) {
                history[sessionId] = result.list.slice(-MAX_TURN_HISTORY)
                state.history = history
                changed = true
              }
            }
            return changed
          })
          // 本轮到底谁答：同台时由被点名的第一位顶着（头像与历史记录先按这位算）
          const effective = multi ? speakers[0] : currentPersona(sessionId, personas, resolved, cwd)
          // 关键：只有「这一轮确实带了新的用户消息」时才重算世界书与同台名单。
          // 同一个回合里，工具调用之后的下一步往往没有新的用户消息（text 为空）；
          // 那时若照空白重算，同台会在中途退回单人——所以宁可沿用上一步的结果。
          if (text.trim() !== '') {
            // 世界书：同台时把每位命中的条目都挑上，再按全局上限合并一次
            const candidates = multi
              ? speakers.flatMap((persona) => matchLore(persona.lore, text))
              : effective
                ? matchLore(effective.lore, text)
                : []
            const mergedLore = limitLore(candidates)
            loreHits.set(sessionId, mergedLore)
            multiHits.set(sessionId, multi ? speakers.map((persona) => persona.id) : [])
            // 事后留痕：这一轮判成了什么，全写进 decisions.log
            appendDecision({
              at: new Date().toISOString(),
              session: sessionId,
              turn: Number.isFinite(Number(payload?.turn)) ? Math.trunc(Number(payload.turn)) : null,
              text: text.slice(0, 60),
              hits: hits.map((persona) => persona.id),
              multi,
              lead: effective ? effective.id : '',
              lore: mergedLore.map((entry) => entry.id),
            })
          }
          if (cwd !== '') sessionCwds.set(sessionId, cwd)
        }
      }
    } catch (error) {
      // 判定失败绝不拦路：记一条就够了
      console.warn('[persona-router] pre-step 判定失败：', error instanceof Error ? error.message : String(error))
    }
    return next()
  })

  // ---- 3. HTTP：状态 / 头像 / 客户端上报 ----
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
          const method = req.method ?? 'GET'
          try {
            if (route === '/health' && method === 'GET') {
              // 面板要看全部（含停用），所以这里带 true
              const personas = loadPersonas(true)
              const reports = {}
              for (const [key, value] of clientReports) reports[key] = value
              json(res, 200, {
                ok: true,
                plugin: 'dsh-multi-persona',
                codeVersion: 'r18-disable-panel',
                enabled: isEnabled(),
                personaRoot: personaRoot(),
                statePath: statePath(),
                personas: personas.map(publicView),
                reports,
              })
              return
            }

            if (route === '/state' && method === 'GET') {
              const personas = loadPersonas()
              const sessionId = url.searchParams.get('session') ?? ''
              // 浏览器没带 cwd 时用这个会话最近一次的工作目录补上（见 sessionCwds）
              const cwd = url.searchParams.get('cwd') ?? sessionCwds.get(sessionId) ?? ''
              const state = readState()
              const persona = currentPersona(sessionId, personas, state, cwd)
              const fallbackPersona = findPersona([state.default], personas) ?? personas[0]
              // 三档各自的原始选择（给面板显示「这一档钉的是谁」用）
              const sessionPick = sessionId !== '' ? state.sessions[String(sessionId)] : undefined
              const workspaceKey = normalizeCwd(cwd)
              const workspacePick = workspaceKey !== '' ? state.workspaces[workspaceKey] : undefined
              const workspacePersona =
                typeof workspacePick === 'string' && workspacePick !== OFF
                  ? findPersona([workspacePick], personas)?.id ?? ''
                  : ''
              json(res, 200, {
                enabled: isEnabled(),
                session: sessionId,
                default: state.default,
                defaultPersona: fallbackPersona ? fallbackPersona.id : '',
                current: persona ? publicView(persona) : null,
                // 三档：会话 → 工作区 → default。current 是阶梯最终落点，effective 与它同源。
                effective: persona ? persona.id : '',
                off: persona === undefined,
                sessionPick: typeof sessionPick === 'string' ? sessionPick : null,
                sessionOff: sessionPick === OFF,
                workspaceKey: workspaceKey === '' ? null : workspaceKey,
                workspacePick: typeof workspacePick === 'string' ? workspacePick : null,
                workspacePersona,
                // 列表给面板看：含停用项，否则停用后就再也点不回来（判定与注入仍只用启用的）
                personas: loadPersonas(true).map(publicView),
                // 历史消息用：这一轮是谁答的。没记到的轮次由客户端回落到 defaultPersona。
                history: sessionId !== '' ? state.history[sessionId] ?? [] : [],
                personaRoot: personaRoot(),
                avatarRepeatRows: readConfig().avatarRepeatRows,
                avatarSize: readConfig().avatarSize,
                // 老师自己的头像：null = 没设过（客户端就沿用壁纸引擎那张，或干脆不画）
                userAvatar: userAvatarView(),
                reportPath: `${ROUTE_PREFIX}/client-report`,
              })
              return
            }

            // 试运行判定：GET /probe?text=…&session=…&cwd=…
            // 只算不落盘——改完配置想验证「这句话会不会触发同台」，调它就行，不用真发消息、不用重启。
            if (route === '/probe' && method === 'GET') {
              const text = url.searchParams.get('text') ?? ''
              const sessionId = url.searchParams.get('session') ?? ''
              const cwd = url.searchParams.get('cwd') ?? sessionCwds.get(sessionId) ?? ''
              const personas = loadPersonas()
              const state = readState()
              const result = describeDetection(text, personas, state, { sessionId, cwd })
              json(res, 200, {
                ok: true,
                enabled: isEnabled(),
                text,
                ...result,
                lore: (() => {
                  const speakers = result.speakers.length > 0
                    ? result.speakers.map((id) => personas.find((persona) => persona.id === id)).filter(Boolean)
                    : personas.filter((persona) => persona.id === result.lead)
                  return limitLore(speakers.flatMap((persona) => matchLore(persona.lore, text))).map((entry) => entry.id)
                })(),
              })
              return
            }

            // 最近几轮判成了什么：GET /decisions?limit=20
            if (route === '/decisions' && method === 'GET') {
              json(res, 200, {
                ok: true,
                path: decisionsPath(),
                items: readDecisions(url.searchParams.get('limit') ?? 20),
              })
              return
            }

            if (route === '/client-report' && method === 'POST') {
              const body = await readBody(req, 64 * 1024)
              let parsed
              try {
                parsed = JSON.parse(body.toString('utf8'))
              } catch {
                json(res, 400, { error: 'invalid json' })
                return
              }
              const sessionId = String(parsed?.sessionId ?? '')
              if (sessionId !== '') {
                clientReports.set(sessionId, {
                  at: new Date().toISOString(),
                  mode: String(parsed?.mode ?? ''),
                  personaId: String(parsed?.personaId ?? ''),
                  avatarNodes: Number(parsed?.avatarNodes ?? 0),
                  detail: typeof parsed?.detail === 'string' ? parsed.detail.slice(0, 200) : '',
                })
              }
              json(res, 200, { ok: true })
              return
            }

            // 老师自己的头像：查看 / 导入 / 清除（三条路由的语义照壁纸引擎的 mascot-avatar 来）
            if (route === '/user-avatar') {
              const versioned = url.searchParams.get('v') !== null
              if (method === 'GET' || method === 'HEAD') {
                const file = findUserAvatar()
                if (file === '') {
                  // 错误响应绝不缓存，否则导入之后还会看到上次那个 404
                  json(res, 404, { error: 'no user avatar' })
                  return
                }
                const ext = extOf(file)
                let bytes
                try {
                  bytes = readFileSync(file)
                } catch {
                  json(res, 404, { error: 'user avatar unreadable' })
                  return
                }
                res.writeHead(200, {
                  'content-type': MIME_OF[ext] ?? 'application/octet-stream',
                  'content-length': String(bytes.length),
                  'cache-control': versioned ? 'public, max-age=31536000, immutable' : 'no-store',
                })
                res.end(method === 'HEAD' ? undefined : bytes)
                return
              }

              if (method === 'POST' || method === 'PUT') {
                const body = await readBody(req, MAX_BODY_BYTES)
                if (body.length === 0) {
                  json(res, 400, { error: 'empty body' })
                  return
                }
                const kind = sniffImage(body)
                if (!kind) {
                  json(res, 415, { error: 'only png / jpeg / webp accepted' })
                  return
                }
                const dir = userAvatarDir()
                mkdirSync(dir, { recursive: true })
                // 换图即清兄弟：同族的旧文件先删掉，免得按名字找的时候命中旧的那张
                for (const existing of USER_AVATAR_NAMES) {
                  if (existing === `user-avatar.${kind.ext}`) continue
                  try {
                    unlinkSync(join(dir, existing))
                  } catch {
                    /* 没有就算了 */
                  }
                }
                const target = join(dir, `user-avatar.${kind.ext}`)
                const tmp = `${target}.tmp`
                writeFileSync(tmp, body)
                renameSync(tmp, target)
                json(res, 200, { ok: true, ext: kind.ext, bytes: body.length, version: Math.round(mtimeOf(target)) })
                return
              }

              if (method === 'DELETE') {
                const file = findUserAvatar()
                let removed = false
                if (file !== '') {
                  try {
                    unlinkSync(file)
                    removed = true
                  } catch {
                    /* 删不掉就当没设过 */
                  }
                }
                json(res, 200, { ok: true, removed })
                return
              }

              json(res, 405, { error: 'method not allowed' })
              return
            }

            if (route.startsWith('/avatar/')) {
              const id = decodeURIComponent(route.slice('/avatar/'.length))
              const personas = loadPersonas()
              const persona = personas.find((entry) => entry.id === id)
              if (!persona) {
                json(res, 404, { error: 'no such persona', id })
                return
              }
              const dir = join(personaRoot(), id)

              if (method === 'GET') {
                const file = findAvatarFile(dir)
                if (file === '') {
                  json(res, 404, { error: 'no avatar', id })
                  return
                }
                const ext = extOf(file)
                let bytes
                try {
                  bytes = readFileSync(file)
                } catch {
                  json(res, 404, { error: 'avatar unreadable', id })
                  return
                }
                const versioned = url.searchParams.get('v') !== null
                res.writeHead(200, {
                  'content-type': MIME_OF[ext] ?? 'application/octet-stream',
                  'content-length': String(bytes.length),
                  'cache-control': versioned ? 'public, max-age=31536000, immutable' : 'no-store',
                })
                res.end(bytes)
                return
              }

              if (method === 'POST') {
                const body = await readBody(req, MAX_BODY_BYTES)
                if (body.length === 0) {
                  json(res, 400, { error: 'empty body' })
                  return
                }
                const kind = sniffImage(body)
                if (!kind) {
                  json(res, 415, { error: 'only png / jpeg / webp accepted' })
                  return
                }
                mkdirSync(dir, { recursive: true })
                for (const existing of AVATAR_NAMES) {
                  if (existing === `avatar.${kind.ext}`) continue
                  try {
                    unlinkSync(join(dir, existing))
                  } catch {
                    /* 没有就算了 */
                  }
                }
                const target = join(dir, `avatar.${kind.ext}`)
                const tmp = `${target}.tmp`
                writeFileSync(tmp, body)
                renameSync(tmp, target)
                json(res, 200, { ok: true, id, ext: kind.ext, bytes: body.length })
                return
              }

              if (method === 'DELETE') {
                for (const existing of AVATAR_NAMES) {
                  try {
                    unlinkSync(join(dir, existing))
                  } catch {
                    /* 没有就算了 */
                  }
                }
                json(res, 200, { ok: true, id, removed: true })
                return
              }

              json(res, 405, { error: 'method not allowed' })
              return
            }

            // ---- 人格的增删改（面板用） ------------------------------------

            if (route === '/config' && method === 'PUT') {
              const body = await readBody(req, 8 * 1024)
              let parsed
              try {
                parsed = JSON.parse(body.toString('utf8'))
              } catch {
                json(res, 400, { error: 'invalid json' })
                return
              }
              const current = readConfig()
              const next = { ...current }
              if (typeof parsed?.enabled === 'boolean') next.enabled = parsed.enabled
              if (typeof parsed?.multiRole === 'boolean') next.multiRole = parsed.multiRole
              if (typeof parsed?.pinLeadOnMulti === 'boolean') next.pinLeadOnMulti = parsed.pinLeadOnMulti
              if (Number.isFinite(Number(parsed?.avatarRepeatRows))) {
                next.avatarRepeatRows = Math.min(30, Math.max(1, Math.round(Number(parsed.avatarRepeatRows))))
              }
              if (Number.isFinite(Number(parsed?.avatarSize))) {
                next.avatarSize = Math.min(72, Math.max(24, Math.round(Number(parsed.avatarSize))))
              }
              writeJsonAtomic(configPath(), next)
              json(res, 200, { ok: true, config: next })
              return
            }

            if (route === '/default' && method === 'PUT') {
              const body = await readBody(req, 8 * 1024)
              let parsed
              try {
                parsed = JSON.parse(body.toString('utf8'))
              } catch {
                json(res, 400, { error: 'invalid json' })
                return
              }
              const wanted = String(parsed?.default ?? '')
              const personas = loadPersonas()
              if (!personas.some((p) => p.id === wanted)) {
                json(res, 400, { error: 'no such persona', id: wanted })
                return
              }
              await mutateState((state) => {
                if (state.default === wanted) return false
                state.default = wanted
                return true
              })
              json(res, 200, { ok: true, default: wanted })
              return
            }

            // ---- 三档里的会话档 / 工作区档（面板与命令行都用这两条） ----------

            // PUT /session  { session, personaId }
            //   personaId = '@none' ⇒ 本会话谁都别注入；null / '' ⇒ 清除选择，回到阶梯下一层
            if (route === '/session' && method === 'PUT') {
              const body = await readBody(req, 8 * 1024)
              let parsed
              try {
                parsed = JSON.parse(body.toString('utf8'))
              } catch {
                json(res, 400, { error: 'invalid json' })
                return
              }
              const sessionId = String(parsed?.session ?? '')
              if (sessionId === '') {
                json(res, 400, { error: '缺少 session' })
                return
              }
              const rawWanted = parsed?.personaId
              const wanted = rawWanted === null || rawWanted === undefined ? null : String(rawWanted)
              const personas = loadPersonas()
              if (wanted !== null && wanted !== '' && wanted !== OFF && !personas.some((p) => p.id === wanted)) {
                json(res, 400, { error: 'no such persona', id: wanted })
                return
              }
              await mutateState((state) => {
                if (wanted === null || wanted === '') {
                  if (state.sessions[sessionId] === undefined) return false
                  delete state.sessions[sessionId]
                  return true
                }
                if (state.sessions[sessionId] === wanted) return false
                state.sessions[sessionId] = wanted
                return true
              })
              const after = readState()
              const effective = currentPersona(sessionId, personas, after, String(parsed?.cwd ?? ''))
              json(res, 200, {
                ok: true,
                session: sessionId,
                sessionPick: after.sessions[sessionId] ?? null,
                sessionOff: after.sessions[sessionId] === OFF,
                effective: effective ? effective.id : '',
              })
              return
            }

            // PUT /workspace  { cwd, personaId }
            //   personaId = null / '' ⇒ 这个工作目录跟随全局默认
            if (route === '/workspace' && method === 'PUT') {
              const body = await readBody(req, 8 * 1024)
              let parsed
              try {
                parsed = JSON.parse(body.toString('utf8'))
              } catch {
                json(res, 400, { error: 'invalid json' })
                return
              }
              const key = normalizeCwd(String(parsed?.cwd ?? ''))
              if (key === '') {
                json(res, 400, { error: '缺少 cwd' })
                return
              }
              const rawWanted = parsed?.personaId
              const wanted = rawWanted === null || rawWanted === undefined ? null : String(rawWanted)
              const personas = loadPersonas()
              if (wanted !== null && wanted !== '') {
                if (!personas.some((p) => p.id === wanted)) {
                  json(res, 400, { error: 'no such persona', id: wanted })
                  return
                }
              }
              await mutateState((state) => {
                const had = state.workspaces?.[key]
                if (wanted === null || wanted === '') {
                  if (had === undefined) return false
                  delete state.workspaces[key]
                  return true
                }
                if (had === wanted) return false
                state.workspaces[key] = wanted
                return true
              })
              json(res, 200, { ok: true, cwd: key, workspacePick: readState().workspaces[key] ?? null })
              return
            }

            if (route === '/persona' && method === 'POST') {
              const body = await readBody(req, 8 * 1024)
              let parsed
              try {
                parsed = JSON.parse(body.toString('utf8'))
              } catch {
                json(res, 400, { error: 'invalid json' })
                return
              }
              const id = String(parsed?.id ?? '').trim().toLowerCase()
              if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) {
                json(res, 400, { error: 'id 只能是 1–40 位小写字母、数字、- 或 _' })
                return
              }
              const dir = join(personaRoot(), id)
              if (existsSync(dir)) {
                json(res, 409, { error: '这个 id 已经存在', id })
                return
              }
              const name = String(parsed?.name ?? '').trim() || id
              mkdirSync(dir, { recursive: true })
              writeFileSync(
                join(dir, 'persona.json'),
                `${JSON.stringify({ id, name, aliases: [name], color: '#8AB4F8', order: 900, enabled: true }, null, 2)}\n`,
                'utf8',
              )
              writeFileSync(join(dir, 'prompt.md'), NEW_PERSONA_BODY.replaceAll('{{name}}', name), 'utf8')
              cache = { signature: '', personas: [] }
              json(res, 200, { ok: true, id, name })
              return
            }

            if (route.startsWith('/persona/')) {
              const id = decodeURIComponent(route.slice('/persona/'.length))
              const dir = join(personaRoot(), id)
              if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id) || !existsSync(dir)) {
                json(res, 404, { error: 'no such persona', id })
                return
              }

              if (method === 'PUT') {
                const body = await readBody(req, 32 * 1024)
                let parsed
                try {
                  parsed = JSON.parse(body.toString('utf8'))
                } catch {
                  json(res, 400, { error: 'invalid json' })
                  return
                }
                const file = join(dir, 'persona.json')
                const current = readJson(file, {}) ?? {}
                const next = { ...current, id }
                if (typeof parsed?.name === 'string' && parsed.name.trim() !== '') next.name = parsed.name.trim()
                if (Array.isArray(parsed?.aliases)) {
                  next.aliases = parsed.aliases
                    .filter((a) => typeof a === 'string' && a.trim() !== '')
                    .map((a) => a.trim())
                    .slice(0, 40)
                }
                if (typeof parsed?.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(parsed.color.trim())) {
                  next.color = parsed.color.trim()
                }
                if (Number.isFinite(Number(parsed?.order))) next.order = Math.trunc(Number(parsed.order))
                if (typeof parsed?.enabled === 'boolean') next.enabled = parsed.enabled
                writeJsonAtomic(file, next)
                cache = { signature: '', personas: [] }
                json(res, 200, { ok: true, id, persona: next })
                return
              }

              if (method === 'DELETE') {
                const personas = loadPersonas()
                if (personas.length <= 1) {
                  json(res, 409, { error: '最后一个人格不能删——删光了就没有兜底了' })
                  return
                }
                try {
                  rmSync(dir, { recursive: true, force: true })
                } catch (error) {
                  json(res, 500, { error: `删除失败：${error instanceof Error ? error.message : String(error)}` })
                  return
                }
                cache = { signature: '', personas: [] }
                // 历史里指向它的轮次会自然回落到 default，不必改写
                json(res, 200, { ok: true, id, removed: true })
                return
              }

              json(res, 405, { error: 'method not allowed' })
              return
            }

            json(res, 404, { error: 'no such route', route })
          } catch (error) {
            const code = error?.code
            if (code === 'E_TOO_LARGE') {
              json(res, 413, { error: 'body too large' })
              return
            }
            json(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    'persona-router: routes',
  )
}

/** 供测试脚本直接引用的纯函数（宿主运行时不会用到导出之外的任何东西）。 */
export const testing = {
  detectPersona,
  detectPersonas,
  multiPersonaBlock,
  limitLore,
  lastUserText,
  personaBlock,
  loadPersonas,
  readState,
  writeState,
  currentPersona,
  dshHome,
  personaRoot,
  statePath,
  findAvatarFile,
  findUserAvatar,
  userAvatarView,
  userAvatarDir,
  sniffImage,
  // 三档 + 世界书（r8）
  OFF,
  normalizeCwd,
  cwdOf,
  loadLore,
  matchLore,
  loreBlock,
  // 多角色同台（r9/r10）
  upsertTurn,
  detectPersonaHits,
  explainAliases,
  describeDetection,
  pinForTurn,
  readConfig,
  // 判定日志（r13）
  appendDecision,
  readDecisions,
  decisionsPath,
}
