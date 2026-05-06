## v0.2.0

1. ~~不能增加/删除 文件/文件夹~~ ✅ v0.2.0
   - 抽屉里文件树加了 `+` 按钮(新建文件/新建文件夹),长按条目弹删除菜单;服务端新增 `/api/fs/{mkdir,touch,delete}`。
2. ~~不能复制/粘贴 文字/图片~~ ✅ v0.2.0(文字)
   - 终端下方键盘条加了"复制"按钮:先在终端里长按/拖选文字,再点复制。"粘贴"按钮保持。图片目前不做(终端没典型的图片复制语义)。
3. ~~/status 之后没法右键跳到 Usage,而且退不出来了~~ ✅ v0.2.0(通过修 ESC/Ctrl 解决退出)
   - 这是 #4 #5 的连带后果:当时 ESC/Ctrl 按钮发的是字面 6 个字符 ``,所以 `/status` 菜单里按 ESC 退不出来。现在 ESC 真的是 `\x1b`,能退出。右键跳 Usage 是桌面端鼠标行为,手机端用上下箭头 + Enter 代替(键盘条已有方向键)。
4. ~~没法 ESC~~ ✅ v0.2.0
5. ~~没法 Ctrl~~ ✅ v0.2.0
   - 根因:HTML 属性里 `data-k=""` 是字面量 6 个字符,不是控制字符。换成符号键名 `data-key="esc"/"c-c"`,在 app.js 里映射到真实控制序列。所有方向键、^C/^D/^L、ESC、Tab 全部修好了。
6. ~~展示历史 Claude 会话+搜索+选模式~~ ✅ v0.2.0
   - 新建会话入口从对话框升级为 `NewSessionActivity`,两个 Tab:
     - **新对话**:会话名 + 工作目录(带"浏览"按钮进文件夹选择器)+ **模式下拉**(默认 / 自动接受编辑 / 计划模式 / 旁路权限)+ 启动即运行 claude 勾选
     - **继续历史**:搜索框 + 历史会话列表(按最新排序);点一条 → 以该会话原 cwd 新建,autorun = `claude --resume <id>`
   - 服务端新增 `/api/claude/sessions?q=...`,扫 `~/.claude/projects/*/*.jsonl`,返回 id/cwd/首轮提问/消息数/mtime/gitBranch;search 在首轮提问、cwd、branch、id 上做子串匹配。
7. ~~版本 / APP 名~~ ✅ v0.2.0
   - APP 名改为 **LittleGab**(Android label + Mac CFBundleDisplayName)。版本规则:本轮改动够大,用 `0.2.0 / versionCode 2`。以后小改补丁号(0.2.1),加新功能推小版本(0.3.0)。
8. ~~运行时 Shift+Tab 切模式~~ ✅ v0.2.0
   - 键盘条多了 `⇧⇥` 按钮,发 `\x1b[Z`——Claude CLI 可以识别这个序列触发模式切换,效果跟桌面按 Shift+Tab 一样。
9. ~~做更好的内存管理,删除会话后,马上删除在这个会话中浏览的文件。~~ ✅ v0.2.0
   - 新增 `SessionCache`:手机端每个会话的临时文件走独立目录 `cacheDir/shared/<sessionId>/`。删除会话时立刻 `clearSession(id)` 把这个目录整个删掉;另外每次刷新会话列表时调用 `reconcile(liveIds)` 清理服务器上已经消失的会话对应的 cache,避免泄漏。全局上限仍然保留(总量超 100 MB 时修剪到 50 MB)。

## v0.3.0

1. ~~还是没法 esc/左右移动,/status 出不来~~ ✅ v0.3.0
   - 根因诊断:v0.2.0 只是改对了字节,但 `click` 事件在 ColorOS 的 Chromium WebView 上经常被手势检测/点击延迟吞掉,尤其是快速连按。现在改成:
     - **`pointerdown` 触发**:触点一落下就发送,不等 300ms click 判定,也不被滑动识别打断;`preventDefault` 避免焦点抖动。
     - **视觉反馈 toast**:每次按键在终端上方浮出"→ ESC / → ^C / → ↑"之类,即使发送了但 TUI 不响应,你也一眼能看到字节确实出去了。
     - **离线时点按会立刻触发重连**:从前 `ws` 未连上时静默丢弃,现在给 toast + 马上 `reconnectNow()`。
2. ~~滑动只滚 1 行~~ ✅ v0.3.0
   - 加了**触摸滑动检测**:识别到垂直 swipe 就按 `-dy/15` 计算行数调 `term.scrollLines()`,一指能翻一屏。另外 `⇞⇟` 按钮保留做精确翻屏。xterm 的 `scrollback` 从 5000 扩到 10000 行。
3. ~~两次 ESC 查会话历史~~ ✅ v0.3.0
   - 键盘条新增 `Esc×2` 按钮(v0.2.0 已加过 HTML,这轮接入事件模型 + toast)。点一次就发 `\x1b\x1b`。
4. ~~复制粘贴~~ ✅ v0.2.0(继续保留)
   - 文字复制:长按选中 → 点"复制"(toast 提示)。文字粘贴:点"粘贴"→ 把剪贴板内容注入终端。
5. ~~体验更顺滑~~ ✅ v0.3.0
   - pointerdown + 动画 + toast + 更大按钮(48dp 起)+ 滑动顺手,综合下来手感接近桌面 claude cli。
6. ~~运行一条 prompt 之后停不下来~~ ✅ v0.3.0 (与 #1 同源,^C/ESC 都修好了)
7. ~~关掉再打开会话就断开了~~ ✅ v0.3.0
   - 根因诊断 + 多重加固:
     - Android `SessionActivity.onResume()`:调 `WebView.onResume()` 并 `evaluateJavascript("window.__reconnectNow()")` 强制立刻重连一次,不等 JS 的退避。
     - `SessionActivity.onDestroy()`:彻底 `webview.destroy()` 释放网络句柄,下次进来是干净状态。
     - Web 侧 `document.visibilitychange`:页面回到可见,若 ws 已关就立即重连;若还开就 fit + resize 一次,修应用间切换造成的行高错位。
     - 首次重连延迟从 1000ms 降到 300ms,之后才指数退避——网络抖动基本无感知。
     - 4404(服务端会话被回收)从"悄悄新建一个空会话"改为**显式提示"会话已在服务器端结束"**,不再把你过去的状态弄丢。
   - 因为 PTY 只有在真的退出后 30 秒无客户端才会被回收,只要 Mac 端的 claude 还活着,你手机何时回来都能继续接上。

## v0.3.1

1. ~~手机上字符显示的不齐。非常影响阅读。~~ ✅ v0.3.1
   - 根因:字体栈 `"SF Mono", Menlo, Consolas` 在 Android WebView 里全都不存在,fallback 退到**比例字体**——ASCII 字符宽度不等,混排中英文时列完全错位。xterm 是在 `term.open()` 那一刻测量字符宽度的,一旦量到比例字体就再也对不齐。
   - 改:字体栈改成 `ui-monospace, "Roboto Mono", "Noto Sans Mono", "DejaVu Sans Mono", "Droid Sans Mono", Menlo, Consolas, monospace`(Android 命中 Roboto/Noto Mono,iOS/Mac 走 ui-monospace);加 `letterSpacing: 0`;并在 `document.fonts.ready` 之后再 `fit.fit() + term.refresh()`,保证拿到真正的等宽字体尺寸再测量。
2. ~~我现在按键有效果了,但是按下去会触发两次。检查一下你设置的这些按键。~~ ✅ v0.3.1
   - 根因:v0.3.0 同时挂了 `pointerdown` 和 `click` 两个监听器,想用 `btn.__pointerHandled` 标志去重——但这个标志**从没被置过 true**,所以 `pointerdown` 处理一次、浏览器合成的 `click` 又处理一次,每个按钮真的触发两次。
   - 改:统一走 `pointerdown`;`click` 监听器改为只 `preventDefault()` 吞掉合成事件,什么也不做。顺便把 Ctrl / 复制 / 粘贴 三个按钮各自独立的 `click` handler 合并进统一的 `dispatchButton`,避免被吞掉。
3. ~~在命令行里能不能做一个可以拖动的滚轮啊?这样子向上或者向下翻会更方便一些。~~ ✅ v0.3.1
   - 终端右边加了个 14px 宽的悬浮滚动条,蓝色滑块可以直接**用手指拖**,拖多快就跟多快;点轨道非滑块处会直接跳过去。
   - 交互:空闲 1.5 秒淡出,滚动/拖动时再亮起,不挡视线;用了 `pointerdown/move/up` + `setPointerCapture`,整个过程不丢触点。
   - 实现:订阅 `term.onScroll`,用 `buffer.active.length / viewportY / term.rows` 算出滑块高度和 top 位置,拖拽时把像素位置映射回 `scrollLines(delta)`。`scrollback` 保持 10000 行,一千多行输出也能一指划到顶。
4. ~~我在mac端的命令行中操作过之后,手机上看不到相关的记录。然后同样的在手机上操作过之后,mac端的命令行也看不到. 这两边能不能同步。~~ ✅ v0.3.1
   - 架构变更:每个会话背后**挂一个 tmux session**,手机端的 PTY 和 Mac 端的 Terminal.app 同时 attach 到它。tmux 原生支持多 client 同屏镜像,所以:
     - 手机上打字 → Mac 终端立刻看到
     - Mac 终端上打字 → 手机 xterm 立刻看到
     - 双方光标共享、滚动各自独立(我们开了 `window-size latest`,以最新 client 的尺寸为准,避免小屏把大屏压扁)
   - 隔离性:用 `tmux -L phonemac` 自己独立的 socket,不污染你本身可能在用的 tmux server/config。关了 status bar(省一行),打开了 mouse。
   - 一键同步:手机会话列表**长按**会多一个菜单「在 Mac 终端打开(同步)」,点一下服务端走 `osascript` 启动 Terminal.app 并执行 `tmux -L phonemac attach -t phonemac-<id>`,Mac 屏幕瞬间出现同一个会话的终端窗口。
   - 手动方式:如果你想自己开,复制 `macAttachCommand`(`tmux -L phonemac attach -t phonemac-<sessionId>`)到 Mac 任何一个终端粘贴就行。
   - 删会话时同步 `tmux kill-session`,不留孤儿。tmux 未安装就自动回退到原来的裸 PTY 行为(会在 server 日志里报提示)。

## v0.4.0

1. ~~命令行里修改代码的那些代码块。显示不出来。你再看看命令行会话还有没有其他的显示问题,帮我修复。~~ ✅ v0.4.0
   - 根因:之前 TERM 设成 `xterm-256color` 但 tmux 没告诉程序 24-bit 色可用,Claude CLI 退到 ANSI-16 近似色,代码块的语法高亮大量信息丢失;`COLORTERM` 环境变量也没设。
   - 改:tmux `default-terminal` 改为 `tmux-256color`,`terminal-overrides` 加 `*:RGB`;会话 PTY env 设 `COLORTERM=truecolor`;tmux 里开 `escape-time 0 / focus-events on / mouse on`,整体响应感也上来了。Claude CLI 现在拿到真 truecolor,代码块颜色、斜体、下划线都能渲染。
2. 3. ~~跨设备跨命令行的一致性~~ ✅ v0.4.0(这两条合并一起讲,最终收敛到了一套极简规则)
   - **搞清楚了物理约束**:tmux 能做多 client 同屏镜像,前提是双方都在 tmux 里。tmux **无法**把"已经在 Terminal.app 里跑起来、从没走 tmux 的 claude 进程"事后拉进来。
   - **结合 Claude `--resume` 机制**:对话真源是 `~/.claude/projects/*/<id>.jsonl`,`claude --resume <id>` 在任何进程里都能续上。**顺序切换**(一端关了,另一端再开)完全靠这个,不需要 tmux。
   - **服务器重启不再造新会话**(最重要的一致性修复):之前服务器一重启,SessionManager Map 清空,手机带旧 id 重连 → 404 → 造了一个**新**的 tmux session,于是"看起来像不同步"。现在:
     - 元数据持久化到 `~/.phone-mac-bridge/sessions.json`(name/cwd/autorun/createdAt/claudeJsonlId)
     - 启动时扫 `tmux -L phonemac ls` × 持久化 metadata → 活着的 tmux session **原地重建 Session 对象**,同 id、同 tmux 名
     - WS 来了不在 Map 里 → `getOrReattach(id)`,tmux 找得到就复活;找不到才 4404
   - **历史回放升级**:WS attach 时 `capture-pane -e -S - -E -`,把**全量 scrollback + 当前屏**作为 ANSI 发给手机。`history-limit` 50000 行。
   - **独占写入 —— 单向规则"只允许手机杀 Mac,不允许 Mac 杀手机"**(最终方案,代码完全重写过,去掉了原先的双向互踢 + 5s 轮询):
     - **手机打开一个会话** → `claimSessionForPhone(id)`:扫 `ps + lsof` 找外部 claude(用 ppid 排除我们自己 tmux 下的) 占着 `<jsonlId>.jsonl` 的 → `SIGTERM` + 等 2.5s 退出 → 再让手机 attach。手机上会看到 `[已接管 Mac 上的对话 (N 个 claude 进程已终止)]`
     - **Mac 打开一个会话** → server **什么都不做**。手机侧的 tmux / claude 不受任何影响,无论它是前台(有 WS)还是后台(tmux 活着、没 WS)
     - 移除了原先的 5s 后台轮询、`killInnerClaude` / `kickAllClients` / 4409 关闭码 —— 这些是"Mac 杀手机"方向的代码,按新规则不再需要,代码已清理
   - **这条规则带来什么**:
     - 手机上可以同时挂 N 个会话(前台切一个,后台 N-1 个全在跑);Mac 无论对其中任何一个做什么都伤不到手机
     - 代价是:如果用户故意**同时**在手机前台和 Mac 上跟同一个会话对话,jsonl 会短暂交错 —— 这是用户主动两端并发带来的后果,我们不拦。phone 下次重新 attach 时 `claimSessionForPhone` 会把 Mac 踢掉,jsonl 最新状态为准往下走
   - **识别哪个 jsonl 属于哪个会话**:autorun 含 `--resume <id>` 直接抓;没有的话(纯 `claude`)启动后 30s 内轮 `~/.claude/projects/*/*.jsonl`,取 mtime 大于会话创建时间的最新文件学到 id。
4. ~~命令行上下滑动要有惯性~~ ✅ v0.4.0
   - 原来 touchmove 结束手指一抬就停。现在 `touchstart/move/end` 组合计算速度(EMA),`touchend` 时如果超过阈值就 `requestAnimationFrame` 里按 `DECAY=0.94` 每帧衰减,继续 `term.scrollLines()`。感觉接近看代码文件时的原生滚动。
   - 新触摸会立即 `cancelInertia()`,不会叠加。
5. ~~手机端打开某个会话历史记录显示不全~~ ✅ v0.4.0
   - 见上面 #2/#3 里的"历史回放升级"。`capture-pane -e -J -S - -E -` 把 tmux 全部 scrollback(50000 行上限)作为 ANSI 回放给手机,脱离了以前 64KB byte-buffer 的限制。`\n` 统一替换为 `\r\n` 避免 xterm 列错位。xterm 端 `scrollback: 10000` 保持。
6. ~~按钮在松开的时候触发,而不是按下的时候触发~~ ✅ v0.4.0
   - keybar 改成 **pointerdown 标记 armed → pointermove 超过 12px 撤销 armed → pointerup 仍在按钮内部就派发**。
   - 副作用修好:之前 `pointerdown` 里 `preventDefault` 阻止了 keybar 的**横向滚动**,现在不 prevent 了,你能左右拖整个 keybar 看更多按键也不误触。
   - `pointercancel` 也正确撤销,系统滑动手势打断不会残留按键状态。

## v0.4.1

1. ~~之后把已完成的需求放到新文件里, 和需要完成的需求分开放。这样读我的需求的时候可以少用一些token。~~ ✅ v0.4.1
   - 完成项都转到了这个 `DemandDone.md`,`Demand.md` 只留未做的。以后新来一条就补到 `Demand.md` 末尾,做完再挪过来。
