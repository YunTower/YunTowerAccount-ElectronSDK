# YunTowerAccount-ElectronSDK

云塔账号通行证 Electron 桌面端 SDK，支持在桌面应用中拉起浏览器完成授权，并通过自定义 URL 方案回到应用、获取 token 与用户信息。

- 官网：[https://account.yuntower.com](https://account.yuntower.com)
- 文档：[https://docs.yuntower.com/account/open.html](https://docs.yuntower.com/account/open.html)
- NPM：[https://www.npmjs.com/package/@yuntower/yuntower-account-electron-sdk](https://www.npmjs.com/package/@yuntower/yuntower-account-electron-sdk)

```bash
npm install @yuntower/yuntower-account-electron-sdk
```

依赖：`electron >= 20`（peerDependency）

---

## 快速开始

接入前请在云塔账号通行证**应用详情页**为该应用配置并加入白名单的**重定向地址**（如 `myapp://callback`）。授权完成后浏览器会重定向到该地址；Electron 侧使用的**方案名**（`protocol`）与**重定向 URL**（`redirectUrl`）须与后台一致。下例中的 `myapp` 请替换为本应用已注册的方案名与地址。

在主进程中：① 在 **app.ready 之前** 创建 SDK 并调用 `install(app)`，将当前应用注册为该 URL 方案的默认处理程序；② 在需要登录时调用 `launchAuthorization()`，会打开系统浏览器，用户完成授权后通过重定向回到应用，Promise 返回 `{ token, user }`。  
开发环境（如 `electron .`）须对 `install(app)` 传入第二、第三参数（见下方示例）；生产环境直接 `sdk.install(app)`。使用 electron-builder 打包时，若需在安装时注册 URL 方案，可在 `package.json` 的 `build.protocols` 中配置 `schemes`（与 SDK 的 `protocol` 一致）。

---

### 完整示例：主进程入口 `main.js`

单实例锁保证通过 URL 方案唤起时由已运行实例处理回调；渲染进程通过 IPC 发送 `start-oauth` 触发登录，主进程将结果通过 `oauth-success` / `oauth-error` 回传。

```js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const YunTowerAccountElectronSDK = require('@yuntower/yuntower-account-electron-sdk').default;

// 替换为你在后台配置的 appid、appsecret 及已加入白名单的 URL 方案与重定向地址
const APP_ID = 'YOUR_APP_ID';
const APP_SECRET = 'YOUR_APP_SECRET';
const REDIRECT_URL = 'myapp://callback';
const PROTOCOL = 'myapp';

const sdk = new YunTowerAccountElectronSDK(APP_ID, APP_SECRET, {
  redirectUrl: REDIRECT_URL,
  protocol: PROTOCOL,
  scope: 'user:profile,user:email',
});

// 必须在 app.ready 之前注册 URL 方案
if (process.defaultApp && process.argv.length >= 2) {
  sdk.install(app, process.execPath, [path.resolve(process.argv[1])]);
} else {
  sdk.install(app);
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

let mainWindow = null;

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => { mainWindow = null; });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 渲染进程点击「登录」时发送 'start-oauth'，此处发起授权并将结果回传
ipcMain.on('start-oauth', async () => {
  if (mainWindow) mainWindow.webContents.send('oauth-started');
  try {
    const { token, user } = await sdk.launchAuthorization({
      scope: 'user:profile,user:email',
      fetchUser: true,
    });
    if (mainWindow) mainWindow.webContents.send('oauth-success', { token, user });
  } catch (err) {
    if (mainWindow) mainWindow.webContents.send('oauth-error', { message: err.message });
  }
});
```

### 渲染进程示例：`index.html` 中触发登录并接收结果

```html
<button id="loginBtn">使用云塔账号登录</button>
<pre id="result"></pre>
<script>
  const { ipcRenderer } = require('electron');
  const btn = document.getElementById('loginBtn');
  const result = document.getElementById('result');

  btn.onclick = () => ipcRenderer.send('start-oauth');

  ipcRenderer.on('oauth-started', () => {
    result.textContent = '已打开浏览器，请在浏览器中完成授权…';
  });
  ipcRenderer.on('oauth-success', (event, { token, user }) => {
    result.textContent = JSON.stringify({ token: { ...token, access_token: token.access_token?.slice(0, 20) + '…' }, user }, null, 2);
  });
  ipcRenderer.on('oauth-error', (event, err) => {
    result.textContent = '授权失败: ' + (err.message || err);
  });
</script>
```