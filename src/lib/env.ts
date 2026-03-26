function readEnv(name: string): string | undefined {
  const value = process.env[name];

  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getConfiguredBaseUrl(): string | undefined {
  return readEnv("APP_BASE_URL")?.replace(/\/$/, "");
}

export function getBaseUrlFromRequest(request: Request): string {
  return getConfiguredBaseUrl() ?? new URL(request.url).origin;
}

export function getRedisConfig() {
  return {
    url: readEnv("UPSTASH_REDIS_REST_URL"),
    token: readEnv("UPSTASH_REDIS_REST_TOKEN"),
  };
}

export function getPusherServerConfig() {
  return {
    appId: readEnv("PUSHER_APP_ID"),
    key: readEnv("PUSHER_KEY"),
    secret: readEnv("PUSHER_SECRET"),
    cluster: readEnv("PUSHER_CLUSTER"),
  };
}

export function getPusherClientConfig() {
  return {
    key: readEnv("NEXT_PUBLIC_PUSHER_KEY"),
    cluster: readEnv("NEXT_PUBLIC_PUSHER_CLUSTER"),
  };
}

export function hasRedisConfig(): boolean {
  const config = getRedisConfig();
  return Boolean(config.url && config.token);
}

export function hasPusherServerConfig(): boolean {
  const config = getPusherServerConfig();
  return Boolean(config.appId && config.key && config.secret && config.cluster);
}

export function hasPusherClientConfig(): boolean {
  const config = getPusherClientConfig();
  return Boolean(config.key && config.cluster);
}

export function hasRealtimeConfig(): boolean {
  return hasPusherServerConfig() && hasPusherClientConfig();
}