window.__ModuleLoader__.load({
  id: 'dsh-multi-persona',
  factory(require) {
    const React = require('react')

    const API = '/persona-router'
    const ASSISTANT_KIND = 'assistant-step'
    /** 用户消息行的类型（宿主里 data-chat-flow-kind 的取值之一） */
    const USER_KIND = 'user'
    const NODE_ATTR = 'data-dpr-avatar-node'
    /** 自绘层给「老师」那一侧单独用的属性，和人格头像分开，免得互相清掉 */
    const USER_NODE_ATTR = 'data-dpr-user-avatar-node'
    /** 面板里用这个哨兵当「这次裁剪是给用户头像用的」，和人格 id 区分开 */
    const USER_AVATAR_KEY = '__user__'
    /** 壁纸引擎头像层的开关属性 —— 它在 body 上写 data-we-avatar="on"。 */
    const WE_ATTR = 'data-we-avatar'
    const WE_NODE = '[data-we-avatar-node="ai"]'
    /** 壁纸引擎给用户行插的那一族节点；老师设过头像时才接管 */
    const WE_USER_NODE = '[data-we-avatar-node="user"]'

    /** 模块级单例：同一时刻只允许一层头像。 */
    const layer = {
      active: false,
      sessionId: '',
      persona: null,
      /** 老师自己的头像：null = 没设过（沿用壁纸引擎那张，或不画） */
      userAvatar: null,
      config: { repeat: 6, size: 40 },
      mode: 'none',
      observer: null,
      timer: 0,
      raf: 0,
      touchedRows: new Set(),
      /** 上一次寄生改写实际覆盖到的壁纸引擎节点数（诊断用） */
      theirNodes: 0,
      /** 其中属于用户行的那几个（老师设过头像时才有） */
      theirUserNodes: 0,
      lastReport: '',
      /** 人格清单与「回合 → 人格」小表：历史消息要贴回**当时那张脸** */
      byId: new Map(),
      turnMap: new Map(),
      defaultPersona: '',
    }

    function nowIso() {
      return new Date().toISOString()
    }

    function avatarUrl(persona) {
      if (!persona || !persona.avatar) return ''
      return `${API}/avatar/${encodeURIComponent(persona.id)}?v=${persona.avatarVersion}`
    }

    /** 老师自己的头像地址；没设过就是空串（空串 = 一切保持原样，做到可随时退回）。 */
    function userAvatarUrl() {
      const ua = layer.userAvatar
      if (!ua || !ua.version) return ''
      return `${API}/user-avatar?v=${ua.version}`
    }

    /**
     * 没有头像文件的人格，现场画一张「本色底 + 名字首字」的占位图。
     *
     * 为什么必须画：寄生改写如果用「没头像就不动」，那个位置会留着壁纸引擎自己的头像，
     * 于是出现「人格是甲、脸是乙」的错配（实测踩过：爱丽丝没头像，显示成了优香那张）。
     */
    const placeholderCache = new Map()

    function placeholderAvatar(persona) {
      if (!persona) return ''
      const key = `${persona.id}|${persona.name}|${persona.color}`
      if (placeholderCache.has(key)) return placeholderCache.get(key)
      let url = ''
      try {
        const size = 128
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const context = canvas.getContext('2d')
        context.fillStyle = persona.color || '#8AB4F8'
        context.fillRect(0, 0, size, size)
        context.fillStyle = '#ffffff'
        context.font = `600 ${Math.round(size * 0.5)}px system-ui, sans-serif`
        context.textAlign = 'center'
        context.textBaseline = 'middle'
        context.fillText(String(persona.name || persona.id || '?').slice(0, 1), size / 2, size / 2 + 2)
        url = canvas.toDataURL('image/webp', 0.9)
        if (!String(url).startsWith('data:image')) url = canvas.toDataURL('image/png')
      } catch (_error) {
        url = ''
      }
      placeholderCache.set(key, url)
      return url
    }

    /** 某一轮该显示哪张图：有头像用头像，没有就用占位图。 */
    function avatarSrcFor(persona) {
      return avatarUrl(persona) || placeholderAvatar(persona)
    }

    /**
     * 某一轮是哪个格答的。没记到的轮次（插件装上之前的历史）回落到默认人格 ——
     * 「十点半以前的都算诺亚」就是靠这一条，而不是靠时间戳。
     */
    function personaForTurn(turn) {
      const id = turn === null || turn === undefined ? '' : layer.turnMap.get(String(turn))
      if (id && layer.byId.has(id)) return layer.byId.get(id)
      if (layer.defaultPersona && layer.byId.has(layer.defaultPersona)) return layer.byId.get(layer.defaultPersona)
      return layer.persona
    }

    /** 从「头像节点」往回找它所属的聊天行，取回合号再取人格。 */
    function personaForNode(node) {
      let row = null
      try {
        row = node.closest('[data-chat-turn]')
      } catch (_error) {
        row = null
      }
      if (!row) row = node.parentElement
      const turn = row && row.getAttribute ? row.getAttribute('data-chat-turn') : null
      if (turn === null) return null // 没有回合号就不猜，宁可不动
      return personaForTurn(turn)
    }

    function postReport() {
      if (!layer.active) return
      const ownNodes = document.querySelectorAll(`[${NODE_ATTR}]`).length
      const ownUserNodes = document.querySelectorAll(`[${USER_NODE_ATTR}]`).length
      const theirNodes = layer.theirNodes ?? 0
      const theirUserNodes = layer.theirUserNodes ?? 0
      const personaId = layer.persona ? layer.persona.id : ''
      // 上限 200 字（宿主侧会截断）：mode / 人格 / 自绘助手节点 / 被改写的壁纸节点 / 用户侧（自绘/被改写）
      const detail = `${layer.mode}|${personaId}|own=${ownNodes}|their=${theirNodes}|u=${ownUserNodes}/${theirUserNodes}`
      if (detail === layer.lastReport) return
      layer.lastReport = detail
      try {
        fetch(`${API}/client-report`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: layer.sessionId,
            mode: layer.mode,
            personaId,
            avatarNodes: ownNodes,
            detail: `${detail} at ${nowIso()}`,
          }),
        }).catch(() => {})
      } catch (_error) {
        /* 上报纯诊断，失败不影响任何东西 */
      }
    }

    // ---- 壁纸引擎那一层 --------------------------------------------------

    function weLayerOn() {
      const body = document.body
      return Boolean(body && body.hasAttribute(WE_ATTR))
    }

    /**
     * 寄生改写：只动壁纸引擎已经画好的那些节点，布局大小圆角全归它。
     *
     * ⚠️ 两点都是踩过的坑：
     *   ① 必须遍历**全部** `[data-we-avatar-node="ai"]` —— 它给每条助手行各插一个头像节点，
     *      只改第一个的话，新消息那一侧永远还是它自己的脸。
     *   ② 每张脸按**那一轮的人格**取图，不是按当前人格 —— 否则切一次人，历史记录全变脸。
     *
     * 它自己的 avatarFillNode 会在 sweep 时把 img.src 改回它自己的地址，所以真正的「补一次」
     * 由轮询与观察者负责 —— 它只订 childList/行属性、不订 src，因此不会和本函数来回打架。
     * @returns {number} 实际改写到的节点数
     */
    function fillWallpaperAvatar() {
      let nodes
      try {
        nodes = document.querySelectorAll(WE_NODE)
      } catch (_error) {
        return 0
      }
      if (nodes.length === 0) return 0
      let touched = 0
      for (const node of nodes) {
        const persona = personaForNode(node)
        if (!persona) continue // 连是哪个人格都判定不出来，就别动
        const url = avatarSrcFor(persona)
        if (!url) continue // 连占位图都画不出来（没有 canvas），只能留着原来的
        const kind = node.getAttribute('data-we-avatar-kind')
        const existing = node.querySelector('img.we-avatar__img')
        if (existing) {
          if (existing.getAttribute('src') !== url) existing.setAttribute('src', url)
          touched += 1
          continue
        }
        if (kind === 'glyph' || kind === null) {
          // 它把 kind 记成 glyph 之后，fill 会走「已是 glyph」的早退分支，不会重建内容 ⇒ 换掉不会被打回
          const image = document.createElement('img')
          image.className = 'we-avatar__img'
          image.setAttribute('alt', '')
          image.setAttribute('src', url)
          try {
            node.textContent = ''
            node.appendChild(image)
            touched += 1
          } catch (_error) {
            /* 单行失败不影响其它行 */
          }
        }
      }
      return touched
    }

    /**
     * 寄生层：老师设过自己的头像时，把壁纸引擎画在用户行上的那几个节点也接管过来。
     * 没设过就一个都不动 —— 它自己的头像照常显示，这是「随时能退回」的前提。
     * @returns {number} 实际改写到的节点数
     */
    function fillWallpaperUserAvatar() {
      const url = userAvatarUrl()
      if (!url) return 0
      let nodes
      try {
        nodes = document.querySelectorAll(WE_USER_NODE)
      } catch (_error) {
        return 0
      }
      let touched = 0
      for (const node of nodes) {
        const existing = node.querySelector('img.we-avatar__img')
        if (existing) {
          if (existing.getAttribute('src') !== url) existing.setAttribute('src', url)
          touched += 1
          continue
        }
        const kind = node.getAttribute('data-we-avatar-kind')
        if (kind === 'glyph' || kind === null) {
          const image = document.createElement('img')
          image.className = 'we-avatar__img'
          image.setAttribute('alt', '')
          image.setAttribute('src', url)
          try {
            node.textContent = ''
            node.appendChild(image)
            touched += 1
          } catch (_error) {
            /* 单行失败不影响其它行 */
          }
        }
      }
      return touched
    }

    // ---- 自绘那一层 ------------------------------------------------------

    /** 只清老师那一侧的自绘节点（寄生模式接管成功时用，保证不双层）。 */
    function removeUserNodes() {
      for (const node of document.querySelectorAll(`[${USER_NODE_ATTR}]`)) {
        try {
          node.remove()
        } catch (_error) {
          /* ignore */
        }
      }
    }

    function removeSelfNodes() {
      for (const node of document.querySelectorAll(`[${NODE_ATTR}]`)) {
        try {
          node.remove()
        } catch (_error) {
          /* ignore */
        }
      }
      // 老师那一侧的节点也一起收掉：两层切换时不许留下半套
      removeUserNodes()
      for (const row of layer.touchedRows) {
        try {
          row.style.removeProperty('position')
        } catch (_error) {
          /* ignore */
        }
      }
      layer.touchedRows.clear()
    }

    function makeNode(persona, size) {
      const wrap = document.createElement('div')
      wrap.setAttribute(NODE_ATTR, '')
      wrap.setAttribute('aria-hidden', 'true')
      const url = avatarUrl(persona)
      const style = wrap.style
      style.position = 'absolute'
      style.top = '2px'
      style.width = `${size}px`
      style.height = `${size}px`
      style.borderRadius = '50%'
      style.overflow = 'hidden'
      style.pointerEvents = 'none'
      style.zIndex = '1'
      style.background = persona && persona.color ? persona.color : '#8AB4F8'
      if (url) {
        const image = document.createElement('img')
        image.src = url
        image.alt = ''
        image.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block'
        wrap.appendChild(image)
      } else {
        wrap.style.display = 'flex'
        wrap.style.alignItems = 'center'
        wrap.style.justifyContent = 'center'
        wrap.style.color = '#fff'
        wrap.style.font = `600 ${Math.round(size * 0.45)}px/1 system-ui, sans-serif`
        wrap.textContent = persona && persona.name ? persona.name.slice(0, 1) : '?'
      }
      return wrap
    }

    function placeNode(row, node, size) {
      let rect
      try {
        rect = row.getBoundingClientRect()
      } catch (_error) {
        rect = null
      }
      if (!rect) return
      // 贴在行左侧外沿；窗口太窄时夹到 4px，宁可压一点也不能飘出屏幕
      const desired = -size - 12
      const clamped = Math.max(4 - rect.left, desired)
      node.style.left = `${Math.round(clamped)}px`
    }

    function pickRows(repeat) {
      const rows = document.querySelectorAll(`[data-chat-flow-kind="${ASSISTANT_KIND}"]`)
      const wanted = new Set()
      const counter = new Map()
      for (const row of rows) {
        // 只用属性判可见性，不碰布局：长会话里几百行，逐个 getClientRects 会拖慢整帧
        if (row.hasAttribute('hidden')) continue
        if (row.hasAttribute('data-turn-process-hidden')) continue
        if (!row.isConnected) continue
        const turn = row.getAttribute('data-chat-turn') ?? '0'
        const seen = (counter.get(turn) ?? 0) + 1
        counter.set(turn, seen)
        if (seen === 1 || (repeat > 0 && (seen - 1) % repeat === 0)) wanted.add(row)
      }
      return wanted
    }

    function drawSelf(config) {
      const size = config.size
      const wanted = pickRows(config.repeat)
      for (const row of wanted) {
        // 自绘同理：按**这一轮**的人格画，不是按当前人格
        const persona = personaForTurn(row.getAttribute('data-chat-turn'))
        let node = row.querySelector(`:scope > [${NODE_ATTR}]`)
        if (!node) {
          let rect
          try {
            rect = row.getBoundingClientRect()
          } catch (_error) {
            continue
          }
          // 行要能承载绝对定位；原本不是 static 的就不动它
          if (window.getComputedStyle(row).position === 'static') {
            row.style.position = 'relative'
            layer.touchedRows.add(row)
          }
          node = makeNode(persona, size)
          try {
            row.insertBefore(node, row.firstChild)
          } catch (_error) {
            continue
          }
          placeNode(row, node, size)
        } else {
          const url = avatarUrl(persona)
          const image = node.querySelector('img')
          if (url && image && image.getAttribute('src') !== url) image.setAttribute('src', url)
          if (url && !image) {
            const fresh = makeNode(persona, size)
            node.replaceWith(fresh)
            placeNode(row, fresh, size)
            continue
          }
          node.style.background = persona && persona.color ? persona.color : '#8AB4F8'
          placeNode(row, node, size)
        }
      }
      for (const node of document.querySelectorAll(`[${NODE_ATTR}]`)) {
        const row = node.parentElement
        if (!row || !wanted.has(row)) {
          try {
            node.remove()
          } catch (_error) {
            /* ignore */
          }
        }
      }
    }

    // ---- 自绘层：老师那一侧 ------------------------------------------------

    function makeUserNode(size, url) {
      const wrap = document.createElement('div')
      wrap.setAttribute(USER_NODE_ATTR, '')
      wrap.setAttribute('aria-hidden', 'true')
      const style = wrap.style
      style.position = 'absolute'
      style.top = '2px'
      style.width = `${size}px`
      style.height = `${size}px`
      style.borderRadius = '50%'
      style.overflow = 'hidden'
      style.pointerEvents = 'none'
      style.zIndex = '1'
      style.background = '#8AB4F8'
      const image = document.createElement('img')
      image.src = url
      image.alt = ''
      image.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block'
      wrap.appendChild(image)
      return wrap
    }

    /** 贴在行右外侧；屏幕太窄就往回收一点，宁可压一点也不飘出可视区。 */
    function placeUserNode(row, node, size) {
      let rect
      try {
        rect = row.getBoundingClientRect()
      } catch (_error) {
        rect = null
      }
      if (!rect) return
      const room = window.innerWidth - rect.right - 4
      const outward = Math.min(size + 12, Math.max(0, room))
      node.style.right = `${-outward}px`
    }

    /**
     * 自绘层里老师那一侧的头像：只在设过图的时候画，没设就一个节点都不留。
     * 用户行不做「间隔重复」——每一条用户消息旁边都该有一张，不然会以为漏了。
     */
    function drawUserSelf(config) {
      const url = userAvatarUrl()
      if (!url) {
        for (const node of document.querySelectorAll(`[${USER_NODE_ATTR}]`)) {
          try {
            node.remove()
          } catch (_error) {
            /* ignore */
          }
        }
        return
      }
      const size = config.size
      const wanted = new Set()
      let rows
      try {
        rows = document.querySelectorAll(`[data-chat-flow-kind="${USER_KIND}"]`)
      } catch (_error) {
        return
      }
      for (const row of rows) {
        if (row.hasAttribute('hidden')) continue
        if (!row.isConnected) continue
        wanted.add(row)
      }
      for (const row of wanted) {
        let node = row.querySelector(`:scope > [${USER_NODE_ATTR}]`)
        if (!node) {
          try {
            if (window.getComputedStyle(row).position === 'static') {
              row.style.position = 'relative'
              layer.touchedRows.add(row)
            }
          } catch (_error) {
            continue
          }
          node = makeUserNode(size, url)
          try {
            row.appendChild(node)
          } catch (_error) {
            continue
          }
        } else {
          const image = node.querySelector('img')
          if (image && image.getAttribute('src') !== url) image.setAttribute('src', url)
        }
        placeUserNode(row, node, size)
      }
      for (const node of document.querySelectorAll(`[${USER_NODE_ATTR}]`)) {
        const row = node.parentElement
        if (!row || !wanted.has(row)) {
          try {
            node.remove()
          } catch (_error) {
            /* ignore */
          }
        }
      }
    }

    // ---- 两层调度 --------------------------------------------------------

    function applyLayer() {
      if (!layer.active) return
      if (weLayerOn()) {
        if (layer.mode !== 'parasitic') {
          removeSelfNodes()
          layer.mode = 'parasitic'
        }
        layer.theirNodes = fillWallpaperAvatar()
        // 老师那一侧：设过才接管，没设就让壁纸引擎自己画
        layer.theirUserNodes = fillWallpaperUserAvatar()
        // 它没画用户节点（可能把「我」那张关了）⇒ 我们补一排；它一旦画出来，我们那排立刻收掉，
        // 保证「每一侧同一时刻只有一层」这条不变量在两侧都成立。
        if (userAvatarUrl() && layer.theirUserNodes === 0) {
          drawUserSelf(layer.config)
        } else {
          removeUserNodes()
        }
        postReport()
        return
      }
      layer.mode = 'self'
      layer.theirNodes = 0
      layer.theirUserNodes = 0
      drawSelf(layer.config)
      drawUserSelf(layer.config)
      postReport()
    }

    function scheduleApply() {
      if (layer.raf) return
      layer.raf = window.requestAnimationFrame(() => {
        layer.raf = 0
        applyLayer()
      })
    }

    async function refresh() {
      if (!layer.active) return
      try {
        const query = layer.sessionId ? `?session=${encodeURIComponent(layer.sessionId)}` : ''
        const response = await fetch(`${API}/state${query}`, { cache: 'no-store' })
        if (!response.ok) return
        const data = await response.json()
        if (!layer.active || data.session !== layer.sessionId) return
        layer.persona = data.current ?? null
        layer.userAvatar = data.userAvatar ?? null
        layer.defaultPersona = typeof data.defaultPersona === 'string' ? data.defaultPersona : ''
        const byId = new Map()
        if (Array.isArray(data.personas)) {
          for (const entry of data.personas) {
            if (entry && typeof entry.id === 'string') byId.set(entry.id, entry)
          }
        }
        layer.byId = byId
        const turnMap = new Map()
        if (Array.isArray(data.history)) {
          for (const entry of data.history) {
            if (!entry) continue
            if (entry.turn !== undefined && entry.persona) turnMap.set(String(entry.turn), entry.persona)
          }
        }
        layer.turnMap = turnMap
        layer.config = {
          repeat: Number.isFinite(Number(data.avatarRepeatRows)) ? Number(data.avatarRepeatRows) : 6,
          size: Number.isFinite(Number(data.avatarSize)) ? Number(data.avatarSize) : 40,
        }
        if (!data.enabled) {
          removeSelfNodes()
          layer.mode = 'none'
          return
        }
        applyLayer()
      } catch (_error) {
        /* 宿主没起或路由没挂：安静降级，不干扰消息渲染 */
      }
    }

    function start(sessionId) {
      if (typeof document === 'undefined') return
      if (layer.active && layer.sessionId === sessionId) return
      stop()
      layer.active = true
      layer.sessionId = sessionId
      layer.lastReport = ''
      try {
        layer.observer = new MutationObserver(scheduleApply)
        layer.observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['hidden', 'data-chat-flow-kind', 'data-chat-turn', WE_ATTR],
        })
      } catch (_error) {
        layer.observer = null
      }
      window.addEventListener('resize', scheduleApply)
      refresh()
      layer.timer = window.setInterval(refresh, 1500)
    }

    function stop() {
      layer.active = false
      layer.sessionId = ''
      layer.persona = null
      layer.userAvatar = null
      layer.mode = 'none'
      layer.theirNodes = 0
      layer.lastReport = ''
      if (layer.observer) {
        try {
          layer.observer.disconnect()
        } catch (_error) {
          /* ignore */
        }
        layer.observer = null
      }
      if (layer.timer) {
        window.clearInterval(layer.timer)
        layer.timer = 0
      }
      if (layer.raf) {
        window.cancelAnimationFrame(layer.raf)
        layer.raf = 0
      }
      try {
        window.removeEventListener('resize', scheduleApply)
      } catch (_error) {
        /* ignore */
      }
      if (typeof document !== 'undefined') removeSelfNodes()
    }

    /**
     * 一个不渲染任何东西的运行时组件：只为拿到 sessionId 与生命周期。
     * 挂在 conversation.composer.dock 这个 session 作用域的 list 座位里，add-one、replaceRisk none。
     */
    function Runtime(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : ''
      React.useEffect(() => {
        if (!sessionId) return undefined
        start(sessionId)
        return () => stop()
      }, [sessionId])
      return null
    }

    // ---- 设置页：人格管理（A 档，只管配置） --------------------------------

    const C = {
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      faint: 'var(--dsw-alias-label-tertiary)',
      line: 'var(--dsw-alias-border-l1)',
      card: 'var(--dsw-alias-bg-layer-1)',
      brand: 'var(--dsw-alias-brand-primary)',
      danger: 'var(--dsw-alias-state-error-primary)',
    }

    async function apiJson(url, init) {
      const options = { cache: 'no-store', ...(init || {}) }
      // 只有 JSON 字符串才声明 content-type；头像上传是二进制，让浏览器自己定
      if (typeof options.body === 'string') {
        options.headers = { 'content-type': 'application/json', ...(options.headers || {}) }
      }
      const response = await fetch(`${API}${url}`, options)
      let payload = null
      try {
        payload = await response.json()
      } catch (_error) {
        payload = null
      }
      if (!response.ok) throw new Error((payload && payload.error) || `HTTP ${response.status}`)
      return payload
    }

    /** 裁切框在屏幕上的边长（px）与导出方图的边长（px）。 */
    const CROP_FRAME = 240
    const CROP_OUT = 512
    const CROP_MIN_ZOOM = 1
    const CROP_MAX_ZOOM = 4

    /**
     * 预览与导出共用的几何：图片先「盖满」方框（cover），再乘缩放倍数。
     * @returns {{scale: number, rw: number, rh: number, minX: number, minY: number}}
     */
    function cropGeometry(image, zoom) {
      const w = image.width || 1
      const h = image.height || 1
      const base = Math.max(CROP_FRAME / w, CROP_FRAME / h)
      const scale = base * zoom
      const rw = w * scale
      const rh = h * scale
      return { scale, rw, rh, minX: CROP_FRAME - rw, minY: CROP_FRAME - rh }
    }

    /** 位移夹住：图片永远盖满方框，不留白边。 */
    function clampOffset(value, min) {
      return Math.min(0, Math.max(min, value))
    }

    /** 读本地文件成可绘制的 Image。 */
    async function loadImageFile(file) {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(new Error('读取文件失败'))
        reader.readAsDataURL(file)
      })
      return await new Promise((resolve, reject) => {
        const i = new Image()
        i.onload = () => resolve(i)
        i.onerror = () => reject(new Error('这不是一张能解码的图片'))
        i.src = dataUrl
      })
    }

    /** 把裁切框里看到的那一块画成 512×512 再导出（预览与导出共用同一套变换）。 */
    async function exportCropBlob(image, crop) {
      const k = CROP_OUT / CROP_FRAME
      const canvas = document.createElement('canvas')
      canvas.width = CROP_OUT
      canvas.height = CROP_OUT
      const context = canvas.getContext('2d')
      context.imageSmoothingQuality = 'high'
      context.drawImage(image, crop.ox * k, crop.oy * k, crop.rw * k, crop.rh * k)
      const webp = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/webp', 0.92))
      if (webp) return webp
      const png = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'))
      if (!png) throw new Error('浏览器没能导出图片')
      return png
    }

    /**
     * 裁切窗：拖动移位、滚轮或滑块缩放，确定后按同一套变换导出 512×512。
     * 只做方形裁切——头像本来就是圆的，多留四角也没用。
     */
    function CropDialog(props) {
      const { crop, busy } = props
      const image = crop.image
      const geometry = cropGeometry(image, crop.zoom)
      const ox = clampOffset(crop.ox, geometry.minX)
      const oy = clampOffset(crop.oy, geometry.minY)

      // 事件处理器用 ref 拿最新的，免得每帧重挂监听
      const latest = React.useRef(props)
      latest.current = props
      const drag = React.useRef(null)
      const frameRef = React.useRef(null)

      React.useEffect(() => {
        const node = frameRef.current
        if (!node || typeof node.addEventListener !== 'function') return undefined
        const onWheel = (event) => {
          event.preventDefault()
          latest.current.onZoom(event.deltaY < 0 ? 1 : -1)
        }
        node.addEventListener('wheel', onWheel, { passive: false })
        return () => node.removeEventListener('wheel', onWheel)
      }, [])

      return React.createElement(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 40,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
          },
          onClick: (event) => {
            if (event.target === event.currentTarget) props.onCancel()
          },
        },
        React.createElement(
          'div',
          {
            style: {
              background: C.card,
              border: `1px solid ${C.line}`,
              borderRadius: '12px',
              padding: '16px',
              width: '304px',
              boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
            },
          },
          React.createElement('div', { style: { fontSize: '13px', fontWeight: 600, color: C.text, marginBottom: '2px' } }, '调整头像'),
          React.createElement(
            'div',
            { style: { fontSize: '11px', color: C.faint, marginBottom: '10px' } },
            '拖动移动位置，滚轮或下面的滑块缩放',
          ),
          React.createElement(
            'div',
            {
              ref: frameRef,
              style: {
                position: 'relative',
                width: `${CROP_FRAME}px`,
                height: `${CROP_FRAME}px`,
                margin: '0 auto',
                overflow: 'hidden',
                borderRadius: '8px',
                background: '#000',
                cursor: 'grab',
                touchAction: 'none',
                userSelect: 'none',
              },
              onPointerDown: (event) => {
                drag.current = { x: event.clientX, y: event.clientY, ox, oy }
                try {
                  event.currentTarget.setPointerCapture(event.pointerId)
                } catch (_error) {
                  /* ignore */
                }
              },
              onPointerMove: (event) => {
                const start = drag.current
                if (!start) return
                props.onPan(start.ox + (event.clientX - start.x), start.oy + (event.clientY - start.y))
              },
              onPointerUp: (event) => {
                drag.current = null
                try {
                  event.currentTarget.releasePointerCapture(event.pointerId)
                } catch (_error) {
                  /* ignore */
                }
              },
              onPointerCancel: () => {
                drag.current = null
              },
            },
            React.createElement('img', {
              src: image.src,
              alt: '',
              draggable: false,
              style: {
                position: 'absolute',
                left: `${ox}px`,
                top: `${oy}px`,
                width: `${geometry.rw}px`,
                height: `${geometry.rh}px`,
                objectFit: 'cover',
                pointerEvents: 'none',
              },
            }),
            // 圆形遮罩只是提示最终长什么样，不参与裁切
            React.createElement('div', {
              style: {
                position: 'absolute',
                inset: 0,
                borderRadius: '50%',
                boxShadow: '0 0 0 9999px rgba(0,0,0,0.35)',
                pointerEvents: 'none',
              },
            }),
          ),
          React.createElement('input', {
            type: 'range',
            min: CROP_MIN_ZOOM,
            max: CROP_MAX_ZOOM,
            step: 0.01,
            value: crop.zoom,
            style: { width: '100%', marginTop: '12px' },
            onChange: (event) => props.onZoomTo(Number(event.target.value)),
          }),
          React.createElement(
            'div',
            { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '12px' } },
            React.createElement(
              'button',
              { type: 'button', style: btnStyle, disabled: busy, onClick: () => props.onCancel() },
              '取消',
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                style: { ...btnStyle, borderColor: C.brand, color: C.brand },
                disabled: busy,
                onClick: () => props.onConfirm({ ox, oy, rw: geometry.rw, rh: geometry.rh }),
              },
              busy ? '上传中…' : '确定',
            ),
          ),
        ),
      )
    }

    /**
     * 自检：把「这一层到底能不能工作」摆出来。
     *
     * 这插件有两处是借宿主 DOM 过日子的（壁纸引擎的头像节点、聊天行的
     * data-chat-flow-kind / data-chat-turn）——宿主一升级改名，它就会静默失效。
     * 与其等老师发现「头像怎么没了」，不如在设置页里直接报出来。
     * @returns {{flowRows: number, hasTurn: boolean, weOn: boolean, weNodes: number, mode: string}}
     */
    function diagnoseDom() {
      const out = { flowRows: 0, hasTurn: false, weOn: false, weNodes: 0, mode: layer.mode }
      try {
        const rows = document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')
        out.flowRows = rows.length
        out.hasTurn = rows.length > 0 && rows[0].hasAttribute('data-chat-turn')
      } catch (_error) {
        /* 拿不到就保持 0 */
      }
      try {
        out.weOn = Boolean(document.body && document.body.hasAttribute('data-we-avatar'))
        out.weNodes = document.querySelectorAll('[data-we-avatar-node="ai"]').length
      } catch (_error) {
        /* 同上 */
      }
      return out
    }

    /**
     * 把自检结果翻译成能看懂的话。纯函数：是否已启动由调用方给，方便测试。
     * @param {{flowRows: number, hasTurn: boolean, weOn: boolean, weNodes: number, mode: string}} diag
     * @param {boolean} layerActive - 头像层当前是否已启动
     */
    function diagnoseMessages(diag, layerActive) {
      const warnings = []
      if (diag.flowRows === 0) {
        warnings.push('找不到助手聊天行（data-chat-flow-kind="assistant-step"）——宿主可能改了属性名，头像会画不出来')
      } else if (!diag.hasTurn) {
        warnings.push('聊天行上没有 data-chat-turn——按回合贴头像会失效，会全部回落到默认人格')
      }
      if (diag.weOn && diag.weNodes === 0) {
        warnings.push('壁纸引擎的头像层开着，但没有 [data-we-avatar-node="ai"] 节点——可能还没渲染，或者它改了节点属性')
      }
      if (diag.flowRows > 0 && layerActive !== true) {
        warnings.push('头像层没启动（这个页面还没绑定会话）')
      }
      return warnings
    }

    const rowStyle = {
      display: 'flex',
      gap: '12px',
      alignItems: 'center',
      padding: '12px',
      borderRadius: '10px',
      border: `1px solid ${C.line}`,
      background: C.card,
      marginBottom: '10px',
    }
    const btnStyle = {
      font: 'inherit',
      fontSize: '12px',
      padding: '5px 10px',
      borderRadius: '8px',
      border: `1px solid ${C.line}`,
      background: 'transparent',
      color: C.text,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }
    const inputStyle = {
      font: 'inherit',
      fontSize: '13px',
      padding: '6px 9px',
      borderRadius: '8px',
      border: `1px solid ${C.line}`,
      background: 'transparent',
      color: C.text,
      width: '100%',
      boxSizing: 'border-box',
    }
    // 人格名输入框：外观要像标题而不是表单，所以去边框、加粗、随内容收窄
    const nameInputStyle = {
      font: 'inherit',
      fontSize: '14px',
      fontWeight: 600,
      padding: '2px 6px',
      margin: '-2px 0',
      borderRadius: '6px',
      border: '1px solid transparent',
      background: 'transparent',
      color: C.text,
      width: 'auto',
      minWidth: '80px',
      maxWidth: '220px',
      boxSizing: 'border-box',
    }
    const thumbStyle = (color) => ({
      width: '40px',
      height: '40px',
      borderRadius: '50%',
      flex: 'none',
      background: color || '#8AB4F8',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#fff',
      fontWeight: 600,
      overflow: 'hidden',
      fontSize: '16px',
    })

    function PersonaSection() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [note, setNote] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [confirmId, setConfirmId] = React.useState('')
      const [newId, setNewId] = React.useState('')
      const [newName, setNewName] = React.useState('')
      /** 裁切窗状态：null 表示没开；否则 {id, image, zoom, ox, oy} */
      const [crop, setCrop] = React.useState(null)
      /** 试运行判定（r13）：不真发消息，先看这句话会被切给谁 */
      const [probeText, setProbeText] = React.useState('')
      const [probe, setProbe] = React.useState(null)
      const [probeError, setProbeError] = React.useState('')
      const fileInput = React.useRef(null)
      const uploadFor = React.useRef('')

      // ⚠️ 顺序有讲究：load 必须定义在所有引用它的 useCallback **之前**，
      //    否则依赖数组求值时会撞上 TDZ（Cannot access 'load' before initialization），
      //    整页直接白屏——踩过一次。
      const load = React.useCallback(async () => {
        try {
          const query = layer.sessionId ? `?session=${encodeURIComponent(layer.sessionId)}` : ''
          const next = await apiJson(`/state${query}`)
          setData(next)
          setError('')
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        }
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      /** 试运行：把一句话交给 /probe，算出会切给谁、算不算同台，不落盘也不消耗对话。 */
      const runProbe = React.useCallback(async () => {
        const text = probeText.trim()
        if (text === '') {
          setProbe(null)
          setProbeError('先写一句话')
          return
        }
        try {
          const session = layer.sessionId ? `&session=${encodeURIComponent(layer.sessionId)}` : ''
          setProbe(await apiJson(`/probe?text=${encodeURIComponent(text)}${session}`))
          setProbeError('')
        } catch (e) {
          setProbeError(e instanceof Error ? e.message : String(e))
        }
      }, [probeText])

      /** 缩放时把方框中心那一点钉住，画面才不会乱跳。 */
      const zoomTo = React.useCallback((nextZoom) => {
        setCrop((prev) => {
          if (!prev) return prev
          const z = Math.min(CROP_MAX_ZOOM, Math.max(CROP_MIN_ZOOM, nextZoom))
          const before = cropGeometry(prev.image, prev.zoom)
          const after = cropGeometry(prev.image, z)
          const curX = clampOffset(prev.ox, before.minX)
          const curY = clampOffset(prev.oy, before.minY)
          const center = CROP_FRAME / 2
          const ix = (center - curX) / before.scale
          const iy = (center - curY) / before.scale
          return { ...prev, zoom: z, ox: center - ix * after.scale, oy: center - iy * after.scale }
        })
      }, [])

      const confirmCrop = React.useCallback(
        async (geometry) => {
          const current = crop
          if (!current) return
          setBusy(current.id)
          setNote('')
          try {
            const blob = await exportCropBlob(current.image, geometry)
            if (current.id === USER_AVATAR_KEY) {
              // 用户头像：走 /user-avatar，和人格头像共用同一套裁剪，但不碰任何人格目录
              await apiJson('/user-avatar', { method: 'POST', body: blob })
              setCrop(null)
              await load()
              setNote('用户头像已更新')
              return
            }
            await apiJson(`/avatar/${encodeURIComponent(current.id)}`, { method: 'POST', body: blob })
            setCrop(null)
            await load()
            setNote('头像已更新')
          } catch (e) {
            setNote(`失败：${e instanceof Error ? e.message : String(e)}`)
          } finally {
            setBusy('')
          }
        },
        [crop, load],
      )

      const act = React.useCallback(
        async (key, fn, okText) => {
          setBusy(key)
          setNote('')
          try {
            await fn()
            await load()
            setNote(okText || '已保存')
          } catch (e) {
            setNote(`失败：${e instanceof Error ? e.message : String(e)}`)
          } finally {
            setBusy('')
          }
        },
        [load],
      )

      if (error) {
        return React.createElement(
          'div',
          { style: { padding: '8px 0', color: C.danger, fontSize: '13px' } },
          `读不到人格清单：${error}`,
        )
      }
      if (!data) {
        return React.createElement('div', { style: { padding: '8px 0', color: C.faint, fontSize: '13px' } }, '读取中…')
      }

      const personas = Array.isArray(data.personas) ? data.personas : []
      const currentId = data.current ? data.current.id : ''
      const defaultId = data.defaultPersona || data.default || ''
      const diag = diagnoseDom()

      const children = []

      children.push(
        React.createElement(
          'div',
          { key: 'head', style: { marginBottom: '16px' } },
          React.createElement('div', { style: { fontSize: '15px', fontWeight: 600, color: C.text } }, '多人格切换'),
          React.createElement(
            'div',
            { style: { fontSize: '12px', color: C.dim, marginTop: '4px' } },
            '按称呼切人格、管头像。人格正文在 dsh-agent-md 的「人格」页。',
          ),
          React.createElement(
            'div',
            { style: { fontSize: '12px', color: C.dim, marginTop: '6px' } },
            layer.sessionId ? `本窗口当前：${currentId || '未知'}` : '打开一个会话后，这里会显示本窗口当前人格',
          ),
          React.createElement(
            'label',
            { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', marginTop: '10px', fontSize: '12px', color: C.dim, cursor: 'pointer' } },
            React.createElement('input', {
              type: 'checkbox',
              checked: data.enabled !== false,
              disabled: busy === 'config',
              onChange: (event) => act('config', () => apiJson('/config', { method: 'PUT', body: JSON.stringify({ enabled: event.target.checked }) }), event.target.checked ? '已开启' : '已关闭（退回 AGENT.md 兜底）'),
            }),
            '按称呼自动切人格',
          ),
        ),
      )

      // ---- 老师自己的头像：一个主人、一张图，清除即回到壁纸引擎那张 ----
      {
        const ua = data.userAvatar
        const userPreview = ua && ua.version ? `${API}/user-avatar?v=${ua.version}` : ''
        children.push(
          React.createElement(
            'div',
            {
              key: 'user-avatar',
              style: { padding: '12px', borderRadius: '10px', border: `1px solid ${C.line}`, background: C.card, marginBottom: '12px' },
            },
            React.createElement('div', { style: { fontSize: '13px', fontWeight: 600, color: C.text } }, '用户头像'),
            React.createElement(
              'div',
              { style: { fontSize: '11px', color: C.dim, marginTop: '2px' } },
              userPreview
                ? '用户消息那一侧显示这张图；按「清除」就退回壁纸引擎自己的头像'
                : '未设置：用户消息那一侧沿用壁纸引擎的头像',
            ),
            React.createElement(
              'div',
              { style: { display: 'flex', gap: '12px', alignItems: 'center', marginTop: '10px' } },
              React.createElement(
                'div',
                {
                  style: {
                    width: '40px',
                    height: '40px',
                    borderRadius: '50%',
                    overflow: 'hidden',
                    flex: 'none',
                    background: '#8AB4F8',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fff',
                    fontSize: '16px',
                  },
                },
                userPreview
                  ? React.createElement('img', {
                      src: userPreview,
                      alt: '',
                      style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
                    })
                  : '人',
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  style: btnStyle,
                  disabled: busy === USER_AVATAR_KEY,
                  onClick: () => {
                    uploadFor.current = USER_AVATAR_KEY
                    if (fileInput.current) fileInput.current.click()
                  },
                },
                userPreview ? '换一张' : '上传',
              ),
              userPreview
                ? React.createElement(
                    'button',
                    {
                      type: 'button',
                      style: btnStyle,
                      disabled: busy === USER_AVATAR_KEY,
                      onClick: () =>
                        act(USER_AVATAR_KEY, () => apiJson('/user-avatar', { method: 'DELETE' }), '用户头像已清除'),
                    },
                    '清除',
                  )
                : null,
            ),
          ),
        )
      }

      for (const persona of personas) {
        const isDefault = persona.id === defaultId
        const isCurrent = persona.id === currentId
        const isBusy = busy === persona.id
        children.push(
          React.createElement(
            'div',
            { key: persona.id, style: rowStyle },
            React.createElement(
              'div',
              { style: thumbStyle(persona.color) },
              persona.avatar
                ? React.createElement('img', {
                    src: `${API}/avatar/${encodeURIComponent(persona.id)}?v=${persona.avatarVersion}`,
                    alt: '',
                    style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
                  })
                : String(persona.name || persona.id).slice(0, 1),
            ),
            React.createElement(
              'div',
              { style: { flex: '1 1 auto', minWidth: 0 } },
              React.createElement(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
                React.createElement('input', {
                  key: `name-${persona.id}`,
                  style: nameInputStyle,
                  defaultValue: persona.name || persona.id,
                  placeholder: '人格名',
                  title: '直接改人格名，回车或点别处保存（系统提示词里的「当前人格」用的就是这个名字）',
                  onFocus: (event) => {
                    event.target.style.borderColor = C.line
                    event.target.style.background = C.card
                  },
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                    if (event.key === 'Escape') {
                      event.currentTarget.value = persona.name || persona.id
                      event.currentTarget.blur()
                    }
                  },
                  onBlur: (event) => {
                    event.target.style.borderColor = 'transparent'
                    event.target.style.background = 'transparent'
                    const next = String(event.target.value || '').trim()
                    const before = String(persona.name || persona.id || '').trim()
                    if (next === '' || next === before) {
                      event.target.value = before
                      return
                    }
                    act(
                      persona.id,
                      () => apiJson(`/persona/${encodeURIComponent(persona.id)}`, { method: 'PUT', body: JSON.stringify({ name: next }) }),
                      '人格名已保存',
                    )
                  },
                }),
                isDefault
                  ? React.createElement('span', { style: { fontSize: '11px', color: C.brand, border: `1px solid ${C.brand}`, borderRadius: '6px', padding: '1px 6px' } }, '默认')
                  : null,
                isCurrent
                  ? React.createElement('span', { style: { fontSize: '11px', color: C.dim, border: `1px solid ${C.line}`, borderRadius: '6px', padding: '1px 6px' } }, '本窗口')
                  : null,
                persona.enabled === false
                  ? React.createElement('span', { style: { fontSize: '11px', color: C.faint } }, '已停用')
                  : null,
              ),
              React.createElement(
                'div',
                { style: { fontSize: '11px', color: C.faint, marginTop: '2px' } },
                `目录 personas/${persona.id}`,
              ),
              React.createElement('input', {
                style: { ...inputStyle, marginTop: '8px' },
                defaultValue: (persona.aliases || []).join(', '),
                placeholder: '别名，用逗号分隔',
                onBlur: (event) => {
                  const raw = event.target.value
                  const aliases = raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
                  const before = (persona.aliases || []).join('|')
                  if (aliases.join('|') === before) return
                  act(
                    persona.id,
                    () => apiJson(`/persona/${encodeURIComponent(persona.id)}`, { method: 'PUT', body: JSON.stringify({ aliases }) }),
                    '别名已保存',
                  )
                },
              }),
            ),
            React.createElement(
              'div',
              { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: '260px' } },
              React.createElement(
                'button',
                {
                  type: 'button',
                  style: btnStyle,
                  disabled: isBusy,
                  onClick: () => {
                    uploadFor.current = persona.id
                    if (fileInput.current) fileInput.current.click()
                  },
                },
                '换头像',
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  style: btnStyle,
                  disabled: isBusy || isDefault,
                  onClick: () => act(persona.id, () => apiJson('/default', { method: 'PUT', body: JSON.stringify({ default: persona.id }) }), '默认人格已改'),
                },
                '设默认',
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  style: btnStyle,
                  disabled: isBusy,
                  onClick: () =>
                    act(
                      persona.id,
                      () =>
                        apiJson(`/persona/${encodeURIComponent(persona.id)}`, {
                          method: 'PUT',
                          body: JSON.stringify({ enabled: persona.enabled === false }),
                        }),
                      persona.enabled === false ? '已启用' : '已停用',
                    ),
                },
                persona.enabled === false ? '启用' : '停用',
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  style: { ...btnStyle, color: confirmId === persona.id ? '#fff' : C.danger, borderColor: C.danger, background: confirmId === persona.id ? C.danger : 'transparent' },
                  disabled: isBusy,
                  onClick: () => {
                    if (confirmId !== persona.id) {
                      setConfirmId(persona.id)
                      setNote(`再点一次就删除「${persona.name || persona.id}」——不可撤销`)
                      return
                    }
                    setConfirmId('')
                    act(persona.id, () => apiJson(`/persona/${encodeURIComponent(persona.id)}`, { method: 'DELETE' }), '已删除')
                  },
                },
                confirmId === persona.id ? '确认删除' : '删除',
              ),
            ),
          ),
        )
      }

      children.push(
        React.createElement(
          'div',
          { key: 'new', style: { marginTop: '14px', padding: '12px', borderRadius: '10px', border: `1px dashed ${C.line}` } },
          React.createElement('div', { style: { fontSize: '12px', color: C.dim, marginBottom: '8px' } }, '新建人格'),
          React.createElement(
            'div',
            { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            React.createElement('input', {
              style: { ...inputStyle, flex: '1 1 140px', width: 'auto' },
              placeholder: '目录名（英文小写，如 mio）',
              value: newId,
              onChange: (e) => setNewId(e.target.value),
            }),
            React.createElement('input', {
              style: { ...inputStyle, flex: '1 1 140px', width: 'auto' },
              placeholder: '显示名（如 弥央）',
              value: newName,
              onChange: (e) => setNewName(e.target.value),
            }),
            React.createElement(
              'button',
              {
                type: 'button',
                style: { ...btnStyle, borderColor: C.brand, color: C.brand },
                disabled: busy === 'new' || newId.trim() === '',
                onClick: () =>
                  act(
                    'new',
                    async () => {
                      await apiJson('/persona', { method: 'POST', body: JSON.stringify({ id: newId.trim(), name: newName.trim() }) })
                      setNewId('')
                      setNewName('')
                    },
                    '已新建，正文是占位稿，记得去改 prompt.md',
                  ),
              },
              '新建',
            ),
          ),
        ),
      )

      children.push(
        React.createElement('input', {
          key: 'file',
          ref: fileInput,
          type: 'file',
          accept: 'image/png,image/jpeg,image/webp',
          style: { display: 'none' },
          onChange: async (event) => {
            const file = event.target.files && event.target.files[0]
            const id = uploadFor.current
            event.target.value = ''
            if (!file || !id) return
            setNote('')
            try {
              const image = await loadImageFile(file)
              const geometry = cropGeometry(image, 1)
              // 初始：盖满方框并居中
              setCrop({
                id,
                image,
                zoom: 1,
                ox: (CROP_FRAME - geometry.rw) / 2,
                oy: (CROP_FRAME - geometry.rh) / 2,
              })
            } catch (e) {
              setNote(`失败：${e instanceof Error ? e.message : String(e)}`)
            }
          },
        }),
      )

      if (crop) {
        children.push(
          React.createElement(CropDialog, {
            key: 'crop-dialog',
            crop,
            busy: busy === crop.id,
            onPan: (ox, oy) => setCrop((prev) => (prev ? { ...prev, ox, oy } : prev)),
            onZoom: (direction) => zoomTo(crop.zoom * (direction > 0 ? 1.08 : 1 / 1.08)),
            onZoomTo: zoomTo,
            onCancel: () => setCrop(null),
            onConfirm: confirmCrop,
          }),
        )
      }

      if (note) {
        children.push(
          React.createElement('div', { key: 'note', style: { marginTop: '10px', fontSize: '12px', color: note.startsWith('失败') ? C.danger : C.dim } }, note),
        )
      }

      children.push(
        React.createElement(
          'div',
          { key: 'probe', style: { marginTop: '14px', padding: '10px 12px', borderRadius: '10px', border: `1px solid ${C.line}` } },
          React.createElement('div', { style: { fontSize: '11px', color: C.dim, marginBottom: '6px' } }, '试运行判定（不真发消息）'),
          React.createElement(
            'div',
            { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            React.createElement('input', {
              value: probeText,
              placeholder: '比如：诺亚、优香，你们在吗',
              onChange: (event) => setProbeText(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') runProbe()
              },
              style: { flex: '1', padding: '6px 8px', borderRadius: '8px', border: `1px solid ${C.line}`, background: 'transparent', color: C.text, fontSize: '13px' },
            }),
            React.createElement(
              'button',
              { type: 'button', onClick: runProbe, style: { padding: '6px 12px', borderRadius: '8px', border: `1px solid ${C.line}`, background: 'transparent', color: C.text, cursor: 'pointer', fontSize: '12px' } },
              '试算',
            ),
          ),
          probeError ? React.createElement('div', { style: { marginTop: '6px', fontSize: '11px', color: C.danger } }, `失败：${probeError}`) : null,
          probe
            ? React.createElement(
                'div',
                { style: { marginTop: '6px', fontSize: '11px', color: C.faint, lineHeight: 1.7 } },
                probe.multi
                  ? `同台：${(probe.speakers || []).join(' → ')}（${probe.leadName || probe.lead} 先开口）`
                  : `单人：${probe.leadName || probe.lead || '（不注入）'}`,
                probe.hits && probe.hits.length > 0 ? ` · 命中 ${probe.hits.map((hit) => `${hit.alias}→${hit.id}`).join('、')}` : ' · 没命中称呼',
                probe.lore && probe.lore.length > 0 ? ` · 世界书 ${probe.lore.join('、')}` : '',
              )
            : null,
        ),
      )

      children.push(
        React.createElement(
          'div',
          { key: 'diag', style: { marginTop: '14px', padding: '10px 12px', borderRadius: '10px', border: `1px solid ${C.line}` } },
          React.createElement(
            'div',
            { style: { fontSize: '11px', color: C.dim, marginBottom: '4px' } },
            '自检',
          ),
          React.createElement(
            'div',
            { style: { fontSize: '11px', color: C.faint, lineHeight: 1.7 } },
            `助手行 ${diag.flowRows} 条 · 回合号 ${diag.hasTurn ? '有' : '无'} · 壁纸头像层 ${diag.weOn ? '开' : '关'}（节点 ${diag.weNodes}） · 本层 ${diag.mode}`,
          ),
          ...diagnoseMessages(diag, layer.active).map((text, index) =>
            React.createElement(
              'div',
              { key: `warn-${index}`, style: { fontSize: '11px', color: C.danger, lineHeight: 1.7, marginTop: '2px' } },
              `⚠ ${text}`,
            ),
          ),
        ),
      )

      children.push(
        React.createElement(
          'div',
          { key: 'foot', style: { marginTop: '14px', fontSize: '11px', color: C.faint, lineHeight: 1.6 } },
          '人格正文（prompt.md）不在这里编辑——那是 dsh-agent-md 的「人格」页负责的事。',
          React.createElement('br'),
          `数据目录：${data.personaRoot || '~/.dsh/personas'}`,
        ),
      )

      return React.createElement('div', { style: { maxWidth: '720px' } }, ...children)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'persona-router-runtime', order: 900 },
            Runtime,
          ),
        )
        // 设置 → 「人格路由」页：根作用域的 settings.section。
        // ⚠️ 两处都踩过：① 标题**不能**叫「人格」——dsh-agent-md 已经占了那个名字（它管 AGENT.md 正文），
        //    同名条目会让人找不到；② 位置放在它旁边（order 47，紧跟 agent-md 的 46），
        //    排到最后谁也不会往下翻。
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'persona-router', order: 47, label: '多人格切换' }, PersonaSection),
        )
      },
      // 供 test/*.mjs 验证（裁切几何 + 组件能否安全渲染）。运行时不会被读到。
      testing: { cropGeometry, clampOffset, CROP_FRAME, CROP_OUT, PersonaSection, CropDialog, diagnoseDom, diagnoseMessages },
    }
  },
})
