/**
 * Durable primary 下 sessionless 命令（/grant、/reply-mode、/tabs …）的回执去重键。
 *
 * 这类命令不属于任何 Session，回执没有 Session outbox 可走，只能直接调飞书发送。
 * Inbox claim 保证同一事件同一时刻只有一个副本在处理，但处理到一半崩溃或抛错时
 * 整个事件会被重新领取、从头再跑一遍，已经发出的回执就会重复。飞书 reply/create
 * 接受 `uuid`，同一 uuid 一小时内至多成功发送一条，所以这里按「Inbox 事件 id + 本次
 * 处理内第几条回执」派生稳定 uuid：重跑同一事件时第 N 条回执拿到同一个 uuid，被飞书
 * 去重；同一消息的编辑（updated 事件）是另一个事件 id，照常回复。
 *
 * 只在 primary 下传入；disabled/shadow 不传，行为不变。
 */
import { createHash } from 'node:crypto';

export interface SessionlessReplyKeys {
  /** 下一条回执的 uuid。调用顺序必须是确定的（同一代码路径上第几条回执）。 */
  next(): string;
}

export function createSessionlessReplyKeys(larkAppId: string, eventId: string): SessionlessReplyKeys {
  let seq = 0;
  return {
    next() {
      const n = seq++;
      // 飞书 uuid 上限 50 字符：前缀 + 32 位 hex = 36。
      return `bsl_${createHash('sha256').update(`${larkAppId}\0${eventId}\0${n}`).digest('hex').slice(0, 32)}`;
    },
  };
}
