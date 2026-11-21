import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import crypto from 'node:crypto';
import pg from 'pg';
import { hashPassword, hashResetToken } from './auth.js';
import {
  calculateRecommendedReorderQty,
  getStockStatus,
} from '../src/shared/inventoryLogic.js';
import type {
  AppSettings,
  LowStockAlert,
  Product,
  PurchaseOrder,
  PurchaseOrderEvent,
  PurchaseOrderItem,
  PurchaseOrderStatus,
  StockTransaction,
  Supplier,
  TransactionType,
  User,
  UserRole,
} from '../src/shared/types.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;
type PgPoolClient = pg.PoolClient;

export type StorageMode = 'postgres' | 'sqlite' | 'ephemeral-tmp';

const isVercelRuntime = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);

interface DbSession {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<void>;
}

function resolvePostgresConfig(): { url: string | null; configError: string | null } {
  const candidates = [
    process.env.DATABASE_URL,
    process.env.POSTGRES_URL,
    process.env.POSTGRES_PRISMA_URL,
    process.env.POSTGRES_URL_NON_POOLING,
    process.env.SUPABASE_DB_URL,
    process.env.NEON_DATABASE_URL,
  ];

  for (const rawCandidate of candidates) {
    const raw = rawCandidate?.trim();
    if (!raw) continue;
    if (/^MY_/i.test(raw) || /^CHANGE_ME/i.test(raw)) continue;

    if (/^postgres(ql)?:\/\//i.test(raw)) {
      return { url: raw, configError: null };
    }

    if (/^sb_/i.test(raw) || /^https?:\/\//i.test(raw)) {
      return {
        url: null,
        configError:
          'Database URL appears to be an API key or HTTP URL rather than a PostgreSQL connection string (postgresql://...). Copy the PostgreSQL connection URI from your database provider into DATABASE_URL or POSTGRES_URL.',
      };
    }

    return {
      url: null,
      configError:
        'Configured database URL does not start with postgresql:// or postgres://. Update DATABASE_URL or POSTGRES_URL with a valid PostgreSQL connection string.',
    };
  }

  return { url: null, configError: null };
}

function resolveSqlitePath(): string {
  const raw = process.env.DATABASE_PATH?.trim();
  const defaultLocalPath = path.resolve(process.cwd(), 'data', 'smartstock.db');
  const vercelTmpPath = path.join(os.tmpdir(), 'smartstock.db');

  if (!raw) {
    if (isVercelRuntime) {
      return vercelTmpPath;
    }
    return defaultLocalPath;
  }

  const looksLikeNonPathSecret =
    /^sb_/i.test(raw) ||
    /^https?:\/\//i.test(raw) ||
    (!raw.includes('/') && !raw.includes('\\') && !/\.(db|sqlite|sqlite3)$/i.test(raw));
  if (looksLikeNonPathSecret) {
    console.warn(
      'Ignoring invalid DATABASE_PATH value (expected a .db/.sqlite file path); defaulting to writable smartstock.db path'
    );
    return isVercelRuntime ? vercelTmpPath : defaultLocalPath;
  }

  const resolved = path.resolve(raw);
  if (isVercelRuntime && !resolved.startsWith(os.tmpdir())) {
    return vercelTmpPath;
  }
  return resolved;
}

const pgConfig = resolvePostgresConfig();
const resolvedSqlitePath = resolveSqlitePath();

export function getStorageMode(): StorageMode {
  if (pgConfig.url) return 'postgres';
  if (isVercelRuntime && resolvedSqlitePath.startsWith(os.tmpdir())) return 'ephemeral-tmp';
  return 'sqlite';
}

export function isEphemeralDatabase(): boolean {
  return getStorageMode() === 'ephemeral-tmp';
}

function toPostgresParams(sql: string): string {
  let idx = 0;
  let inSingleQuote = false;
  let out = '';
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'" && sql[i - 1] !== '\\') {
      if (inSingleQuote && sql[i + 1] === "'") {
        out += "''";
        i += 1;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      out += ch;
    } else if (ch === '?' && !inSingleQuote) {
      idx += 1;
      out += `$${idx}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function loadDatabaseSync(): typeof DatabaseSyncType {
  const procWithBuiltin = process as unknown as {
    getBuiltinModule?: (id: string) => { DatabaseSync?: typeof DatabaseSyncType } | undefined;
  };
  const builtin = procWithBuiltin.getBuiltinModule?.('node:sqlite');
  if (builtin?.DatabaseSync) {
    return builtin.DatabaseSync;
  }
  const req = createRequire(import.meta.url);
  const mod = req('node:sqlite') as { DatabaseSync?: typeof DatabaseSyncType };
  if (!mod?.DatabaseSync) {
    throw new Error(
      `Built-in node:sqlite module is unavailable on Node ${process.version}. Node.js 22.x or 24.x is required.`
    );
  }
  return mod.DatabaseSync;
}

declare global {
  var __smartstockPgPool: PgPool | undefined;
}

let sqliteDb: DatabaseSyncType | null = null;
let pgPool: PgPool | null = null;
let dbInitError: string | null = pgConfig.configError;
let initPromise: Promise<void> | null = null;
let sqliteTxQueue: Promise<unknown> = Promise.resolve();

function createPgPool(connectionString: string): PgPool {
  if (globalThis.__smartstockPgPool) {
    return globalThis.__smartstockPgPool;
  }
  const isLocal = /localhost|127\.0\.0\.1/i.test(connectionString) || connectionString.includes('sslmode=disable');
  const pool = new Pool({
    connectionString,
    max: isVercelRuntime ? 5 : 10,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 20000,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
  pool.on('error', (err) => {
    console.error('SmartStock PostgreSQL pool error:', err);
  });
  globalThis.__smartstockPgPool = pool;
  return pool;
}

function makePgSession(runner: { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }> }): DbSession {
  return {
    async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const result = await runner.query(toPostgresParams(sql), params);
      return result.rows as T[];
    },
    async get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
      const result = await runner.query(toPostgresParams(sql), params);
      return (result.rows[0] as T | undefined) ?? undefined;
    },
    async run(sql: string, params: unknown[] = []): Promise<void> {
      await runner.query(toPostgresParams(sql), params);
    },
  };
}

function makeSqliteSession(dbInstance: DatabaseSyncType): DbSession {
  return {
    async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const stmt = dbInstance.prepare(sql);
      return stmt.all(...(params as Array<string | number | null | Uint8Array>)) as T[];
    },
    async get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
      const stmt = dbInstance.prepare(sql);
      return stmt.get(...(params as Array<string | number | null | Uint8Array>)) as T | undefined;
    },
    async run(sql: string, params: unknown[] = []): Promise<void> {
      const stmt = dbInstance.prepare(sql);
      stmt.run(...(params as Array<string | number | null | Uint8Array>));
    },
  };
}

const MIGRATIONS: Array<{ version: number; name: string; statements: string[] }> = [
  {
    version: 1,
    name: 'create_multitenant_inventory_schema',
    statements: [
      `CREATE TABLE IF NOT EXISTS businesses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'staff')),
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        business_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS business_settings (
        business_id TEXT PRIMARY KEY,
        business_name TEXT NOT NULL,
        currency_symbol TEXT NOT NULL DEFAULT '$',
        timezone TEXT NOT NULL DEFAULT 'UTC',
        default_reorder_multiplier DOUBLE PRECISION NOT NULL DEFAULT 2,
        low_stock_banner_enabled INTEGER NOT NULL DEFAULT 1,
        low_stock_digest_enabled INTEGER NOT NULL DEFAULT 1,
        po_status_alerts_enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS suppliers (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        company_name TEXT NOT NULL,
        contact_person TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT NOT NULL,
        address TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        delivery_status TEXT NOT NULL DEFAULT 'On Schedule',
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        name TEXT NOT NULL,
        sku TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        supplier_id TEXT NOT NULL,
        unit_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
        selling_price DOUBLE PRECISION NOT NULL DEFAULT 0,
        quantity INTEGER NOT NULL DEFAULT 0,
        reorder_point INTEGER NOT NULL DEFAULT 10,
        image_url TEXT DEFAULT '',
        barcode TEXT DEFAULT '',
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(business_id, sku),
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
        FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE IF NOT EXISTS stock_transactions (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('stock_in', 'stock_out', 'adjustment')),
        quantity_change INTEGER NOT NULL,
        previous_quantity INTEGER NOT NULL,
        resulting_quantity INTEGER NOT NULL,
        party TEXT NOT NULL DEFAULT '',
        reference_number TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        transaction_date TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE IF NOT EXISTS purchase_orders (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        po_number TEXT NOT NULL,
        supplier_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('Draft', 'Ordered', 'Partially Received', 'Received', 'Cancelled')),
        order_date TEXT NOT NULL,
        expected_delivery_date TEXT NOT NULL,
        total_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(business_id, po_number),
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
        FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE IF NOT EXISTS purchase_order_items (
        id TEXT PRIMARY KEY,
        po_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        quantity_ordered INTEGER NOT NULL,
        quantity_received INTEGER NOT NULL DEFAULT 0,
        unit_cost DOUBLE PRECISION NOT NULL,
        FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
      )`,
      `CREATE TABLE IF NOT EXISTS purchase_order_events (
        id TEXT PRIMARY KEY,
        po_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        description TEXT NOT NULL,
        user_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE
      )`,
      `CREATE TABLE IF NOT EXISTS low_stock_alerts (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'resolved')),
        alert_type TEXT NOT NULL CHECK(alert_type IN ('low_stock', 'out_of_stock')),
        recommended_qty INTEGER NOT NULL DEFAULT 10,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_users_business ON users(business_id)`,
      `CREATE INDEX IF NOT EXISTS idx_suppliers_business ON suppliers(business_id)`,
      `CREATE INDEX IF NOT EXISTS idx_products_business ON products(business_id)`,
      `CREATE INDEX IF NOT EXISTS idx_tx_business_date ON stock_transactions(business_id, transaction_date)`,
      `CREATE INDEX IF NOT EXISTS idx_po_business ON purchase_orders(business_id)`,
      `CREATE INDEX IF NOT EXISTS idx_alerts_business_status ON low_stock_alerts(business_id, status)`,
    ],
  },
  {
    version: 2,
    name: 'create_app_meta_table',
    statements: [
      `CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    ],
  },
];

async function runMigrationsOnPostgres(pool: PgPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    for (const m of MIGRATIONS) {
      const check = await client.query('SELECT version FROM schema_migrations WHERE version = $1', [m.version]);
      if (check.rows.length === 0) {
        await client.query('BEGIN');
        try {
          for (const stmt of m.statements) {
            await client.query(stmt);
          }
          await client.query(
            'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)',
            [m.version, m.name, new Date().toISOString()]
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
    }
  } finally {
    client.release();
  }
}

function runMigrationsOnSqlite(dbInstance: DatabaseSyncType): void {
  dbInstance.exec('PRAGMA foreign_keys = ON;');
  try {
    dbInstance.exec('PRAGMA journal_mode = WAL;');
  } catch {
    // Some serverless /tmp mounts do not support WAL locking; default journal mode works
  }
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const legacyUsers = dbInstance
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
    .get() as { name: string } | undefined;
  const hasMigrations = dbInstance
    .prepare('SELECT COUNT(*) as cnt FROM schema_migrations WHERE version = 1')
    .get() as { cnt: number };

  if (legacyUsers && Number(hasMigrations.cnt) === 0) {
    dbInstance.exec('PRAGMA foreign_keys = OFF;');
    dbInstance.exec(`
      DROP TABLE IF EXISTS low_stock_alerts;
      DROP TABLE IF EXISTS purchase_order_events;
      DROP TABLE IF EXISTS purchase_order_items;
      DROP TABLE IF EXISTS purchase_orders;
      DROP TABLE IF EXISTS stock_transactions;
      DROP TABLE IF EXISTS products;
      DROP TABLE IF EXISTS suppliers;
      DROP TABLE IF EXISTS users;
      DROP TABLE IF EXISTS settings;
    `);
    dbInstance.exec('PRAGMA foreign_keys = ON;');
  }

  for (const m of MIGRATIONS) {
    const applied = dbInstance
      .prepare('SELECT version FROM schema_migrations WHERE version = ?')
      .get(m.version) as { version: number } | undefined;
    if (!applied) {
      dbInstance.exec('BEGIN IMMEDIATE');
      try {
        for (const stmt of m.statements) {
          dbInstance.exec(stmt);
        }
        dbInstance
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(m.version, m.name, new Date().toISOString());
        dbInstance.exec('COMMIT');
      } catch (err) {
        dbInstance.exec('ROLLBACK');
        throw err;
      }
    }
  }
}

async function initializeDatabase(): Promise<void> {
  if (pgConfig.configError) {
    dbInitError = pgConfig.configError;
    throw new Error(pgConfig.configError);
  }

  if (pgConfig.url) {
    const pool = createPgPool(pgConfig.url);
    await runMigrationsOnPostgres(pool);
    pgPool = pool;
    dbInitError = null;
    return;
  }

  const dataDir = path.dirname(resolvedSqlitePath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const DatabaseSyncCtor = loadDatabaseSync();
  const instance = new DatabaseSyncCtor(resolvedSqlitePath);
  runMigrationsOnSqlite(instance);
  sqliteDb = instance;
  dbInitError = null;
}

export async function ensureDatabaseReady(): Promise<void> {
  if (pgPool || sqliteDb) return;
  if (!initPromise) {
    initPromise = initializeDatabase().catch((err) => {
      dbInitError = err instanceof Error ? err.message : String(err);
      initPromise = null;
      throw err;
    });
  }
  await initPromise;
}

export function getDatabaseInitError(): string | null {
  return dbInitError;
}

async function getSession(): Promise<DbSession> {
  await ensureDatabaseReady();
  if (pgPool) return makePgSession(pgPool);
  if (sqliteDb) return makeSqliteSession(sqliteDb);
  throw new Error(dbInitError || 'Database is not initialized.');
}

async function withTransaction<T>(fn: (tx: DbSession) => Promise<T>): Promise<T> {
  await ensureDatabaseReady();

  if (pgPool) {
    const client: PgPoolClient = await pgPool.connect();
    const txSession = makePgSession(client);
    try {
      await client.query('BEGIN');
      const result = await fn(txSession);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback error if connection dropped
      }
      throw err;
    } finally {
      client.release();
    }
  }

  if (sqliteDb) {
    const dbInstance = sqliteDb;
    const runTask = sqliteTxQueue.then(async () => {
      const txSession = makeSqliteSession(dbInstance);
      dbInstance.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(txSession);
        dbInstance.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          dbInstance.exec('ROLLBACK');
        } catch {
          // ignore
        }
        throw err;
      }
    });
    sqliteTxQueue = runTask.catch(() => undefined);
    return runTask;
  }

  throw new Error(dbInitError || 'Database is not initialized.');
}

export async function getOrCreateSessionSecret(): Promise<string> {
  const db = await getSession();
  const existing = await db.get<{ value: string }>(
    "SELECT value FROM app_meta WHERE key = 'session_secret'"
  );
  if (existing?.value && existing.value.length >= 32) {
    return existing.value;
  }
  const generated = crypto.randomBytes(32).toString('hex');
  await db.run(
    "INSERT INTO app_meta (key, value) VALUES ('session_secret', ?) ON CONFLICT (key) DO NOTHING",
    [generated]
  );
  const stored = await db.get<{ value: string }>(
    "SELECT value FROM app_meta WHERE key = 'session_secret'"
  );
  return stored?.value || generated;
}

function mapUser(r: Record<string, unknown>): User {
  return {
    id: String(r.id),
    businessId: String(r.business_id),
    name: String(r.name),
    email: String(r.email),
    role: String(r.role) as UserRole,
    active: Boolean(r.active),
    createdAt: String(r.created_at),
  };
}

export async function registerBusinessAndAdmin(input: {
  businessName: string;
  adminName: string;
  email: string;
  password: string;
  currencySymbol?: string;
  timezone?: string;
}): Promise<{ businessId: string; user: User }> {
  const now = new Date().toISOString();
  const businessId = `biz-${crypto.randomUUID().slice(0, 8)}`;
  const userId = `user-${crypto.randomUUID().slice(0, 8)}`;
  const passwordHash = hashPassword(input.password);

  await withTransaction(async (tx) => {
    await tx.run('INSERT INTO businesses (id, name, created_at) VALUES (?, ?, ?)', [
      businessId,
      input.businessName.trim(),
      now,
    ]);

    await tx.run(
      `INSERT INTO business_settings (business_id, business_name, currency_symbol, timezone, default_reorder_multiplier, low_stock_banner_enabled, low_stock_digest_enabled, po_status_alerts_enabled, updated_at)
       VALUES (?, ?, ?, ?, 2, 1, 1, 1, ?)`,
      [
        businessId,
        input.businessName.trim(),
        (input.currencySymbol || '$').trim() || '$',
        (input.timezone || 'UTC').trim() || 'UTC',
        now,
      ]
    );

    await tx.run(
      `INSERT INTO users (id, business_id, name, email, password_hash, role, active, created_at)
       VALUES (?, ?, ?, ?, ?, 'admin', 1, ?)`,
      [
        userId,
        businessId,
        input.adminName.trim(),
        input.email.trim().toLowerCase(),
        passwordHash,
        now,
      ]
    );
  });

  return { businessId, user: (await getUserById(userId))! };
}

export async function getUserById(id: string): Promise<User | null> {
  const db = await getSession();
  const row = await db.get<Record<string, unknown>>(
    'SELECT id, business_id, name, email, role, active, created_at FROM users WHERE id = ?',
    [id]
  );
  return row ? mapUser(row) : null;
}

export async function getUserAuthByEmail(
  email: string
): Promise<(User & { passwordHash: string }) | null> {
  const db = await getSession();
  const row = await db.get<Record<string, unknown>>(
    'SELECT id, business_id, name, email, password_hash, role, active, created_at FROM users WHERE lower(email) = lower(?)',
    [email.trim()]
  );
  if (!row) return null;
  return {
    ...mapUser(row),
    passwordHash: String(row.password_hash),
  };
}

export async function listUsers(businessId: string): Promise<User[]> {
  const db = await getSession();
  const rows = await db.all<Record<string, unknown>>(
    'SELECT id, business_id, name, email, role, active, created_at FROM users WHERE business_id = ? ORDER BY created_at ASC',
    [businessId]
  );
  return rows.map(mapUser);
}

export async function createUser(
  businessId: string,
  input: {
    name: string;
    email: string;
    password: string;
    role: UserRole;
  }
): Promise<User> {
  const db = await getSession();
  const id = `user-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  await db.run(
    'INSERT INTO users (id, business_id, name, email, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
    [
      id,
      businessId,
      input.name.trim(),
      input.email.trim().toLowerCase(),
      hashPassword(input.password),
      input.role,
      now,
    ]
  );
  return (await getUserById(id))!;
}

export async function updateUser(
  businessId: string,
  id: string,
  updates: { role?: UserRole; active?: boolean; name?: string }
): Promise<{ ok: boolean; user?: User; error?: string }> {
  const db = await getSession();
  const row = await db.get<Record<string, unknown>>(
    'SELECT id, business_id, name, email, role, active, created_at FROM users WHERE id = ? AND business_id = ?',
    [id, businessId]
  );
  if (!row) return { ok: false, error: 'User not found.' };
  const existing = mapUser(row);

  const nextRole = updates.role ?? existing.role;
  const nextActive = updates.active !== undefined ? updates.active : existing.active;
  const nextName = updates.name !== undefined ? updates.name.trim() : existing.name;

  if (existing.role === 'admin' && existing.active && (!nextActive || nextRole !== 'admin')) {
    const activeAdmins = await db.get<{ cnt: number | string }>(
      "SELECT COUNT(*) as cnt FROM users WHERE business_id = ? AND role = 'admin' AND active = 1",
      [businessId]
    );
    if (Number(activeAdmins?.cnt || 0) <= 1) {
      return {
        ok: false,
        error: 'At least one active administrator must remain in the workspace.',
      };
    }
  }

  await db.run('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ? AND business_id = ?', [
    nextName,
    nextRole,
    nextActive ? 1 : 0,
    id,
    businessId,
  ]);
  return { ok: true, user: (await getUserById(id))! };
}

export async function updateUserPassword(userId: string, newPassword: string): Promise<void> {
  const db = await getSession();
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), userId]);
}

export async function createPasswordResetToken(
  businessId: string,
  userId: string,
  ttlMinutes = 15
): Promise<{ rawToken: string; expiresAt: string }> {
  const db = await getSession();
  const rawToken = crypto.randomBytes(24).toString('base64url');
  const tokenHash = hashResetToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString();

  await db.run(
    `INSERT INTO password_reset_tokens (id, user_id, business_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [`prt-${crypto.randomUUID().slice(0, 8)}`, userId, businessId, tokenHash, expiresAt, now.toISOString()]
  );

  return { rawToken, expiresAt };
}

export async function consumePasswordResetToken(
  rawToken: string,
  newPassword: string
): Promise<{ ok: boolean; error?: string }> {
  const tokenHash = hashResetToken(rawToken.trim());
  const nowIso = new Date().toISOString();
  const nextHash = hashPassword(newPassword);

  return withTransaction(async (tx) => {
    const row = await tx.get<{ id: string; user_id: string; expires_at: string; used_at: string | null }>(
      'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?',
      [tokenHash]
    );

    if (!row) {
      return { ok: false, error: 'Reset token is invalid or unrecognized.' };
    }
    if (row.used_at) {
      return { ok: false, error: 'This reset token has already been used.' };
    }
    if (row.expires_at < nowIso) {
      return { ok: false, error: 'This reset token has expired. Request a new reset link.' };
    }

    await tx.run('UPDATE users SET password_hash = ? WHERE id = ?', [nextHash, row.user_id]);
    await tx.run('UPDATE password_reset_tokens SET used_at = ? WHERE id = ?', [nowIso, row.id]);
    return { ok: true };
  });
}

export async function deleteBusinessWorkspace(businessId: string): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.run(
      'DELETE FROM purchase_order_events WHERE po_id IN (SELECT id FROM purchase_orders WHERE business_id = ?)',
      [businessId]
    );
    await tx.run(
      'DELETE FROM purchase_order_items WHERE po_id IN (SELECT id FROM purchase_orders WHERE business_id = ?)',
      [businessId]
    );
    await tx.run('DELETE FROM low_stock_alerts WHERE business_id = ?', [businessId]);
    await tx.run('DELETE FROM stock_transactions WHERE business_id = ?', [businessId]);
    await tx.run('DELETE FROM purchase_orders WHERE business_id = ?', [businessId]);
    await tx.run('DELETE FROM products WHERE business_id = ?', [businessId]);
    await tx.run('DELETE FROM suppliers WHERE business_id = ?', [businessId]);
    await tx.run('DELETE FROM password_reset_tokens WHERE business_id = ?', [businessId]);
    await tx.run('DELETE FROM business_settings WHERE business_id = ?', [businessId]);
    await tx.run('DELETE FROM users WHERE business_id = ?', [businessId]);
    await tx.run('DELETE FROM businesses WHERE id = ?', [businessId]);
  });
}

export async function getSettings(businessId: string): Promise<AppSettings> {
  const db = await getSession();
  const row = await db.get<Record<string, unknown>>(
    'SELECT * FROM business_settings WHERE business_id = ?',
    [businessId]
  );
  if (!row) {
    return {
      businessId,
      businessName: 'My Workspace',
      currencySymbol: '$',
      timezone: 'UTC',
      defaultReorderMultiplier: 2,
      lowStockBannerEnabled: true,
      lowStockDigestEnabled: true,
      poStatusAlertsEnabled: true,
    };
  }
  return {
    businessId: String(row.business_id),
    businessName: String(row.business_name),
    currencySymbol: String(row.currency_symbol || '$'),
    timezone: String(row.timezone || 'UTC'),
    defaultReorderMultiplier: Number(row.default_reorder_multiplier || 2),
    lowStockBannerEnabled: Boolean(row.low_stock_banner_enabled),
    lowStockDigestEnabled: Boolean(row.low_stock_digest_enabled),
    poStatusAlertsEnabled: Boolean(row.po_status_alerts_enabled),
  };
}

export async function updateSettings(
  businessId: string,
  partial: Partial<AppSettings>
): Promise<AppSettings> {
  const current = await getSettings(businessId);
  const next: AppSettings = {
    ...current,
    ...partial,
    businessId,
  };
  const now = new Date().toISOString();

  await withTransaction(async (tx) => {
    await tx.run(
      `INSERT INTO business_settings (business_id, business_name, currency_symbol, timezone, default_reorder_multiplier, low_stock_banner_enabled, low_stock_digest_enabled, po_status_alerts_enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(business_id) DO UPDATE SET
         business_name = excluded.business_name,
         currency_symbol = excluded.currency_symbol,
         timezone = excluded.timezone,
         default_reorder_multiplier = excluded.default_reorder_multiplier,
         low_stock_banner_enabled = excluded.low_stock_banner_enabled,
         low_stock_digest_enabled = excluded.low_stock_digest_enabled,
         po_status_alerts_enabled = excluded.po_status_alerts_enabled,
         updated_at = excluded.updated_at`,
      [
        businessId,
        next.businessName.trim() || current.businessName,
        next.currencySymbol.trim() || '$',
        next.timezone.trim() || 'UTC',
        next.defaultReorderMultiplier,
        next.lowStockBannerEnabled ? 1 : 0,
        next.lowStockDigestEnabled ? 1 : 0,
        next.poStatusAlertsEnabled ? 1 : 0,
        now,
      ]
    );

    if (partial.businessName?.trim()) {
      await tx.run('UPDATE businesses SET name = ? WHERE id = ?', [partial.businessName.trim(), businessId]);
    }
  });

  return getSettings(businessId);
}

export async function listSuppliers(businessId: string, includeArchived = true): Promise<Supplier[]> {
  const db = await getSession();
  const rows = await db.all<Record<string, unknown>>(
    `SELECT s.*,
      (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id AND p.business_id = s.business_id) as product_count,
      (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.business_id = s.business_id AND po.status IN ('Draft', 'Ordered', 'Partially Received')) as open_order_count,
      (SELECT MAX(po.updated_at) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.business_id = s.business_id) as last_activity_at
     FROM suppliers s
     WHERE s.business_id = ? ${includeArchived ? '' : 'AND s.archived = 0'}
     ORDER BY s.archived ASC, s.company_name ASC`,
    [businessId]
  );

  return rows.map((r) => ({
    id: String(r.id),
    businessId: String(r.business_id),
    companyName: String(r.company_name),
    contactPerson: String(r.contact_person),
    email: String(r.email),
    phone: String(r.phone),
    address: String(r.address || ''),
    notes: String(r.notes || ''),
    deliveryStatus: (String(r.delivery_status) as Supplier['deliveryStatus']) || 'On Schedule',
    archived: Boolean(r.archived),
    productCount: Number(r.product_count || 0),
    openOrderCount: Number(r.open_order_count || 0),
    lastActivityAt: r.last_activity_at ? String(r.last_activity_at) : String(r.updated_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));
}

export async function getSupplierById(businessId: string, id: string): Promise<Supplier | null> {
  const all = await listSuppliers(businessId, true);
  return all.find((s) => s.id === id) || null;
}

export async function createSupplier(
  businessId: string,
  input: {
    companyName: string;
    contactPerson: string;
    email: string;
    phone: string;
    address?: string;
    notes?: string;
    deliveryStatus?: Supplier['deliveryStatus'];
  }
): Promise<Supplier> {
  const db = await getSession();
  const id = `sup-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO suppliers (id, business_id, company_name, contact_person, email, phone, address, notes, delivery_status, archived, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    [
      id,
      businessId,
      input.companyName.trim(),
      input.contactPerson.trim(),
      input.email.trim(),
      input.phone.trim(),
      (input.address || '').trim(),
      (input.notes || '').trim(),
      input.deliveryStatus || 'On Schedule',
      now,
      now,
    ]
  );
  return (await getSupplierById(businessId, id))!;
}

export async function updateSupplier(
  businessId: string,
  id: string,
  input: Partial<{
    companyName: string;
    contactPerson: string;
    email: string;
    phone: string;
    address: string;
    notes: string;
    deliveryStatus: Supplier['deliveryStatus'];
    archived: boolean;
  }>
): Promise<Supplier | null> {
  const existing = await getSupplierById(businessId, id);
  if (!existing) return null;
  const db = await getSession();
  const now = new Date().toISOString();
  await db.run(
    `UPDATE suppliers
     SET company_name = ?, contact_person = ?, email = ?, phone = ?, address = ?, notes = ?, delivery_status = ?, archived = ?, updated_at = ?
     WHERE id = ? AND business_id = ?`,
    [
      (input.companyName ?? existing.companyName).trim(),
      (input.contactPerson ?? existing.contactPerson).trim(),
      (input.email ?? existing.email).trim(),
      (input.phone ?? existing.phone).trim(),
      (input.address ?? existing.address).trim(),
      (input.notes ?? existing.notes).trim(),
      input.deliveryStatus ?? existing.deliveryStatus,
      (input.archived ?? existing.archived) ? 1 : 0,
      now,
      id,
      businessId,
    ]
  );
  return getSupplierById(businessId, id);
}

export async function deleteSupplier(
  businessId: string,
  id: string
): Promise<{ ok: boolean; error?: string }> {
  const supplier = await getSupplierById(businessId, id);
  if (!supplier) return { ok: false, error: 'Supplier not found.' };
  const db = await getSession();

  const linkedProducts = await db.get<{ cnt: number | string }>(
    'SELECT COUNT(*) as cnt FROM products WHERE supplier_id = ? AND business_id = ?',
    [id, businessId]
  );
  const prodCount = Number(linkedProducts?.cnt || 0);
  if (prodCount > 0) {
    return {
      ok: false,
      error: `Cannot delete "${supplier.companyName}" because ${prodCount} product${prodCount > 1 ? 's reference' : ' references'} it. Archive the supplier instead to keep catalog history intact.`,
    };
  }

  const linkedOrders = await db.get<{ cnt: number | string }>(
    'SELECT COUNT(*) as cnt FROM purchase_orders WHERE supplier_id = ? AND business_id = ?',
    [id, businessId]
  );
  const orderCount = Number(linkedOrders?.cnt || 0);
  if (orderCount > 0) {
    return {
      ok: false,
      error: `Cannot delete "${supplier.companyName}" because ${orderCount} purchase order record${orderCount > 1 ? 's reference' : ' references'} it. Archive the supplier instead to preserve audit history.`,
    };
  }

  await db.run('DELETE FROM suppliers WHERE id = ? AND business_id = ?', [id, businessId]);
  return { ok: true };
}

export async function listProducts(businessId: string, includeArchived = true): Promise<Product[]> {
  const db = await getSession();
  const rows = await db.all<Record<string, unknown>>(
    `SELECT p.*, s.company_name as supplier_name
     FROM products p
     LEFT JOIN suppliers s ON p.supplier_id = s.id AND s.business_id = p.business_id
     WHERE p.business_id = ? ${includeArchived ? '' : 'AND p.archived = 0'}
     ORDER BY p.archived ASC, p.updated_at DESC`,
    [businessId]
  );

  return rows.map((r) => ({
    id: String(r.id),
    businessId: String(r.business_id),
    name: String(r.name),
    sku: String(r.sku),
    category: String(r.category),
    description: String(r.description || ''),
    supplierId: String(r.supplier_id),
    supplierName: r.supplier_name ? String(r.supplier_name) : 'Supplier',
    unitCost: Number(r.unit_cost),
    sellingPrice: Number(r.selling_price),
    quantity: Number(r.quantity),
    reorderPoint: Number(r.reorder_point),
    imageUrl: r.image_url ? String(r.image_url) : '',
    barcode: r.barcode ? String(r.barcode) : '',
    archived: Boolean(r.archived),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));
}

export async function getProductById(businessId: string, id: string): Promise<Product | null> {
  const all = await listProducts(businessId, true);
  return all.find((p) => p.id === id) || null;
}

export async function createProduct(
  businessId: string,
  input: {
    name: string;
    sku: string;
    category: string;
    description?: string;
    supplierId: string;
    unitCost: number;
    sellingPrice: number;
    quantity: number;
    reorderPoint: number;
    imageUrl?: string;
    barcode?: string;
  },
  actor: { id: string; name: string }
): Promise<Product> {
  const id = `prod-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const qty = Math.trunc(Number(input.quantity));

  await withTransaction(async (tx) => {
    await tx.run(
      `INSERT INTO products (id, business_id, name, sku, category, description, supplier_id, unit_cost, selling_price, quantity, reorder_point, image_url, barcode, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        id,
        businessId,
        input.name.trim(),
        input.sku.trim(),
        input.category.trim(),
        (input.description || '').trim(),
        input.supplierId,
        Number(input.unitCost),
        Number(input.sellingPrice),
        qty,
        Math.trunc(Number(input.reorderPoint)),
        (input.imageUrl || '').trim(),
        (input.barcode || '').trim(),
        now,
        now,
      ]
    );

    if (qty > 0) {
      await tx.run(
        `INSERT INTO stock_transactions (id, business_id, product_id, type, quantity_change, previous_quantity, resulting_quantity, party, reference_number, reason, note, user_id, user_name, transaction_date, created_at)
         VALUES (?, ?, ?, 'stock_in', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `tx-${crypto.randomUUID().slice(0, 8)}`,
          businessId,
          id,
          qty,
          qty,
          'Opening Balance',
          `INIT-${input.sku.trim()}`,
          'Initial product setup',
          'Opening stock recorded on product creation',
          actor.id,
          actor.name,
          now.slice(0, 10),
          now,
        ]
      );
    }
  });

  await syncLowStockAlertForProduct(businessId, id);
  return (await getProductById(businessId, id))!;
}

export async function updateProduct(
  businessId: string,
  id: string,
  input: Partial<{
    name: string;
    sku: string;
    category: string;
    description: string;
    supplierId: string;
    unitCost: number;
    sellingPrice: number;
    quantity: number;
    reorderPoint: number;
    imageUrl: string;
    barcode: string;
    archived: boolean;
  }>
): Promise<Product | null> {
  const existing = await getProductById(businessId, id);
  if (!existing) return null;
  const db = await getSession();
  const now = new Date().toISOString();

  await db.run(
    `UPDATE products
     SET name = ?, sku = ?, category = ?, description = ?, supplier_id = ?, unit_cost = ?, selling_price = ?, quantity = ?, reorder_point = ?, image_url = ?, barcode = ?, archived = ?, updated_at = ?
     WHERE id = ? AND business_id = ?`,
    [
      (input.name ?? existing.name).trim(),
      (input.sku ?? existing.sku).trim(),
      (input.category ?? existing.category).trim(),
      (input.description ?? existing.description).trim(),
      input.supplierId ?? existing.supplierId,
      input.unitCost !== undefined ? Number(input.unitCost) : existing.unitCost,
      input.sellingPrice !== undefined ? Number(input.sellingPrice) : existing.sellingPrice,
      input.quantity !== undefined ? Math.trunc(Number(input.quantity)) : existing.quantity,
      input.reorderPoint !== undefined ? Math.trunc(Number(input.reorderPoint)) : existing.reorderPoint,
      (input.imageUrl ?? existing.imageUrl ?? '').trim(),
      (input.barcode ?? existing.barcode ?? '').trim(),
      (input.archived ?? existing.archived) ? 1 : 0,
      now,
      id,
      businessId,
    ]
  );

  await syncLowStockAlertForProduct(businessId, id);
  return getProductById(businessId, id);
}

export async function deleteProduct(
  businessId: string,
  id: string
): Promise<{ ok: boolean; error?: string }> {
  const existing = await getProductById(businessId, id);
  if (!existing) return { ok: false, error: 'Product not found.' };
  const db = await getSession();

  const poUsage = await db.get<{ cnt: number | string }>(
    `SELECT COUNT(*) as cnt FROM purchase_order_items poi
     JOIN purchase_orders po ON po.id = poi.po_id
     WHERE poi.product_id = ? AND po.business_id = ?`,
    [id, businessId]
  );
  const poCount = Number(poUsage?.cnt || 0);
  if (poCount > 0) {
    return {
      ok: false,
      error: `Cannot delete "${existing.name}" because it is referenced by ${poCount} purchase order line${poCount > 1 ? 's' : ''}. Archive the product instead to preserve order audit history.`,
    };
  }

  const txUsage = await db.get<{ cnt: number | string }>(
    'SELECT COUNT(*) as cnt FROM stock_transactions WHERE product_id = ? AND business_id = ?',
    [id, businessId]
  );
  const txCount = Number(txUsage?.cnt || 0);
  if (txCount > 0) {
    return {
      ok: false,
      error: `Cannot delete "${existing.name}" because it has ${txCount} stock audit transaction${txCount > 1 ? 's' : ''}. Archive the product instead to keep your stock ledger immutable.`,
    };
  }

  await db.run('DELETE FROM products WHERE id = ? AND business_id = ?', [id, businessId]);
  return { ok: true };
}

export async function listTransactions(
  businessId: string,
  filters?: {
    productId?: string;
    type?: string;
    limit?: number;
  }
): Promise<StockTransaction[]> {
  const db = await getSession();
  let sql = `
    SELECT t.*, p.name as product_name, p.sku as product_sku
    FROM stock_transactions t
    LEFT JOIN products p ON t.product_id = p.id AND p.business_id = t.business_id
    WHERE t.business_id = ?
  `;
  const args: Array<string | number> = [businessId];
  if (filters?.productId) {
    sql += ' AND t.product_id = ?';
    args.push(filters.productId);
  }
  if (
    filters?.type &&
    (filters.type === 'stock_in' || filters.type === 'stock_out' || filters.type === 'adjustment')
  ) {
    sql += ' AND t.type = ?';
    args.push(filters.type);
  }
  sql += ' ORDER BY t.transaction_date DESC, t.created_at DESC';
  if (filters?.limit) {
    sql += ' LIMIT ?';
    args.push(filters.limit);
  }

  const rows = await db.all<Record<string, unknown>>(sql, args);
  return rows.map((r) => ({
    id: String(r.id),
    businessId: String(r.business_id),
    productId: String(r.product_id),
    productName: r.product_name ? String(r.product_name) : 'Removed Product',
    productSku: r.product_sku ? String(r.product_sku) : '-',
    type: String(r.type) as TransactionType,
    quantityChange: Number(r.quantity_change),
    previousQuantity: Number(r.previous_quantity),
    resultingQuantity: Number(r.resulting_quantity),
    party: String(r.party || ''),
    referenceNumber: String(r.reference_number || ''),
    reason: String(r.reason || ''),
    note: String(r.note || ''),
    userId: String(r.user_id),
    userName: String(r.user_name),
    transactionDate: String(r.transaction_date),
    createdAt: String(r.created_at),
  }));
}

export async function recordStockTransaction(
  businessId: string,
  input: {
    productId: string;
    type: TransactionType;
    quantity: number;
    transactionDate: string;
    party: string;
    referenceNumber: string;
    reason?: string;
    note?: string;
    userId: string;
    userName: string;
    allowNegativeOverride?: boolean;
    isAdmin?: boolean;
  }
): Promise<{ ok: boolean; transaction?: StockTransaction; product?: Product; error?: string }> {
  const qty = Math.trunc(Number(input.quantity));
  if (!Number.isFinite(qty)) {
    return { ok: false, error: 'Quantity must be a whole number.' };
  }
  if (input.type === 'adjustment') {
    if (!input.isAdmin) {
      return { ok: false, error: 'Only workspace administrators can record stock adjustments.' };
    }
    if (qty === 0) {
      return { ok: false, error: 'Adjustment quantity change cannot be zero.' };
    }
    if (!input.reason || input.reason.trim().length < 3) {
      return { ok: false, error: 'Provide an adjustment reason (at least 3 characters).' };
    }
  } else if (qty <= 0) {
    return { ok: false, error: 'Quantity must be a positive whole number.' };
  }

  const now = new Date().toISOString();
  const txId = `tx-${crypto.randomUUID().slice(0, 8)}`;

  const txResult = await withTransaction<{ ok: boolean; error?: string }>(async (tx) => {
    const productRow = await tx.get<{ id: string; name: string; quantity: number; archived: number }>(
      'SELECT id, name, quantity, archived FROM products WHERE id = ? AND business_id = ?',
      [input.productId, businessId]
    );

    if (!productRow) {
      return { ok: false, error: 'Selected product was not found in your workspace.' };
    }
    if (productRow.archived) {
      return {
        ok: false,
        error: `Cannot record stock movements for archived product "${productRow.name}". Unarchive it first.`,
      };
    }

    const previousQty = Number(productRow.quantity);
    const delta = input.type === 'stock_in' ? qty : input.type === 'stock_out' ? -qty : qty;
    const resultingQty = previousQty + delta;

    if (resultingQty < 0 && !(input.type === 'adjustment' && input.isAdmin && input.allowNegativeOverride)) {
      return {
        ok: false,
        error: `Movement would drop "${productRow.name}" below zero (${previousQty} -> ${resultingQty}).`,
      };
    }

    await tx.run('UPDATE products SET quantity = ?, updated_at = ? WHERE id = ? AND business_id = ?', [
      resultingQty,
      now,
      productRow.id,
      businessId,
    ]);

    await tx.run(
      `INSERT INTO stock_transactions (id, business_id, product_id, type, quantity_change, previous_quantity, resulting_quantity, party, reference_number, reason, note, user_id, user_name, transaction_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        txId,
        businessId,
        productRow.id,
        input.type,
        delta,
        previousQty,
        resultingQty,
        input.party.trim() ||
          (input.type === 'stock_in'
            ? 'Supplier Restock'
            : input.type === 'stock_out'
              ? 'Fulfillment'
              : 'Inventory Count / Adjustment'),
        input.referenceNumber.trim() || `REF-${txId.slice(-5).toUpperCase()}`,
        (input.reason || '').trim(),
        (input.note || '').trim(),
        input.userId,
        input.userName,
        input.transactionDate || now.slice(0, 10),
        now,
      ]
    );

    return { ok: true };
  });

  if (!txResult.ok) {
    return txResult;
  }

  await syncLowStockAlertForProduct(businessId, input.productId);
  const txs = await listTransactions(businessId, { productId: input.productId });
  const transaction = txs.find((t) => t.id === txId);
  const product = (await getProductById(businessId, input.productId))!;
  return { ok: true, transaction, product };
}

export async function syncLowStockAlertForProduct(
  businessId: string,
  productId: string
): Promise<void> {
  const product = await getProductById(businessId, productId);
  if (!product) return;
  const db = await getSession();
  const now = new Date().toISOString();

  const activeAlerts = await db.all<{ id: string; alert_type: string }>(
    "SELECT id, alert_type FROM low_stock_alerts WHERE business_id = ? AND product_id = ? AND status = 'active'",
    [businessId, productId]
  );

  if (product.archived || getStockStatus(product.quantity, product.reorderPoint) === 'in_stock') {
    if (activeAlerts.length > 0) {
      await db.run(
        "UPDATE low_stock_alerts SET status = 'resolved', resolved_at = ? WHERE business_id = ? AND product_id = ? AND status = 'active'",
        [now, businessId, productId]
      );
    }
    return;
  }

  const status = getStockStatus(product.quantity, product.reorderPoint);
  const transactions = await listTransactions(businessId, { productId });
  const settings = await getSettings(businessId);
  const desiredType = status === 'out_of_stock' ? 'out_of_stock' : 'low_stock';
  const recQty = Math.max(
    10,
    calculateRecommendedReorderQty(
      product,
      transactions,
      30,
      Date.now(),
      settings.defaultReorderMultiplier || 2
    )
  );

  if (activeAlerts.length === 0) {
    await db.run(
      `INSERT INTO low_stock_alerts (id, business_id, product_id, status, alert_type, recommended_qty, created_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?)`,
      [`alt-${crypto.randomUUID().slice(0, 8)}`, businessId, productId, desiredType, recQty, now]
    );
  } else {
    const [primary, ...extras] = activeAlerts;
    await db.run(
      'UPDATE low_stock_alerts SET alert_type = ?, recommended_qty = ? WHERE id = ? AND business_id = ?',
      [desiredType, recQty, primary.id, businessId]
    );
    for (const extra of extras) {
      await db.run(
        "UPDATE low_stock_alerts SET status = 'resolved', resolved_at = ? WHERE id = ? AND business_id = ?",
        [now, extra.id, businessId]
      );
    }
  }
}

export async function listLowStockAlerts(
  businessId: string,
  includeResolved = false
): Promise<LowStockAlert[]> {
  const db = await getSession();
  const rows = await db.all<Record<string, unknown>>(
    `SELECT a.*, p.name as product_name, p.sku, p.category, p.supplier_id, p.quantity, p.reorder_point, s.company_name as supplier_name
     FROM low_stock_alerts a
     JOIN products p ON p.id = a.product_id AND p.business_id = a.business_id
     LEFT JOIN suppliers s ON s.id = p.supplier_id AND s.business_id = a.business_id
     WHERE a.business_id = ? AND p.archived = 0 ${includeResolved ? '' : "AND a.status = 'active'"}
     ORDER BY CASE WHEN a.alert_type = 'out_of_stock' THEN 0 ELSE 1 END, p.quantity ASC`,
    [businessId]
  );

  return rows.map((r) => ({
    id: String(r.id),
    businessId: String(r.business_id),
    productId: String(r.product_id),
    productName: String(r.product_name),
    sku: String(r.sku),
    category: String(r.category),
    supplierId: String(r.supplier_id),
    supplierName: r.supplier_name ? String(r.supplier_name) : 'Supplier',
    quantity: Number(r.quantity),
    reorderPoint: Number(r.reorder_point),
    alertType: String(r.alert_type) as 'low_stock' | 'out_of_stock',
    recommendedQty: Number(r.recommended_qty),
    status: String(r.status) as 'active' | 'resolved',
    createdAt: String(r.created_at),
    resolvedAt: r.resolved_at ? String(r.resolved_at) : null,
  }));
}

export async function listPurchaseOrders(businessId: string): Promise<PurchaseOrder[]> {
  const db = await getSession();
  const poRows = await db.all<Record<string, unknown>>(
    `SELECT po.*, s.company_name as supplier_name
     FROM purchase_orders po
     LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.business_id = po.business_id
     WHERE po.business_id = ?
     ORDER BY po.created_at DESC`,
    [businessId]
  );

  if (poRows.length === 0) return [];

  const itemRows = await db.all<Record<string, unknown>>(
    `SELECT poi.*, p.name as product_name, p.sku as product_sku
     FROM purchase_order_items poi
     JOIN purchase_orders po ON po.id = poi.po_id
     LEFT JOIN products p ON p.id = poi.product_id AND p.business_id = po.business_id
     WHERE po.business_id = ?`,
    [businessId]
  );

  const eventRows = await db.all<Record<string, unknown>>(
    `SELECT poe.*
     FROM purchase_order_events poe
     JOIN purchase_orders po ON po.id = poe.po_id
     WHERE po.business_id = ?
     ORDER BY poe.created_at DESC`,
    [businessId]
  );

  const itemsByPo = new Map<string, PurchaseOrderItem[]>();
  for (const r of itemRows) {
    const poId = String(r.po_id);
    const list = itemsByPo.get(poId) || [];
    list.push({
      id: String(r.id),
      poId,
      productId: String(r.product_id),
      productName: r.product_name ? String(r.product_name) : 'Product',
      productSku: r.product_sku ? String(r.product_sku) : '-',
      quantityOrdered: Number(r.quantity_ordered),
      quantityReceived: Number(r.quantity_received),
      unitCost: Number(r.unit_cost),
    });
    itemsByPo.set(poId, list);
  }

  const eventsByPo = new Map<string, PurchaseOrderEvent[]>();
  for (const r of eventRows) {
    const poId = String(r.po_id);
    const list = eventsByPo.get(poId) || [];
    list.push({
      id: String(r.id),
      poId,
      eventType: String(r.event_type),
      description: String(r.description),
      userName: String(r.user_name),
      createdAt: String(r.created_at),
    });
    eventsByPo.set(poId, list);
  }

  return poRows.map((r) => ({
    id: String(r.id),
    businessId: String(r.business_id),
    poNumber: String(r.po_number),
    supplierId: String(r.supplier_id),
    supplierName: r.supplier_name ? String(r.supplier_name) : 'Supplier',
    status: String(r.status) as PurchaseOrderStatus,
    orderDate: String(r.order_date),
    expectedDeliveryDate: String(r.expected_delivery_date),
    totalAmount: Number(r.total_amount),
    notes: String(r.notes || ''),
    createdBy: String(r.created_by),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    items: itemsByPo.get(String(r.id)) || [],
    events: eventsByPo.get(String(r.id)) || [],
  }));
}

export async function getPurchaseOrderById(
  businessId: string,
  id: string
): Promise<PurchaseOrder | null> {
  const all = await listPurchaseOrders(businessId);
  return all.find((po) => po.id === id) || null;
}

export async function createPurchaseOrder(
  businessId: string,
  input: {
    supplierId: string;
    status: 'Draft' | 'Ordered';
    orderDate: string;
    expectedDeliveryDate: string;
    notes?: string;
    items: Array<{ productId: string; quantityOrdered: number; unitCost: number }>;
  },
  actorName: string
): Promise<PurchaseOrder> {
  const id = `po-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const year = new Date().getUTCFullYear();
  const totalAmount = input.items.reduce(
    (sum, item) => sum + Number(item.quantityOrdered) * Number(item.unitCost),
    0
  );

  await withTransaction(async (tx) => {
    const existingCount = await tx.get<{ cnt: number | string }>(
      'SELECT COUNT(*) as cnt FROM purchase_orders WHERE business_id = ?',
      [businessId]
    );
    const poNumber = `PO-${year}-${String(Number(existingCount?.cnt || 0) + 101).padStart(3, '0')}`;

    await tx.run(
      `INSERT INTO purchase_orders (id, business_id, po_number, supplier_id, status, order_date, expected_delivery_date, total_amount, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        businessId,
        poNumber,
        input.supplierId,
        input.status,
        input.orderDate || now.slice(0, 10),
        input.expectedDeliveryDate || now.slice(0, 10),
        Math.round(totalAmount * 100) / 100,
        (input.notes || '').trim(),
        actorName,
        now,
        now,
      ]
    );

    for (const item of input.items) {
      await tx.run(
        `INSERT INTO purchase_order_items (id, po_id, product_id, quantity_ordered, quantity_received, unit_cost)
         VALUES (?, ?, ?, ?, 0, ?)`,
        [
          `poi-${crypto.randomUUID().slice(0, 8)}`,
          id,
          item.productId,
          Math.trunc(Number(item.quantityOrdered)),
          Number(item.unitCost),
        ]
      );
    }

    await tx.run(
      `INSERT INTO purchase_order_events (id, po_id, event_type, description, user_name, created_at)
       VALUES (?, ?, 'Created', ?, ?, ?)`,
      [
        `poe-${crypto.randomUUID().slice(0, 8)}`,
        id,
        `Purchase order ${poNumber} created with status ${input.status}.`,
        actorName,
        now,
      ]
    );
  });

  return (await getPurchaseOrderById(businessId, id))!;
}

export async function updatePurchaseOrderStatus(
  businessId: string,
  id: string,
  status: PurchaseOrderStatus,
  actorName: string
): Promise<{ ok: boolean; order?: PurchaseOrder; error?: string }> {
  const po = await getPurchaseOrderById(businessId, id);
  if (!po) return { ok: false, error: 'Purchase order not found.' };
  if (po.status === 'Received' || po.status === 'Cancelled') {
    return { ok: false, error: `Cannot change status of a ${po.status} purchase order.` };
  }
  if (po.status === 'Partially Received' && status === 'Cancelled') {
    return { ok: false, error: 'Partially received orders cannot be cancelled.' };
  }

  const now = new Date().toISOString();
  await withTransaction(async (tx) => {
    await tx.run(
      'UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ? AND business_id = ?',
      [status, now, id, businessId]
    );
    await tx.run(
      `INSERT INTO purchase_order_events (id, po_id, event_type, description, user_name, created_at)
       VALUES (?, ?, 'Status Changed', ?, ?, ?)`,
      [
        `poe-${crypto.randomUUID().slice(0, 8)}`,
        id,
        `Order status changed from ${po.status} to ${status}.`,
        actorName,
        now,
      ]
    );
  });

  return { ok: true, order: (await getPurchaseOrderById(businessId, id))! };
}

export async function receivePurchaseOrderItems(
  businessId: string,
  poId: string,
  receipts: Array<{ itemId: string; quantityToReceive: number }>,
  actor: { id: string; name: string }
): Promise<{ ok: boolean; order?: PurchaseOrder; error?: string }> {
  const po = await getPurchaseOrderById(businessId, poId);
  if (!po) return { ok: false, error: 'Purchase order not found.' };
  if (po.status === 'Cancelled' || po.status === 'Received') {
    return { ok: false, error: `Cannot receive stock for a ${po.status} purchase order.` };
  }
  if (po.status === 'Draft') {
    return { ok: false, error: 'Mark this purchase order as Ordered before receiving items.' };
  }

  const validLines = receipts.filter((r) => Math.trunc(Number(r.quantityToReceive)) > 0);
  if (validLines.length === 0) {
    return { ok: false, error: 'Enter at least one positive quantity to receive.' };
  }

  const now = new Date().toISOString();
  const touchedProducts: string[] = [];

  const txResult = await withTransaction<{ ok: boolean; error?: string }>(async (tx) => {
    const receivedSummary: string[] = [];

    for (const r of validLines) {
      const qtyToAdd = Math.trunc(Number(r.quantityToReceive));
      const itemRow = await tx.get<{
        id: string;
        po_id: string;
        product_id: string;
        quantity_ordered: number;
        quantity_received: number;
        unit_cost: number;
      }>('SELECT * FROM purchase_order_items WHERE id = ? AND po_id = ?', [r.itemId, poId]);

      if (!itemRow) {
        return { ok: false, error: 'Line item not found on purchase order.' };
      }

      const remaining = Number(itemRow.quantity_ordered) - Number(itemRow.quantity_received);
      if (qtyToAdd > remaining) {
        return {
          ok: false,
          error: `Cannot receive ${qtyToAdd} units when only ${remaining} units remain open on this line.`,
        };
      }

      const prodRow = await tx.get<{ id: string; name: string; quantity: number }>(
        'SELECT id, name, quantity FROM products WHERE id = ? AND business_id = ?',
        [itemRow.product_id, businessId]
      );

      if (!prodRow) {
        return { ok: false, error: 'Linked product no longer exists.' };
      }

      const prevQty = Number(prodRow.quantity);
      const nextQty = prevQty + qtyToAdd;

      await tx.run('UPDATE purchase_order_items SET quantity_received = ? WHERE id = ?', [
        Number(itemRow.quantity_received) + qtyToAdd,
        itemRow.id,
      ]);

      await tx.run('UPDATE products SET quantity = ?, updated_at = ? WHERE id = ? AND business_id = ?', [
        nextQty,
        now,
        prodRow.id,
        businessId,
      ]);

      await tx.run(
        `INSERT INTO stock_transactions (id, business_id, product_id, type, quantity_change, previous_quantity, resulting_quantity, party, reference_number, reason, note, user_id, user_name, transaction_date, created_at)
         VALUES (?, ?, ?, 'stock_in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `tx-${crypto.randomUUID().slice(0, 8)}`,
          businessId,
          prodRow.id,
          qtyToAdd,
          prevQty,
          nextQty,
          po.supplierName || 'Supplier',
          po.poNumber,
          'Purchase order receipt',
          `Received against ${po.poNumber}`,
          actor.id,
          actor.name,
          now.slice(0, 10),
          now,
        ]
      );

      touchedProducts.push(prodRow.id);
      receivedSummary.push(`${qtyToAdd}x ${prodRow.name}`);
    }

    const updatedItems = await tx.all<{ quantity_ordered: number; quantity_received: number }>(
      'SELECT quantity_ordered, quantity_received FROM purchase_order_items WHERE po_id = ?',
      [poId]
    );

    const allReceived = updatedItems.every(
      (i) => Number(i.quantity_received) >= Number(i.quantity_ordered)
    );
    const nextStatus: PurchaseOrderStatus = allReceived ? 'Received' : 'Partially Received';

    await tx.run('UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ? AND business_id = ?', [
      nextStatus,
      now,
      poId,
      businessId,
    ]);

    await tx.run(
      `INSERT INTO purchase_order_events (id, po_id, event_type, description, user_name, created_at)
       VALUES (?, ?, 'Received', ?, ?, ?)`,
      [
        `poe-${crypto.randomUUID().slice(0, 8)}`,
        poId,
        `Confirmed receipt of ${receivedSummary.join(', ')}. Status updated to ${nextStatus}.`,
        actor.name,
        now,
      ]
    );

    return { ok: true };
  });

  if (!txResult.ok) {
    return txResult;
  }

  for (const pid of touchedProducts) {
    await syncLowStockAlertForProduct(businessId, pid);
  }

  return { ok: true, order: (await getPurchaseOrderById(businessId, poId))! };
}

export async function exportBusinessBackup(businessId: string) {
  const [settings, users, suppliers, products, transactions, purchaseOrders, alerts] = await Promise.all([
    getSettings(businessId),
    listUsers(businessId),
    listSuppliers(businessId, true),
    listProducts(businessId, true),
    listTransactions(businessId),
    listPurchaseOrders(businessId),
    listLowStockAlerts(businessId, true),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    schemaVersion: 1,
    settings,
    users,
    suppliers,
    products,
    transactions,
    purchaseOrders,
    alerts,
  };
}
