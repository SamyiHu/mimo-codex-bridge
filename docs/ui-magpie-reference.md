# 面板 UI：照着 magpie 重写（v2 · 仪表盘）

参考：[yetone/magpie](https://github.com/yetone/magpie) 的桌面端（`internal/gui/assets/app.css`、`docs/subsystems/gui-shell.md`）。

第一版只换了配色，被吐槽"就是把旧页面打散"。这一版重做了三件事：**信息分层**、**图表**、**数据密度**。

---

## 一、从 magpie 拿的两层东西

### 1. 密度与节奏（直接沿用）

- 正文 13px、行高 40px、行内 `padding: 5px 14px`、行间只有 1px 发丝线（`.row`）。
- 卡片 = 1px 边框 + 14px 圆角 + 半像素外描边 + 极轻投影（`--shadow-1`），从不叠第二层阴影。
- 一个强调色（靛蓝 `#4f46e5` / 深色 `#7f77f5`），语义色各带 `-soft` 底；失败画 ✕ 形状。
- 分段控件（`.seg`）用 track + thumb 两层灰，滑块带半像素边。

### 2. 它没给、这一版补的（这才是"设计"的部分）

| 层 | 做法 |
| --- | --- |
| **Hero 带** | 概览顶部一条渐变面板：左边是状态 + 大数字 + 24 分钟流量柱，右边四个 KPI（上游在线 / 额度最紧 / P95 延迟 / 累计请求）。一眼看出"现在怎么样"，不用读表格。 |
| **两栏布局** | 宽屏下 1.15fr / 0.85fr：左边"上游 + 最近请求"（会变的），右边"额度 + Codex + 最近动作"（参考信息）。1100px 以下自动落成一栏。 |
| **图表** | 路由页每个上游一张 24 小时额度曲线（SVG：面积 + 折线 + 90% 参考虚线 + 末点圆标）；概览的流量柱是 24 个 1 分钟桶。 |
| **请求流水** | 独立一页：四个统计（累计 / 在飞 / P50 / 错误率）+ 过滤（全部/错误/慢/流式）+ 搜索 + 表格（时间/模型/上游/状态/首字/耗时条/tokens）。 |
| **虚拟列表** | 模型页改成 30px 行高的窗口化列表：98 个模型只渲染约 20 行，滚到底换窗口（实测 firstIdx 从 1 跳到 79）。几百上千个也不卡。 |
| **图标系统** | 18 个内联 SVG symbol（stroke 1.6，15px），导航/按钮/空态统一用它们，不再用 ◉ ⇄ ⚙ 这类字符。 |
| **排版层级** | h1 20px/650/-0.022em；卡片标题 12.5px/600；数值 21–30px + `tabular-nums`；元信息 11–11.5px muted。三种字号解决"没有层级"的问题。 |
| **粘性页头** | 页头 `position: sticky` + `backdrop-filter` 半透明，滚动时标题和刷新按钮不离开视野。 |
| **微交互** | 卡片 hover 上浮 1px、导航激活项左侧 2px 竖条、按钮按下位移 0.5px、页面切换 160ms 上浮淡入、Toast、`prefers-reduced-motion` 全关。 |

---

## 二、页面

| 页 | 内容 |
| --- | --- |
| 概览 | Hero（状态/大数字/流量柱/KPI 4 个）+ 上游健康 + 最近 6 条请求 + 额度条 + Codex + 最近动作 + 提示 |
| 请求 | 4 个统计 + 过滤/搜索 + 流水表格（可滚动，表头吸顶） |
| 上游 | 三张切换卡 + 启停操作 + 说明 |
| 路由 | 每个上游一张卡（额度条 + 24h 曲线 + 地址 + 状态）+ 路由组列表 |
| 模型 | 虚拟列表 + 搜索 + 点行复制 |
| 配置 | 两列表单（地址/目录/Key）+ 保存/重载 + 一致性提示 |
| 插件 | `panel-plugins/*.mjs` 的卡片各自一页，标题取卡片 `<h2>` |

---

## 三、为 UI 新加的两条数据链路

UI 不能凭空画图，所以顺手把两条数据补上了：

1. **请求流水（bridge 侧）**：`MetricsRegistry` 加了 200 条的环形缓冲，每条记 `{时间, 模型, 上游, 状态, 是否流式, 首字耗时, 总耗时, input/output/total tokens, error}`——**只记元信息，不留 prompt**。`/status.metrics.requests.recent` 对外暴露，面板 8 秒轮询一次。
2. **额度历史（面板侧）**：`panel-history.json` 存 `{t, id, share}`，每 5 分钟或变化 ≥1% 落一个点，7 天 / 4000 点封顶。`GET /api/history` 给图表用。bridge 不管这事——额度是面板的视角。

---

## 四、验证（没有肉眼也要能判断）

页面内置自检 `?selftest=1`：逐页渲染 → 量布局 → 量计算样式 → 输出 JSON。headless Edge 跑出来：

```
overview    cards=3 rows=7  ovf=0  hero=600px 362px  radius=14px  sticky=sticky
requests    cards=1 tr=5    ovf=0
routing     cards=3         ovf=0
models      cards=1 vrows=20 ovf=0    models@bottom → vrows=20 firstIdx=79（窗口化生效）
config / upstreams / plugin/0..2       ovf=0
```

- 10 个页面全部 0 横向溢出；侧栏 216px、内容 1080px（窄屏 820px 时侧栏变顶栏）。
- 兼容性：对着**旧版 bridge 进程**（没有 `metrics.recent`）跑一遍，10 个页面同样 0 报错。
- 截图在 `reports/ui/`：概览/请求/路由/模型/上游/配置/插件 + 深色 2 张 + 窄屏 1 张。

---

## 五、第三轮补齐的四件事

上一版留了四个口子，这轮都补上了：

| 项 | 做法 | 验证方式 |
| --- | --- | --- |
| **图表交互** | 路由页顶部加时间窗分段（1 小时 / 24 小时 / 7 天）；曲线支持悬停：跟随鼠标的竖虚线 + 实心点 + 浮层（`45% · 14:32`）。数据点存在 `state.chartPoints`，`mountCharts()` 一次性绑定 | 自检里合成 `mousemove`，断言 `#chartTip` 带上 `.on` 类 → `tipOn=true`，`chartPoints=2` |
| **请求详情** | 行可点：展开一行通栏详情（请求 ID / 路径 / 上游 / 模型 / 是否流式 / 首字 / 总耗时 / tokens 明细 / 错误原文），展开行高亮 | DOM 断言 `tr.req-row` 可点、展开后出现 `tr.detail-row` |
| **键盘快捷键** | `g` + `o/q/u/r/m/c` 跳页（1.2 秒窗口）、`r` 刷新、`/` 聚焦搜索、`Esc` 关面板或清搜索、`?` 打开快捷键面板；侧栏底部加了一个 `?` 按钮 | 自检合成 `g`→`m`，断言 `location.hash === "#/models"`；合成 `?`，断言 `#helpMask` 存在 → `helpOpen=true` |
| **插件页样式** | 之前插件卡片只有骨架样式，行内操作胶囊是裸文字。现在补了 `.plugin-card` 作用域：账号行做成内嵌小卡、`.wtr-act/.wbc-act` 变语义胶囊（靛蓝/琥珀/红/绿）、`.toggle` 做成迷你开关、登录/导入面板、`pre` 输出框、倍率表格 | 插件页抓到 7 个 `.wtr-act` 元素、卡片带 `plugin-card` 类；三张插件页在自检里 0 溢出 |

自检输出（1440×900，headless Edge）：

```
overview   cards=4 ovf=0        requests  cards=1 tr=3 ovf=0
routing    cards=3 charts=2     models    cards=1 vrows=20
plugin/0   tr=36   plugin/1 tr=2   plugin/2 tr=0     全部 ovf=0
interactions: tipOn=true chartPoints=2 afterChord=#/models helpOpen=true
models@bottom: vrows=20 firstIdx=79
```

---

## 六、仍然没做（想清楚了再说）

1. **请求详情里的时间线**：现在是一次请求的静态字段；要做成 magpie 的 Requests 那样"每一次尝试都列出来"（failover 的第 1 跳、第 2 跳），得让 bridge 在 metrics 里记 attempt 数组。
2. **图表时间窗外推**：7 天窗口下点数会到 2000+，SVG path 还行，但该做降采样（每 10 点取 min/max）——现在没到那个量，先不写。
3. **快捷键表可配置**：写死在 `onKeydown` 的 map 里，够用。

---

## 七、面板里直接开多上游（这一轮加的）

之前"开多上游"要手工写 `upstreams.json` 再重启 bridge。现在路由页底部就是配置面板：

- **上游**：每行 id / kind / base / token 文件，可增删；
- **路由组**：成员 chip（`provider/model`）、`routing` 七选一、`stays` 五选一，可增删；
- **额度**：每上游一个「已用 %」+「几小时后重置」，写进 `quota.json`；
- **保存** → 原子写文件；**启用** → 只是让 `upstreams.json` 存在；**停用** → 改名成 `upstreams.disabled.json`。

bridge 侧没有新增接口：它本来就每 250ms 按 mtime 重读注册表，所以**保存即生效，进程不重启**（pid 不变，实测验证）。

面板侧新增（都写文件 + 校验，不碰进程）：
`GET/POST /api/routing`、`POST /api/routing/enable`、`POST /api/routing/disable`、`POST /api/quota`。

一轮实测（脚本跑的）：

```
① 启用前 routing.enabled: false
② 保存: true（磁盘 groups: daily:2）
③ 启用: true
④ bridge 热加载: true | 上游: wb,trae | pid 未变
⑤ 模型: 97 | wb/cn:auto, trae/Doubao-Seed-2.1-Turbo | group: group/daily
⑥ group/daily → 200 | 输出: "OK"
⑦ UI：上游输入 2 · 组卡 2 · 模式按钮 14 · 成员 4
⑧ 停用后: false
```

插件页也顺手修了：倍率那一片原来是几十个 chip 横向挤成一条（还有横向滚动条），现在按 `auto-fill` 栅格排、行高收紧、表格不再溢出。

---

## 八、插件卡片模板重写

之前插件页只是"用 CSS 压进新体系"，实际还是插件自己那套：一个大卡片 + 一串行 + 一坨 chip。这一轮把三个插件的 **registerCard 模板**重写了（JS 一行没动，只保证 ID 不变）：

```
Trae 账号池        账号状态 / 倍率明细
WorkBuddy 积分     账号状态 / 用量 / 倍率明细 / 日报
WorkBuddy 自动任务  定时任务
```

结构统一成：

```html
<section class="card">
  <div class="phead"><h2>标题</h2><div class="phead-sub">一句话说明</div></div>
  <div class="pblock">
    <div class="pblock-head">区块名</div>
    <div class="rows" id="原 ID">…插件照旧往里写…</div>
  </div>
  …
  <pre id="wtr-out"></pre>
  <div class="card-foot">按钮组</div>
</section>
```

保留的契约：13 / 13 / 5 个 ID 全在、`#xxx.show` 的显示约定不变、插件脚本自己 `getElementById` 拿到的节点不变。
验证：三个插件页 DOM 里 `phead=1`、区块数 2/4/1、真实数据正常渲染（账号、倍率表、任务开关），横向溢出全 0。

---

## 九、去重：概览只留"现在在跑的那一家"

原来概览有一张「上游」卡（三行：mimo / workbuddy / trae）+ 一张「额度」卡，跟路由页顶部的运行条和上游卡重复。现在改成：

```
┌ 当前上游 · 3 家已接入 ───────────────────────────┐
│ [图标] WorkBuddy  [最近在用]        ● 在线        │
│        http://127.0.0.1:7863                     │
│        ▓▓▓▓▓▓░░░░ 71%  ·  5 小时后重置            │
│ ─────────────────────────────────────────────── │
│ 其余 2 家  ● mimo  ● trae 71%        路由详情 → │
└──────────────────────────────────────────────────┘
```

规则：

- **"当前"** = 请求流水里最近一条的 upstream（真实在用的那家），没有流水时退到第一家用得上、且不在休息中的；
- 额度条只给当前这家画，其余几家只在 chips 上带百分比；
- 每家上游的详细状态（base / 休息中 / 曲线）留在路由页，不在这里重复；
- 上游 id 与注册表对齐（`mimo` / `wb` / `trae`），之前出现过"最近在用 wb 却匹配不到"的 id 不一致问题。

验证：概览 DOM 里 `upnow` 块 1 个、主行 1 个、其余行 1 个；自检 8 页 0 溢出；115 条测试全绿。

---

## 十、最终信息架构

导航：**概览 / 请求 / 上游 / 路由组 / 模型 / 配置 + 插件**

| 页 | 装什么 | 不装什么 |
| --- | --- | --- |
| 概览 | 当前上游（一家）+ 其余几家一行、额度最紧、P95、最近 6 条请求 | 每家上游的细节 |
| 请求 | 请求流水表格 + 过滤 + 统计 | — |
| 上游 | 运行条（启停）、时间窗、每家上游的额度曲线卡、上游配置（base/token）、额度、别名 | 路由组 |
| 路由组 | 组的只读视图（成员带上游状态与额度）+ 组编辑器（routing / stays / 成员） | 上游配置 |
| 模型 | 虚拟列表 | — |
| 配置 | 网关地址 / Key | — |

改动要点：

- `routingEditor()` 拆成 `upstreamEditor()` 与 `groupEditor()`，两个页面各用一块；
- 老链接 `#/routing` → `#/upstreams`（`#/upstreams` 曾是另一页，现在指回上游页）；
- 路由组页在未启用多上游时给出引导（跳去上游页启用）；
- "面板代码已更新"横幅只看 `panel.mjs` 的 mtime —— panel-ui 是每请求读盘的，改样式不需要重启。

验证：6 个主页面 + 3 个插件页自检 0 溢出；115 条测试全绿；截图 `reports/ui/01…10`。

---

## 十一、可视化与信息面板

### 1. 概览 · 实时拓扑（照 magpie 架构图那套）

三列：**接入方 → 模型桥 → 上游**。中间一张卡写清 Gateway 讲哪些协议、Routing groups 有哪些、别名/插件/模型数；两侧是带状态点的节点，连线用贝塞尔曲线，健康的走强调色、断的走灰线。

数据全部来自 `/api/status` —— 开多上游时用注册表的 `wb/trae/mimo`，没开时退回老三样。

### 2. 路由组页 · 一条请求怎么被分下去

照 magpie Routing 页的信息结构重做：

~~~text
[接入方]            [模型桥]               [成员]
Codex          ──▶  桥 · 127.0.0.1:8788    ● wb/cn:auto        answered
group/daily         smart · stays=auto      ○ trae/Doubao…      可用
Claude Code                                  （resting 时显示"休息中 · Xs"）
其他客户端
──────────────────────────────────────────────────────────────────
wb/cn:auto 先上                     2 请求   0 换过家   0 错误
最近一次路由 55 秒前
 · 顺序：wb::cn:auto → trae::Doubao-Seed-2.1-Turbo
 · 选中 wb · 首选 · 额度未知
 · 健康账号里，额度重置最早的先上（剩下的到点就作废）
~~~

这需要 bridge 记**路由决策**：`bridge-routing.noteDecision()` 往环形缓冲写 `{at, model, chosen, order, notes, reason, pinned}`，`/status.routing.recentDecisions` 暴露最近 10 条。面板据此算"换过家"次数，并把 notes 原样列出来 —— 路由不再是黑盒。

### 3. 上游卡 · 信息面板

每家上游的卡片里加一排数字（模型数 / 近期请求 / 平均延迟 / 错误）和一行能力 chip（`raw`、`模型透传`、`自动发现`、`倍率装饰`），全部从 `/status.models` + `metrics.requests.recent` + 注册表 capabilities 现算。

### 4. 插件页 · 信息面板

每个插件页顶部加一张"这个插件做什么"：作用 / 后端 / 接口 / 数据存在哪。插件代码一行没改，元信息在 `app.js` 的 `PLUGIN_INFO` 里维护。

验证：概览拓扑 1 张卡 / 7 个节点 / 6 条连线；组页 3 个 tab、2 条成员、决策说明完整；上游卡 3 张都有统计格；插件页 4 个字段；自检 9 页 0 溢出；115 条测试全绿。

---

## 十二、按"别套模板"改的两处

### 1. 客户端是认出来的，不是写死的

之前拓扑左侧写死 `Codex / Claude Code / 其他客户端` —— 这属于"套模板"。现在 bridge 从请求头认：

~~~js
originator / x-client-name / x-app / x-title / user-agent
  → DSH / Codex / Claude Code / Gemini CLI / Cursor / OpenCode / Cherry Studio /
    OpenAI SDK / Python / Node / curl，认不出就原样回 UA 前缀
~~~

每条请求记 `client` 字段（只记名字，不记 UA 全文），拓扑左侧按 `client` 聚合最近 200 条请求：

~~~text
接入方
● DSH            2 次请求
● Codex          1 次请求
~~~

没请求时显示"还没有请求进来"，不假装有客户端。

### 2. 倍率区：省掉三分之二的空白

你圈出来的三块，处理如下：

| 之前 | 现在 |
| --- | --- |
| 一行占满整宽的提示 | `.rate-note`：10.5px、灰、只占一行文字的长度 |
| 6 列表格 + 大行高 + 偶发横向滚动 | 紧凑表：11.5px、行高 3px 内边距、数字 `tabular-nums`、六列贴紧 |
| "其余 47 个模型"平铺 47 个 chip 占三行 | `<details>` 折叠，一行 "▸ 其余 47 个模型未使用 · 官方倍率"，展开后 4 列对齐的 `name —— 0.50x` 栅格 |

实测：插件页高度从 1250px 缩到 ~1150px 以内，页面横向溢出 0。
