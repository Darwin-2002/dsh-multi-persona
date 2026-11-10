/**
 * 判定解释器：给一句话，逐个别名说明它算不算「在叫她」。
 * 规则只来自 plugin/index.js 的 explainAliases —— 这里不再自己抄一份，
 * 免得改了判定却忘了改解释（2026-11-09 就撞过一次：解释说「算」，真判定说「不切」）。
 * 用法：node test/explain.mjs [一句话]
 */
import { testing } from '../plugin/index.js'

const { detectPersona, loadPersonas, explainAliases } = testing

// 默认就是老师睡前那句
const text = process.argv[2] ?? '我们明天再做吧，晚安诺亚，阿罗娜和普拉娜也幸苦了'

const personas = loadPersonas()

console.log(`原句：${text}\n`)

const trace = explainAliases(text, personas)
for (const item of trace) {
  const left = item.prev === undefined ? '(句首)' : item.prev
  const right = item.next === undefined ? '(句尾)' : item.next
  let why
  if (item.counted) {
    why = [
      item.leftOk ? '左邻是边界' : '',
      item.rightOk ? '右邻是边界' : '',
      item.suffix ? `后面跟着「${item.suffix}」` : '',
      item.pronoun ? '后面跟着「你」' : '',
      item.particle ? '后面是呼语助词' : '',
    ]
      .filter(Boolean)
      .join('、')
  } else if (item.nested) {
    why = '被更长的别名覆盖，不重复计数'
  } else if (item.inQuote) {
    why = '在引号/括号里，是在说它不是在叫它'
  } else if (item.copula) {
    why = '左邻是「是 / 为」，那是判断句'
  } else {
    why = '两边都是正文里的字，不算称呼位'
  }
  const verdict = item.counted ? '算在叫她' : '不算'
  console.log(
    `  ${item.alias.padEnd(6)} 第 ${String(item.at).padStart(2)} 字  左「${left}」 右「${right}」  →  ${verdict}（${why}）`,
  )
}

console.log('')
const winner = detectPersona(text, personas)
console.log(`判定结果：${winner ? `${winner.name}（${winner.id}）` : '(不切，沿用上一次)'}`)

const counted = trace.filter((item) => item.counted)
if (counted.length > 1) {
  const sorted = counted.slice().sort((a, b) => b.at - a.at)
  console.log(`命中多个时取最靠后的：${sorted.map((hit) => `${hit.alias}@${hit.at}`).join('  >  ')}`)
}
