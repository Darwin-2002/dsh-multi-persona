# 人格路由插件（dsh-persona-router）设计记录

记录时间：2026-11-07
状态：思路定稿，尚未开工

---

## 一、要解决的问题

在同一个会话窗口里，按称呼切换人格。说「你好，诺亚，帮我整理文献」进诺亚，说「普拉娜，帮我整理 C 盘」进普拉娜。切换时头像一起换。

区别于 DSH 现有机制：dsh-agent-md 只能按**工作目录**分层，一个窗口一套人格，做不到窗口内按话切换。

---

## 二、已验证的事实（都读过源码）

| 事实 | 位置 |
| --- | --- |
| agent-md 的 `composePersona` 把全局块与项目块**拼接**注入，项目块只带「优先于全局人格」标题，不替换 | `dsh-agent-md/lib/persona.js:504-553` |
| 人格块在 `assemble()` 里产生，位置早于 `agent/pre-step` 瀑布 | `dsh-agent-loop/lib/index.js:907`（assemble）与 `909`（waterfall） |
| `agent/pre-step` 能拿到本轮 `messages`，是**唯一**看得到用户这句话的注入前时机 | 同上 |
| 客户端设置页是真的插槽接口：`ctx.slots.inject("settings.section", () => ctx.slots.register({name, id, order, label}, () => React.createElement(...)))` | `dsh-plugin-wallpaper-engine/lib/client.js:31153-31159` |
| 聊天消息行带 `data-chat-flow-kind`（`user` / `steering` / `assistant-step`）、`data-chat-turn`、`data-turn-process-hidden` | `dsh-client-ui-chat/lib/client.js:3810-3813`（当前安装版本实测存在） |
| 聊天界面**没有**头像插槽，头像靠纯 DOM 装饰补；注册 `conversation.chat.node` 同名 key 是**替换**官方渲染器（禁止） | `wallpaper-engine/lib/client.js:12793-12848` |

由此得出的两条硬约束：

1. 因为人格块在 `assemble` 阶段就产生了，路由器**必须让 agent-md 让路**，否则两套人格叠在一起。
2. 头像只能装饰 DOM，不能插槽。

---

## 三、切换机制

### 配置文件 `~/.dsh/persona-router.json`

```json
{
  "enabled": true,
  "defaultPersona": "noa",
  "takeOver": true,
  "personas": {
    "noa":  { "name": "诺亚", "aliases": ["诺亚", "生盐", "Noa"], "file": "noa.md", "avatar": "" },
    "plana":{ "name": "普拉娜", "aliases": ["普拉娜", "Plana"], "file": "plana.md", "avatar": "" },
    "arona":{ "name": "阿罗娜", "aliases": ["阿罗娜", "Arona"], "file": "arona.md", "avatar": "" }
  }
}
```

人格正文放 `~/.dsh/agents/personas/<file>`（目录已存在，现有 arona.md / plana.md 可复用）。头像图放 `~/.dsh/persona-router/avatars/`。

### 触发规则

- 本轮最后一条用户消息里，别名以**独立词**出现（首选句首或称呼位，如「诺亚，…」「…诺亚」），即切到该人格
- 本轮没有出现任何别名 → 沿用上一轮的人格
- 会话开场第一条没有别名 → 用 `defaultPersona`
- 切换**下一轮**才生效（本轮的 system prompt 已组装完毕，改不动）
- 每轮都要**重申**当前人格：历史里旧人格的对话还在，不重申会被带偏

### 与 agent-md 的共存

路由器接管 systemPrompt 注入，并通过写 `~/.dsh/agent-md.json` 的 `enabled: false` 让 agent-md 让路。这是**改写用户现有配置**，所以：

- 面板上做成显式开关 `takeOver`，默认开，但改之前把原文件备份成 `agent-md.json.bak-persona-router`
- 关掉 `takeOver` 就恢复原值
- 注意 agent-md 是全局层，关掉会影响**所有窗口**

---

## 四、头像

### 三档做法

| 档 | 做法 | 成本 | 评价 |
| --- | --- | --- | --- |
| 轻 | 只换名字与配色 | 略 | 不算换头像 |
| 中（选定） | 按人格给助手侧消息贴不同图 | 4–8 万 token | 即时生效，保留现有布局 |
| 重 | 每条消息都带头像 + 过渡动效 | 再 +3 万 | 收益不抵维护成本 |

### 为什么不能直接改壁纸引擎的设置

壁纸引擎的 `avatarAiImage` 确实就是「助手头像文件名」，宿主侧 `PUT /wallpaper-engine/settings/mascot` 也能改。但它的 `selection` 是**客户端自己的内存 store**，外部 PUT 只会改 `config.json`，已打开的页面不会即时换脸，得刷新。

所以「借它的设置实现切换」这条路只到「刷新后生效」，不满足即时切换。

### 选定方案：寄生改写

壁纸引擎的头像层是纯 DOM 装饰，节点带 `data-we-avatar-node`，里面是 `img.we-avatar__img`。它开着的时候：

- 我们**不画新节点**，只把已有节点的 `img.src` 换成 `/persona-router/avatar/<id>?v=<文件名>`
- 保留它的左右分列、大小、圆角设置
- 切换人格 → 改 src → 立即换脸

它关着的时候，退化为自绘一层：观察 `[data-chat-flow-kind]`，照它的频率规则（回合首条可见行 + 之后每 N 条可见行再露一次）贴节点。

两条路都不碰渲染器，只做装饰。

### 图片规格

≤1024×1024、≤4MiB 导入（客户端先缩），宿主侧 8MB 上限；`POST /persona-router/avatar/<id>` 收原始字节，MIME 白名单 jpg/png/webp，`.tmp` + rename 原子落盘，文件名带时间戳（换图即换名，好做长缓存）。

---

## 五、插件结构

```
~/.dsh/plugins/dsh-persona-router/
  package.json          # dsh.bundle.patch + dsh.client{platform:"web", inject:["@deepseek-ai/dsh-client-runtime"]}
  cordis.patch.yml
  lib/index.js          # 宿主半：agent/pre-step 钩子、路由、配置读写
  lib/routes/avatar.js  # 头像族：POST / GET / DELETE
  lib/routes/state.js   # 状态族：GET 当前人格 / PUT 配置
  lib/client.js         # 客户端半：settings.section 面板 + 头像装饰层
```

### 宿主侧

- `export const inject = ['webServer']`（有头像路由就得有 web）
- `agent/pre-step` 里读 messages → 判定人格 → 记录到会话状态 → 写 systemPrompt
- 注入文本 = 人格正文 + 一行「本轮身份：<name>」+ 人格自己的笔记（可选，第一版先不做）

### 面板（`settings.section` 插槽，`id: "persona-router"`, `order: 600`）

- 人格清单：增 / 删 / 改名 / 别名 / 绑正文文件 / 传头像
- 默认人格
- 总开关、接管 agent-md 开关
- 当前人格的只读显示
- 每人人格一本笔记（第二版）

---

## 六、成本估算

| 部分 | token |
| --- | --- |
| 服务端（钩子、配置、切换、状态路由） | 20–30 万 |
| 设置面板 | 10–15 万 |
| 头像（寄生改写） | 4–8 万 |
| 合计 | **35–55 万** |

折合人民币约 5–10 元。若头像走自绘那一层，再加 2–4 万 token。

（计费明细读不到，只能按 token 量估，误差可能翻倍。）

---

## 七、未决问题

1. 头像走「寄生改写」还是「干脆请壁纸引擎关掉头像、由我们一套负责」
2. `takeOver` 改变 agent-md 全局开关，是否接受这个副作用
3. 别名出现在正文中间（不是称呼位）时算不算触发 —— 倾向不算，避免误切
4. 人格级笔记（每人一套记忆）是否纳入第一版 —— 倾向放到第二版

---

## 八、回退

删掉 `~/.dsh/plugins/dsh-persona-router/` 即可。不改 `AGENT.md`、不改 agent-md 的代码；唯一碰过的外部状态是 `agent-md.json`，有 `.bak` 备份且在面板上可一键恢复。
