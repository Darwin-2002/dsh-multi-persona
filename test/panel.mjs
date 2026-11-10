/**
 * 组件渲染自测：用一套最小的 React 替身真的把组件跑一遍。
 *
 * 目的是抓这类「不报错、只白屏」的错：
 *   · useCallback 的依赖数组里引用了还没声明的 const（TDZ）
 *   · 渲染中途 undefined 上取属性
 * 用法：node test/panel.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'plugin', 'client.js'), 'utf8')

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}
globalThis.document = undefined

new Function('window', 'Image', 'FileReader', 'fetch', source)(globalThis.window, function Image() {}, function FileReader() {}, () => Promise.reject(new Error('no net')))

if (!captured) {
  console.error('FAIL  没能抓到客户端模块定义')
  process.exit(1)
}

/**
 * 最小 React 替身。关键点：useCallback 会**立即求值依赖数组**——
 * 真实的 React 也是这么做的，所以 TDZ 这类错在这里同样会抛。
 */
function makeReact(hookInitials) {
  let index = 0
  const next = () => (index < hookInitials.length ? hookInitials[index++] : undefined)
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(initial) {
      const forced = next()
      return [forced === undefined ? initial : forced, () => {}]
    },
    useRef(initial) {
      return { current: initial }
    },
    useCallback(fn, deps) {
      // 故意把 deps 读一遍：真实 React 也要在渲染期取它们
      if (Array.isArray(deps)) for (const dep of deps) void dep
      return fn
    },
    useEffect() {},
    useMemo(fn) {
      return fn()
    },
  }
}

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

function loadPlugin(hookInitials) {
  return captured.factory((name) => (name === 'react' ? makeReact(hookInitials) : {}))
}

const sampleState = {
  enabled: true,
  session: 'session-x',
  default: 'noa',
  defaultPersona: 'noa',
  current: { id: 'noa', name: '诺亚' },
  personas: [
    { id: 'noa', name: '诺亚', aliases: ['诺亚', 'Noa'], color: '#7FB3D5', order: 10, enabled: true, avatar: 'png', avatarVersion: 1 },
    { id: 'plana', name: '普拉娜', aliases: ['普拉娜'], color: '#A9A9F5', order: 30, enabled: false, avatar: '', avatarVersion: 0 },
  ],
  personaRoot: 'C:/Users/x/.dsh/personas',
  avatarRepeatRows: 6,
  avatarSize: 40,
}

console.log('=== 面板组件渲染 ===')

check('首屏（还没读到数据）能渲染，不抛', () => {
  const plugin = loadPlugin([])
  const tree = plugin.testing.PersonaSection()
  if (!tree || !tree.type) throw new Error('没返回元素')
})

check('读到人格清单后能渲染，不抛（TDZ / undefined 属性的照妖镜）', () => {
  // 钩子顺序：data, error, note, busy, confirmId, newId, newName, crop
  const plugin = loadPlugin([sampleState, '', '', '', '', '', '', null])
  const tree = plugin.testing.PersonaSection()
  if (!tree || !tree.type) throw new Error('没返回元素')
  const flat = JSON.stringify(tree)
  for (const id of ['noa', 'plana']) {
    if (!flat.includes(id)) throw new Error(`渲染结果里没有 ${id}`)
  }
})

check('裁切窗能渲染，不抛', () => {
  const plugin = loadPlugin([])
  const tree = plugin.testing.CropDialog({
    crop: { id: 'noa', image: { src: 'data:,', width: 800, height: 2400 }, zoom: 1.4, ox: -120, oy: -300 },
    busy: false,
    onPan: () => {},
    onZoom: () => {},
    onZoomTo: () => {},
    onCancel: () => {},
    onConfirm: () => {},
  })
  if (!tree || !tree.type) throw new Error('没返回元素')
})

check('设置页注册的标题不是「人格」（避免与 dsh-agent-md 撞名）', () => {
  const plugin = loadPlugin([])
  const registered = []
  const ctx = {
    slots: {
      inject(key, callback) {
        if (key === 'settings.section') callback()
      },
      register(options) {
        registered.push(options)
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  const section = registered.find((options) => options.id === 'persona-router')
  if (!section) throw new Error('没有注册 settings.section')
  if (section.label === '人格') throw new Error('标题是「人格」，会和 dsh-agent-md 撞名')
  if (section.label !== '多人格切换') throw new Error(`标题意外：${section.label}`)
})

// ---- 自检：宿主 DOM 变了要能说出来 --------------------------------------

console.log('\n=== 自检（宿主 DOM 改名时要说人话） ===')

function withDom(fakeDocument, fn) {
  const previous = globalThis.document
  globalThis.document = fakeDocument
  try {
    fn()
  } finally {
    globalThis.document = previous
  }
}

function fakeDoc({ rows = 0, hasTurn = true, weOn = false, weNodes = 0 }) {
  const row = { hasAttribute: (name) => (name === 'data-chat-turn' ? hasTurn : false) }
  return {
    body: { hasAttribute: (name) => (name === 'data-we-avatar' ? weOn : false) },
    querySelectorAll: (selector) => {
      if (selector.includes('assistant-step')) return Array.from({ length: rows }, () => row)
      if (selector.includes('data-we-avatar-node')) return Array.from({ length: weNodes }, () => ({}))
      return []
    },
  }
}

check('一切正常时不报警', () => {
  const plugin = loadPlugin([])
  withDom(fakeDoc({ rows: 5, hasTurn: true }), () => {
    const warnings = plugin.testing.diagnoseMessages(plugin.testing.diagnoseDom(), true)
    if (warnings.length !== 0) throw new Error(`不该有警告：${warnings.join(' / ')}`)
  })
})

check('找不到助手聊天行时报警（宿主改了 data-chat-flow-kind）', () => {
  const plugin = loadPlugin([])
  withDom(fakeDoc({ rows: 0 }), () => {
    const warnings = plugin.testing.diagnoseMessages(plugin.testing.diagnoseDom(), true)
    if (!warnings.some((w) => w.includes('找不到助手聊天行'))) throw new Error(`没报出来：${JSON.stringify(warnings)}`)
  })
})

check('聊天行没有 data-chat-turn 时报警', () => {
  const plugin = loadPlugin([])
  withDom(fakeDoc({ rows: 3, hasTurn: false }), () => {
    const warnings = plugin.testing.diagnoseMessages(plugin.testing.diagnoseDom(), true)
    if (!warnings.some((w) => w.includes('data-chat-turn'))) throw new Error(`没报出来：${JSON.stringify(warnings)}`)
  })
})

check('壁纸引擎开着却没有头像节点时报警', () => {
  const plugin = loadPlugin([])
  withDom(fakeDoc({ rows: 3, hasTurn: true, weOn: true, weNodes: 0 }), () => {
    const warnings = plugin.testing.diagnoseMessages(plugin.testing.diagnoseDom(), true)
    if (!warnings.some((w) => w.includes('data-we-avatar-node'))) throw new Error(`没报出来：${JSON.stringify(warnings)}`)
  })
})

console.log(`\n=== ${failed === 0 ? '全部通过' : `${failed} 条失败`} ===`)
process.exit(failed === 0 ? 0 : 1)
