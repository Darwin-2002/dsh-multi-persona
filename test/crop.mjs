/**
 * 裁切几何自测：把客户端半在 Node 里装配起来，只验数学，不碰 DOM。
 * 用法：node test/crop.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'plugin', 'client.js'), 'utf8')

// 假装是浏览器：抓住 __ModuleLoader__.load 传进来的定义
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}
// React 在装配阶段不会被调用，给个空壳就够
const fakeReact = { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useRef: () => ({}), useCallback: (fn) => fn }
globalThis.document = undefined

// 执行客户端半的源码（它会调用 window.__ModuleLoader__.load）
new Function('window', 'Image', 'FileReader', 'fetch', source)(globalThis.window, function Image() {}, function FileReader() {}, () => Promise.reject(new Error('no net')))

if (!captured) {
  console.error('FAIL  没能抓到客户端模块定义')
  process.exit(1)
}
const plugin = captured.factory((name) => (name === 'react' ? fakeReact : {}))
const { cropGeometry, clampOffset, CROP_FRAME, CROP_OUT } = plugin.testing

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
function near(actual, expected, eps = 1e-6, what = '') {
  if (Math.abs(actual - expected) > eps) throw new Error(`${what} 期望 ${expected}，实际 ${actual}`)
}
function ok(cond, message) {
  if (!cond) throw new Error(message)
}

console.log('=== 裁切几何 ===')
console.log(`框 ${CROP_FRAME}px → 导出 ${CROP_OUT}px`)

check('方图 zoom=1：正好盖满，位移只能为 0', () => {
  const g = cropGeometry({ width: 1000, height: 1000 }, 1)
  near(g.rw, CROP_FRAME, 1e-9, 'rw')
  near(g.rh, CROP_FRAME, 1e-9, 'rh')
  near(g.minX, 0, 1e-9, 'minX')
  near(g.minY, 0, 1e-9, 'minY')
})

check('横图 zoom=1：按短边盖满，左右可挪', () => {
  const g = cropGeometry({ width: 4000, height: 1000 }, 1)
  near(g.rh, CROP_FRAME, 1e-9, 'rh 应等于框高')
  ok(g.rw > CROP_FRAME, 'rw 应比框宽')
  near(g.minX, CROP_FRAME - g.rw, 1e-9, 'minX')
  near(g.minY, 0, 1e-9, 'minY')
})

check('放大 2 倍：尺寸翻倍，可挪范围也翻倍', () => {
  const g1 = cropGeometry({ width: 4000, height: 1000 }, 1)
  const g2 = cropGeometry({ width: 4000, height: 1000 }, 2)
  near(g2.rw, g1.rw * 2, 1e-9, 'rw')
  near(g2.rh, g1.rh * 2, 1e-9, 'rh')
  near(g2.minX, CROP_FRAME - g2.rw, 1e-9, 'minX')
})

check('位移夹取：越界一律贴边', () => {
  near(clampOffset(50, -300), 0, 1e-9, '正向越界')
  near(clampOffset(-999, -300), -300, 1e-9, '负向越界')
  near(clampOffset(-120, -300), -120, 1e-9, '范围内不动')
})

check('竖图 zoom=1.5：导出仍盖满 512 方图（不留白）', () => {
  const image = { width: 800, height: 2400 }
  const zoom = 1.5
  const g = cropGeometry(image, zoom)
  const ox = clampOffset((CROP_FRAME - g.rw) / 2, g.minX)
  const oy = clampOffset(-100, g.minY)
  const k = CROP_OUT / CROP_FRAME
  const left = ox * k
  const top = oy * k
  const right = left + g.rw * k
  const bottom = top + g.rh * k
  ok(left <= 1e-6, `左边留白：${left}`)
  ok(top <= 1e-6, `上边留白：${top}`)
  ok(right >= CROP_OUT - 1e-6, `右边留白：right=${right}`)
  ok(bottom >= CROP_OUT - 1e-6, `下边留白：bottom=${bottom}`)
})

check('任意 zoom 下导出都盖满（扫一遍）', () => {
  const images = [
    { width: 1000, height: 1000 },
    { width: 4000, height: 1000 },
    { width: 800, height: 2400 },
    { width: 37, height: 601 },
  ]
  for (const image of images) {
    for (const zoom of [1, 1.3, 2, 4]) {
      const g = cropGeometry(image, zoom)
      const k = CROP_OUT / CROP_FRAME
      // 极端位移：先把图挪到最左，再挪到最右
      for (const ox of [g.minX, 0]) {
        const left = ox * k
        const right = left + g.rw * k
        ok(left <= 1e-6 && right >= CROP_OUT - 1e-6, `${image.width}x${image.height} zoom=${zoom} ox=${ox} 留白`)
      }
    }
  }
})

console.log(`\n=== ${failed === 0 ? '全部通过' : `${failed} 条失败`} ===`)
process.exit(failed === 0 ? 0 : 1)
