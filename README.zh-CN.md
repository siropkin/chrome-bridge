# chrome-bridge

[English](README.md) | **中文**

[![MIT 许可证](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Node ≥ 18](https://img.shields.io/badge/node-%E2%89%A5%2018-339933)](https://nodejs.org) [![零依赖](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)

让**任何 AI 智能体**驱动你正在使用的 Chrome——你已打开的标签页、已登录的会话和 SSO。Playwright 系工具驱动的是它们自己启动的浏览器、自己管理的配置;MCP 桥需要客户端支持 MCP 并配置服务器。chrome-bridge 两者都不需要:它驱动的就是你已登录的那个 Chrome——而且这是唯一模式——一个解压加载的扩展,一个零依赖的 Node CLI。被智能体操作的标签页还会戴上 🟣 小标签,实时播报它正在做什么。

![chrome-bridge 正在驱动标签页——右下角 🟣 标签为标记](docs/banner.png)

## 快速开始

需要 macOS/Linux(或 Windows 上的 Git Bash)、Chrome ≥ 117(ask / `snap --find` / `console --ask` 另需 Chrome ≥ 138 的内置 Nano 模型)和 Node ≥ 18。

```bash
git clone https://github.com/siropkin/chrome-bridge && cd chrome-bridge && ./install.sh
```

然后加载扩展:`chrome://extensions` → 开发者模式 → **加载已解压的扩展程序** → 选择 `extension/` 文件夹(Chrome 要求必须手动点击,脚本无法代劳)。

验证是否就绪:`node cli.mjs health` → `{"ok":true,"extension":true}`

完成。把下面这段告诉你的智能体:

- **Claude Code** — 把 `.claude/skills/chrome-bridge/` 复制进你项目的 `.claude/skills/`(或你的 `~/.claude/skills/`):`cp -r .claude/skills/chrome-bridge <your-project>/.claude/skills/`。遇到浏览器任务它会自动加载,并指向 `AGENTS.md` 获取完整手册。
- **其他任何智能体**(Cursor、Qwen、GLM、Baseten、原生 curl)——把这一行粘贴到智能体指令中(`CLAUDE.md`、`.cursorrules`、`AGENTS.md`、系统提示词……):

  > 驱动我的 Chrome 浏览器(真实的已登录标签页)时,阅读 `<path>/chrome-bridge/AGENTS.md` 并运行 `node <path>/chrome-bridge/cli.mjs <command>`。如果 health 检查失败,运行 `node <path>/chrome-bridge/cli.mjs start`;如果扩展未连接,告诉我重新加载它。

这就是全部集成工作。`AGENTS.md` 是一份自包含的操作手册——命令、配方、注意事项——任何能读文件或联网的智能体都能阅读。有联网能力的智能体可以直接从 GitHub 读取:`https://raw.githubusercontent.com/siropkin/chrome-bridge/master/AGENTS.md`。

---

一个小小的 Chrome 解压扩展通过 WebSocket 连接到本地 Node 服务器;任何能执行 shell 命令的工具都能驱动浏览器:

```bash
node server.mjs &                        # 启动桥接服务(Node ≥ 18,零依赖)
node cli.mjs snap localhost:8082         # 紧凑的无障碍树快照,带元素引用
node cli.mjs click localhost:8082 @e4    # 按引用点击
node cli.mjs fill localhost:8082 @e2 "hello@example.com"
node cli.mjs shot localhost:8082 out.png --max 800 --format jpeg
```

`snap` 的输出长这样——整个页面变成一棵紧凑的文本树,你可以直接操作其中的引用:

```
table "Hacker News new | past | comments | ask | show | jobs | submit" @e1
  link "Hacker News" @e5
  link "new" @e6
  link "submit" @e12
  link "login" @e13
table "1. Playa Phone (playaphone.com) 122 points by cutoff 1 hour…" @e14
  link "Playa Phone" @e16
  link "41 comments" @e21
```

默认不输出链接 URL(在我们的实测中它们占快照 token 的大头——你点击的是 `@eN` 引用,而不是 URL);无名称的链接仍保留 URL,`snap --href` 可恢复全部。

## 为什么不用 Playwright(或 playwright-mcp)?

Playwright 驱动的是它自己启动的浏览器——一个独立的 Playwright 管理的配置,不是你已登录的那个 Chrome,所以智能体每次都是未登录状态(挂载模式存在——`--remote-debugging-port` 重启,或 playwright-mcp 的扩展模式——但都需要手动开启;playwright-mcp 现在也为编程智能体提供了 CLI)。chrome-bridge 驱动的是你正在使用的 Chrome,而且这是唯一模式。它借鉴了 Playwright 最好的两个设计(带元素引用的无障碍树快照、基于引用的操作),同时省掉了 40 MB 的依赖和独立配置。

## 为什么不选 MCP 浏览器桥?

MCP 桥(mcp-chrome、BrowserMCP)要求客户端支持 MCP,还需要配置长期运行的 MCP 服务器(playwriter 也提供 CLI,但仍要启动/挂载一个浏览器实例)。Chrome DevTools MCP 的免 MCP CLI 能挂载到你的真实配置(`--autoConnect`,Chrome 144+)——但那是一个可选开关,而且它的卖点是 DevTools 深度(性能 trace、调试),不是极简。chrome-bridge 的真实浏览器模式就是*唯一*模式,客户端是任何能执行 shell 命令的工具:一个普通 CLI 加一个命令端点(`POST /cmd`)——智能体侧无需安装、无需配置——同样的命令也可以用在脚本、cron 任务或你自己的终端里。

## 安装细节

`install.sh` 会检查 Node ≥ 18、后台启动服务器(日志写入 `server.log`)、打开 `chrome://extensions`(macOS;Linux 请自行打开)、等待扩展连接(最长约 90 秒),并打印填好真实路径的智能体接入语句。如果服务器挂了或机器重启,智能体的 health 检查会失败,它可以用 `node cli.mjs start` 自行重启(`node cli.mjs stop` 关闭)。

**升级**:执行 `git pull` 后要重启服务器——它运行的仍是启动时的代码,而且 health 检查依然通过,没有别的东西会提醒你。同时要在 `chrome://extensions` 重新加载扩展(服务工作线程也是旧代码——加载的扩展版本和仓库不一致时,`node cli.mjs health` 会打印警告):

```bash
node cli.mjs stop && node cli.mjs start
```

**端口**:桥接器固定使用 127.0.0.1:9333。`BRIDGE_PORT` 可以移动服务器和 CLI(安装器强制要求 9333)——但扩展始终拨打 9333;如果必须换端口,需要同时修改 `extension/background.js`。

**Windows**:`install.sh` 是 bash(macOS/Linux,或 Git Bash)。桥接器本身是纯 Node——任何平台都能在终端里运行 `node server.mjs`,所有 `cli.mjs` 命令都是跨平台的。

被桥接驱动的标签页会在右下角显示 🟣 小标签(点击查看完整操作历史;✕ 可隐藏,下次导航前不再显示)并加入 🟣 标签页分组,你随时知道哪些页面正在被自动化。小标签实时播报智能体正在做什么(`🟣 taking screenshot…`、`🟣 reading page…`,长命令会显示已耗时秒数),历史面板列出最近的操作并自动滚动到最新一行;空闲时显示 `🟣 AI idle`(连续失败后显示 `⚠ N failed since last ok`,桥接服务器不可达时显示 `⚠ bridge offline`);命令执行期间,紫色边框亮起,标签页 favicon 显示 ⏳(完成 ✅,失败 ✗,✗ 会保留到下一条命令),点击/悬停处会闪现紫色指针标记智能体的操作位置。`release`(或 `close`)即可全部还原。

**多个 Chrome 配置**:扩展可以同时加载在多个配置中——每个配置保持独立连接,智能体可以并行驱动它们。命令会自动路由到唯一拥有匹配标签页的配置;当多个配置都有匹配时**拒绝执行**,要求智能体用 `--profile <id 或 name>` 指明(`cli profiles` 同时列出两者)——智能体绝不会在你以为操作工作浏览器时悄悄点进个人浏览器。每个配置还有一个稳定的短名字(`birch`、`oak` 等),`--profile` 直接接受该名字,显示在 `watch` 输出和标签里——对正在观看的人类来说,uuid 前缀毫无意义。

## 支持任何 AI 智能体——不限于 Claude

桥接器就是一个普通的本地 CLI + HTTP 接口,设计上与具体 harness 无关:

| 智能体 / harness | 一行指令放在哪里 |
|---|---|
| Claude Code | `CLAUDE.md` |
| Kimi CLI(月之暗面) | `AGENTS.md` 或系统提示词 |
| Qwen Code(阿里通义) | `AGENTS.md` |
| GLM / DeepSeek / 其他编程智能体 | `AGENTS.md` 或系统提示词 |
| Cursor | `.cursor/rules` |
| 你自己的智能体循环 | 直接调用 `cli.mjs`,或向 `http://127.0.0.1:9333/cmd` POST JSON |

HTTP API 只有一个命令端点:`POST /cmd`,Body 如 `{"type": "snap", "urlMatch": "…"}`——任何语言、任何框架、任何模型都能用。

## 安全

你要把已登录的浏览器交给智能体——本工具的设计前提是你想看着它工作:

- **仅本地**:服务器只绑定 `127.0.0.1`,并拒绝来自浏览器页面的请求(Origin/Sec-Fetch/Host 防护),你访问的网页无法驱动桥接器——但**任何本地进程仍然可以**。使用时加载扩展;用完后在 `chrome://extensions` 卸载。
- **看得见的自动化**:被驱动的标签页会戴上 🟣 小标签并播报每一步操作、加入 🟣 标签页分组、命令执行时亮起紫色边框;`node cli.mjs watch` 会在终端同步显示操作流。标签页分组是恶意页面无法伪造的驱动信号。
- **为什么是解压加载的扩展?** 因为你可以直接读到运行的全部代码——整个扩展只有一个可读的 `extension/background.js` 加一个 manifest,没有应用商店的压缩包。
- **提示注入**:桥接器返回的一切都是不可信的页面内容;智能体应遵循的规则见 [AGENTS.md](AGENTS.md)。注意 `upload`:它让浏览器读取智能体指定的任意本地路径并放进页面的文件输入框,页面可以提交它——永远不要让页面告诉你(或智能体)该附加什么文件。

## 命令

<details>
<summary>完整命令表——snap、click、fill、shot、net、emulate、batch、watch 等</summary>

| 命令 | 作用 |
|---|---|
| `tabs` | 列出标签页(id、url、标题、是否被驱动);多个 Chrome 配置同时连接时合并输出,带 `profile` 标记 |
| `profiles` | 列出已连接的 Chrome 配置——id 和 name(用于 `--profile`)+ 版本 |
| `open <url>` · `nav <match> <url> [--diff]` · `close <match>` | 标签页生命周期——`open`/`nav` 等待页面加载完成(8 秒上限) |
| `snap <match> [css] [--diff] [--href] [--find "nl"]` | 无障碍树快照,带 `@eN` 引用——**便宜,优先于截图使用**。可限定子树、与上一次快照对比,`--href` 输出全部链接 URL。`--find "取消按钮"` 由本地 Gemini Nano 挑出匹配行(~2 秒,无云端 token)——是待验证的候选清单,不是绝对正确。`*` 前缀标记上次快照后新增的元素 |
| `click <match> <@ref\|css> [--dbl] [--diff]` | 点击(自动滚动到可见位置,完整 pointer/mouse 事件序列,遮挡检测);`--dbl` 双击 |
| `drag <match> <@ref\|css> <@ref\|css> [--diff]` | 把一个元素拖到另一个上(合成指针序列) |
| `dialog <match> accept\|dismiss [--text s]` | 应答卡死的 JS 对话框(alert/confirm/prompt 会阻塞标签页上的所有其他命令) |
| `fill <match> <@ref\|css> <value> [--diff]` | 设置输入框的值——React 安全(原生 setter + input/change 事件);原生 `<select>` 按选项值或标签匹配 |
| `type <match> <@ref\|css> <text> [--diff]` · `press <match> <key> [@ref] [--diff]` · `hover <match> <@ref\|css> [--diff]` | 逐字符输入(自动补全 UI)、按键(`Control+k` 组合键可用)、悬停 |
| `scroll <match> <up\|down\|top\|bottom\|@ref\|css> [--diff]` | 滚动——自动找到真正的滚动容器(Linear、Gmail 这类应用外壳滚动的是内部面板,不是窗口) |
| `upload <match> <@ref\|css> <file...> [--diff]` | 通过 CDP 设置文件输入框的文件——隐藏输入框也可用;目标是输入框或包裹它的元素 |
| `ask <match> <question>` | *(实验性)* 本地 Gemini Nano 根据页面文本回答——无云端 token,质量仅供预筛 |
| `wait <match> <css\|--text t> [--timeout ms]` | 等待元素或可见文本出现(MutationObserver 驱动,页面一变即返回;默认 10 秒,上限 60 秒) |
| `eval <match> <js\|-> [--world main\|isolated]` | 在页面中执行 JS;`-` 从 stdin 读取 |
| `shot <match> <out> [--max px] [--scale N] [--format jpeg] [--quality N] [--crop x,y,w,h] [--full]` | CDP 截图。长边默认限制为 `--max` 1280px(`0` = 原始分辨率)——模型读取大图时本来就会缩小,原图只增加文件体积不增加细节。`--full` = 整页高度 |
| `net <match> [--dur ms] [--filter s] [--body s]` | CDP 网络抓包(单次 ≤30 秒)——每个请求一行紧凑输出;`--body s` 附加匹配的 JSON/文本响应体 |
| `measure <match> <css>` | 元素位置 + 计算样式,JSON 输出——不看像素也能知道布局真相 |
| `console <match> [--clear] [--ask [q]]` | 页面 console + 未捕获错误(首次调用时安装钩子);`--ask` 用本地 Gemini Nano 分诊日志——只有结论消耗云端 token |
| `grid <match>` | 开关 8px 对齐网格覆盖层 |
| `emulate <match> <w> <h> [mobile]` · `unemulate <match>` | 桌面 / 移动设备视图切换——CDP 模拟,无需调整窗口大小 |
| `resize <match> <w> <h>` | 调整窗口大小 |
| `batch` | 从 stdin 逐行读取命令,一个进程跑完整序列;遇错即停 |
| `mark <match>` · `release <match>` | 添加 / 移除驱动标记(右下角 🟣 标签)+ 标签页分组 |
| `note <match> <text>` | 向人类播报——文本显示在被驱动标签页的小标签及其历史中(小标签本来就显示*做了什么*;note 补充*为什么*) |
| `watch` | 终端里实时显示桥接器的每条命令——小标签的孪生。在智能体会话旁边运行,跟着看;Ctrl-C 退出 |
| `swlogs` | 服务工作线程控制台日志尾部(错误/警告) |
| `start` · `stop` | 服务器生命周期——`start` 在服务器未运行时分离启动(智能体可以自愈挂掉的服务器) |

`<match>` 是标签页 URL 的子串;被驱动的标签页优先,然后是最近活动的。匹配多个时结果会警告并列出其他标签页——用更长的匹配重试,不要盲信选中的那个。引用在重复 `snap` 之间保持稳定(只要 role+name 不变,元素就保持它的 `@eN`),但导航后失效——`nav` 之后请重新 `snap`。

</details>

## 桌面与移动设备模拟

无需调整窗口大小,即可把任何标签页在桌面和移动设备视图之间切换——与 DevTools 设备工具栏相同的机制(CDP 指标 + 触摸 + 移动端 UA):

```bash
node cli.mjs emulate news.ycombinator.com 390 844 mobile   # iPhone 尺寸视图,触摸 + 移动端 UA
node cli.mjs emulate news.ycombinator.com 1440 900         # 桌面尺寸视图
node cli.mjs unemulate news.ycombinator.com                # 恢复正常
```

![被驱动标签页的移动端模拟](docs/mobile.png)

## 省 token 的智能体工作流

1. **先 `snap`**——文本树的 token 开销比截图低大约一个数量级,而且通常已经能回答问题。
2. 保持小巧:`snap <match> "dialog"` 限定子树;操作之后用 `snap --diff` 只返回变化的部分(引用跨快照保持稳定)。
3. **操作 + 观察合为一次调用**:`click <match> @e4 --diff` 执行点击、等待 DOM 安静(3 秒上限),然后在同一结果里附上快照差异——不需要单独的 `wait` 和 `snap` 往返。
4. 只有需要像素时才 `shot`,且尽量便宜:`--max 800 --format jpeg`,或 `--crop` 到组件区域。
5. 布局问题("这个居中了吗?")相信 `measure` 的数字,而不是肉眼。
6. 有依赖关系的步骤用 `batch` 串起来——`printf 'click m @e4\nwait m --text "Saved"\nsnap m --diff\n' | node cli.mjs batch`,整个序列只占一个进程、一次 shell 调用。

## 设计走查

[design-eye.md](design-eye.md)——一套对比实现与 Figma/设计稿的流程,不会漏掉对齐和包含关系等细节。包含 8px 对齐网格覆盖层:

![8px 对齐网格覆盖层](docs/grid.png)

## 开发

`node test/selftest.mjs`——用模拟扩展做端到端检查(不需要 Chrome);每次 push 由 GitHub Actions 自动运行(Node 18/20/22)。如何提交变更(自测门禁、版本号、标签、风格)见 [AGENTS.md](AGENTS.md) 的 *Developing* 一节。

chrome-bridge **不在 npm 上**——唯一的安装途径就是本仓库(`npm install chrome-bridge` 装到的是无关的同名包)。要固定智能体运行的代码,请签出标签——例如 `git checkout v1.4.1`;`git tag -l` 列出最新标签。

## 许可证

MIT
