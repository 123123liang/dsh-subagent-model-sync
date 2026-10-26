# 开发者指南

面向要改本插件代码的人。用户向说明见 [README](README.md)。

---

## 结构

```
.
├── lib/
│   ├── resolver.js     纯函数：给定一个 Agent，决定本次请求该用什么路由
│   ├── prefs.js        偏好持久化（每会话开关 + 每子代理单独指定）
│   ├── index.js        Host 半：agent/request 钩子 + 本地 HTTP 接口 + 偏好清理
│   └── client.js       浏览器半：两个界面座位（主会话开关 / 子代理模型面板）
├── locale/
│   ├── en.json         必需：插件页显示的英文标题与描述
│   └── zh.json         其他语言，文件名即语言 id
├── test/               41 条自动化测试
├── tools/              取证与自检脚本（不随包运行）
├── cordis.patch.yml    一行 insert，让 Loader 加载 Host 半
├── icon.svg            插件页图标（≤256 KiB）
└── package.json        dsh.bundle / dsh.client 声明，locale 的 exports
```

一个包同时含 Host 半与浏览器半：

- **Host 半**（`lib/index.js`）由 `cordis.patch.yml` 注册；
- **浏览器半**（`lib/client.js`）由 `package.json` 的 `dsh.client` 声明，构建期打进前端启动图。

---

## 核心设计（改代码前必须理解）

### 1. 只有一个钩子，且在最外层

```js
ctx.on('agent/request', async (payload, next) => {
  const config = await next()                 // 先让官方与其它插件的改写全部跑完
  const { route, source } = resolveRouteWithSource(...)
  return route === undefined ? config : applyRoute(config, route)
}, { prepend: true })
```

`prepend` 在事件数组里把监听器放到**最前**，而回调链按数组顺序包装——最前即**最外层**，
因此它看到的是所有改写之后的结果，并拥有最终决定权。这不是"最先执行"，是"最后拍板"。

### 2. 决策是两遍扫描

```
第一遍：向上找最近的「开启同步」祖先 → 找到就用它的路由，直接返回
第二遍：子代理自身的单独指定 → 最近的祖先单独指定
```

**必须分两遍**：单次向上遍历会让中间层的手动指定遮蔽管理它的同步开关。
相关函数：`ancestorsOf`（带深度上限与环保护）、`ownRoute`（优先 `pending` 而非 `lastUsed`）。

### 3. 单独指定"生效即作废"，不是"休眠"

- 勾选同步**不改任何数据**；
- 只有当一次请求真的被同步改写时，才把该子代理的单独指定删掉（`shouldRetirePin`）。

所以"来回勾选但不发消息"是纯幂等操作，而"被覆盖过"的指定不会在取消同步后复活。

### 4. 绝不伪造会话事件

不追加 `model/selection`，不改写 descriptor。真实路由只由官方的 `request/header` 记录。
这是"日志可审计、卸载不留痕"的基础，**不要为了 UI 好看去写事件**。

### 5. 偏好读取永不阻断请求

钩子里任何异常都 `return config`（原样放行）。偏好文件损坏时整体降级为空 = 等同于未安装。

---

## 常见改动

### 改优先级

只改 `lib/resolver.js` 的 `resolveRouteWithSource`。它返回 `{ route, source }`，
`source` 是 `'sync' | 'manual' | 'none'`，调用方靠它决定是否作废单独指定——**改判序时别忘了同步改它**。

改完必须补/改 `test/resolver.test.js` 的决策表。历史上有两条用例的语义被整体反转，不能只改断言了事。

### 加一个接口操作

1. `lib/prefs.js` 加方法（注意：写入走 `#schedule()` 的防抖 + 原子替换）；
2. `lib/index.js` 的 `handle` 里加 `case`；只接受 POST、只服务环回、body 上限 64 KiB 是既有约束；
3. `lib/client.js` 的 `callBridge({ op: ... })` 调用它。

### 改界面

浏览器半跑在宿主页面里，有几个坑必须避开（都是真实踩过的）：

| 约束 | 原因 |
|---|---|
| 只使用 `useSession` / `useSessions` 两个 prop | 读取不存在的 prop 会抛错，而渲染器会**永久注销**该座位 |
| `h(type, props)` 的 children 必须放在 `props.children` | 第三个参数是 `key`，传 children 会渲染成空壳 |
| 不要用 `useSyncExternalStore` 返回新数组 | 会触发 `getSnapshot should be cached`；用 `useState` + 订阅 |
| 不要用 fetch 结果决定是否渲染 | 接口不通时整块控件消失，桌面端尤其明显 |
| 只用官方 `MenuSurface` 做浮层材质 | 自己实现会透出对话内容 |

槽位：`conversation.input.right`（list 类，`replaceRisk: none`）。
**不要**去遮蔽官方模型控件所在的 `conversation.input.model`，风险高且随上游更新易碎。

### 加语言

在 `locale/` 下新增 `<语言id>.json`，必须含非空的 `meta.title` 与 `meta.description`；
文件名即语言 id，且必须与 `en.json` 同目录。`package.json` 的 `exports` 需保留 `./locale/*.json`，
否则语言文件解析不到。

界面内文案不在这里——`client.js` 里有一份内联字典（`zh` / `en` 两个对象），两处都要改。

---

## 测试与工具

```bash
node --test
```

| 文件 | 覆盖 |
|---|---|
| `test/resolver.test.js` | 决策表、来源判定、作废规则、偏好读写往返、幂等 |
| `test/client-smoke.test.js` | 模块加载、缺少 primitives 时的降级、座位注册 |
| `test/render.test.js` | 真 React + jsdom 挂载，断言 DOM（改前端后必跑） |
| `test/hook.test.js` | 真实 `apply()` + 钩子：改写、作废、清理安全阀 |

三个工具（不随包运行）：

- `tools/route-report.mjs <sessionId>`：读会话日志打印**真实**路由历史。判据很硬——
  **路由没变就不会追加 `request/header`**，多出一条才算改写生效。
- `tools/browser-check.js`：粘进浏览器控制台，读取实时 DOM 自检，不改任何偏好。
- `tools/probe-resolver.mjs <log>`：把真实日志喂给生产 resolver，验证依赖的两个 Host 表面
  （`sessionProjections.stateOf` / `session.requestHeader()`）没有变。发版前跑一次。

---

## 发布清单

### 发版步骤

```bash
# 1. 全绿
node --test

# 2. 升版本（改 package.json 的 version，并同步 README 页首的 vX.Y.Z）

# 3. 检查打包内容：应含 lib/、locale/、cordis.patch.yml、README.md、DEVELOPING.md、icon.svg、LICENSE；
#    不应含 test/、tools/、node_modules/
npm pack --dry-run

# 4. 提交并推送
git add -A && git commit -m "release: vX.Y.Z"
git push origin main
git tag vX.Y.Z && git push origin vX.Y.Z

# 5. 发布到 npm
npm publish --access public

# 6. 在 GitHub 用该 tag 建 Release，正文写清支持的 DSH 版本
```

### 几个会卡住的点（都实际踩过）

| 现象 | 原因与处置 |
|---|---|
| `npm publish` 报 403 / EOTP | npm 对**发布**强制 2FA。若验证器配对有问题，用浏览器授权：`npm publish` 会打印 `https://www.npmjs.com/auth/cli/<uuid>`，在浏览器里点授权即可，**不要**加 `--otp` |
| 发布成功但 `npm view` 还是旧版本 | registry 有几十秒到几分钟的处理延迟，`latest` 不会立刻更新；`Invoke-WebRequest` 轮询 tarball 或稍等 |
| `cannot publish over the previously published versions` | npm 不允许覆盖已发布版本，**必须升版本号**再发 |
| 插件页没有图标 | `package.json` 必须有 `icon` 字段（如 `"icon": "icon.svg"`）。缺失时管理器会退回去解析 `<包名>/icon` 这个导出路径，而 `exports` 里没有就会拿不到 |
| 插件页标题/描述是英文 | 缺 `locale/en.json` 的 `meta.title` / `meta.description`。文件名即语言 id，必须与 `en.json` 同目录 |
| `git push` 报 SSL / Connection reset | 网络偶发。重试 git；仍不通时可改用 GitHub REST API 逐个复刻提交（注意校验 blob/tree/commit 的 SHA 与本地一致） |
| README 徽章版本滞后 | shields.io 已更新，但 GitHub 的图片代理会缓存旧图，硬刷新或等几分钟 |

### 提交信息里不要出现的东西

会话 id、本机绝对路径、真实渠道名与模型名、任何账号或密钥。
测试夹具请使用 `provider-a` / `model-x` 这类中性命名。

