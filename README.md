# dsh-multi-persona（曾用名 dsh-persona-router）

同一个 DSH 窗口里，按**称呼**切换人格，也可以让几位同台接话；每个人格自带正文与头像；人格是文件夹，增减不改代码。

> **关于两个名字**：2026-11-10 起包名是 `dsh-multi-persona`，面板标题是「多人格切换」。
> 内部的**路由前缀 `/persona-router`、数据目录 `<DSH_HOME>/persona-router/`、上下文段名 `persona-router:*`**
> 仍然是旧名 —— 那些改了要迁移状态文件，为了一致性去动它不划算。看到它们时知道是同一件东西就好。

```text
「普拉娜，帮我看看这段 C 盘日志」   → 这一句起换成普拉娜
「阿罗娜，刚才那个再说一遍」         → 这一句起换成阿罗娜
「那这份文献呢」                     → 沿用上一个（不会乱切）
```

---

## 它怎么工作

| 环节 | 做法 |
| --- | --- |
| 判定 | `agent/pre-step` 读本轮最后一条用户消息，找**称呼位**上的别名 |
| 记账 | `<DSH_HOME>/persona-router/state.json`，按 **session** 分开记 |
| 注入 | `ctx.systemPrompt.context()`，`order: 250`，`interpolate: false`，每次装配重新求值 |
| 头像 | 壁纸引擎开着就寄生改写它的头像节点；关着就自绘一层；同一时刻只有一份 |
| 底座 | `~/.dsh/AGENT.md` 写成中性协作规则 + 「兜底人格」一节，插件失效时退回兜底那位 |

判定规则（刻意保守，避免误切）：

- 别名必须**贴着一个边界**：句首、逗号/冒号/句号/空白之前或之后都算
- 别名后面紧跟称呼尾词也放行——`在不在` / `在吗` / `在么` / `在哪` / `呢` / `呀`
  （所以「再测试一下看普拉娜在不在」也算在叫她）
- 除此之外，正文中间顺带提到的名字**不算**（「帮我问一下诺亚这件事」不会切）
- 一句话里叫了两个名字 ⇒ 取**最后**那个当主答，同时**同台**（见下一节）
- 本轮没叫任何名字 ⇒ 沿用这个会话上一次的人格；从未切换过 ⇒ 按三档阶梯解析（见下一节）

---

## 多角色同台（点名）

一轮里点了**好几位**（≥2），就让他们**共用同一段记忆、依次接话**：

```text
「诺亚、优香，这个预算你们看」
  → 【诺亚】先回应老师
  → 【优香】接着她的话说：同意 / 不同意 / 补一句她漏掉的
```

判定规则和单人完全一样（只认称呼位，不做模糊匹配），所以：

- 句中被顺带提到的名字不进场：「普拉娜，跟阿罗娜说一声」只算普拉娜
- 判断句里的名字不进场：「头像是优香，是怎么回事」
- 同一位被叫两遍只算一位

**先开口 = 消息里第一个被叫到的名字**，其余按点名顺序接话。
每段以「【名字】」起头；后的人要指明在回应前一位的哪一句，不许只顺着夸。
两人正文都进提示词（一位标「先开口」、其余标「接话」），所以这一轮提示词会变长。

### 声线硬约束（防串味）

人格目录的 `persona.json` 可以写一个可选的 `voice` 数组（每条一句话，最多 6 条）：

```json
{ "voice": ["几乎不用感叹号（约 5%）", "句尾常以「……呢」收住"] }
```

同台时这些条目会挂在该人格正文后面，标成「硬约束（说话前先对一遍）」。
**开头怎么写不设禁区**——宣布式、观察式、反问式都可以，要求的是用词、句长、标点像本人。
提示词里还会明写一句：没被点名的人格一律不出场，也不许借她的口癖。

代价：仍然只有**一次调用**——接话是同一个模型分角色演出来的，不是真的两个 AI。
好处：token 只多一份正文（约 ×1.1），延迟不变。

同台之后**默认由「先开口」那位接棒**：下一轮不点名，就继续跟她聊（`pinLeadOnMulti`，默认 `true`）。想回到「同台只演一轮」的老行为，把它设成 `false`。
想关掉：`config.json` 写 `"multiRole": false`，就退回「取最后一位」的老规矩。

> 排障不用真发消息：`GET /probe?text=<URL 编码的一句话>&session=<id>` 会算出
> 命中谁、算不算同台、谁先开口、会带哪几条世界书——只算不落盘。

> 头像限制：历史消息一轮只记一位（`persona`），同台轮次贴的是**先开口**那位。
> 同一个 turn 只留一条记录（原位覆盖；读盘时还会按 turn 去重、只留最早那条），
> 否则客户端按 Map 取到后一条，头像就会贴错人。

---

## 生效范围：会话 → 工作区 → 全局（三档）

阶梯，越细越优先：

```text
会话档（叫名字 / 手动钉住） → 工作区档（按 cwd） → default（全局） → 列表第一个可用
```

| 档 | 存哪 | 怎么钉 |
| --- | --- | --- |
| 会话 | `state.json` 的 `sessions[sessionId]` | 叫一声名字就自动钉住；也可以 `PUT /session` |
| 工作区 | `state.json` 的 `workspaces[归一化 cwd]` | `PUT /workspace` 指定某个目录用谁 |
| 全局 | `state.json` 的 `default` | 面板「设为默认」 |

三个约定：

- **叫名字永远第一优先**——判定逻辑一行没动，命中就直接写进会话档，压过另外两档。
- **`@none` 是终止符**：会话档或工作区档记成 `@none`，表示「这一档谁都别注入」，
  就地停下，不再往下一层回落。「没选过」与「选了不要」是两件事。
- **不把阶梯结果写回会话档**：否则就成了永久钉住，工作区档后来再改也追不上。
  会话档只记「明确钉过的」，其余每轮现算。

cwd 取 `agent.session.header.cwd`，归一化成小写正斜杠（`E:\A\` 与 `e:/a` 是同一个工作区）。
拿不到 cwd 时工作区档自然不生效，其余两档照旧——不会因此变成空壳。

---

## 人格 = 一个文件夹

```text
<DSH_HOME>/personas/
  <id>/
    persona.json     # 必填
    prompt.md        # 必填，人格正文（纯 Markdown）
    avatar.png       # 可选，也可以是 avatar.jpg / avatar.webp
```

`persona.json`：

```json
{
  "id": "sample",
  "name": "示例",
  "aliases": ["示例", "Sample"],
  "color": "#8AB4F8",
  "order": 900,
  "enabled": true
}
```

| 字段 | 作用 |
| --- | --- |
| `id` | 目录名，也是状态里的键 |
| `name` | 注入块里显示的名字 |
| `aliases` | 叫它什么会切过去（自动并入 `name` 和 `id`，不必重复写） |
| `color` | 没头像时自绘那颗圆点的底色 |
| `order` | 列表排序，小数也行 |
| `enabled` | `false` 就是停用，不用删目录 |
| `suffix` | 可选。跟正文末尾一起注入的收尾指令（相当于角色卡的 `post_history_instructions`） |
| `voice` | 可选。同台时挂在该人格后面的「声线硬约束」条目数组（每条一句话、最多 6 条） |

**增一个人格** = 复制 `examples/sample/` 改个目录名，重启（或等热重载）就能叫出来。
删掉目录即下线，状态里那条会退回 `default`。

> 头像：`avatar.png` 建议 ≤ 1024×1024。运行中换图不用重启，URL 带 `?v=<mtime>`，
> 换文件即换缓存键。
>
> **改名**：`name` 只影响注入块里显示的名字，**不动的别名**——把 `早濑优香` 改成 `优香`，
> 原来的 `早濑优香` / `早濑` 仍然叫得动，因为它们还在 `aliases` 里。面板上直接点名字就能改。

---

## 世界书：`lore.json`（可选）

人格目录里多放一个 `lore.json`，就能把「不该常驻」的资料按关键词触发注入，
省下的就是每次请求都要付的那几千 token。**没有这个文件 = 没有这段功能，行为一点不变。**

```text
<DSH_HOME>/personas/<id>/lore.json
```

```json
{
  "entries": [
    { "id": "asr", "keys": ["转写", "whisper"], "content": "本机转写走 D:\\AI\\ASR，faster-whisper large-v3，CPU int8。", "order": 10 },
    { "id": "rule", "constant": true, "content": "回答前先收敛结论，别铺陈。", "order": 5 }
  ]
}
```

| 字段 | 作用 |
| --- | --- |
| `keys` | 命中其中任意一个词（大小写无关）就注入这一条 |
| `content` | 注入的正文 |
| `constant` | `true` ⇒ 每轮都注入，不看关键词 |
| `order` | 注入顺序，小的在前（同时决定超量时谁先被丢） |

上限：一次最多 8 条、每条 4,000 字符、合计 20,000 字符——宁可少注入，也不把一次请求撑爆。
一轮都没有命中时只留 `constant` 条目；一条都没有 ⇒ 不产生任何注入文本。

---

## 设置面板

**设置 → 人格路由**（`settings.section` 里 id `persona-router`、order 47，紧跟 dsh-agent-md 的「人格」）。
标题不叫「人格」是因为那名字已经被 dsh-agent-md 占了——同名两条会让人找不到。

| 能做什么 | 怎么存 |
| --- | --- |
| 看人格清单、头像、谁在本窗口、谁是默认 | 只读 |
| 开 / 关「按称呼自动切人格」 | 写 `config.json` 的 `enabled` |
| 改别名（逗号分隔，失焦即存） | 写该人格的 `persona.json` |
| 换头像（选图 → 拖动/缩放裁成方形 → 512×512 → 直传） | `POST /persona-router/avatar/<id>` |
| 改**人格名**（直接点名字改，回车或点别处保存，Esc 撤回） | 写该人格 `persona.json` 的 `name` |
| 上传 / 更换 / 清除**用户头像**（面板上就叫「用户头像」） | `POST` / `DELETE /persona-router/user-avatar` |
| 设为默认 | 写 `state.json` 的 `default` |
| 停用 / 启用某个人格 | `persona.json` 的 `enabled`（目录留着） |
| 新建人格（自动写一份占位正文） | 建 `personas/<id>/` |
| 删除人格（**要点两次**，不可撤销） | 删目录；历史里指向它的轮次回落默认 |
| **试运行判定**：输入一句话点「试算」，看会切给谁 / 算不算同台 / 带哪几条世界书 | 只调 `GET /probe`，不改任何状态 |

**面板不编辑正文**（`prompt.md`）——那是 dsh-agent-md 的「人格」页负责的事，两套编辑器迟早对不上。
面板也不做拖拽排序、不做人格笔记。

---

## 状态与配置

`<DSH_HOME>/persona-router/state.json`（插件自己维护，别手改）：

```json
{
  "version": 1,
  "default": "sample",
  "sessions": { "session-xxx": "sample" },
  "workspaces": { "e:/d·s·h": "sample" },
  "history": { "session-xxx": [{ "turn": 12, "persona": "sample" }] }
}
```

- `sessions` 记**这一会话钉住的人格**（`@none` = 本会话不注入）；`workspaces` 是按**归一化 cwd**
  记的工作区选择；`default` 是两档都没选中时的兜底
- 注意 `sessions` **只记明确钉过的**（叫过名字、面板设过）。没钉过的会话每轮按阶梯现算，
  这样工作区档后来改才追得上
- `history` 记「**第几轮是谁答的**」，每个会话最多 400 条，超出从旧到新剪掉
- **历史消息的头像按 `history` 各贴各的**：第 3 轮是 A、第 5 轮换成 B，那两条就各显示各的脸
- 表里查不到的轮次（插件装上之前的老对话）一律回落到 `default`——这件账只能从开始记录那一轮记起，
  更早的对话无从知道当时是谁

`<DSH_HOME>/persona-router/config.json`（可选，手写）：

```json
{ "enabled": true, "avatarRepeatRows": 6, "avatarSize": 40 }
```

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关掉后不注入人格块，退回 AGENT.md 兜底 |
| `avatarRepeatRows` | `6` | 自绘层每隔几条可见助手行再露一次头像（1 = 每条都露） |
| `avatarSize` | `40` | 自绘头像边长（px，24–72） |
| `multiRole` | `true` | 一轮点了好几位时让他们接话；`false` 退回「取最后一位」 |
| `pinLeadOnMulti` | `true` | 同台之后让「先开口」那位接棒；`false` 则同台只演那一轮 |

**用户头像**（用户消息那一侧那张脸）是单独一份，不写在人格目录里：

```text
<DSH_HOME>/persona-router/user-avatar.png   # 也可能是 .jpg / .webp
```

- 有这张图 ⇒ 用户消息那一侧显示它；没有 ⇒ 一个节点都不画，沿用壁纸引擎自己的头像
- 所以**想临时关掉这个功能，把这张图删了就行**，不用改代码、不用重启
- 换图会自动清掉同族的旧文件（否则读取端按名字取第一张，会出现「新图导入了、屏上还是旧的」）

---

## HTTP 路由

插件需要 `webServer`（头像要经由本机 HTTP 提供）。挂在 `/persona-router` 前缀下：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /persona-router/state?session=<id>&cwd=<path>` | 该会话当前人格 + 三档视角（`sessionPick` / `sessionOff` / `workspacePick` / `effective` / `off`）+ 人格清单 + 头像参数 |
| `GET /persona-router/probe?text=<一句话>&session=<id>` | 试运行判定：命中谁、是否同台、谁先开口、带哪几条世界书；只算不落盘 |
| `GET /persona-router/decisions?limit=20` | 最近几轮的判定记录（`decisions.log` 的尾部） |
| `PUT /persona-router/session` | `{ session, personaId }`：钉住本会话；`personaId: null` 清除、`"@none"` 本会话不注入 |
| `PUT /persona-router/workspace` | `{ cwd, personaId }`：钉住某个工作目录；`personaId: null` 跟随全局 |
| `PUT /persona-router/default` | `{ default }`：改全局兜底 |
| `PUT /persona-router/config` | 开关与人设头像参数 |
| `GET /persona-router/avatar/<id>?v=<mtime>` | 头像字节；带 `v` 给长缓存，不带给 `no-store` |
| `POST /persona-router/avatar/<id>` | 导入头像（jpg/png/webp，8 MB 上限，`.tmp` + rename 原子落盘） |
| `DELETE /persona-router/avatar/<id>` | 删头像 |
| `GET /persona-router/user-avatar?v=<mtime>` | 用户头像字节；带 `v` 给长缓存，未设置回 404 且不缓存 |
| `POST /persona-router/user-avatar` | 导入用户头像（原始字节，jpg/png/webp，8 MB 上限，换图先清同族旧文件） |
| `DELETE /persona-router/user-avatar` | 清除用户头像（等于关掉这个功能，用户侧回到壁纸引擎那张） |
| `GET /persona-router/health` | 自检：启用状态、人格清单、`codeVersion`（当前 `r17-rename`）、客户端上报 |
| `POST /persona-router/client-report` | 客户端上报实际生效的头像层（诊断用） |

> 手边只有命令行时，钉工作区就是一句：
> `Invoke-RestMethod -Method Put http://127.0.0.1:<port>/persona-router/workspace -ContentType 'application/json' -Body '{"cwd":"E:\\D·S·H","personaId":"noa"}'`

---

## 安装

**从 npm（发布之后）**：

```powershell
dsh plugin add dsh-multi-persona          # 会写 profile 的依赖与 bundles 列表
```

**本地目录安装（开发）**：指向本包的 `plugin/` 目录。

```powershell
dsh plugin install <本包目录>
```

> 从旧版升上来的：包名在 2026-11-10 从 `dsh-persona-router` 改成 `dsh-multi-persona`。
> 升级时要**先卸旧的再装新的**（依赖键换了名字，直接装会冲突）：
> `dsh plugin remove dsh-persona-router` → `dsh plugin add dsh-multi-persona`。
> 人格目录与 `persona-router/` 下的状态**都不受影响**，不用迁移。

或在 DSH 的「插件管理」里选「安装本地插件」指向本目录。安装器会接管
`profile/package.json` 与 `cordis.patch.yml`，**不要手写那两份文件**，也不要往 profile 目录里跑 pnpm。

装上之后：

- 宿主半需要 `webServer` 与 `systemPrompt`（已在 `inject` 里声明；没有 web 的 profile 不会激活）
- 客户端半只用到浏览器模块表里的 `react` 与 `slots` 服务，不依赖任何 `@deepseek-ai/dsh-client-ui-*` 包
- **改过宿主半的代码不会热重载**。`GET /persona-router/health` 的 `codeVersion` 是判断依据；
  要让新代码生效，在插件管理里把本行关一次再开一次（或重启 DSH）。客户端半的改动要刷新页面。
- `state.json` 的读-改-写在进程内串行，几个会话同时切换不会互相覆盖

---

## 与 dsh-agent-md 共存

**不改 dsh-agent-md 的代码，只改它读的那份文件。**

1. `~/.dsh/AGENT.md` 换成中性底座：协作方式 + 边界 + 「兜底人格（仅在人格路由缺席时生效）」
2. 兜底那节写清两条判定：本轮有「当前人格」块 ⇒ 整节作废；没有 ⇒ 照它演
3. 所以：插件在 ⇒ 按称呼切；插件被删/停用/加载失败 ⇒ 仍然是兜底那位，不会变成空壳

回退：把 `~/.dsh/agents/backups/AGENT-*.md` 里想要的那份拷回 `~/.dsh/AGENT.md`。

---

## 已知边界

- **自绘层是纯 DOM 装饰**，依赖聊天行的 `data-chat-flow-kind` / `data-chat-turn` 属性。
  宿主改这两个属性名，头像会静默消失——不会影响消息渲染。
- **寄生改写**只换 `img.we-avatar__img` 的 `src`，布局、大小、圆角全归壁纸引擎。
  它自己的 sweep 偶尔会把 `src` 改回去，客户端补一次即可（不会来回打架：
  它的观察者不订 `src`）。壁纸引擎头像开着但**没设过图**时，它画的是内置图形，
  本插件把图形换成图片、并保持它的 `data-we-avatar-kind` 不变，所以也不会被重建。
- 只认**称呼位**，不做模糊匹配。名字太短（单字）容易误触，建议两个字符以上。
- 三档（会话 / 工作区 / 全局）与世界书目前都只有**宿主侧**：可用 `PUT /session`、`PUT /workspace`
  与手写 `lore.json` 操作，设置面板的界面入口还没接（下一步）。
- 人格级私有记忆 / 笔记不在第一版；人格市场、审核、在线分发也不在。

---

## 卸载

删掉插件（`dsh plugin remove dsh-multi-persona`，从旧包装的就用旧名 `dsh-persona-router`；或在插件管理里移除）即可。
留下的只有数据：`<DSH_HOME>/personas/` 与 `<DSH_HOME>/persona-router/`（状态目录仍用旧名前缀）。
想要彻底回到装之前：再按上面「回退」把 `AGENT.md` 拷回去。

---

## 仓库结构

| 路径 | 是什么 |
| --- | --- |
| 根目录 | npm 包本体：`package.json`、`index.js`（宿主半）、`client.js`（前端半）、`cordis.patch.yml`、`locale/`、`examples/` |
| `test/` | 自测：称呼判定单测、裁剪、面板、HTTP 路由、判定解释 |
| `tools/` | 打包校验 `verify-pack.mjs`、`asar-scan.mjs`、回滚脚本 |
| `SPEC.md` | 设计规格与施工记录 |
| `DESIGN.md` | 早期调研笔记 |

```powershell
dsh plugin add dsh-multi-persona          # 从 npm
dsh plugin add github:Darwin-2002/dsh-multi-persona   # 从源码（构建期需要 allowBuilds 授权）
```

自测（在仓库根跑）：

```powershell
node test/unit.mjs          # 判定与状态机，90 项
node test/panel.mjs         # 面板注册与交互，8 项
node test/crop.mjs          # 头像裁剪，6 项
node test/routes.mjs <端口>  # HTTP 路由，24 项（需要 DSH 正在运行）
```

## 许可

MIT
