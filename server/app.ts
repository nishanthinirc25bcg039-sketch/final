import express from 'express';
import {
  clearSessionCookie,
  createAuthMiddleware,
  createRateLimiter,
  extractRequestToken,
  isHttpsRequest,
  registerFallbackSecretProvider,
  requireAdmin,
  setSessionCookie,
  signAuthToken,
  validatePasswordStrength,
  verifyAuthToken,
  verifyPassword,
  type AuthenticatedRequest,
} from './auth.js';
import {
  consumePasswordResetToken,
  createPasswordResetToken,
  createProduct,
  createPurchaseOrder,
  createSupplier,
  createUser,
  deleteBusinessWorkspace,
  deleteProduct,
  deleteSupplier,
  ensureDatabaseReady,
  exportBusinessBackup,
  getDatabaseInitError,
  getOrCreateSessionSecret,
  getProductById,
  getPurchaseOrderById,
  getSettings,
  getStorageMode,
  getSupplierById,
  getUserAuthByEmail,
  getUserById,
  isEphemeralDatabase,
  listLowStockAlerts,
  listProducts,
  listPurchaseOrders,
  listSuppliers,
  listTransactions,
  listUsers,
  receivePurchaseOrderItems,
  recordStockTransaction,
  registerBusinessAndAdmin,
  updateProduct,
  updatePurchaseOrderStatus,
  updateSettings,
  updateSupplier,
  updateUser,
  updateUserPassword,
} from './db.js';
import { answerInventoryChat, generateInventoryInsights } from './ai.js';
import {
  analyzeDemandTrends,
  buildDailyBriefing,
  buildMovementSeries,
  calculateInventoryValuation,
  calculateStockHealthScore,
  validateProductInput,
  validateStockMovement,
  validateSupplierInput,
} from '../src/shared/inventoryLogic.js';
import type { PurchaseOrderStatus, TransactionType, UserRole } from '../src/shared/types.js';

registerFallbackSecretProvider(getOrCreateSessionSecret);

const asyncHandler =
  (
    fn: (
      req: AuthenticatedRequest,
      res: express.Response,
      next: express.NextFunction
    ) => Promise<void> | void
  ): express.RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req as AuthenticatedRequest, res, next)).catch(next);
  };

export function createApiApp(): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));

  const requireAuth = createAuthMiddleware(getUserById);
  const authRateLimit = createRateLimiter({
    maxRequests: 25,
    windowMs: 15 * 60 * 1000,
    keyFn: (req) => `auth:${req.ip || 'unknown'}`,
    message: 'Too many authentication attempts. Please wait a few minutes before retrying.',
  });
  const aiRateLimit = createRateLimiter({
    maxRequests: 25,
    windowMs: 10 * 60 * 1000,
    keyFn: (req) => `ai:${req.authUser?.id || req.ip || 'unknown'}`,
    message: 'AI request rate limit reached. Please wait a minute before sending another request.',
  });

  // Health
  app.get(
    '/api/health',
    asyncHandler(async (_req, res) => {
      try {
        await ensureDatabaseReady();
      } catch (err) {
        const dbErr = getDatabaseInitError() || (err instanceof Error ? err.message : String(err));
        res.status(503).json({
          ok: false,
          error: dbErr,
          storageMode: getStorageMode(),
          nodeVersion: process.version,
          ephemeralStorage: isEphemeralDatabase(),
        });
        return;
      }
      res.json({
        ok: true,
        storageMode: getStorageMode(),
        ephemeralStorage: isEphemeralDatabase(),
        nodeVersion: process.version,
      });
    })
  );

  // Ensure DB is initialized lazily and return structured 503 diagnostics on connection/runtime errors
  app.use(
    '/api',
    asyncHandler(async (_req, res, next) => {
      try {
        await ensureDatabaseReady();
        next();
      } catch (err) {
        const dbErr = getDatabaseInitError() || (err instanceof Error ? err.message : String(err));
        res.status(503).json({
          error:
            getStorageMode() === 'postgres'
              ? `PostgreSQL connection error: ${dbErr}`
              : `Database unavailable on Node ${process.version}: ${dbErr}. Set Node.js Version to 22.x or 24.x, or configure DATABASE_URL / POSTGRES_URL.`,
        });
      }
    })
  );

  // Auth: Register New Business Workspace + Admin
  app.post(
    '/api/auth/signup',
    authRateLimit,
    asyncHandler(async (req, res) => {
      const businessName = typeof req.body?.businessName === 'string' ? req.body.businessName.trim() : '';
      const adminName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const currencySymbol = typeof req.body?.currencySymbol === 'string' ? req.body.currencySymbol.trim() : '$';
      const timezone = typeof req.body?.timezone === 'string' ? req.body.timezone.trim() : 'UTC';
      const rememberMe = Boolean(req.body?.rememberMe);

      const fieldErrors: Record<string, string> = {};
      if (!businessName) fieldErrors.businessName = 'Business name is required.';
      if (!adminName) fieldErrors.name = 'Your full name is required.';
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        fieldErrors.email = 'Enter a valid email address.';
      }
      const pwErr = validatePasswordStrength(password);
      if (pwErr) fieldErrors.password = pwErr;

      if (Object.keys(fieldErrors).length > 0) {
        res.status(400).json({ error: Object.values(fieldErrors)[0], fieldErrors });
        return;
      }

      if (await getUserAuthByEmail(email)) {
        res.status(409).json({
          error: 'An account with this email already exists. Sign in or use a different email.',
          fieldErrors: { email: 'Email is already registered.' },
        });
        return;
      }

      const { user } = await registerBusinessAndAdmin({
        businessName,
        adminName,
        email,
        password,
        currencySymbol: currencySymbol || '$',
        timezone: timezone || 'UTC',
      });

      const token = await signAuthToken(
        { id: user.id, businessId: user.businessId, role: user.role },
        rememberMe
      );
      setSessionCookie(res, token, rememberMe, isHttpsRequest(req));
      res.status(201).json({ token, user });
    })
  );

  // Auth: Sign In
  app.post(
    '/api/auth/login',
    authRateLimit,
    asyncHandler(async (req, res) => {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const rememberMe = Boolean(req.body?.rememberMe);

      if (!email || !password) {
        res.status(400).json({ error: 'Email and password are required.' });
        return;
      }

      const account = await getUserAuthByEmail(email);
      if (!account || !verifyPassword(password, account.passwordHash)) {
        const hint = isEphemeralDatabase()
          ? ' Note: this Vercel preview has no external database configured yet, so temporary /tmp storage resets across cold starts.'
          : '';
        res.status(401).json({ error: `Invalid email or password.${hint}` });
        return;
      }
      if (!account.active) {
        res.status(403).json({ error: 'This account has been deactivated by an administrator.' });
        return;
      }

      const token = await signAuthToken(
        { id: account.id, businessId: account.businessId, role: account.role },
        rememberMe
      );
      setSessionCookie(res, token, rememberMe, isHttpsRequest(req));
      const { passwordHash: _ignored, ...safeUser } = account;
      res.json({ token, user: safeUser });
    })
  );

  app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(res, isHttpsRequest(req));
    res.json({ ok: true });
  });

  app.get(
    '/api/auth/me',
    asyncHandler(async (req, res) => {
      const { token } = extractRequestToken(req);
      if (!token) {
        res.json({ user: null });
        return;
      }
      const payload = await verifyAuthToken(token);
      if (!payload) {
        res.json({ user: null });
        return;
      }
      const user = await getUserById(payload.sub);
      res.json({
        user: user && user.active && user.businessId === payload.businessId ? user : null,
      });
    })
  );

  app.post(
    '/api/auth/change-password',
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
      const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
      if (!currentPassword) {
        res.status(400).json({ error: 'Enter your current password.' });
        return;
      }
      const pwErr = validatePasswordStrength(newPassword);
      if (pwErr) {
        res.status(400).json({ error: pwErr });
        return;
      }
      const account = await getUserAuthByEmail(req.authUser!.email);
      if (!account || !verifyPassword(currentPassword, account.passwordHash)) {
        res.status(401).json({ error: 'Current password is incorrect.' });
        return;
      }
      await updateUserPassword(req.authUser!.id, newPassword);
      res.json({ ok: true });
    })
  );

  app.post('/api/auth/forgot-password', authRateLimit, (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'Enter a valid email address.' });
      return;
    }
    res.json({
      ok: true,
      emailDeliveryConfigured: false,
      message:
        'Automated email delivery is not configured in this environment. Ask your workspace Administrator to issue a one-time reset token from Settings > Team & Role Access, then enter it on the Complete Reset tab.',
    });
  });

  app.post(
    '/api/auth/reset-password',
    authRateLimit,
    asyncHandler(async (req, res) => {
      const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
      const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
      if (!token) {
        res.status(400).json({ error: 'Enter the one-time reset token.' });
        return;
      }
      const pwErr = validatePasswordStrength(newPassword);
      if (pwErr) {
        res.status(400).json({ error: pwErr });
        return;
      }
      const result = await consumePasswordResetToken(token, newPassword);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ ok: true });
    })
  );

  async function buildDashboardPayload(businessId: string, days: number) {
    const [products, suppliers, transactions, purchaseOrders, alerts, settings] = await Promise.all([
      listProducts(businessId, true),
      listSuppliers(businessId, true),
      listTransactions(businessId),
      listPurchaseOrders(businessId),
      listLowStockAlerts(businessId, false),
      getSettings(businessId),
    ]);

    const activeProducts = products.filter((p) => !p.archived);
    const activeSupplierCount = suppliers.filter((s) => !s.archived).length;
    const valuation = calculateInventoryValuation(products);
    const openOrders = purchaseOrders.filter(
      (po) => po.status === 'Draft' || po.status === 'Ordered' || po.status === 'Partially Received'
    );
    const incomingUnits = openOrders.reduce((acc, po) => {
      if (po.status !== 'Ordered' && po.status !== 'Partially Received') return acc;
      return (
        acc +
        po.items.reduce(
          (sum, item) => sum + Math.max(0, item.quantityOrdered - item.quantityReceived),
          0
        )
      );
    }, 0);

    const healthScore = calculateStockHealthScore(activeProducts, openOrders);
    const trends = analyzeDemandTrends(activeProducts, transactions, days);
    const briefing = buildDailyBriefing(
      activeProducts,
      alerts,
      openOrders,
      trends,
      activeSupplierCount
    );
    const movementSeries = buildMovementSeries(transactions, days);
    const upcomingDeliveries = openOrders
      .filter((po) => po.status === 'Ordered' || po.status === 'Partially Received')
      .sort((a, b) => a.expectedDeliveryDate.localeCompare(b.expectedDeliveryDate));

    return {
      dashboard: {
        metrics: {
          totalProducts: valuation.totalProducts,
          archivedProducts: valuation.archivedProducts,
          totalUnits: valuation.totalUnits,
          inventoryCostValue: valuation.inventoryCostValue,
          inventoryRetailValue: valuation.inventoryRetailValue,
          lowStockCount: valuation.lowStockCount,
          outOfStockCount: valuation.outOfStockCount,
          openPurchaseOrders: openOrders.length,
          incomingUnits,
        },
        healthScore,
        briefing,
        movementSeries,
        lowStockItems: alerts,
        recentTransactions: transactions.slice(0, 8),
        upcomingDeliveries,
        settings,
      },
      products,
      transactions,
      suppliers,
      purchaseOrders,
      alerts,
    };
  }

  // Single-request workspace bootstrap (fast initial open & fewer concurrent serverless hops)
  app.get(
    '/api/workspace/bootstrap',
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const businessId = req.authUser!.businessId;
      const days = Math.min(90, Math.max(7, Number(req.query.days) || 14));
      res.json(await buildDashboardPayload(businessId, days));
    })
  );

  // Dashboard snapshot
  app.get(
    '/api/dashboard',
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const businessId = req.authUser!.businessId;
      const days = Math.min(90, Math.max(7, Number(req.query.days) || 14));
      const payload = await buildDashboardPayload(businessId, days);
      res.json(payload.dashboard);
    })
  );

  // Products
  app.get(
    '/api/products',
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json({ products: await listProducts(req.authUser!.businessId, true) });
    })
  );

  app.get(
    '/api/products/:id',
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const businessId = req.authUser!.businessId;
      const product = await getProductById(businessId, String(req.params.id));
      if (!product) {
        res.status(404).json({ error: 'Product not found.' });
        return;
      }
      const transactions = await listTransactions(businessId, { productId: product.id });
      res.json({ product, transactions });
    })
  );

  app.post(
    '/api/products',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const businessId = req.authUser!.businessId;
      const existing = await listProducts(businessId, true);
      const errors = validateProductInput(req.body || {}, existing);
      if (Object.keys(errors).length > 0) {
        res.status(400).json({ error: Object.values(errors)[0], fieldErrors: errors });
        return;
      }
      const supplier = await getSupplierById(businessId, String(req.body.supplierId));
      if (!supplier) {
        res.status(400).json({ error: 'Selected supplier was not found in your workspace.' });
        return;
      }
      const created = await createProduct(
        businessId,
        {
          name: String(req.body.name),
          sku: String(req.body.sku),
          category: String(req.body.category),
          description: String(req.body.description || ''),
          supplierId: supplier.id,
          unitCost: Number(req.body.unitCost),
          sellingPrice: Number(req.body.sellingPrice),
          quantity: Number(req.body.quantity),
          reorderPoint: Number(req.body.reorderPoint),
          imageUrl: typeof req.body.imageUrl === 'string' ? req.body.imageUrl : '',
          barcode: typeof req.body.barcode === 'string' ? req.body.barcode : '',
        },
        { id: req.authUser!.id, name: req.authUser!.name }
      );
      res.status(201).json({ product: created });
    })
  );

  app.post(
    '/api/products/import',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const businessId = req.authUser!.businessId;
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      const defaultSupplierId = String(req.body?.defaultSupplierId || '');

      if (rows.length === 0) {
        res.status(400).json({ error: 'No product rows were provided for import.' });
        return;
      }
      if (rows.length > 500) {
        res.status(400).json({ error: 'Import is limited to 500 rows per batch.' });
        return;
      }

      const [suppliers, existingProducts] = await Promise.all([
        listSuppliers(businessId, true),
        listProducts(businessId, true),
      ]);
      const seenSkus = new Set(existingProducts.map((p) => p.sku.toLowerCase()));
      const rowErrors: string[] = [];
      const prepared: Array<{
        name: string;
        sku: string;
        category: string;
        description: string;
        supplierId: string;
        unitCost: number;
        sellingPrice: number;
        quantity: number;
        reorderPoint: number;
        barcode: string;
      }> = [];

      rows.forEach((raw: Record<string, unknown>, idx: number) => {
        const lineNum = idx + 1;
        const supplierName = String(raw.supplier || raw.suppliername || '').trim().toLowerCase();
        const matchedSup =
          suppliers.find((s) => s.companyName.toLowerCase() === supplierName) ||
          suppliers.find((s) => s.id === defaultSupplierId);

        const candidate = {
          name: String(raw.name || raw.productname || '').trim(),
          sku: String(raw.sku || '').trim(),
          category: String(raw.category || 'General').trim(),
          description: String(raw.description || '').trim(),
          supplierId: matchedSup?.id || '',
          unitCost: Number(raw.unitcost ?? raw.cost ?? 0),
          sellingPrice: Number(raw.sellingprice ?? raw.price ?? 0),
          quantity: Number(raw.quantity ?? raw.qty ?? 0),
          reorderPoint: Number(raw.reorderpoint ?? raw.reorder ?? 10),
          barcode: String(raw.barcode || '').trim(),
        };

        const errs = validateProductInput(candidate, existingProducts);
        if (candidate.sku && seenSkus.has(candidate.sku.toLowerCase()) && !errs.sku) {
          errs.sku = `Duplicate SKU "${candidate.sku}" in import or existing catalog.`;
        }
        if (Object.keys(errs).length > 0) {
          rowErrors.push(`Row ${lineNum}: ${Object.values(errs).join(' ')}`);
        } else {
          seenSkus.add(candidate.sku.toLowerCase());
          prepared.push(candidate);
        }
      });

      if (rowErrors.length > 0) {
        res.status(400).json({
          error: rowErrors.slice(0, 5).join(' | '),
          rowErrors,
        });
        return;
      }

      const actor = { id: req.authUser!.id, name: req.authUser!.name };
      let importedCount = 0;
      for (const item of prepared) {
        await createProduct(businessId, item, actor);
        importedCount += 1;
      }
      res.status(201).json({ importedCount });
    })
  );

  app.put(
    '/api/products/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const businessId = req.authUser!.businessId;
      const id = String(req.params.id);
      const existing = await getProductById(businessId, id);
      if (!existing) {
        res.status(404).json({ error: 'Product not found.' });
        return;
      }
      const errors = validateProductInput(req.body || {}, await listProducts(businessId, true), id);
      if (Object.keys(errors).length > 0) {
        res.status(400).json({ error: Object.values(errors)[0], fieldErrors: errors });
        return;
      }
      const supplier = await getSupplierById(businessId, String(req.body.supplierId));
      if (!supplier) {
        res.status(400).json({ error: 'Selected supplier does not exist.' });
        return;
      }
      const updated = await updateProduct(businessId, id, {
        name: String(req.body.name),
        sku: String(req.body.sku),
        category: String(req.body.category),
        description: String(req.body.description || ''),
        supplierId: supplier.id,
        unitCost: Number(req.body.unitCost),
        sellingPrice: Number(req.body.sellingPrice),
        quantity: Number(req.body.quantity),
        reorderPoint: Number(req.body.reorderPoint),
        imageUrl: typeof req.body.imageUrl === 'string' ? req.body.imageUrl : existing.imageUrl,
        barcode: typeof req.body.barcode === 'string' ? req.body.barcode : existing.barcode,
      });
      res.json({ product: updated });
    })
  );

  app.patch(
    '/api/products/:id/archive',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const businessId = req.authUser!.businessId;
      const archived = Boolean(req.body?.archived);
      const updated = await updateProduct(businessId, String(req.params.id), { archived });
      if (!updated) {
        res.status(404).json({ error: 'Product not found.' });
        return;
      }
      res.json({ product: updated });
    })
  );

  app.delete(
    '/api/products/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const result = await deleteProduct(req.authUser!.businessId, String(req.params.id));
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ ok: true });
    })
  );

  // Transactions (Stock In & Stock Out — Staff & Admin; Adjustments — Admin only)
  app.get(
    '/api/transactions',
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json({ transactions: await listTransactions(req.authUser!.businessId) });
    })
  );

  app.post(
    '/api/transactions',
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const businessId = req.authUser!.businessId;
      const productId = String(req.body?.productId || '');
      const rawType = req.body?.type;
      const type: TransactionType | null =
        rawType === 'stock_in' || rawType === 'stock_out' || rawType === 'adjustment' ? rawType : null;
      const quantity = Number(req.body?.quantity);
      const transactionDate = String(req.body?.transactionDate || new Date().toISOString().slice(0, 10));
      const party = String(req.body?.party || '');
      const referenceNumber = String(req.body?.referenceNumber || '');
      const reason = String(req.body?.reason || '');
      const note = String(req.body?.note || '');
      const allowNegativeOverride = Boolean(req.body?.allowNegativeOverride);
      const isAdmin = req.authUser!.role === 'admin';

      if (!productId || !type) {
        res.status(400).json({ error: 'Product and valid transaction type are required.' });
        return;
      }

      const prod = await getProductById(businessId, productId);
      if (!prod) {
        res.status(404).json({ error: 'Product not found.' });
        return;
      }
      if (prod.archived) {
        res.status(400).json({ error: 'Cannot record stock movements for an archived product.' });
        return;
      }

      const check = validateStockMovement({
        currentQty: prod.quantity,
        type,
        quantity,
        reason,
        isAdmin,
        allowNegativeOverride,
      });
      if (!check.valid) {
        res.status(type === 'adjustment' && !isAdmin ? 403 : 400).json({ error: check.error });
        return;
      }

      const result = await recordStockTransaction(businessId, {
        productId,
        type,
        quantity,
        transactionDate,
        party,
        referenceNumber,
        reason,
        note,
        userId: req.authUser!.id,
        userName: req.authUser!.name,
        allowNegativeOverride,
        isAdmin,
      });

      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.status(201).json({ transaction: result.transaction, product: result.product });
    })
  );

  // Suppliers
  app.get(
    '/api/suppliers',
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json({ suppliers: await listSuppliers(req.authUser!.businessId, true) });
    })
  );

  app.get(
    '/api/suppliers/:id',
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const businessId = req.authUser!.businessId;
      const id = String(req.params.id);
      const supplier = await getSupplierById(businessId, id);
      if (!supplier) {
        res.status(404).json({ error: 'Supplier not found.' });
        return;
      }
      const [allProducts, allOrders] = await Promise.all([
        listProducts(businessId, true),
        listPurchaseOrders(businessId),
      ]);
      res.json({
        supplier,
        products: allProducts.filter((p) => p.supplierId === id),
        purchaseOrders: allOrders.filter((po) => po.supplierId === id),
      });
    })
  );

  app.post(
    '/api/suppliers',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const errors = validateSupplierInput(req.body || {});
      if (Object.keys(errors).length > 0) {
        res.status(400).json({ error: Object.values(errors)[0], fieldErrors: errors });
        return;
      }
      const supplier = await createSupplier(req.authUser!.businessId, {
        companyName: String(req.body.companyName),
        contactPerson: String(req.body.contactPerson),
        email: String(req.body.email),
        phone: String(req.body.phone),
        address: String(req.body?.address || ''),
        notes: String(req.body?.notes || ''),
        deliveryStatus: req.body?.deliveryStatus || 'On Schedule',
      });
      res.status(201).json({ supplier });
    })
  );

  app.post(
    '/api/suppliers/import',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const businessId = req.authUser!.businessId;
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      if (rows.length === 0) {
        res.status(400).json({ error: 'No supplier rows were provided.' });
        return;
      }
      if (rows.length > 500) {
        res.status(400).json({ error: 'Import is limited to 500 rows per batch.' });
        return;
      }

      const rowErrors: string[] = [];
      const prepared: Array<{
        companyName: string;
        contactPerson: string;
        email: string;
        phone: string;
        address: string;
        notes: string;
      }> = [];

      rows.forEach((raw: Record<string, unknown>, idx: number) => {
        const candidate = {
          companyName: String(raw.companyname || raw.company || raw.name || '').trim(),
          contactPerson: String(raw.contactperson || raw.contact || '').trim(),
          email: String(raw.email || '').trim(),
          phone: String(raw.phone || '').trim(),
          address: String(raw.address || '').trim(),
          notes: String(raw.notes || '').trim(),
        };
        const errs = validateSupplierInput(candidate);
        if (Object.keys(errs).length > 0) {
          rowErrors.push(`Row ${idx + 1}: ${Object.values(errs).join(' ')}`);
        } else {
          prepared.push(candidate);
        }
      });

      if (rowErrors.length > 0) {
        res.status(400).json({ error: rowErrors.slice(0, 5).join(' | '), rowErrors });
        return;
      }

      let importedCount = 0;
      for (const s of prepared) {
        await createSupplier(businessId, s);
        importedCount += 1;
      }
      res.status(201).json({ importedCount });
    })
  );

  app.put(
    '/api/suppliers/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const errors = validateSupplierInput(req.body || {});
      if (Object.keys(errors).length > 0) {
        res.status(400).json({ error: Object.values(errors)[0], fieldErrors: errors });
        return;
      }
      const updated = await updateSupplier(req.authUser!.businessId, String(req.params.id), {
        companyName: String(req.body.companyName),
        contactPerson: String(req.body.contactPerson),
        email: String(req.body.email),
        phone: String(req.body.phone),
        address: String(req.body?.address || ''),
        notes: String(req.body?.notes || ''),
        deliveryStatus: req.body?.deliveryStatus,
      });
      if (!updated) {
        res.status(404).json({ error: 'Supplier not found.' });
        return;
      }
      res.json({ supplier: updated });
    })
  );

  app.patch(
    '/api/suppliers/:id/archive',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const updated = await updateSupplier(req.authUser!.businessId, String(req.params.id), {
        archived: Boolean(req.body?.archived),
      });
      if (!updated) {
        res.status(404).json({ error: 'Supplier not found.' });
        return;
      }
      res.json({ supplier: updated });
    })
  );

  app.delete(
    '/api/suppliers/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const result = await deleteSupplier(req.authUser!.businessId, String(req.params.id));
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ ok: true });
    })
  );

  // Purchase Orders
  app.get(
    '/api/purchase-orders',
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json({ purchaseOrders: await listPurchaseOrders(req.authUser!.businessId) });
    })
  );

  app.get(
    '/api/purchase-orders/:id',
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const po = await getPurchaseOrderById(req.authUser!.businessId, String(req.params.id));
      if (!po) {
        res.status(404).json({ error: 'Purchase order not found.' });
        return;
      }
      res.json({ purchaseOrder: po });
    })
  );

  app.post(
    '/api/purchase-orders',
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const businessId = req.authUser!.businessId;
      const supplierId = String(req.body?.supplierId || '');
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      const supplier = supplierId ? await getSupplierById(businessId, supplierId) : null;
      if (!supplier || supplier.archived) {
        res.status(400).json({ error: 'Select an active supplier from your workspace.' });
        return;
      }
      if (items.length === 0) {
        res.status(400).json({ error: 'Add at least one product line to the purchase order.' });
        return;
      }
      for (const item of items) {
        const qty = Number(item.quantityOrdered);
        const cost = Number(item.unitCost);
        const prod = item.productId ? await getProductById(businessId, String(item.productId)) : null;
        if (!prod || prod.archived) {
          res.status(400).json({ error: 'All line items must reference active products in your workspace.' });
          return;
        }
        if (!Number.isInteger(qty) || qty <= 0) {
          res.status(400).json({ error: 'Ordered quantities must be positive whole numbers.' });
          return;
        }
        if (!Number.isFinite(cost) || cost < 0) {
          res.status(400).json({ error: 'Unit cost must be 0 or greater.' });
          return;
        }
      }

      const created = await createPurchaseOrder(
        businessId,
        {
          supplierId,
          status: req.body?.status === 'Ordered' ? 'Ordered' : 'Draft',
          orderDate: String(req.body?.orderDate || new Date().toISOString().slice(0, 10)),
          expectedDeliveryDate: String(req.body?.expectedDeliveryDate || ''),
          notes: String(req.body?.notes || ''),
          items,
        },
        req.authUser!.name
      );
      res.status(201).json({ purchaseOrder: created });
    })
  );

  app.patch(
    '/api/purchase-orders/:id/status',
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const status = String(req.body?.status || '') as PurchaseOrderStatus;
      const allowed: PurchaseOrderStatus[] = ['Draft', 'Ordered', 'Cancelled'];
      if (!allowed.includes(status)) {
        res.status(400).json({ error: 'Invalid status transition.' });
        return;
      }
      const result = await updatePurchaseOrderStatus(
        req.authUser!.businessId,
        String(req.params.id),
        status,
        req.authUser!.name
      );
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ purchaseOrder: result.order });
    })
  );

  app.post(
    '/api/purchase-orders/:id/receive',
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const receipts = Array.isArray(req.body?.receipts) ? req.body.receipts : [];
      const result = await receivePurchaseOrderItems(
        req.authUser!.businessId,
        String(req.params.id),
        receipts,
        { id: req.authUser!.id, name: req.authUser!.name }
      );
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ purchaseOrder: result.order });
    })
  );

  // Low-Stock Alerts
  app.get(
    '/api/alerts',
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const includeResolved = req.query.includeResolved === 'true';
      res.json({ alerts: await listLowStockAlerts(req.authUser!.businessId, includeResolved) });
    })
  );

  app.patch(
    '/api/alerts/product/:productId/threshold',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const businessId = req.authUser!.businessId;
      const productId = String(req.params.productId);
      const reorderPoint = Math.trunc(Number(req.body?.reorderPoint));
      if (!Number.isFinite(reorderPoint) || reorderPoint < 0) {
        res.status(400).json({ error: 'Reorder threshold must be a whole number 0 or greater.' });
        return;
      }
      const updated = await updateProduct(businessId, productId, { reorderPoint });
      if (!updated) {
        res.status(404).json({ error: 'Product not found.' });
        return;
      }
      res.json({ product: updated, alerts: await listLowStockAlerts(businessId, false) });
    })
  );

  // Reports
  app.get(
    '/api/reports',
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const businessId = req.authUser!.businessId;
      const days = Math.min(180, Math.max(7, Number(req.query.days) || 30));
      const category = typeof req.query.category === 'string' ? req.query.category : 'all';

      const [allProducts, allTransactions, allPurchaseOrders, suppliers] = await Promise.all([
        listProducts(businessId, false),
        listTransactions(businessId),
        listPurchaseOrders(businessId),
        listSuppliers(businessId, false),
      ]);

      const filteredProducts =
        category !== 'all'
          ? allProducts.filter((p) => p.category.toLowerCase() === category.toLowerCase())
          : allProducts;
      const productIds = new Set(filteredProducts.map((p) => p.id));

      const cutoffIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const transactions = allTransactions.filter(
        (tx) => productIds.has(tx.productId) && tx.transactionDate >= cutoffIso
      );
      const purchaseOrders = allPurchaseOrders.filter((po) => po.orderDate >= cutoffIso);
      const valuation = calculateInventoryValuation(filteredProducts);
      const trends = analyzeDemandTrends(filteredProducts, allTransactions, days);

      const categoryBreakdownMap = new Map<
        string,
        { category: string; skus: number; units: number; costValue: number; retailValue: number }
      >();
      for (const p of filteredProducts) {
        const entry = categoryBreakdownMap.get(p.category) || {
          category: p.category,
          skus: 0,
          units: 0,
          costValue: 0,
          retailValue: 0,
        };
        entry.skus += 1;
        entry.units += p.quantity;
        entry.costValue += p.quantity * p.unitCost;
        entry.retailValue += p.quantity * p.sellingPrice;
        categoryBreakdownMap.set(p.category, entry);
      }

      res.json({
        days,
        cutoffIso,
        category,
        categories: Array.from(new Set(allProducts.map((p) => p.category))).sort(),
        valuation,
        products: filteredProducts,
        transactions,
        purchaseOrders,
        suppliers,
        trends,
        movementSeries: buildMovementSeries(transactions, Math.min(days, 30)),
        categoryBreakdown: Array.from(categoryBreakdownMap.values()),
      });
    })
  );

  // AI Insights & Inventory Chatbot (Strict Gemini API, zero fake fallbacks)
  app.post(
    '/api/ai/insights',
    requireAuth,
    aiRateLimit,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const businessId = req.authUser!.businessId;
      const periodDays = Math.min(90, Math.max(7, Number(req.body?.periodDays) || 30));
      const [products, transactions, purchaseOrders] = await Promise.all([
        listProducts(businessId, false),
        listTransactions(businessId),
        listPurchaseOrders(businessId),
      ]);
      const insights = await generateInventoryInsights({
        products,
        transactions,
        purchaseOrders,
        periodDays,
      });
      res.json({ insights });
    })
  );

  app.post(
    '/api/ai/chat',
    requireAuth,
    aiRateLimit,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const businessId = req.authUser!.businessId;
      const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
      if (!question) {
        res.status(400).json({ error: 'Enter a question about your inventory.' });
        return;
      }
      if (question.length > 600) {
        res.status(400).json({ error: 'Keep questions under 600 characters.' });
        return;
      }
      const [products, transactions, purchaseOrders] = await Promise.all([
        listProducts(businessId, false),
        listTransactions(businessId),
        listPurchaseOrders(businessId),
      ]);
      const reply = await answerInventoryChat({
        question,
        products,
        transactions,
        purchaseOrders,
      });
      res.json({ reply });
    })
  );

  // Settings, Users, Backup Export & Workspace Deletion
  app.get(
    '/api/settings',
    requireAuth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json({ settings: await getSettings(req.authUser!.businessId) });
    })
  );

  app.put(
    '/api/settings',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const businessName =
        typeof req.body?.businessName === 'string' ? req.body.businessName.trim() : undefined;
      if (businessName !== undefined && !businessName) {
        res.status(400).json({ error: 'Business name cannot be empty.' });
        return;
      }
      const updated = await updateSettings(req.authUser!.businessId, {
        businessName,
        currencySymbol:
          typeof req.body?.currencySymbol === 'string'
            ? req.body.currencySymbol.trim() || '$'
            : undefined,
        timezone:
          typeof req.body?.timezone === 'string' ? req.body.timezone.trim() || 'UTC' : undefined,
        defaultReorderMultiplier:
          req.body?.defaultReorderMultiplier !== undefined
            ? Math.max(1, Math.min(5, Number(req.body.defaultReorderMultiplier) || 2))
            : undefined,
        lowStockBannerEnabled:
          typeof req.body?.lowStockBannerEnabled === 'boolean'
            ? req.body.lowStockBannerEnabled
            : undefined,
        lowStockDigestEnabled:
          typeof req.body?.lowStockDigestEnabled === 'boolean'
            ? req.body.lowStockDigestEnabled
            : undefined,
        poStatusAlertsEnabled:
          typeof req.body?.poStatusAlertsEnabled === 'boolean'
            ? req.body.poStatusAlertsEnabled
            : undefined,
      });
      res.json({ settings: updated });
    })
  );

  app.get(
    '/api/users',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json({ users: await listUsers(req.authUser!.businessId) });
    })
  );

  app.post(
    '/api/users',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const businessId = req.authUser!.businessId;
      const name = String(req.body?.name || '').trim();
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const role: UserRole = req.body?.role === 'admin' ? 'admin' : 'staff';

      if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        res.status(400).json({ error: 'Full name and a valid email address are required.' });
        return;
      }
      const pwErr = validatePasswordStrength(password);
      if (pwErr) {
        res.status(400).json({ error: pwErr });
        return;
      }
      if (await getUserAuthByEmail(email)) {
        res.status(409).json({ error: 'An account with this email already exists.' });
        return;
      }
      const created = await createUser(businessId, { name, email, password, role });
      res.status(201).json({ user: created });
    })
  );

  app.patch(
    '/api/users/:id',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const businessId = req.authUser!.businessId;
      const targetId = String(req.params.id);
      if (targetId === req.authUser!.id && req.body?.active === false) {
        res.status(400).json({ error: 'You cannot deactivate your own active session.' });
        return;
      }
      const result = await updateUser(businessId, targetId, {
        role: req.body?.role === 'admin' || req.body?.role === 'staff' ? req.body.role : undefined,
        active: typeof req.body?.active === 'boolean' ? req.body.active : undefined,
        name: typeof req.body?.name === 'string' ? req.body.name : undefined,
      });
      if (!result.ok) {
        res.status(result.error === 'User not found.' ? 404 : 400).json({ error: result.error });
        return;
      }
      res.json({ user: result.user });
    })
  );

  app.post(
    '/api/users/:id/reset-token',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const businessId = req.authUser!.businessId;
      const target = await getUserById(String(req.params.id));
      if (!target || target.businessId !== businessId) {
        res.status(404).json({ error: 'Team user not found in your workspace.' });
        return;
      }
      const issued = await createPasswordResetToken(businessId, target.id, 15);
      res.json({
        token: issued.rawToken,
        expiresAt: issued.expiresAt,
        userName: target.name,
        userEmail: target.email,
      });
    })
  );

  app.get(
    '/api/backup/export',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const backup = await exportBusinessBackup(req.authUser!.businessId);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="smartstock-backup-${new Date().toISOString().slice(0, 10)}.json"`
      );
      res.send(JSON.stringify(backup, null, 2));
    })
  );

  app.delete(
    '/api/account/workspace',
    requireAuth,
    requireAdmin,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const account = await getUserAuthByEmail(req.authUser!.email);
      if (!account || !verifyPassword(password, account.passwordHash)) {
        res.status(401).json({ error: 'Enter your current password to confirm workspace deletion.' });
        return;
      }
      await deleteBusinessWorkspace(req.authUser!.businessId);
      clearSessionCookie(res, isHttpsRequest(req));
      res.json({ ok: true });
    })
  );

  // API 404 fallback
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  // Global JSON error fallback (never return HTML error pages for /api/*)
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : 'Unexpected server error.';
    console.error('SmartStock API error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    }
  });

  return app;
}
