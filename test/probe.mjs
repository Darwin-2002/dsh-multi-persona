// 临时测试工具：改某个 session 的人格，然后读插件健康接口。仅本地自检用。
import { readFileSync, writeFileSync } from 'node:fs'

const STATE = 'C:/Users/Darwin/.dsh/persona-router/state.json'
const BASE = 'http://127.0.0.1:54691/persona-router'

const [sid, persona] = process.argv.slice(2)
if (sid && persona) {
  const state = JSON.parse(readFileSync(STATE, 'utf8'))
  state.sessions[sid] = persona
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  console.log(`set ${sid} -> ${persona}`)
}

const health = await (await fetch(`${BASE}/health`)).json()
console.log(`codeVersion=${health.codeVersion} enabled=${health.enabled} personas=${health.personas.map((p) => p.id).join(',')}`)
const reports = health.reports ?? {}
const keys = Object.keys(reports)
if (keys.length === 0) console.log('reports: (none)')
for (const key of keys) {
  const r = reports[key]
  console.log(`  report ${key}`)
  console.log(`    mode=${r.mode} persona=${r.personaId} own=${r.avatarNodes} at=${r.at}`)
  console.log(`    detail=${r.detail}`)
}
