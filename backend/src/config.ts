function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing env ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: req('DATABASE_URL'),
  jwtSecret: req('JWT_SECRET'),
  /** 32-byte key, base64 — encrypts the Google refresh token (TD §3.4) */
  encryptionKey: req('ENCRYPTION_KEY'),
  appUrl: req('APP_URL', 'http://localhost:8080'),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  filesDir: req('FILES_DIR', '/data/files'),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:8080/api/v1/integrations/google/callback',
  },
  seed: {
    ownerEmail: process.env.SEED_OWNER_EMAIL ?? 'owner@jes.local',
    ownerPassword: process.env.SEED_OWNER_PASSWORD ?? '',
    staffEmail: process.env.SEED_STAFF_EMAIL ?? 'staff@jes.local',
    staffPassword: process.env.SEED_STAFF_PASSWORD ?? '',
  },
};

export const googleConfigured = () => !!(config.google.clientId && config.google.clientSecret);
