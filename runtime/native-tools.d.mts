export function nativeReply(
  message: { method?: string; params?: any },
  threadId?: string,
): { result?: any; error?: { code: number; message: string } };
