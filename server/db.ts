import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import crypto from 'node:crypto';
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

const isVercelRuntime = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);

function resolveDatabasePath(): string {
  const raw = process.env.DATABASE_PATH?.trim();
  const defaultLocalPath = path.resolve(process.cwd(), 'data', 'smartstock.db');
  const vercelTmpPath = path.join(os.tmpdir(), 'smartstock.db');

  if (!raw) {
    if (isVercelRuntime) {
      console.warn(
        'VERCEL runtime detected with no writable persistent volume; using ephemeral /tmp/smartstock.db. Use a persistent Node server or external database for durable production storage.'
      );
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
    console.warn(
      `Vercel serverless filesystem outside ${os.tmpdir()} is read-only; redirecting DATABASE_PATH to ${vercelTmpPath}`
    );
    return vercelTmpPath;
  }
  return resolved;
}

const resolvedDbPath = resolveDatabasePath();

export function isEphemeralDatabase(): boolean {
  return isVercelRuntime && resolvedDbPath.startsWith(os.tmpdir());
}

let db!: DatabaseSyncType;
let dbInitError: string | null = null;

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

export function getDatabaseInitError(): string | null {
  return dbInitError;
}

function runMigrations() {
  db.exec('PRAGMA foreign_keys = ON;');
  try {
    db.exec('PRAGMA journal_mode = WAL;');
  } catch {
    // Some serverless /tmp mounts do not support WAL locking; default journal mode works
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  // Detect legacy single-tenant schema without schema_migrations / businesses and reset cleanly
  const legacyUsers = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'")
    .get() as { name: string } | undefined;
  const hasMigrations = db
    .prepare('SELECT COUNT(*) as cnt FROM schema_migrations WHERE version = 1')
    .get() as { cnt: number };

  if (legacyUsers && hasMigrations.cnt === 0) {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(`
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
    db.exec('PRAGMA foreign_keys = ON;');
  }

  const migrations: Array<{ version: number; name: string; sql: string }> = [
    {
      version: 1,
      name: 'create_multitenant_inventory_schema',
      sql: `
        CREATE TABLE IF NOT EXISTS businesses (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          business_id TEXT NOT NULL,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('admin', 'staff')),
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS password_reset_tokens (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          business_id TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL,
          used_at TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS business_settings (
          business_id TEXT PRIMARY KEY,
          business_name TEXT NOT NULL,
          currency_symbol TEXT NOT NULL DEFAULT '$',
          timezone TEXT NOT NULL DEFAULT 'UTC',
          default_reorder_multiplier REAL NOT NULL DEFAULT 2,
          low_stock_banner_enabled INTEGER NOT NULL DEFAULT 1,
          low_stock_digest_enabled INTEGER NOT NULL DEFAULT 1,
          po_status_alerts_enabled INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS suppliers (
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
        );

        CREATE TABLE IF NOT EXISTS products (
          id TEXT PRIMARY KEY,
          business_id TEXT NOT NULL,
          name TEXT NOT NULL,
          sku TEXT NOT NULL,
          category TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          supplier_id TEXT NOT NULL,
          unit_cost REAL NOT NULL DEFAULT 0,
          selling_price REAL NOT NULL DEFAULT 0,
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
        );

        CREATE TABLE IF NOT EXISTS stock_transactions (
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
        );

        CREATE TABLE IF NOT EXISTS purchase_orders (
          id TEXT PRIMARY KEY,
          business_id TEXT NOT NULL,
          po_number TEXT NOT NULL,
          supplier_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('Draft', 'Ordered', 'Partially Received', 'Received', 'Cancelled')),
          order_date TEXT NOT NULL,
          expected_delivery_date TEXT NOT NULL,
          total_amount REAL NOT NULL DEFAULT 0,
          notes TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(business_id, po_number),
          FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
          FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS purchase_order_items (
          id TEXT PRIMARY KEY,
          po_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          quantity_ordered INTEGER NOT NULL,
          quantity_received INTEGER NOT NULL DEFAULT 0,
          unit_cost REAL NOT NULL,
          FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
          FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS purchase_order_events (
          id TEXT PRIMARY KEY,
          po_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          description TEXT NOT NULL,
          user_name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS low_stock_alerts (
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
        );

        CREATE INDEX IF NOT EXISTS idx_users_business ON users(business_id);
        CREATE INDEX IF NOT EXISTS idx_suppliers_business ON suppliers(business_id);
        CREATE INDEX IF NOT EXISTS idx_products_business ON products(business_id);
        CREATE INDEX IF NOT EXISTS idx_tx_business_date ON stock_transactions(business_id, transaction_date);
        CREATE INDEX IF NOT EXISTS idx_po_business ON purchase_orders(business_id);
        CREATE INDEX IF NOT EXISTS idx_alerts_business_status ON low_stock_alerts(business_id, status);
      `,
    },
    {
      version: 2,
      name: 'create_app_meta_table',
      sql: `
        CREATE TABLE IF NOT EXISTS app_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `,
    },
  ];

  for (const m of migrations) {
    const applied = db
      .prepare('SELECT version FROM schema_migrations WHERE version = ?')
      .get(m.version) as { version: number } | undefined;
    if (!applied) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          new Date().toISOString()
        );
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  }
}

function initDatabase() {
  const dataDir = path.dirname(resolvedDbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const DatabaseSyncCtor = loadDatabaseSync();
  db = new DatabaseSyncCtor(resolvedDbPath);
  runMigrations();
}

try {
  initDatabase();
} catch (err) {
  dbInitError = err instanceof Error ? err.message : String(err);
  console.error('SmartStock SQLite initialization error:', dbInitError);
}

export function getOrCreateSessionSecret(): string {
  const existing = db
    .prepare("SELECT value FROM app_meta WHERE key = 'session_secret'")
    .get() as { value: string } | undefined;
  if (existing?.value && existing.value.length >= 32) {
    return existing.value;
  }
  const generated = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES ('session_secret', ?)").run(
    generated
  );
  const stored = db
    .prepare("SELECT value FROM app_meta WHERE key = 'session_secret'")
    .get() as { value: string } | undefined;
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

export function registerBusinessAndAdmin(input: {
  businessName: string;
  adminName: string;
  email: string;
  password: string;
  currencySymbol?: string;
  timezone?: string;
}): { businessId: string; user: User } {
  const now = new Date().toISOString();
  const businessId = `biz-${crypto.randomUUID().slice(0, 8)}`;
  const userId = `user-${crypto.randomUUID().slice(0, 8)}`;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO businesses (id, name, created_at) VALUES (?, ?, ?)').run(
      businessId,
      input.businessName.trim(),
      now
    );

    db.prepare(
      `INSERT INTO business_settings (business_id, business_name, currency_symbol, timezone, default_reorder_multiplier, low_stock_banner_enabled, low_stock_digest_enabled, po_status_alerts_enabled, updated_at)
       VALUES (?, ?, ?, ?, 2, 1, 1, 1, ?)`
    ).run(
      businessId,
      input.businessName.trim(),
      (input.currencySymbol || '$').trim() || '$',
      (input.timezone || 'UTC').trim() || 'UTC',
      now
    );

    db.prepare(
      `INSERT INTO users (id, business_id, name, email, password_hash, role, active, created_at)
       VALUES (?, ?, ?, ?, ?, 'admin', 1, ?)`
    ).run(
      userId,
      businessId,
      input.adminName.trim(),
      input.email.trim().toLowerCase(),
      hashPassword(input.password),
      now
    );

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { businessId, user: getUserById(userId)! };
}

export function getUserById(id: string): User | null {
  const row = db
    .prepare('SELECT id, business_id, name, email, role, active, created_at FROM users WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? mapUser(row) : null;
}

export function getUserAuthByEmail(email: string): (User & { passwordHash: string }) | null {
  const row = db
    .prepare(
      'SELECT id, business_id, name, email, password_hash, role, active, created_at FROM users WHERE lower(email) = lower(?)'
    )
    .get(email.trim()) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    ...mapUser(row),
    passwordHash: String(row.password_hash),
  };
}

export function listUsers(businessId: string): User[] {
  const rows = db
    .prepare(
      'SELECT id, business_id, name, email, role, active, created_at FROM users WHERE business_id = ? ORDER BY created_at ASC'
    )
    .all(businessId) as Array<Record<string, unknown>>;
  return rows.map(mapUser);
}

export function createUser(
  businessId: string,
  input: {
    name: string;
    email: string;
    password: string;
    role: UserRole;
  }
): User {
  const id = `user-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO users (id, business_id, name, email, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)'
  ).run(
    id,
    businessId,
    input.name.trim(),
    input.email.trim().toLowerCase(),
    hashPassword(input.password),
    input.role,
    now
  );
  return getUserById(id)!;
}

export function updateUser(
  businessId: string,
  id: string,
  updates: { role?: UserRole; active?: boolean; name?: string }
): { ok: boolean; user?: User; error?: string } {
  const row = db
    .prepare('SELECT id, business_id, name, email, role, active, created_at FROM users WHERE id = ? AND business_id = ?')
    .get(id, businessId) as Record<string, unknown> | undefined;
  if (!row) return { ok: false, error: 'User not found.' };
  const existing = mapUser(row);

  const nextRole = updates.role ?? existing.role;
  const nextActive = updates.active !== undefined ? updates.active : existing.active;
  const nextName = updates.name !== undefined ? updates.name.trim() : existing.name;

  // Prevent removing or deactivating the last active admin
  if (existing.role === 'admin' && existing.active && (!nextActive || nextRole !== 'admin')) {
    const activeAdmins = db
      .prepare("SELECT COUNT(*) as cnt FROM users WHERE business_id = ? AND role = 'admin' AND active = 1")
      .get(businessId) as { cnt: number };
    if (activeAdmins.cnt <= 1) {
      return {
        ok: false,
        error: 'At least one active administrator must remain in the workspace.',
      };
    }
  }

  db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ? AND business_id = ?').run(
    nextName,
    nextRole,
    nextActive ? 1 : 0,
    id,
    businessId
  );
  return { ok: true, user: getUserById(id)! };
}

export function updateUserPassword(userId: string, newPassword: string): void {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
}

export function createPasswordResetToken(
  businessId: string,
  userId: string,
  ttlMinutes = 15
): { rawToken: string; expiresAt: string } {
  const rawToken = crypto.randomBytes(24).toString('base64url');
  const tokenHash = hashResetToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString();

  db.prepare(
    `INSERT INTO password_reset_tokens (id, user_id, business_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(`prt-${crypto.randomUUID().slice(0, 8)}`, userId, businessId, tokenHash, expiresAt, now.toISOString());

  return { rawToken, expiresAt };
}

export function consumePasswordResetToken(
  rawToken: string,
  newPassword: string
): { ok: boolean; error?: string } {
  const tokenHash = hashResetToken(rawToken.trim());
  const nowIso = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db
      .prepare('SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?')
      .get(tokenHash) as
      | { id: string; user_id: string; expires_at: string; used_at: string | null }
      | undefined;

    if (!row) {
      db.exec('ROLLBACK');
      return { ok: false, error: 'Reset token is invalid or unrecognized.' };
    }
    if (row.used_at) {
      db.exec('ROLLBACK');
      return { ok: false, error: 'This reset token has already been used.' };
    }
    if (row.expires_at < nowIso) {
      db.exec('ROLLBACK');
      return { ok: false, error: 'This reset token has expired. Request a new reset link.' };
    }

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), row.user_id);
    db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE id = ?').run(nowIso, row.id);
    db.exec('COMMIT');
    return { ok: true };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function deleteBusinessWorkspace(businessId: string): void {
  db.prepare('DELETE FROM businesses WHERE id = ?').run(businessId);
}

export function getSettings(businessId: string): AppSettings {
  const row = db
    .prepare('SELECT * FROM business_settings WHERE business_id = ?')
    .get(businessId) as Record<string, unknown> | undefined;
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

export function updateSettings(businessId: string, partial: Partial<AppSettings>): AppSettings {
  const current = getSettings(businessId);
  const next: AppSettings = {
    ...current,
    ...partial,
    businessId,
  };
  const now = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
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
         updated_at = excluded.updated_at`
    ).run(
      businessId,
      next.businessName.trim() || current.businessName,
      next.currencySymbol.trim() || '$',
      next.timezone.trim() || 'UTC',
      next.defaultReorderMultiplier,
      next.lowStockBannerEnabled ? 1 : 0,
      next.lowStockDigestEnabled ? 1 : 0,
      next.poStatusAlertsEnabled ? 1 : 0,
      now
    );

    if (partial.businessName?.trim()) {
      db.prepare('UPDATE businesses SET name = ? WHERE id = ?').run(partial.businessName.trim(), businessId);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return getSettings(businessId);
}

export function listSuppliers(businessId: string, includeArchived = true): Supplier[] {
  const rows = db
    .prepare(
      `SELECT s.*,
        (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id AND p.business_id = s.business_id) as product_count,
        (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.business_id = s.business_id AND po.status IN ('Draft', 'Ordered', 'Partially Received')) as open_order_count,
        (SELECT MAX(po.updated_at) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.business_id = s.business_id) as last_activity_at
       FROM suppliers s
       WHERE s.business_id = ? ${includeArchived ? '' : 'AND s.archived = 0'}
       ORDER BY s.archived ASC, s.company_name ASC`
    )
    .all(businessId) as Array<Record<string, unknown>>;

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

export function getSupplierById(businessId: string, id: string): Supplier | null {
  return listSuppliers(businessId, true).find((s) => s.id === id) || null;
}

export function createSupplier(
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
): Supplier {
  const id = `sup-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO suppliers (id, business_id, company_name, contact_person, email, phone, address, notes, delivery_status, archived, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(
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
    now
  );
  return getSupplierById(businessId, id)!;
}

export function updateSupplier(
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
): Supplier | null {
  const existing = getSupplierById(businessId, id);
  if (!existing) return null;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE suppliers
     SET company_name = ?, contact_person = ?, email = ?, phone = ?, address = ?, notes = ?, delivery_status = ?, archived = ?, updated_at = ?
     WHERE id = ? AND business_id = ?`
  ).run(
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
    businessId
  );
  return getSupplierById(businessId, id);
}

export function deleteSupplier(businessId: string, id: string): { ok: boolean; error?: string } {
  const supplier = getSupplierById(businessId, id);
  if (!supplier) return { ok: false, error: 'Supplier not found.' };

  const linkedProducts = db
    .prepare('SELECT COUNT(*) as cnt FROM products WHERE supplier_id = ? AND business_id = ?')
    .get(id, businessId) as { cnt: number };
  if (linkedProducts.cnt > 0) {
    return {
      ok: false,
      error: `Cannot delete "${supplier.companyName}" because ${linkedProducts.cnt} product${linkedProducts.cnt > 1 ? 's reference' : ' references'} it. Archive the supplier instead to keep catalog history intact.`,
    };
  }

  const linkedOrders = db
    .prepare('SELECT COUNT(*) as cnt FROM purchase_orders WHERE supplier_id = ? AND business_id = ?')
    .get(id, businessId) as { cnt: number };
  if (linkedOrders.cnt > 0) {
    return {
      ok: false,
      error: `Cannot delete "${supplier.companyName}" because ${linkedOrders.cnt} purchase order record${linkedOrders.cnt > 1 ? 's reference' : ' references'} it. Archive the supplier instead to preserve audit history.`,
    };
  }

  db.prepare('DELETE FROM suppliers WHERE id = ? AND business_id = ?').run(id, businessId);
  return { ok: true };
}

export function listProducts(businessId: string, includeArchived = true): Product[] {
  const rows = db
    .prepare(
      `SELECT p.*, s.company_name as supplier_name
       FROM products p
       LEFT JOIN suppliers s ON p.supplier_id = s.id AND s.business_id = p.business_id
       WHERE p.business_id = ? ${includeArchived ? '' : 'AND p.archived = 0'}
       ORDER BY p.archived ASC, p.updated_at DESC`
    )
    .all(businessId) as Array<Record<string, unknown>>;

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

export function getProductById(businessId: string, id: string): Product | null {
  return listProducts(businessId, true).find((p) => p.id === id) || null;
}

export function createProduct(
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
): Product {
  const id = `prod-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const qty = Math.trunc(Number(input.quantity));

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO products (id, business_id, name, sku, category, description, supplier_id, unit_cost, selling_price, quantity, reorder_point, image_url, barcode, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(
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
      now
    );

    if (qty > 0) {
      db.prepare(
        `INSERT INTO stock_transactions (id, business_id, product_id, type, quantity_change, previous_quantity, resulting_quantity, party, reference_number, reason, note, user_id, user_name, transaction_date, created_at)
         VALUES (?, ?, ?, 'stock_in', ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
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
        now
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  syncLowStockAlertForProduct(businessId, id);
  return getProductById(businessId, id)!;
}

export function updateProduct(
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
): Product | null {
  const existing = getProductById(businessId, id);
  if (!existing) return null;
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE products
     SET name = ?, sku = ?, category = ?, description = ?, supplier_id = ?, unit_cost = ?, selling_price = ?, quantity = ?, reorder_point = ?, image_url = ?, barcode = ?, archived = ?, updated_at = ?
     WHERE id = ? AND business_id = ?`
  ).run(
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
    businessId
  );

  syncLowStockAlertForProduct(businessId, id);
  return getProductById(businessId, id);
}

export function deleteProduct(businessId: string, id: string): { ok: boolean; error?: string } {
  const existing = getProductById(businessId, id);
  if (!existing) return { ok: false, error: 'Product not found.' };

  const poUsage = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.po_id
       WHERE poi.product_id = ? AND po.business_id = ?`
    )
    .get(id, businessId) as { cnt: number };

  if (poUsage.cnt > 0) {
    return {
      ok: false,
      error: `Cannot delete "${existing.name}" because it is referenced by ${poUsage.cnt} purchase order line${poUsage.cnt > 1 ? 's' : ''}. Archive the product instead to preserve order audit history.`,
    };
  }

  const txUsage = db
    .prepare('SELECT COUNT(*) as cnt FROM stock_transactions WHERE product_id = ? AND business_id = ?')
    .get(id, businessId) as { cnt: number };

  if (txUsage.cnt > 0) {
    return {
      ok: false,
      error: `Cannot delete "${existing.name}" because it has ${txUsage.cnt} stock audit transaction${txUsage.cnt > 1 ? 's' : ''}. Archive the product instead to keep your stock ledger immutable.`,
    };
  }

  db.prepare('DELETE FROM products WHERE id = ? AND business_id = ?').run(id, businessId);
  return { ok: true };
}

export function listTransactions(
  businessId: string,
  filters?: {
    productId?: string;
    type?: string;
    limit?: number;
  }
): StockTransaction[] {
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
  if (filters?.type && (filters.type === 'stock_in' || filters.type === 'stock_out' || filters.type === 'adjustment')) {
    sql += ' AND t.type = ?';
    args.push(filters.type);
  }
  sql += ' ORDER BY t.transaction_date DESC, t.created_at DESC';
  if (filters?.limit) {
    sql += ' LIMIT ?';
    args.push(filters.limit);
  }

  const rows = db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
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

export function recordStockTransaction(
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
): { ok: boolean; transaction?: StockTransaction; product?: Product; error?: string } {
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

  db.exec('BEGIN IMMEDIATE');
  try {
    const productRow = db
      .prepare('SELECT id, name, quantity, archived FROM products WHERE id = ? AND business_id = ?')
      .get(input.productId, businessId) as
      | { id: string; name: string; quantity: number; archived: number }
      | undefined;

    if (!productRow) {
      db.exec('ROLLBACK');
      return { ok: false, error: 'Selected product was not found in your workspace.' };
    }
    if (productRow.archived) {
      db.exec('ROLLBACK');
      return { ok: false, error: `Cannot record stock movements for archived product "${productRow.name}". Unarchive it first.` };
    }

    const previousQty = Number(productRow.quantity);
    const delta =
      input.type === 'stock_in' ? qty : input.type === 'stock_out' ? -qty : qty;
    const resultingQty = previousQty + delta;

    if (resultingQty < 0 && !(input.type === 'adjustment' && input.isAdmin && input.allowNegativeOverride)) {
      db.exec('ROLLBACK');
      return {
        ok: false,
        error: `Movement would drop "${productRow.name}" below zero (${previousQty} -> ${resultingQty}).`,
      };
    }

    db.prepare('UPDATE products SET quantity = ?, updated_at = ? WHERE id = ? AND business_id = ?').run(
      resultingQty,
      now,
      productRow.id,
      businessId
    );

    db.prepare(
      `INSERT INTO stock_transactions (id, business_id, product_id, type, quantity_change, previous_quantity, resulting_quantity, party, reference_number, reason, note, user_id, user_name, transaction_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
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
      now
    );

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  syncLowStockAlertForProduct(businessId, input.productId);
  const transaction = listTransactions(businessId, { productId: input.productId }).find((t) => t.id === txId);
  const product = getProductById(businessId, input.productId)!;
  return { ok: true, transaction, product };
}

export function syncLowStockAlertForProduct(businessId: string, productId: string): void {
  const product = getProductById(businessId, productId);
  if (!product) return;
  const now = new Date().toISOString();

  const activeAlerts = db
    .prepare("SELECT id, alert_type FROM low_stock_alerts WHERE business_id = ? AND product_id = ? AND status = 'active'")
    .all(businessId, productId) as Array<{ id: string; alert_type: string }>;

  if (product.archived || getStockStatus(product.quantity, product.reorderPoint) === 'in_stock') {
    if (activeAlerts.length > 0) {
      db.prepare(
        "UPDATE low_stock_alerts SET status = 'resolved', resolved_at = ? WHERE business_id = ? AND product_id = ? AND status = 'active'"
      ).run(now, businessId, productId);
    }
    return;
  }

  const status = getStockStatus(product.quantity, product.reorderPoint);
  const transactions = listTransactions(businessId, { productId });
  const settings = getSettings(businessId);
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
    db.prepare(
      `INSERT INTO low_stock_alerts (id, business_id, product_id, status, alert_type, recommended_qty, created_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?)`
    ).run(`alt-${crypto.randomUUID().slice(0, 8)}`, businessId, productId, desiredType, recQty, now);
  } else {
    const [primary, ...extras] = activeAlerts;
    db.prepare('UPDATE low_stock_alerts SET alert_type = ?, recommended_qty = ? WHERE id = ? AND business_id = ?').run(
      desiredType,
      recQty,
      primary.id,
      businessId
    );
    for (const extra of extras) {
      db.prepare(
        "UPDATE low_stock_alerts SET status = 'resolved', resolved_at = ? WHERE id = ? AND business_id = ?"
      ).run(now, extra.id, businessId);
    }
  }
}

export function listLowStockAlerts(businessId: string, includeResolved = false): LowStockAlert[] {
  const rows = db
    .prepare(
      `SELECT a.*, p.name as product_name, p.sku, p.category, p.supplier_id, p.quantity, p.reorder_point, s.company_name as supplier_name
       FROM low_stock_alerts a
       JOIN products p ON p.id = a.product_id AND p.business_id = a.business_id
       LEFT JOIN suppliers s ON s.id = p.supplier_id AND s.business_id = a.business_id
       WHERE a.business_id = ? AND p.archived = 0 ${includeResolved ? '' : "AND a.status = 'active'"}
       ORDER BY CASE WHEN a.alert_type = 'out_of_stock' THEN 0 ELSE 1 END, p.quantity ASC`
    )
    .all(businessId) as Array<Record<string, unknown>>;

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

export function listPurchaseOrders(businessId: string): PurchaseOrder[] {
  const poRows = db
    .prepare(
      `SELECT po.*, s.company_name as supplier_name
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.business_id = po.business_id
       WHERE po.business_id = ?
       ORDER BY po.created_at DESC`
    )
    .all(businessId) as Array<Record<string, unknown>>;

  if (poRows.length === 0) return [];

  const itemRows = db
    .prepare(
      `SELECT poi.*, p.name as product_name, p.sku as product_sku
       FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.po_id
       LEFT JOIN products p ON p.id = poi.product_id AND p.business_id = po.business_id
       WHERE po.business_id = ?`
    )
    .all(businessId) as Array<Record<string, unknown>>;

  const eventRows = db
    .prepare(
      `SELECT poe.*
       FROM purchase_order_events poe
       JOIN purchase_orders po ON po.id = poe.po_id
       WHERE po.business_id = ?
       ORDER BY poe.created_at DESC`
    )
    .all(businessId) as Array<Record<string, unknown>>;

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

export function getPurchaseOrderById(businessId: string, id: string): PurchaseOrder | null {
  return listPurchaseOrders(businessId).find((po) => po.id === id) || null;
}

export function createPurchaseOrder(
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
): PurchaseOrder {
  const id = `po-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const year = new Date().getUTCFullYear();

  const existingCount = db
    .prepare('SELECT COUNT(*) as cnt FROM purchase_orders WHERE business_id = ?')
    .get(businessId) as { cnt: number };
  const poNumber = `PO-${year}-${String(existingCount.cnt + 101).padStart(3, '0')}`;

  const totalAmount = input.items.reduce(
    (sum, item) => sum + Number(item.quantityOrdered) * Number(item.unitCost),
    0
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO purchase_orders (id, business_id, po_number, supplier_id, status, order_date, expected_delivery_date, total_amount, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
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
      now
    );

    const insertItem = db.prepare(
      `INSERT INTO purchase_order_items (id, po_id, product_id, quantity_ordered, quantity_received, unit_cost)
       VALUES (?, ?, ?, ?, 0, ?)`
    );
    for (const item of input.items) {
      insertItem.run(
        `poi-${crypto.randomUUID().slice(0, 8)}`,
        id,
        item.productId,
        Math.trunc(Number(item.quantityOrdered)),
        Number(item.unitCost)
      );
    }

    db.prepare(
      `INSERT INTO purchase_order_events (id, po_id, event_type, description, user_name, created_at)
       VALUES (?, ?, 'Created', ?, ?, ?)`
    ).run(
      `poe-${crypto.randomUUID().slice(0, 8)}`,
      id,
      `Purchase order ${poNumber} created with status ${input.status}.`,
      actorName,
      now
    );

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return getPurchaseOrderById(businessId, id)!;
}

export function updatePurchaseOrderStatus(
  businessId: string,
  id: string,
  status: PurchaseOrderStatus,
  actorName: string
): { ok: boolean; order?: PurchaseOrder; error?: string } {
  const po = getPurchaseOrderById(businessId, id);
  if (!po) return { ok: false, error: 'Purchase order not found.' };
  if (po.status === 'Received' || po.status === 'Cancelled') {
    return { ok: false, error: `Cannot change status of a ${po.status} purchase order.` };
  }
  if (po.status === 'Partially Received' && status === 'Cancelled') {
    return { ok: false, error: 'Partially received orders cannot be cancelled.' };
  }

  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ? AND business_id = ?').run(
      status,
      now,
      id,
      businessId
    );
    db.prepare(
      `INSERT INTO purchase_order_events (id, po_id, event_type, description, user_name, created_at)
       VALUES (?, ?, 'Status Changed', ?, ?, ?)`
    ).run(
      `poe-${crypto.randomUUID().slice(0, 8)}`,
      id,
      `Order status changed from ${po.status} to ${status}.`,
      actorName,
      now
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { ok: true, order: getPurchaseOrderById(businessId, id)! };
}

export function receivePurchaseOrderItems(
  businessId: string,
  poId: string,
  receipts: Array<{ itemId: string; quantityToReceive: number }>,
  actor: { id: string; name: string }
): { ok: boolean; order?: PurchaseOrder; error?: string } {
  const po = getPurchaseOrderById(businessId, poId);
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

  db.exec('BEGIN IMMEDIATE');
  try {
    const receivedSummary: string[] = [];

    for (const r of validLines) {
      const qtyToAdd = Math.trunc(Number(r.quantityToReceive));
      const itemRow = db
        .prepare('SELECT * FROM purchase_order_items WHERE id = ? AND po_id = ?')
        .get(r.itemId, poId) as
        | {
            id: string;
            po_id: string;
            product_id: string;
            quantity_ordered: number;
            quantity_received: number;
            unit_cost: number;
          }
        | undefined;

      if (!itemRow) {
        db.exec('ROLLBACK');
        return { ok: false, error: 'Line item not found on purchase order.' };
      }

      const remaining = Number(itemRow.quantity_ordered) - Number(itemRow.quantity_received);
      if (qtyToAdd > remaining) {
        db.exec('ROLLBACK');
        return {
          ok: false,
          error: `Cannot receive ${qtyToAdd} units when only ${remaining} units remain open on this line.`,
        };
      }

      const prodRow = db
        .prepare('SELECT id, name, quantity FROM products WHERE id = ? AND business_id = ?')
        .get(itemRow.product_id, businessId) as { id: string; name: string; quantity: number } | undefined;

      if (!prodRow) {
        db.exec('ROLLBACK');
        return { ok: false, error: 'Linked product no longer exists.' };
      }

      const prevQty = Number(prodRow.quantity);
      const nextQty = prevQty + qtyToAdd;

      db.prepare('UPDATE purchase_order_items SET quantity_received = ? WHERE id = ?').run(
        Number(itemRow.quantity_received) + qtyToAdd,
        itemRow.id
      );

      db.prepare('UPDATE products SET quantity = ?, updated_at = ? WHERE id = ? AND business_id = ?').run(
        nextQty,
        now,
        prodRow.id,
        businessId
      );

      db.prepare(
        `INSERT INTO stock_transactions (id, business_id, product_id, type, quantity_change, previous_quantity, resulting_quantity, party, reference_number, reason, note, user_id, user_name, transaction_date, created_at)
         VALUES (?, ?, ?, 'stock_in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
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
        now
      );

      touchedProducts.push(prodRow.id);
      receivedSummary.push(`${qtyToAdd}x ${prodRow.name}`);
    }

    const updatedItems = db
      .prepare('SELECT quantity_ordered, quantity_received FROM purchase_order_items WHERE po_id = ?')
      .all(poId) as Array<{ quantity_ordered: number; quantity_received: number }>;

    const allReceived = updatedItems.every((i) => Number(i.quantity_received) >= Number(i.quantity_ordered));
    const nextStatus: PurchaseOrderStatus = allReceived ? 'Received' : 'Partially Received';

    db.prepare('UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ? AND business_id = ?').run(
      nextStatus,
      now,
      poId,
      businessId
    );

    db.prepare(
      `INSERT INTO purchase_order_events (id, po_id, event_type, description, user_name, created_at)
       VALUES (?, ?, 'Received', ?, ?, ?)`
    ).run(
      `poe-${crypto.randomUUID().slice(0, 8)}`,
      poId,
      `Confirmed receipt of ${receivedSummary.join(', ')}. Status updated to ${nextStatus}.`,
      actor.name,
      now
    );

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  for (const pid of touchedProducts) {
    syncLowStockAlertForProduct(businessId, pid);
  }

  return { ok: true, order: getPurchaseOrderById(businessId, poId)! };
}

export function exportBusinessBackup(businessId: string) {
  return {
    exportedAt: new Date().toISOString(),
    schemaVersion: 1,
    settings: getSettings(businessId),
    users: listUsers(businessId),
    suppliers: listSuppliers(businessId, true),
    products: listProducts(businessId, true),
    transactions: listTransactions(businessId),
    purchaseOrders: listPurchaseOrders(businessId),
    alerts: listLowStockAlerts(businessId, true),
  };
}
