/**
 * YunTower Account Electron SDK
 */

const ACCESS_TOKEN_MAX_EXPIRE = 12 * 24 * 3600;
const REFRESH_TOKEN_MAX_EXPIRE = 24 * 24 * 3600;
const AVATAR_MAX_SIZE = 15 * 1024 * 1024;

const DEFAULT_API_HOST = "https://v1.api.account.yuntower.com";
const DEFAULT_AUTH_URL = "https://account.yuntower.com";

const ALLOWED_SCOPES = [
  "user:profile",
  "user:email",
  "connect:codemao_uid",
  "connect:pgaot_uid",
  "connect:dao3_uid",
] as const;

export type AllowedScope = (typeof ALLOWED_SCOPES)[number];

export interface ElectronSDKOptions {
  /** 自定义协议回调地址（如 yttest://callback） */
  redirectUrl?: string;
  /** 自定义协议名（如 yttest），用于 setAsDefaultProtocolClient */
  protocol?: string;
  /** 默认 scope，发起授权时可覆盖 */
  scope?: string;
}

/** launchAuthorization 的选项 */
export interface LaunchAuthorizationOptions {
  /** 授权 scope，不传则用 constructor 的 scope */
  scope?: string;
  /** access_token 有效期（秒），最大 12 天 */
  accessTokenExpiresIn?: number;
  /** refresh_token 有效期（秒），最大 24 天 */
  refreshTokenExpiresIn?: number;
  /** 授权成功后是否拉取用户信息，默认 true */
  fetchUser?: boolean;
}

/** 接口返回的 token 数据结构 */
export interface TokenData {
  access_token: string;
  access_token_expires_in: number;
  access_token_expires_at: string;
  refresh_token: string;
  refresh_token_expires_in: number;
  refresh_token_expires_at: string;
}

/** 发起授权成功后的结果 */
export interface AuthorizationResult {
  token: TokenData;
  user?: Record<string, unknown>;
}

type ElectronApp = {
  setAsDefaultProtocolClient: (
    protocol: string,
    path?: string,
    args?: string[],
  ) => boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
};

type ElectronShell = {
  openExternal: (url: string) => Promise<void>;
};

export class YunTowerAccountElectronSDK {
  readonly config: {
    api: string;
    appid: string;
    appsecret: string;
    authUrl: string;
    redirectUrl: string;
    protocol: string;
    scope: string;
  };

  private _oauthState: string | null = null;
  private _authResolve: ((result: AuthorizationResult) => void) | null = null;
  private _authReject: ((err: Error) => void) | null = null;
  private _installDone = false;

  /**
   * 创建 SDK 实例
   * @param appid 应用 ID
   * @param appsecret 应用密钥
   * @param options 可选配置：redirectUrl、protocol、scope
   */
  constructor(
    appid: string,
    appsecret: string,
    options: ElectronSDKOptions = {},
  ) {
    if (!appid || !appsecret) {
      console.error("[YunTowerAccountElectronSDK] 参数缺失");
    }
    const scope = options.scope ?? "user:profile,user:email";
    this._validateScope(scope);
    this.config = {
      api: DEFAULT_API_HOST,
      appid,
      appsecret,
      authUrl: DEFAULT_AUTH_URL,
      redirectUrl: options.redirectUrl ?? "",
      protocol: options.protocol ?? "yuntower",
      scope,
    };
  }

  /**
   * 校验 scope 字符串
   */
  private _validateScope(scopeStr: string): void {
    const parts = scopeStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const allowedSet = new Set<string>(ALLOWED_SCOPES);
    for (const p of parts) {
      if (!allowedSet.has(p)) {
        throw new Error(
          `不支持的 scope: "${p}"，仅支持：${ALLOWED_SCOPES.join(", ")}`,
        );
      }
    }
  }

  /**
   * 安装协议与回调监听，必须在 app.ready 之前调用（用于发起授权流程）
   * @param app Electron 的 app 实例
   * @param execPath 可选，开发模式下传入 process.execPath
   * @param execArgv 可选，开发模式下传入 [path.resolve(process.argv[1])]
   */
  install(app: ElectronApp, execPath?: string, execArgv?: string[]): void {
    if (this._installDone) return;
    const protocol = this.config.protocol;
    if (execPath && execArgv) {
      app.setAsDefaultProtocolClient(protocol, execPath, execArgv);
    } else {
      app.setAsDefaultProtocolClient(protocol);
    }
    app.on("second-instance", (_event: unknown, commandLine: unknown) => {
      const args = Array.isArray(commandLine) ? commandLine : [];
      const url = args.find(
        (arg): arg is string =>
          typeof arg === "string" && arg.startsWith(`${protocol}://`),
      );
      if (url) this._handleOAuthCallback(url);
    });
    app.on("open-url", (_event: unknown, url: unknown) => {
      if (typeof url === "string" && url.startsWith(`${protocol}://`))
        this._handleOAuthCallback(url);
    });
    this._installDone = true;
  }

  /** 当前授权流程是否请求拉取用户信息 */
  private _authFetchUser = true;
  /** 当前授权流程的自定义 token 有效期 */
  private _authTokenExpiry: {
    accessTokenExpiresIn?: number;
    refreshTokenExpiresIn?: number;
  } = {};

  /**
   * 发起授权
   * 调用前须已执行 install(app)，且 constructor 中已配置 redirectUrl / protocol。
   * @param opts 可选：scope、accessTokenExpiresIn（秒，最大 12 天）、refreshTokenExpiresIn（秒，最大 24 天）、fetchUser（默认 true）
   * @returns 授权成功时 resolve { token, user? }，失败或用户拒绝时 reject
   * @throws 若 accessTokenExpiresIn / refreshTokenExpiresIn 超过上限会抛错
   */
  async launchAuthorization(
    opts: LaunchAuthorizationOptions = {},
  ): Promise<AuthorizationResult> {
    const authUrl = this.config.authUrl;
    const redirectUrl =
      this.config.redirectUrl || `${this.config.protocol}://callback`;
    if (!authUrl || !this.config.protocol) {
      throw new Error("发起授权需要配置 authUrl 与 protocol（或 redirectUrl）");
    }
    this._validateTokenExpiry(
      opts.accessTokenExpiresIn,
      opts.refreshTokenExpiresIn,
    );
    const scope = opts.scope ?? this.config.scope;
    this._validateScope(scope);
    const state = require("crypto").randomBytes(16).toString("hex");
    this._oauthState = state;
    this._authFetchUser = opts.fetchUser !== false;
    this._authTokenExpiry = {
      accessTokenExpiresIn: opts.accessTokenExpiresIn,
      refreshTokenExpiresIn: opts.refreshTokenExpiresIn,
    };
    const params = new URLSearchParams({
      type: "desktop",
      appid: this.config.appid,
      scope,
      redirect_url: redirectUrl,
      state,
    });
    const url = `${authUrl.replace(/\/$/, "")}/auth/app?${params.toString()}`;
    const electron = require("electron") as { shell: ElectronShell };
    await electron.shell.openExternal(url);
    return new Promise<AuthorizationResult>((resolve, reject) => {
      this._authResolve = (result) => {
        this._authResolve = null;
        this._authReject = null;
        resolve(result);
      };
      this._authReject = (err) => {
        this._authResolve = null;
        this._authReject = null;
        reject(err);
      };
    });
  }

  /** 自定义协议回调 URL 被打开时调用，用 URL 中的 code 换 token 并 resolve */
  private async _handleOAuthCallback(callbackUrl: string): Promise<void> {
    try {
      const url = new URL(callbackUrl);
      const params = Object.fromEntries(url.searchParams);
      if (params.state !== this._oauthState) {
        this._authReject?.(new Error("State 验证失败，可能存在安全风险"));
        this._oauthState = null;
        return;
      }
      this._oauthState = null;
      if (params.status !== "success") {
        this._authReject?.(
          new Error(params.status === "denied" ? "用户拒绝授权" : "授权失败"),
        );
        return;
      }
      const code = params.code;
      if (!code) {
        this._authReject?.(new Error("未收到授权码"));
        return;
      }
      const tokenData = await this._exchangeCodeForToken(code);
      let user: Record<string, unknown> | undefined;
      if (this._authFetchUser) {
        const userRes = await this.getUserInfo(tokenData.access_token);
        user = (userRes as { data?: Record<string, unknown> }).data;
      }
      this._authResolve?.({ token: tokenData, user });
    } catch (e) {
      this._authReject?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  /** 用授权码向服务端换取 access_token / refresh_token */
  private async _exchangeCodeForToken(code: string): Promise<TokenData> {
    const body: Record<string, unknown> = {
      code,
      appid: this.config.appid,
      appsecret: this.config.appsecret,
    };
    if (
      this._authTokenExpiry.accessTokenExpiresIn != null &&
      this._authTokenExpiry.accessTokenExpiresIn > 0
    ) {
      body.access_token_expires_in = this._authTokenExpiry.accessTokenExpiresIn;
    }
    if (
      this._authTokenExpiry.refreshTokenExpiresIn != null &&
      this._authTokenExpiry.refreshTokenExpiresIn > 0
    ) {
      body.refresh_token_expires_in =
        this._authTokenExpiry.refreshTokenExpiresIn;
    }
    const res = await this._fetch(
      `${this.config.api}/user/token/get`,
      "POST",
      body,
    );
    const result = res as { code?: number; msg?: string; data?: TokenData };
    if (result.code !== 0) {
      throw new Error(result.msg || "换取 token 失败");
    }
    if (!result.data) throw new Error("换取 token 失败");
    return result.data;
  }

  /** 校验自定义 token 有效期不超过 12 天 / 24 天，否则抛错 */
  private _validateTokenExpiry(access?: number, refresh?: number): void {
    if (access != null && access > ACCESS_TOKEN_MAX_EXPIRE) {
      throw new Error(
        `access_token 有效期不能超过 ${ACCESS_TOKEN_MAX_EXPIRE} 秒（12 天）`,
      );
    }
    if (refresh != null && refresh > REFRESH_TOKEN_MAX_EXPIRE) {
      throw new Error(
        `refresh_token 有效期不能超过 ${REFRESH_TOKEN_MAX_EXPIRE} 秒（24 天）`,
      );
    }
  }

  /** 发起 JSON POST/GET 请求并返回解析后的 JSON */
  private async _fetch(
    url: string,
    method: "GET" | "POST",
    data: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    const opt: RequestInit = {
      method,
      headers: { "Content-Type": "application/json", ...headers },
    };
    if (method === "POST") opt.body = JSON.stringify(data);
    const response = await fetch(url, opt);
    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
    return response.json();
  }

  /**
   * 用授权码换取 access_token 与 refresh_token
   * @param code 授权码（通常来自授权回调 URL 的 code 参数）
   * @param options 可选：accessTokenExpiresIn、refreshTokenExpiresIn（单位秒，分别最大 12 天、24 天）
   * @returns 接口原始响应（含 code、msg、data），data 内含 access_token、refresh_token、expires_in 等
   * @throws 当 accessTokenExpiresIn / refreshTokenExpiresIn 超过上限时抛错
   */
  async getUserToken(
    code: string,
    options?: { accessTokenExpiresIn?: number; refreshTokenExpiresIn?: number },
  ): Promise<unknown> {
    this._validateTokenExpiry(
      options?.accessTokenExpiresIn,
      options?.refreshTokenExpiresIn,
    );
    const body: Record<string, string | number> = {
      code,
      appid: this.config.appid,
      appsecret: this.config.appsecret,
    };
    if (
      options?.accessTokenExpiresIn != null &&
      options.accessTokenExpiresIn > 0
    ) {
      body.access_token_expires_in = options.accessTokenExpiresIn;
    }
    if (
      options?.refreshTokenExpiresIn != null &&
      options.refreshTokenExpiresIn > 0
    ) {
      body.refresh_token_expires_in = options.refreshTokenExpiresIn;
    }
    return this._fetch(
      `${this.config.api}/user/token/get`,
      "POST",
      body as Record<string, unknown>,
    );
  }

  /**
   * 获取当前用户信息
   * @param access_token 用户访问凭证
   * @returns 接口原始响应，data 内含 profile、email、connect 等（依 scope 而定）
   */
  async getUserInfo(access_token: string): Promise<unknown> {
    return this._fetch(`${this.config.api}/user/data`, "POST", {
      appid: this.config.appid,
      appsecret: this.config.appsecret,
      access_token,
    });
  }

  /**
   * 使用 refresh_token 刷新并获取新的 access_token 与 refresh_token
   * @param refresh_token 刷新凭证
   * @returns 接口原始响应，data 内含新的 access_token、refresh_token、expires_in 等
   */
  async refreshUserToken(refresh_token: string): Promise<unknown> {
    return this._fetch(`${this.config.api}/user/token/refresh`, "POST", {
      appid: this.config.appid,
      appsecret: this.config.appsecret,
      refresh_token,
    });
  }

  /**
   * 退出登录
   * @param access_token 用户访问凭证
   * @returns 接口原始响应
   */
  async logout(access_token: string): Promise<unknown> {
    return this._fetch(`${this.config.api}/user/logout`, "POST", {
      appid: this.config.appid,
      appsecret: this.config.appsecret,
      access_token,
    });
  }

  /**
   * 获取用户关联的第三方平台 UID
   * @param access_token 用户访问凭证
   * @returns 接口原始响应，data 为平台与 uid 的列表
   */
  async getThirdPartyAccount(access_token: string): Promise<unknown> {
    return this._fetch(`${this.config.api}/user/connect`, "POST", {
      appid: this.config.appid,
      appsecret: this.config.appsecret,
      access_token,
    });
  }

  /**
   * 设置用户昵称（1–64 个字符）
   * @param access_token 用户访问凭证
   * @param nickname 昵称字符串
   * @returns 接口原始响应
   * @throws 当昵称为空或长度不在 1–64 时抛错
   */
  async setUserNickname(
    access_token: string,
    nickname: string,
  ): Promise<unknown> {
    const len = [...nickname].length;
    if (len < 1 || len > 64) {
      throw new Error(`昵称长度须为 1-64 个字符，当前为 ${len} 个字符`);
    }
    return this._fetch(`${this.config.api}/user/nickname`, "POST", {
      appid: this.config.appid,
      appsecret: this.config.appsecret,
      access_token,
      nickname,
    });
  }

  /**
   * 设置用户头像，支持 jpg/jpeg/png/webp，≤15MB。
   * @param access_token 用户访问凭证
   * @param image 图片：Buffer、Blob 或本地文件路径（主进程下路径会读文件后上传）
   * @returns 接口原始响应，data 内含 url
   * @throws 当文件不存在、不可读或超过 15MB 时抛错
   */
  async setUserAvatar(
    access_token: string,
    image: Buffer | Blob | string,
  ): Promise<unknown> {
    const fs = await import("fs/promises");
    const path = await import("path");
    let blob: Blob;
    let filename = "avatar.jpg";
    if (typeof image === "string") {
      const buf = await fs.readFile(image);
      if (buf.length > AVATAR_MAX_SIZE) {
        throw new Error(
          `头像文件不能超过 15MB，当前为 ${(buf.length / 1024 / 1024).toFixed(2)}MB`,
        );
      }
      blob = new Blob([new Uint8Array(buf)]);
      filename = path.basename(image) || filename;
    } else if (Buffer.isBuffer(image)) {
      if (image.length > AVATAR_MAX_SIZE) {
        throw new Error(
          `头像文件不能超过 15MB，当前为 ${(image.length / 1024 / 1024).toFixed(2)}MB`,
        );
      }
      blob = new Blob([new Uint8Array(image)]);
    } else {
      if (image.size > AVATAR_MAX_SIZE) {
        throw new Error(
          `头像文件不能超过 15MB，当前为 ${(image.size / 1024 / 1024).toFixed(2)}MB`,
        );
      }
      blob = image;
    }
    const form = new FormData();
    form.append("appid", this.config.appid);
    form.append("appsecret", this.config.appsecret);
    form.append("access_token", access_token);
    form.append("file", blob, filename);
    const response = await fetch(`${this.config.api}/user/avatar`, {
      method: "POST",
      body: form,
    });
    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
    return response.json();
  }
}

export default YunTowerAccountElectronSDK;
