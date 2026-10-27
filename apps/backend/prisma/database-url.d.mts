export function resolveDatabaseUrl(env?: NodeJS.ProcessEnv): string;
export function databaseNameOf(url: string): string;
export function withDatabase(url: string, database: string): string;
export function shadowDatabaseUrl(url: string): string;
