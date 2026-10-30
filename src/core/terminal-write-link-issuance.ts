// 「获取操作链接」发出的写链接附带一个签名的「发给谁」标记，网页终端的输入审计据此
// 记下领链接的人。写入权限仍只看 `?token=`（这里不参与授权）；标记用本机 dashboard
// 密钥签名，改不了、也搬不到别的会话。链接被转给别人时，输入仍记在领链接的人名下。

import { createHmac, timingSafeEqual } from 'node:crypto';
import { loadDashboardSecret } from '../dashboard/auth.js';
import { dashboardSecretPath } from './dashboard-secret.js';

export const WRITE_LINK_ISSUANCE_PARAM = 'issuedTo';

const DOMAIN = 'botmux-terminal-write-link-issued-v1\0';
const OPEN_ID_RE = /^ou_[A-Za-z0-9_-]{1,64}$/;
const ISSUANCE_RE = /^(ou_[A-Za-z0-9_-]{1,64})\.(\d{1,15})\.([A-Za-z0-9_-]{43})$/;

function issuanceMac(secret: string, sessionId: string, openId: string, issuedAt: string): string {
  return createHmac('sha256', secret)
    .update(`${DOMAIN}${sessionId}\0${openId}\0${issuedAt}`)
    .digest('base64url');
}

/** 给写链接加上签名的领取人标记；领取人不是合法 open_id 时原样返回。 */
export function withWriteLinkIssuance(
  url: string,
  secret: string,
  sessionId: string,
  openId: string,
  now = Date.now(),
): string {
  if (!OPEN_ID_RE.test(openId) || !sessionId) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const issuedAt = String(now);
  parsed.searchParams.set(
    WRITE_LINK_ISSUANCE_PARAM,
    `${openId}.${issuedAt}.${issuanceMac(secret, sessionId, openId, issuedAt)}`,
  );
  return parsed.toString();
}

function hostSecret(): string | null {
  try {
    return loadDashboardSecret(dashboardSecretPath());
  } catch {
    return null;
  }
}

/** daemon 发写链接时调用；本机没有可用的 dashboard 密钥就不加标记。 */
export function issueWriteLink(url: string, sessionId: string, openId: string): string {
  const secret = hostSecret();
  return secret ? withWriteLinkIssuance(url, secret, sessionId, openId) : url;
}

/** worker 处理带写 token 的请求时调用；只有带了标记才读密钥。 */
export function writeLinkIssuedTo(params: URLSearchParams, sessionId: string): string | undefined {
  const value = params.get(WRITE_LINK_ISSUANCE_PARAM);
  if (!value) return undefined;
  const secret = hostSecret();
  return secret ? verifyWriteLinkIssuance(secret, sessionId, value) : undefined;
}

/** 验签通过返回领取人的 open_id，否则 undefined（缺失、篡改、别的会话签的）。 */
export function verifyWriteLinkIssuance(
  secret: string,
  sessionId: string,
  value: string | null | undefined,
): string | undefined {
  if (!value || value.length > 256 || !sessionId) return undefined;
  const match = ISSUANCE_RE.exec(value);
  if (!match) return undefined;
  const [, openId, issuedAt, mac] = match;
  const expected = Buffer.from(issuanceMac(secret, sessionId, openId, issuedAt));
  const actual = Buffer.from(mac);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? openId : undefined;
}
