// 面板路由自测：真实打一遍新增的 HTTP 接口，最后把痕迹清干净。
// 用法：node test/routes.mjs [port]   端口也可用环境变量 DSH_WEB_PORT 给。
// 端口每次都变（DSH 启动时分配），所以这里不再写死默认值，取不到就直接说清楚。
const PORT = process.argv[2] ?? process.env.DSH_WEB_PORT ?? process.env.PERSONA_PORT
if (!PORT) {
  console.error('缺少端口：node test/routes.mjs <port>，或设环境变量 DSH_WEB_PORT')
  console.error('当前 Web GUI 的端口可以在 DSH 窗口标题栏地址里看到，例如 http://127.0.0.1:53502')
  process.exit(2)
}
const BASE = `http://127.0.0.1:${PORT}/persona-router`

let failed = 0
async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  return { status: response.status, payload }
}

/** 发原始字节：头像这类二进制上传用；call() 只会发 JSON。 */
async function raw(method, path, bytes, contentType) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    cache: 'no-store',
    headers: { 'content-type': contentType },
    body: bytes,
  })
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  return { status: response.status, payload }
}

function check(name, ok, detail) {  if (ok) console.log(`PASS  ${name}`)
  else {
    failed += 1
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

const ID = 'paneltest'

console.log('=== 面板路由 ===')

const state = await call('GET', '/state?session=none')
check('GET /state 带上 personaRoot', typeof state.payload?.personaRoot === 'string', JSON.stringify(state.payload?.personaRoot))
check('GET /state 列出人格', Array.isArray(state.payload?.personas) && state.payload.personas.length >= 1)

const bad = await call('POST', '/persona', { id: 'BIG LETTER', name: 'x' })
check('非法 id 被拒（400）', bad.status === 400, `status=${bad.status}`)

const created = await call('POST', '/persona', { id: ID, name: '面板测试' })
check('新建人格', created.status === 200 && created.payload?.ok === true, JSON.stringify(created.payload))

const dup = await call('POST', '/persona', { id: ID, name: '面板测试' })
check('重复 id 被拒（409）', dup.status === 409, `status=${dup.status}`)

const listed = await call('GET', '/state')
const mine = (listed.payload?.personas ?? []).find((p) => p.id === ID)
check('新建后立刻出现在清单里', Boolean(mine), JSON.stringify(listed.payload?.personas?.map((p) => p.id)))

const edited = await call('PUT', `/persona/${ID}`, { name: '面板测试2', aliases: ['面板测试', 'paneltest'], color: '#123456', order: 42 })
check('改名称/别名/颜色/order', edited.status === 200 && edited.payload?.persona?.color === '#123456', JSON.stringify(edited.payload?.persona))

const off = await call('PUT', `/persona/${ID}`, { enabled: false })
check('停用', off.payload?.persona?.enabled === false, JSON.stringify(off.payload?.persona?.enabled))
const afterOff = await call('GET', '/state')
check('停用后不在生效清单里', !(afterOff.payload?.personas ?? []).some((p) => p.id === ID))

const on = await call('PUT', `/persona/${ID}`, { enabled: true })
check('重新启用', on.payload?.persona?.enabled === true)

const def = await call('PUT', '/default', { default: ID })
const stateAfter = await call('GET', '/state')
check('设默认（可写回）', def.payload?.default === ID && stateAfter.payload?.default === ID, JSON.stringify(stateAfter.payload?.default))
const back = await call('PUT', '/default', { default: 'noa' })
check('默认改回 noa', back.payload?.default === 'noa')

const cfg = await call('PUT', '/config', { avatarRepeatRows: 6, avatarSize: 40 })
check('改配置（回写原值）', cfg.status === 200 && cfg.payload?.config?.avatarRepeatRows === 6, JSON.stringify(cfg.payload?.config))

const removed = await call('DELETE', `/persona/${ID}`)
check('删除人格', removed.status === 200 && removed.payload?.removed === true, JSON.stringify(removed.payload))

const finalList = await call('GET', '/state')
check('删除后清单恢复', !(finalList.payload?.personas ?? []).some((p) => p.id === ID), JSON.stringify(finalList.payload?.personas?.map((p) => p.id)))
check('删除后 default 已回落到有效人格', (finalList.payload?.personas ?? []).some((p) => p.id === finalList.payload?.default))

console.log('\n=== 老师头像（r16） ===')

// 一张 1×1 的合法 PNG：只验通路，不验画面
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
await raw('DELETE', '/user-avatar') // 先清干净，免得受上一次运行影响
const putAvatar = await raw('POST', '/user-avatar', PNG, 'image/png')
check('POST /user-avatar 收下 PNG', putAvatar.status === 200 && putAvatar.payload?.ok === true, JSON.stringify(putAvatar.payload))
const stateWithAvatar = await call('GET', '/state')
check(
  'state 里出现 userAvatar',
  Boolean(stateWithAvatar.payload?.userAvatar?.version),
  JSON.stringify(stateWithAvatar.payload?.userAvatar),
)
const gotAvatar = await fetch(`${BASE}/user-avatar?v=1`)
const cacheHeader = gotAvatar.headers.get('cache-control') || ''
check('GET /user-avatar 回图并带长缓存', gotAvatar.status === 200 && cacheHeader.includes('immutable'), cacheHeader)
const gotBytes = Buffer.from(await gotAvatar.arrayBuffer())
check('取回的字节与上传一致', gotBytes.equals(PNG), `len=${gotBytes.length} vs ${PNG.length}`)
const headAvatar = await fetch(`${BASE}/user-avatar`, { method: 'HEAD' })
check('HEAD 只探存在，不返回体', headAvatar.status === 200)
const badAvatar = await raw('POST', '/user-avatar', Buffer.from('not-an-image'), 'image/png')
check('非图片被拒（415）', badAvatar.status === 415, `status=${badAvatar.status}`)
const delAvatar = await raw('DELETE', '/user-avatar')
check('DELETE /user-avatar 清掉', delAvatar.status === 200 && delAvatar.payload?.removed === true, JSON.stringify(delAvatar.payload))
const goneAvatar = await fetch(`${BASE}/user-avatar`)
check('清除后 GET 回 404', goneAvatar.status === 404, `status=${goneAvatar.status}`)

console.log(`\n=== ${failed === 0 ? '全部通过' : `${failed} 条失败`} ===`)
process.exit(failed === 0 ? 0 : 1)
