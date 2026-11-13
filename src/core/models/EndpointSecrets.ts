/** Query credentials stay in the main process. Public settings contain editable placeholders. */
const MASK = '[已保存]';
export function isSecretParameter(name: string): boolean {
  return /^(?:key|sig|auth|authorization|password|passwd|token)$|(?:secret|token|password|credential|signature|api[-_]?key|[-_]key)$/i.test(name);
}

export function publicEndpoint(raw?: string): string | undefined {
  if (!raw) return raw;
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  const query = new URLSearchParams();
  let changed = false;
  for (const [name, value] of url.searchParams) {
    const secret = isSecretParameter(name);
    if (secret) changed = true;
    query.append(name, secret ? MASK : value);
  }
  if (!changed) return raw;
  url.search = query.toString();
  return url.href;
}

export function restoreEndpoint(raw: string | undefined, saved?: string): string | undefined {
  if (!raw) return raw;
  const url = new URL(raw);
  if (![...url.searchParams].some(([name, value]) => isSecretParameter(name) && value === MASK)) return raw;
  const original = saved ? new URL(saved) : undefined;
  if (!original || original.origin !== url.origin) throw new Error('端点来源已更改，请重新输入地址中的凭据');
  const query = new URLSearchParams();
  for (const [name, value] of url.searchParams) {
    const previous = original.searchParams.getAll(name)[query.getAll(name).length];
    if (isSecretParameter(name) && value === MASK) {
      if (previous === undefined || previous === MASK) throw new Error('请重新输入地址中的凭据');
      query.append(name, previous);
    } else query.append(name, value);
  }
  url.search = query.toString();
  return url.href;
}
