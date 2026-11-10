/**
 * 用面板同一条接口建人格：POST /persona-router/persona（面板「新建」按钮走的就是它）。
 * 用法：node test/addpersona.mjs <port> <id> <显示名> [别名,逗号分隔]
 */
const [port, id, name, aliasArg] = process.argv.slice(2)
if (!port || !id || !name) {
  console.error('usage: node test/addpersona.mjs <port> <id> <name> [aliases]')
  process.exit(1)
}
const BASE = `http://127.0.0.1:${port}/persona-router`

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

const created = await call('POST', '/persona', { id, name })
console.log(`POST /persona -> ${created.status} ${JSON.stringify(created.payload)}`)

if (aliasArg) {
  const aliases = aliasArg.split(',').map((s) => s.trim()).filter(Boolean)
  const updated = await call('PUT', `/persona/${id}`, { aliases })
  console.log(`PUT /persona/${id} -> ${updated.status} ${JSON.stringify(updated.payload?.persona ?? updated.payload)}`)
}

const state = await call('GET', '/state')
console.log('')
console.log(`现在 ${state.payload.personas.length} 个人格：`)
for (const persona of state.payload.personas) {
  console.log(`  ${persona.id.padEnd(8)} ${persona.name}  别名 ${JSON.stringify(persona.aliases)}  头像 ${persona.avatar || '(无)'}  启用 ${persona.enabled}`)
}
