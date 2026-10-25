export const TEST_DATABASE: 'nelio_test';
export const TEST_SHADOW_DATABASE: 'nelio_test_shadow';
export function assertTestDatabaseName(name: string): void;
export function adminUrl(): string;
export function testDatabaseUrl(): string;
export function testShadowDatabaseUrl(): string;
export function migrationFiles(): { name: string; sql: string }[];
export function buildTestDatabase(): Promise<string[]>;
export function buildDatabaseNamed(target: string): Promise<string[]>;
