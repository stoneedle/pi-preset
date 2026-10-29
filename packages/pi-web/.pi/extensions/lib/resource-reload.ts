import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { SessionState } from './session-state.ts';

// Reload is command-only in Pi. Keep its completion outside the runtime being replaced.
export function resourceReload(pi: ExtensionAPI, getState: () => SessionState | undefined) {
  let pending: { resolve: () => void; reject: (error: unknown) => void } | undefined;

  return {
    request() {
      if (pending) return Promise.reject(new Error('正在重载 Pi 资源'));
      return new Promise<void>((resolve, reject) => {
        pending = { resolve, reject };
        try {
          pi.sendUserMessage('/pi-web reload', { expandPromptTemplates: true });
        } catch (error) {
          pending = undefined;
          reject(error);
        }
      });
    },
    async run(ctx: ExtensionCommandContext) {
      const completion = pending;
      pending = undefined;
      try {
        const state = getState();
        state?.updateContext(ctx);
        if (!state?.snapshot().canReload || !ctx.isIdle() || ctx.hasPendingMessages())
          throw new Error('请等待 Pi 和子任务空闲后再重载资源');
        await ctx.reload();
        completion?.resolve();
      } catch (error) {
        if (completion) completion.reject(error);
        else throw error;
      }
    },
  };
}
