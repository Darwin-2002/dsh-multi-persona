# dsh-multi-persona

Multi-persona switching for **DeepSeek Harness** — switch the assistant's persona
inside one window by *how you address it*, put several personas on stage at once,
and give each one its own avatar. A persona is just a folder; adding or removing one
never touches code.

```
「普拉娜，帮我看下这段日志」   → 这一句起换成普拉娜
「诺亚，你觉得呢」             → 这一句起换成诺亚
「普拉娜、优香，你们怎么看」   → 两位同台，第一位先答
「那这份文献呢」               → 没人被叫到，沿用上一位
```

- **按称呼自动切** —— 不做命令。名字出现在称呼位才算（「头像是优香，」这种判断句不算）
- **多人格同台** —— 一句里点了好几位，他们按顺序真的接话，不是各写一段
- **每人一副头像** —— 寄生改写壁纸引擎的头像节点，或自己画一层；同一时刻只开一层
- **人格 = 一个文件夹** —— `persona.json` + `prompt.md` + `avatar.*`，放在 `$DSH_HOME/personas/`
- **世界书可选** —— 人格目录里多一个 `lore.json`，按关键词注入，不常驻上下文
- **用户头像** —— 用户消息那一侧也能换成自己的图

## 安装

```powershell
dsh plugin add dsh-multi-persona
```

本地目录安装（开发用）：指向 `plugin/` 子目录。

```powershell
dsh plugin install <本仓库>/plugin
```

## 文档

完整说明（判定规则、三档回落、世界书、设置面板、HTTP 路由、已知边界）在
[`plugin/README.md`](plugin/README.md)。

> 包曾用名 `dsh-persona-router`（2026-11-10 改名）。内部的**路由前缀 `/persona-router`、
> 数据目录 `$DSH_HOME/persona-router/`、上下文段名 `persona-router:*`** 仍沿用旧名——
> 那些改动要迁移状态文件，为了一致性去动它不划算。

## 仓库结构

```
plugin/     ← npm 包本体（package.json 在这里，发布从这个目录打）
test/       ← 自测：单元 / 裁剪 / 面板 / 路由 / 判定解释
tools/      ← 打包校验、asar 扫描、回滚脚本
SPEC.md     ← 设计规格与施工记录
DESIGN.md   ← 早期调研笔记
```

## 许可

MIT
