import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const MAX_TIMEOUT_SECONDS = 3600;

export default function (pi: ExtensionAPI) {
  pi.on('tool_call', event => {
    if (event.toolName !== 'bash') return;

    const timeout = event.input.timeout;
    if (typeof timeout !== 'number' || timeout <= MAX_TIMEOUT_SECONDS) return;

    return {
      block: true,
      reason: `bash.timeout 的单位是秒，当前值 ${timeout} 秒超过上限 ${MAX_TIMEOUT_SECONDS} 秒（1 小时）。请按实际等待时长填写不超过 ${MAX_TIMEOUT_SECONDS} 的秒数，例如 3 分钟填 180。`,
    };
  });
}
