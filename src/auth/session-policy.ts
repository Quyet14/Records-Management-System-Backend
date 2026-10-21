export function idleTimeoutMs(): number {
  const minutes = Number(process.env.AUTH_IDLE_MINUTES || '30');
  if (!Number.isSafeInteger(minutes) || minutes < 5 || minutes > 1440) throw new Error('AUTH_IDLE_MINUTES must be between 5 and 1440.');
  return minutes * 60000;
}
export function sessionIdle(session: { lastSeenAt?: Date; createdAt: Date }, now = Date.now()) {
  return now - new Date(session.lastSeenAt || session.createdAt).getTime() >= idleTimeoutMs();
}
