/**
 * 立即刷新协助收件箱，供新手引导刷新请求或从项目看板重新打开授权。
 */
let refresh: ((requestId?: string) => Promise<boolean>) | null = null;

export function registerAssistInboxRefresh(fn: typeof refresh): void {
  refresh = fn;
}

export function requestAssistInboxRefresh(): void {
  void refresh?.();
}

export async function requestAssistAuthorization(requestId: string): Promise<boolean> {
  return refresh?.(requestId) ?? false;
}
