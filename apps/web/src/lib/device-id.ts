let fallback: string | undefined;
const uuid = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  return [...bytes].map((byte, index) => `${[4, 6, 8, 10].includes(index) ? '-' : ''}${byte.toString(16).padStart(2, '0')}`).join('');
};
export function deviceId() {
  try {
    const saved = localStorage.getItem('moa.deviceId');
    if (saved && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved)) return saved;
    fallback ??= uuid();
    localStorage.setItem('moa.deviceId', fallback);
  } catch { fallback ??= uuid(); }
  return fallback;
}
