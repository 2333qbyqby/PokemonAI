# PC、手机与 PWA

项目只维护一套 Preact/TypeScript 客户端。PC 和手机共享相同战斗状态、队伍选择和
挑战逻辑，通过响应式 CSS 改变布局，而不是复制两套容易分叉的业务代码。

## UI 调整

- 首页把“AI 对战”和“阵容库”放在主要位置；
- 对战启动器按“规则 → 难度 → 队伍”排列；
- 难度卡同时显示等级、名称和行为说明；
- 阵容库支持按 format 筛选，展示 6 只宝可梦、体系标签、来源和校验状态；
- 620px 以下切换为单列，点击区域最小约 42～52px；
- 使用 `safe-area-inset-*` 避开 iPhone 刘海、Home Indicator 和移动浏览器底栏；
- Showdown 原有双打目标与行动面板继续负责精确交互，避免复制协议逻辑。

## PWA

`manifest.webmanifest` 和 `pokemonai-sw.js` 提供可安装外壳。Service Worker：

- 预缓存启动 HTML、manifest、PokemonAI CSS、图标和阵容目录；
- 对本域 JS/JSON/HTML 使用 network-first，并缓存成功响应；
- 对静态资源使用 cache-first；
- 明确不拦截 `/showdown/` WebSocket/服务请求。

PWA 让页面像应用一样从主屏幕启动，并能在短暂断网时打开已缓存的启动器和阵容库。
**它不包含浏览器内 Showdown 服务端或 AI 进程，因此不能在完全离线状态完成对战。**

## 本地手机使用

```powershell
.\scripts\start-local.ps1 -ListenLan
```

手机与电脑连接同一可信 Wi-Fi，打开脚本显示的地址。局域网模式是 HTTP；部分浏览器只
在 HTTPS 或 localhost 提供完整 PWA 安装/剪贴板能力，因此局域网调试时可能只得到
普通网页体验。生产 Docker/Caddy 部署使用 HTTPS，可获得完整 PWA 能力。

## 原生壳

当前没有提交 Capacitor、Tauri、Android 或 iOS 原生工程。若以后需要商店安装包，
建议：

- 移动端用 Capacitor 包装同一 Web 产物；
- 桌面端可选 Tauri；
- 战斗服务器仍作为局域网/VPS 服务，或另行投入工作做真正的本地嵌入。

在没有完成离线规则引擎与 AI 进程嵌入前，不应把 WebView 包装误称为离线客户端。
