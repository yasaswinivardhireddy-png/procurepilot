type CryptoLike = { getRandomValues?: (array: Uint8Array) => Uint8Array };

// React Native (Hermes) may not expose Web Crypto, so fall back to Math.random.
// These ids are for correlation and idempotency, not for secrets.
function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const cryptoObj = (globalThis as { crypto?: CryptoLike }).crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

export function randomId(prefix: string, byteLength = 12): string {
  let hex = '';
  for (const b of randomBytes(byteLength)) hex += b.toString(16).padStart(2, '0');
  return `${prefix}_${Date.now().toString(36)}${hex}`;
}

export function newIdempotencyKey(): string {
  return randomId('idem');
}
