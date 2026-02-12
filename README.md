# YunTower Account Electron SDK

云塔账号通行证 Electron 桌面端 SDK。

## 安装

```bash
npm install @yuntower/yuntower-account-electron-sdk
# 或
pnpm add @yuntower/yuntower-account-electron-sdk
```

依赖：`electron >= 20`（peerDependency）。  
Open API 地址与授权页地址由 SDK 内部固定，不可配置。

## 配置与发起授权

1. 在应用**主进程**、且 **app.ready 之前** 创建 SDK 并调用 `install(app)`，用于注册自定义协议并监听回调。
2. 在应用管理后台将自定义协议回调地址加入白名单（如 `yttest://`）。
3. 用户点击「登录」时调用 `launchAuthorization()`，会打开系统浏览器到授权页；用户完成后通过 `yttest://callback?...` 回到应用，Promise 返回 `{ token, user }`。

```js
const { app } = require('electron');
const path = require('path');
const YunTowerAccountElectronSDK = require('@yuntower/yuntower-account-electron-sdk').default;

const sdk = new YunTowerAccountElectronSDK('YOUR_APP_ID', 'YOUR_APP_SECRET', {
  redirectUrl: 'yttest://callback',
  protocol: 'yttest',
  scope: 'user:profile,user:email',
});

// 开发模式：传入 execPath 与 execArgv 以便协议能正确打开当前应用
if (process.defaultApp && process.argv.length >= 2) {
  sdk.install(app, process.execPath, [path.resolve(process.argv[1])]);
} else {
  sdk.install(app);
}

app.whenReady().then(() => {
  // 创建窗口等
});

// 在需要发起登录时（例如 IPC 或菜单）
async function onLoginClick() {
  const { token, user } = await sdk.launchAuthorization({
    scope: 'user:profile,user:email',
    fetchUser: true,
  });
  console.log('access_token:', token.access_token);
  console.log('用户信息:', user);
}
```

## API 与 PHP/Node SDK 对齐

- `getUserToken(code, options?)` — 用授权码换 token，可选 `accessTokenExpiresIn`、`refreshTokenExpiresIn`（秒，超出上限抛错）。
- `getUserInfo(access_token)` — 获取用户信息。
- `refreshUserToken(refresh_token)` — 刷新 token。
- `logout(access_token)` — 退出登录。
- `getThirdPartyAccount(access_token)` — 获取第三方关联 UID。
- `setUserNickname(access_token, nickname)` — 设置昵称（1–64 字符，否则抛错）。
- `setUserAvatar(access_token, image)` — 设置头像，`image` 为 Buffer、Blob 或本地路径，≤15MB，否则抛错。

## 发起授权

- `launchAuthorization(options?)`  
  - 打开系统浏览器到授权页，用户完成后通过自定义协议回到应用，Promise 返回 `{ token, user? }`。  
  - `options.scope`、`options.accessTokenExpiresIn`、`options.refreshTokenExpiresIn`、`options.fetchUser`（默认 true）。

约束与 Node SDK 一致：access_token 最长 12 天、refresh_token 最长 24 天；昵称 1–64 字符；头像 ≤15MB。
