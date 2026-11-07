/** 登录检测：主进程持有的静态检测脚本，在目标页执行后返回结构化结果 */
export function buildLoginDetectScript(loginSelector: string | null): string {
  return `(() => {
      const __sel = ${JSON.stringify(loginSelector)};
      let __bySelector = false;
      if (__sel) { try { __bySelector = !!document.querySelector(__sel); } catch (__e) { __bySelector = false; } }
      const __pwd = !!document.querySelector('input[type="password"]');
      const __title = /log\\s*in|sign\\s*in|登录|登陆/i.test(document.title || '');
      return JSON.stringify({ loginRequired: __bySelector || __pwd || __title, url: location.href, title: document.title });
    })()`;
}

export interface LoginDetectResult {
  loginRequired: boolean;
  url: string;
  title: string;
}

export function parseLoginDetect(raw: unknown): LoginDetectResult {
  try {
    const parsed = JSON.parse(String(raw)) as Partial<LoginDetectResult>;
    return {
      loginRequired: !!parsed.loginRequired,
      url: parsed.url ?? '',
      title: parsed.title ?? '',
    };
  } catch {
    return { loginRequired: false, url: '', title: '' };
  }
}
