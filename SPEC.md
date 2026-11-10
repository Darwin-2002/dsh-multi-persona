# 人格路由插件 · 设计文档

日期：2026-11-07
上一版研究记录见同目录 `DESIGN.md`（含逐条源码出处）。本文是施工依据。

---

## 一、意图

让一个 DSH 窗口里可以有多个角色人格，按称呼切换；人格可由使用者自行增减，每个人格独立（正文 + 头像），并且能装到别人电脑上用。

为什么值得做：dsh-agent-md 只能按**工作目录**分层，一个目录一套人格，做不到窗口内按话切换。

## 二、目标 / 非目标

**目标**

1. 同一窗口内，说「普拉娜，……」即切到普拉娜；不说话里的人名则沿用上一个。
2. 人格 = 一个文件夹。增删人格不需要改代码。
3. 每个人格有自己的头像，切换时即时换脸。
4. 只在当前窗口生效，不影响其他窗口。
5. 可打包分发，别人装上就能加自己的人格。

**非目标（第一版不做）**

- 不改聊天渲染器，不注册 `conversation.chat.node`（那会替换官方渲染器）。
- 不做人格级私有记忆 / 笔记（留到第二版）。
- 不做人格市场、审核、在线分发。
- 不做过渡动画。

## 三、已验证的宿主事实（施工前提，勿再猜）

| 事实 | 出处 |
| --- | --- |
| 每一步先 `assemble()` 再跑 `agent/pre-step`，钩子返回值只能改 messages，**改不了本轮 system prompt** | `dsh-agent-loop/lib/index.js:907` 与 `:909` |
| 提示词段/上下文支持「每次装配求值」的回调，回调收到 `{agent, scope, signal}`，`agent.session.header.cwd` 可读 | `dsh-agent-md/lib/index.js:361-379`（`order: 260`） |
| 系统提示词有人设专用槽位 `deployment:persona-prefix`(order 0) / `deployment:persona-suffix`(10200) | `dsh-system-prompt` README |
| `renderPrompt` 遇未知 `{{变量}}` 会抛错并让整次请求失败 | 同上 |
| 聊天行有 `data-chat-flow-kind`、`data-chat-turn`、`data-turn-process-hidden`；无头像插槽 | `dsh-client-ui-chat/lib/client.js:3810-3813` |
| 设置页真插槽：`ctx.slots.inject("settings.section", …)` | `dsh-plugin-wallpaper-engine/lib/client.js` |
| 壁纸引擎头像层是纯 DOM 装饰，节点带 `data-we-avatar-node`，内部 `img.we-avatar__img`；其开关状态在客户端内存 store | 同上 |

## 四、数据模型

```
~/.dsh/personas/
  noa/
    persona.json     # { id, name, aliases: [], color, order, enabled }
    prompt.md        # 人格正文（纯 Markdown）
    avatar.png       # 可缺省
  arona/ …
  plana/ …
```

- 插件启动时扫描该目录；新增人格 = 新建文件夹，重启或热重载后可见。
- `persona.json` 里的 `aliases` 决定怎么被叫出来。
- 正文与头像都是纯数据，插件代码里不出现任何具体角色名。
- 现有 `~/.dsh/agents/personas/{arona,plana}.md` 平移进来；诺亚的正文需从 `AGENT.md` 中拆出（当前是唯一副本）。

状态文件：`~/.dsh/persona-router/state.json`，形如 `{ "sessions": { "<sessionId>": "<personaId>" }, "default": "noa" }`。

## 五、切换机制

**判定**（`agent/pre-step`，能读到本轮 `messages`）

- 最后一条用户消息里，某个别名的**独立词**出现且处于称呼位（句首、逗号前、或句尾）→ 切到该人格。
- 未出现任何别名 → 沿用该会话上一次的人格；从未切换过 → `default`。
- 切换结果写进 `state.json`。

**生效**（两层）

1. **当即**：pre-step 直接向本轮 messages 追加一条 `【当前人格：普拉娜】`（一句话，不重复正文），保证这次的回复就是新人格。
2. **稳态**：系统提示层注册

   ```js
   ctx.systemPrompt.context({
     name: 'persona-router:persona',
     order: 250,
     text: (context) => personaBlockFor(context?.agent?.session),
   })
   ```

   `personaBlockFor` 按 session 查 `state.json`，返回该人格的**正文全文** + 一行身份声明。因为 text 是函数，每次装配都会重新求值，切换后自动生效。`order: 250` 紧挨 agent-md 的 260 之前。

**为什么不是只靠第 2 层**：装配发生在 pre-step 之前，若只靠系统提示层，新消息这一步用的是旧人格，要等下一步才换。第 1 层补的就是这一下。

## 六、头像

**规矩：同一时刻只允许一份头像。**

- 检测到壁纸引擎的头像节点、且它开着头像 → **只改写**其 `img.we-avatar__img` 的 `src` 为 `/persona-router/avatar/<id>?v=<mtime>`，布局交给它。
- 否则 → 自绘一层：观察 `[data-chat-flow-kind="assistant-step"]`，按「回合首条可见行 + 之后每 N 条」贴节点，位置与圆角沿用配置里的默认值。
- 绝不能两条同时画。
- 宿主路由：`GET /persona-router/avatar/<id>`（长缓存，`?v=` 变名即刷新）、`POST`（导入，MIME 白名单 jpg/png/webp，8MB 上限，`.tmp` + rename 原子落盘）、`DELETE`。

自绘层依赖聊天 DOM 属性，是最容易随 DSH 升级失效的一层；因此它必须**失败可降级**——装饰不上就不贴，绝不能影响消息渲染。

## 七、与 dsh-agent-md 共存

agent-md 目前把 `~/.dsh/AGENT.md` 注入所有窗口。做法：

1. `AGENT.md` 改成**中性底座**：保留协作与安全规则，删掉诺亚的角色正文（正文移入 `personas/noa/`）。
2. 底座末尾留一条兜底：「若上下文中存在『当前人格』块，完全按它演，忽略本节；若没有，你是诺亚……」——这样插件失效时退回的是诺亚，不是空壳。
3. 备份：`~/.dsh/agents/backups/AGENT-<时间戳>.md`（已存在 `AGENT-2026-11-07-2135.md`，6118 B，SHA256 `DB2224FC…BE7`）。

不改 agent-md 的代码，只改它读的那份文件。回退 = 把备份拷回。

## 八、界面

第一版**不做配置界面**：增删人格靠文件夹，开关靠 `persona.json`。

第二版加 `settings.section` 面板（`id: "persona-router"`、`order: 600`）：人格清单、别名编辑、头像上传、默认人格、当前会话人格只读显示。

理由：面板是唯一需要单独构建、且会随宿主升级重做的一块，放在能跑之后再补。

## 九、分发

- 插件目录：`~/.dsh/plugins/dsh-persona-router/`（`package.json` 带 `dsh.bundle.patch` 与 `dsh.client`）。
- 安装途径：DSH 插件管理「安装本地插件」/ bundle 补丁。
- 文档须写明：需要 `webServer` 注入（头像路由）、客户端需 `@deepseek-ai/dsh-client-runtime`。
- 随包带一份示例子人格（一个中性示例），不预置任何商用作品角色。

## 十、失败模式

| 情形 | 应有行为 |
| --- | --- |
| `personas/` 不存在或为空 | 不发任何人格块，退回 AGENT.md 底座（即诺亚兜底） |
| 人格目录缺 `prompt.md` | 跳过该人格并记一条告警，不影响启动 |
| 人格正文含 `{{…}}` | 注册时设 `interpolate: false`，原样保留（否则整次请求抛错） |
| 头像文件损坏 | 路由返回 404，客户端回退到默认图 |
| 壁纸引擎未装 | 自绘层接管 |
| 插件整体加载失败 | 底座兜底为诺亚；无需手动恢复 |

## 十一、验收标准

1. 新建两个会话，同一句话分别叫不同名字，两个窗口各演各的，互不串。
2. 一个会话里先叫普拉娜、再叫阿罗娜，第二次的回复立即换人（不等下一条）。
3. 往 `personas/` 里新建一个文件夹，重启后能被叫出来，且代码零改动。
4. 切换时头像跟着换；关掉壁纸引擎后头像仍出现（自绘接管）。
5. 把插件目录删掉，重开会话，开口仍是诺亚（兜底成立）。
6. 人格正文里写 `{{cwd}}` 之类不抛错。

## 十二、我拿的主意（请老师过目时一并看）

- 状态按 session 存，不按工作目录存 —— 因为需求是「窗口内切换」。
- 用 `context()` 而非 `section()` —— 与 agent-md 同一写法，行为已被它验证过。
- `order: 250` 紧贴 agent-md 的 260 —— 减少与第一方段的排位纠纷。
- 第一版不做面板 —— 面板不构成「能不能用」的门槛。
- 头像自绘层允许失败 —— 宁可没头像，也不能干扰消息渲染。

## 十三、待补

- `agent.session` 上读取「本轮最后一条用户消息」的确切 API —— 若 pre-step 已能拿到 `messages`，此点不阻塞。
- 自绘头像的定位方式（绝对定位 overlay 还是插入行内 flex）—— 施工时按实际 DOM 定，两者都不碰渲染器。
- 打包后 `dsh.bundle.patch` 的具体字段 —— 施工时照 wallpaper-engine 的 `package.json` 抄。

## 十四、施工记录（2026-11-07 晚，实测）

三条待补都有答案了：`agent.session.id` 可读（`dsh-session/lib/index.js:1344`），pre-step 的 `payload.messages` 里正文在 `content[].text`；自绘层用绝对定位（行原本是 static 就补 `position:relative`，卸载时摘掉）；`dsh.client.platform/immediately/inject` 照 decoration 模板写，`inject: []` 就够（只用浏览器模块表里的 `react` 和 `slots`）。

三处与原文不同，都是实测逼出来的：

1. **第五节的第 1 层没做。** 原文理由是「装配发生在 pre-step 之前」。但 `agent-loop/lib/index.js:1053` 在 pre-step **之后**还对上下文做了一次 `refreshContext(assembleContextFor(...))`，会重新求值每个 context 的 `text` 回调；`renderContextSections` 用的正是这一份。所以 context 层本身就同回合生效，第 1 层多余，且往会话历史里塞假消息。验收 2 已实测通过。
2. **状态写入改为串行化**（`mutateState`）。原方案是直接读-改-写；两个会话同时 pre-step 时，实测把 `state.default` 覆盖成了空串。现在同一 Promise 链串行，顺带在首次写入时补 `default`。
3. **装法走插件管理器的 `install_bundle`**，源码留在 `default-workspace/persona-router/plugin/`，profile 以 link 指向它；没有手工建 `~/.dsh/plugins/dsh-persona-router/`，也不手写 profile 的 `package.json` / `cordis.patch.yml`（那是安装器的活）。要分发给别人，复制 `plugin/` 目录即可。

一条操作经验，以后会反复用到：**宿主半改完不会热重载**（`GET /persona-router/health` 的 `codeVersion` 可验），要用 `plugin_manager` 把该行关一次再开一次，才会重新取模块。

## 十五、施工当晚的六次故障与各自的护栏

记在这里，是因为它们几乎都不是「想法错了」，而是**我改完就宣布好了**——把验证推给了使用者。现在每一类都有对应的自动护栏。

| # | 故障 | 症状 | 根因 | 护栏 |
| --- | --- | --- | --- | --- |
| 1 | 头像只换了一个 | 切换后新消息仍是旧脸 | `querySelector` 只取第一个节点，而壁纸引擎给每条助手行各插一个 | 遍历 `querySelectorAll`；`panel`/`routes` 覆盖不到的部分靠 `client-report` 的 `their=` 计数验 |
| 2 | 默认人格被抹成空串 | 历史头像错乱 | 两个会话并发 pre-step，读-改-写互相覆盖 | `mutateState` 串行化；`unit` 有状态隔离用例 |
| 3 | 整个插件消失 | 设置页没入口、注入没人格块 | `Set-Content -Encoding UTF8` 给 `package.json` 加了 BOM，`JSON.parse` 抛错后整个 bundle 被静默丢弃 | `unit` 里四条「无 BOM」+「package.json 可解析」+「patch 声明本包」 |
| 4 | 设置页找不到 | 列表里没有「人格路由」 | 与 `dsh-agent-md` 的页同叫「人格」，且排在最后 | `panel` 断言标题必须是「人格路由」；order 改 47 紧跟它 |
| 5 | 面板读不到别名/启用状态 | 别名框空白、停用按钮失灵 | `publicView` 漏了 `aliases` / `enabled` 两个字段 | `routes` 断言 `/state` 返回的字段齐全 |
| 6 | 面板整页空白 | 点开没有任何内容 | `useCallback` 的依赖数组引用了声明在后面的 `load`，渲染期撞 TDZ，整棵组件被卸掉 | `panel` 用最小 React 替身真的把组件跑一遍（`useCallback` 立即求值依赖）；并用改坏的副本反证测试有效 |

两条从中总结的规矩：

1. **改完不算完，能复现的验证才算。** 六次里有五次只要有一条测试就能当场拦住。
2. **借宿主 DOM 过日子的地方必须有自检。** 头像层两处依赖（壁纸引擎的 `[data-we-avatar-node]`、聊天行的 `data-chat-flow-kind` / `data-chat-turn`）一旦被宿主改名就会静默失效，所以设置页现在直接显示「助手行 N 条 · 回合号 有/无 · 壁纸头像层 开/关（节点 M） · 本层 模式」，并在异常时给出人话警告。

## 十六、实测收尾（2026-11-08）

六条验收全部通过。补三条今天才发现的规则与事实：

1. **称呼判定的两个补丁**（r6-no-copula）：① 别名紧挨「是 / 为」不算称呼——「头像是优香，是怎么回事」这种判断句曾被误判成在叫她；② 长别名优先，短别名套在长别名里不重复计数（「早濑优香」里的「优香」曾绕过第一条）。**已知局限**：引号里的名字仍会误切，那是引用不是称呼，规则分不出来——不再往下收。
2. **没有头像的人格必须给占位图，不能「不动」**——不动就等于回退到壁纸引擎自己的头像，于是出现「人格是爱丽丝、脸是优香」的错配。现在用 canvas 现画本色底加首字。
3. **自绘层已实测**：壁纸引擎关闭时客户端上报 mode=self / own=19 / their=0；寄生模式则是 mode=parasitic / their=118 / own=0。两层从未同时出现。

另记一条删除行为：删掉一个人格后，history 里指向它的回合**不改写**，客户端查不到就回落到 default（现在是诺亚）。所以删人格之后，属于她的几轮历史会显示默认人格的头像——这是设计，不是故障。