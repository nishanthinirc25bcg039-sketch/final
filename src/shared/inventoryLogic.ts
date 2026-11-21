import type {
  DemandTrendItem,
  LowStockAlert,
  Product,
  PurchaseOrder,
  StockHealthBreakdown,
  StockStatus,
  StockTransaction,
  TransactionType,
} from './types.js';

export function getStockStatus(quantity: number, reorderPoint: number): StockStatus {
  if (quantity <= 0) return 'out_of_stock';
  if (quantity <= reorderPoint) return 'low_stock';
  return 'in_stock';
}

export function getStockStatusLabel(status: StockStatus): string {
  switch (status) {
    case 'out_of_stock':
      return 'Out of Stock';
    case 'low_stock':
      return 'Low Stock';
    default:
      return 'In Stock';
  }
}

export function isSafeImageUrl(url?: string): boolean {
  if (!url || !url.trim()) return true;
  const trimmed = url.trim();
  if (trimmed.startsWith('/src/assets/images/')) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function calculateInventoryValuation(products: Product[]) {
  const active = products.filter((p) => !p.archived);
  let totalUnits = 0;
  let inventoryCostValue = 0;
  let inventoryRetailValue = 0;
  let lowStockCount = 0;
  let outOfStockCount = 0;

  for (const p of active) {
    const qty = Math.max(0, Number(p.quantity) || 0);
    totalUnits += qty;
    inventoryCostValue += qty * (Number(p.unitCost) || 0);
    inventoryRetailValue += qty * (Number(p.sellingPrice) || 0);
    const status = getStockStatus(qty, Number(p.reorderPoint) || 0);
    if (status === 'out_of_stock') outOfStockCount += 1;
    else if (status === 'low_stock') lowStockCount += 1;
  }

  return {
    totalProducts: active.length,
    archivedProducts: products.length - active.length,
    totalUnits,
    inventoryCostValue: Math.round(inventoryCostValue * 100) / 100,
    inventoryRetailValue: Math.round(inventoryRetailValue * 100) / 100,
    potentialMargin: Math.round((inventoryRetailValue - inventoryCostValue) * 100) / 100,
    lowStockCount,
    outOfStockCount,
  };
}

export function calculateStockHealthScore(
  products: Product[],
  openOrders: PurchaseOrder[]
): StockHealthBreakdown {
  const active = products.filter((p) => !p.archived);
  const total = active.length;
  if (total === 0) {
    return {
      score: null,
      label: 'No Data',
      inputs: {
        totalProducts: 0,
        healthyCount: 0,
        lowStockCount: 0,
        outOfStockCount: 0,
        incomingCoverageCount: 0,
      },
      factors: [
        {
          name: 'Catalog baseline',
          impact: 'No products yet',
          detail: 'Add real products to begin measuring stock health against reorder thresholds.',
        },
      ],
    };
  }

  let healthyCount = 0;
  let lowStockCount = 0;
  let outOfStockCount = 0;
  const atRiskProductIds = new Set<string>();

  for (const p of active) {
    const st = getStockStatus(p.quantity, p.reorderPoint);
    if (st === 'in_stock') healthyCount += 1;
    else if (st === 'low_stock') {
      lowStockCount += 1;
      atRiskProductIds.add(p.id);
    } else {
      outOfStockCount += 1;
      atRiskProductIds.add(p.id);
    }
  }

  const coveredProductIds = new Set<string>();
  for (const po of openOrders) {
    if (po.status === 'Ordered' || po.status === 'Partially Received') {
      for (const item of po.items || []) {
        if (atRiskProductIds.has(item.productId) && item.quantityOrdered > item.quantityReceived) {
          coveredProductIds.add(item.productId);
        }
      }
    }
  }

  const baseRatio = (healthyCount / total) * 100;
  const outPenalty = Math.min(35, (outOfStockCount / total) * 60);
  const lowPenalty = Math.min(20, (lowStockCount / total) * 28);
  const coverageBonus =
    atRiskProductIds.size > 0
      ? Math.min(12, (coveredProductIds.size / atRiskProductIds.size) * 12)
      : 0;

  const rawScore = Math.round(
    Math.max(0, Math.min(100, baseRatio - outPenalty * 0.4 - lowPenalty * 0.25 + coverageBonus))
  );
  const label: StockHealthBreakdown['label'] =
    rawScore >= 80 ? 'Healthy' : rawScore >= 55 ? 'Needs Attention' : 'At Risk';

  return {
    score: rawScore,
    label,
    inputs: {
      totalProducts: total,
      healthyCount,
      lowStockCount,
      outOfStockCount,
      incomingCoverageCount: coveredProductIds.size,
    },
    factors: [
      {
        name: 'In-stock catalog share',
        impact: `${healthyCount}/${total} SKUs above reorder point`,
        detail: `${Math.round((healthyCount / total) * 100)}% of active SKUs are comfortably stocked.`,
      },
      {
        name: 'Out-of-stock exposure',
        impact:
          outOfStockCount === 0
            ? '0 SKUs out of stock'
            : `-${Math.round(outPenalty * 0.4)} pts (${outOfStockCount} empty)`,
        detail:
          outOfStockCount === 0
            ? 'No zero-quantity products interrupting fulfillment.'
            : `${outOfStockCount} product${outOfStockCount > 1 ? 's have' : ' has'} zero units on hand.`,
      },
      {
        name: 'Low-stock buffer',
        impact: lowStockCount === 0 ? 'No buffer breaches' : `${lowStockCount} at or below reorder point`,
        detail:
          lowStockCount === 0
            ? 'All stocked SKUs remain above their safety thresholds.'
            : `${lowStockCount} product${lowStockCount > 1 ? 's' : ''} reached reorder thresholds.`,
      },
      {
        name: 'Open PO coverage',
        impact:
          atRiskProductIds.size === 0
            ? 'No replenishment needed'
            : `+${Math.round(coverageBonus)} pts (${coveredProductIds.size}/${atRiskProductIds.size} covered)`,
        detail:
          atRiskProductIds.size === 0
            ? 'No low-stock SKUs awaiting inbound replenishment.'
            : `${coveredProductIds.size} of ${atRiskProductIds.size} low/empty SKUs have active inbound purchase orders.`,
      },
    ],
  };
}

export function validateStockMovement(input: {
  currentQty: number;
  type: TransactionType;
  quantity: number;
  reason?: string;
  isAdmin?: boolean;
  allowNegativeOverride?: boolean;
}): { valid: boolean; delta: number; expectedQty: number; error?: string } {
  const qty = Number(input.quantity);
  if (!Number.isFinite(qty) || !Number.isInteger(qty)) {
    return {
      valid: false,
      delta: 0,
      expectedQty: input.currentQty,
      error: 'Quantity must be a whole number.',
    };
  }

  if (input.type === 'adjustment') {
    if (!input.isAdmin) {
      return {
        valid: false,
        delta: 0,
        expectedQty: input.currentQty,
        error: 'Only workspace administrators can record stock adjustments or reversals.',
      };
    }
    if (qty === 0) {
      return {
        valid: false,
        delta: 0,
        expectedQty: input.currentQty,
        error: 'Adjustment delta must be non-zero (positive or negative).',
      };
    }
    if (!input.reason || input.reason.trim().length < 3) {
      return {
        valid: false,
        delta: 0,
        expectedQty: input.currentQty,
        error: 'Provide a clear reason (at least 3 characters) for audit adjustments.',
      };
    }
    const expectedQty = input.currentQty + qty;
    if (expectedQty < 0 && !input.allowNegativeOverride) {
      return {
        valid: false,
        delta: qty,
        expectedQty,
        error: `Adjustment would result in negative stock (${expectedQty}). Confirm explicit negative override or reduce adjustment amount.`,
      };
    }
    return { valid: true, delta: qty, expectedQty };
  }

  if (qty <= 0) {
    return {
      valid: false,
      delta: 0,
      expectedQty: input.currentQty,
      error: 'Quantity must be a positive whole number.',
    };
  }

  const delta = input.type === 'stock_in' ? qty : -qty;
  const expectedQty = input.currentQty + delta;
  if (expectedQty < 0) {
    return {
      valid: false,
      delta,
      expectedQty: input.currentQty,
      error: `Cannot remove ${qty} units when only ${input.currentQty} units are on hand.`,
    };
  }

  return { valid: true, delta, expectedQty };
}

export function validateProductInput(
  input: {
    name?: string;
    sku?: string;
    category?: string;
    supplierId?: string;
    unitCost?: number | string;
    sellingPrice?: number | string;
    quantity?: number | string;
    reorderPoint?: number | string;
    imageUrl?: string;
  },
  existingProducts: Array<{ id: string; sku: string }>,
  editingId?: string
): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = (input.name ?? '').trim();
  const sku = (input.sku ?? '').trim();
  const category = (input.category ?? '').trim();
  const supplierId = (input.supplierId ?? '').trim();

  if (!name) errors.name = 'Product name is required.';
  if (!sku) errors.sku = 'SKU is required.';
  else {
    const duplicate = existingProducts.find(
      (p) => p.sku.toLowerCase() === sku.toLowerCase() && p.id !== editingId
    );
    if (duplicate) errors.sku = `SKU "${sku}" is already assigned to another product.`;
  }
  if (!category) errors.category = 'Category is required.';
  if (!supplierId) errors.supplierId = 'Select a supplier.';

  const unitCost = Number(input.unitCost);
  const sellingPrice = Number(input.sellingPrice);
  const quantity = Number(input.quantity);
  const reorderPoint = Number(input.reorderPoint);

  if (input.unitCost === '' || !Number.isFinite(unitCost) || unitCost < 0) {
    errors.unitCost = 'Unit cost must be 0 or greater.';
  }
  if (input.sellingPrice === '' || !Number.isFinite(sellingPrice) || sellingPrice < 0) {
    errors.sellingPrice = 'Selling price must be 0 or greater.';
  }
  if (input.quantity === '' || !Number.isFinite(quantity) || !Number.isInteger(quantity) || quantity < 0) {
    errors.quantity = 'Quantity on hand must be a whole number 0 or greater.';
  }
  if (
    input.reorderPoint === '' ||
    !Number.isFinite(reorderPoint) ||
    !Number.isInteger(reorderPoint) ||
    reorderPoint < 0
  ) {
    errors.reorderPoint = 'Reorder point must be a whole number 0 or greater.';
  }
  if (!isSafeImageUrl(input.imageUrl)) {
    errors.imageUrl = 'Image URL must use http://, https://, or a built-in preset path.';
  }

  return errors;
}

export function validateSupplierInput(input: {
  companyName?: string;
  contactPerson?: string;
  email?: string;
  phone?: string;
}): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!(input.companyName ?? '').trim()) errors.companyName = 'Company name is required.';
  if (!(input.contactPerson ?? '').trim()) errors.contactPerson = 'Contact person is required.';
  const email = (input.email ?? '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = 'Valid email address is required.';
  }
  if (!(input.phone ?? '').trim()) errors.phone = 'Phone number is required.';
  return errors;
}

export function parseCsvRows(csvText: string): { headers: string[]; rows: Array<Record<string, string>> } {
  const lines: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  const normalized = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (inQuotes) {
      if (ch === '"' && normalized[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell.trim());
      cell = '';
    } else if (ch === '\n') {
      row.push(cell.trim());
      if (row.some((c) => c.length > 0)) lines.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    if (row.some((c) => c.length > 0)) lines.push(row);
  }

  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0].map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const rows = lines.slice(1).map((cols) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = cols[idx] ?? '';
    });
    return obj;
  });

  return { headers, rows };
}

export function calculateRecommendedReorderQty(
  product: Product,
  transactions: StockTransaction[],
  lookbackDays = 30,
  nowMs = Date.now(),
  multiplier = 2
): number {
  const cutoff = nowMs - lookbackDays * 24 * 60 * 60 * 1000;
  let outboundUnits = 0;
  for (const tx of transactions) {
    if (tx.productId !== product.id || tx.type !== 'stock_out') continue;
    const txMs = new Date(tx.transactionDate || tx.createdAt).getTime();
    if (txMs >= cutoff && txMs <= nowMs) {
      outboundUnits += Math.abs(tx.quantityChange);
    }
  }
  const targetByReorder = Math.max(10, product.reorderPoint * Math.max(1.5, multiplier));
  const targetByDemand =
    outboundUnits > 0
      ? Math.ceil((outboundUnits / Math.max(1, lookbackDays)) * 21) + product.reorderPoint
      : 0;
  const targetStock = Math.max(targetByReorder, targetByDemand);
  return Math.max(0, Math.ceil(targetStock - product.quantity));
}

export function analyzeDemandTrends(
  products: Product[],
  transactions: StockTransaction[],
  periodDays = 30,
  nowMs = Date.now()
): DemandTrendItem[] {
  const active = products.filter((p) => !p.archived);
  const halfPeriodMs = periodDays * 24 * 60 * 60 * 1000;
  const recentCutoff = nowMs - halfPeriodMs;
  const previousCutoff = nowMs - halfPeriodMs * 2;

  return active
    .map((p) => {
      let recentOutbound = 0;
      let previousOutbound = 0;
      let recentMaxSingleOut = 0;

      for (const tx of transactions) {
        if (tx.productId !== p.id || tx.type !== 'stock_out') continue;
        const txMs = new Date(tx.transactionDate || tx.createdAt).getTime();
        const qty = Math.abs(tx.quantityChange);
        if (txMs >= recentCutoff && txMs <= nowMs) {
          recentOutbound += qty;
          if (qty > recentMaxSingleOut) recentMaxSingleOut = qty;
        } else if (txMs >= previousCutoff && txMs < recentCutoff) {
          previousOutbound += qty;
        }
      }

      // Only compute a trend percentage when the prior comparison period has actual outbound data
      let changePercent: number | null = null;
      if (previousOutbound > 0) {
        changePercent = Math.round(((recentOutbound - previousOutbound) / previousOutbound) * 100);
      }

      let direction: DemandTrendItem['direction'] = 'insufficient_data';
      if (changePercent !== null) {
        if (changePercent >= 20 && recentOutbound >= 4) direction = 'rising';
        else if (changePercent <= -20 && previousOutbound >= 4) direction = 'falling';
        else direction = 'steady';
      }

      const recommendedReorderQty =
        p.quantity <= p.reorderPoint || (direction === 'rising' && p.quantity <= p.reorderPoint * 1.5)
          ? calculateRecommendedReorderQty(p, transactions, periodDays, nowMs)
          : 0;

      const overstockRisk =
        p.reorderPoint > 0 &&
        p.quantity >= p.reorderPoint * 4 &&
        recentOutbound <= Math.max(2, Math.floor(p.reorderPoint * 0.25));

      const unusualActivity =
        recentOutbound > 0 &&
        (recentMaxSingleOut >= Math.max(15, p.reorderPoint * 1.5) ||
          (previousOutbound > 0 && recentOutbound >= previousOutbound * 2.5));

      let explanation = '';
      if (direction === 'rising' && changePercent !== null) {
        explanation = `Outbound units rose ${changePercent}% (${recentOutbound} vs ${previousOutbound} in prior ${periodDays}d).`;
      } else if (direction === 'falling' && changePercent !== null) {
        explanation = `Outbound units slowed ${Math.abs(changePercent)}% (${recentOutbound} vs ${previousOutbound} in prior ${periodDays}d).`;
      } else if (direction === 'steady') {
        explanation = `Steady movement (${recentOutbound} vs ${previousOutbound} units in prior ${periodDays}d).`;
      } else if (recentOutbound > 0) {
        explanation = `${recentOutbound} units dispatched in the last ${periodDays}d; prior ${periodDays}d baseline not yet recorded.`;
      } else {
        explanation = `No outbound movements recorded across either ${periodDays}d comparison window.`;
      }

      return {
        productId: p.id,
        name: p.name,
        sku: p.sku,
        category: p.category,
        currentQty: p.quantity,
        reorderPoint: p.reorderPoint,
        recentOutbound,
        previousOutbound,
        changePercent,
        direction,
        explanation,
        recommendedReorderQty,
        overstockRisk,
        unusualActivity,
      };
    })
    .sort((a, b) => b.recentOutbound - a.recentOutbound);
}

export function buildMovementSeries(
  transactions: StockTransaction[],
  days = 14,
  nowMs = Date.now()
): Array<{ date: string; stockIn: number; stockOut: number }> {
  const buckets = new Map<string, { stockIn: number; stockOut: number }>();
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(nowMs - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, { stockIn: 0, stockOut: 0 });
  }

  for (const tx of transactions) {
    const key = (tx.transactionDate || tx.createdAt).slice(0, 10);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    if (tx.quantityChange >= 0) bucket.stockIn += Math.abs(tx.quantityChange);
    else bucket.stockOut += Math.abs(tx.quantityChange);
  }

  return Array.from(buckets.entries()).map(([date, val]) => ({
    date,
    stockIn: val.stockIn,
    stockOut: val.stockOut,
  }));
}

export function buildDailyBriefing(
  products: Product[],
  alerts: LowStockAlert[],
  openOrders: PurchaseOrder[],
  trends: DemandTrendItem[],
  supplierCount = 1
) {
  const activeProducts = products.filter((p) => !p.archived);
  const items: Array<{
    priority: 'urgent' | 'warning' | 'info';
    title: string;
    description: string;
    actionTab: string;
    productId?: string;
  }> = [];

  if (supplierCount === 0) {
    items.push({
      priority: 'info',
      title: 'Add your first supplier',
      description: 'Create or import your vendor contacts before adding SKUs or issuing purchase orders.',
      actionTab: 'suppliers',
    });
  }

  if (activeProducts.length === 0) {
    items.push({
      priority: 'info',
      title: 'Add your first product',
      description: 'Set up your product catalog individually or via CSV import to start tracking inventory.',
      actionTab: 'products',
    });
    return items;
  }

  const outAlerts = alerts.filter((a) => a.alertType === 'out_of_stock' && a.status === 'active');
  const lowAlerts = alerts.filter((a) => a.alertType === 'low_stock' && a.status === 'active');

  if (outAlerts.length > 0) {
    items.push({
      priority: 'urgent',
      title: `${outAlerts.length} product${outAlerts.length > 1 ? 's' : ''} out of stock`,
      description: `${outAlerts
        .slice(0, 2)
        .map((a) => a.productName)
        .join(', ')}${outAlerts.length > 2 ? ` +${outAlerts.length - 2} more` : ''} cannot fulfill new orders until restocked.`,
      actionTab: 'purchase-orders',
      productId: outAlerts[0].productId,
    });
  }

  if (lowAlerts.length > 0) {
    items.push({
      priority: 'warning',
      title: `${lowAlerts.length} SKU${lowAlerts.length > 1 ? 's' : ''} below reorder point`,
      description: `${lowAlerts[0].productName} has ${lowAlerts[0].quantity} units left (reorder point ${lowAlerts[0].reorderPoint}).`,
      actionTab: 'products',
      productId: lowAlerts[0].productId,
    });
  }

  const pendingReceipts = openOrders.filter(
    (po) => po.status === 'Ordered' || po.status === 'Partially Received'
  );
  if (pendingReceipts.length > 0) {
    items.push({
      priority: 'info',
      title: `${pendingReceipts.length} purchase order${pendingReceipts.length > 1 ? 's' : ''} awaiting receipt`,
      description: `Next expected delivery: ${pendingReceipts[0].poNumber} from ${pendingReceipts[0].supplierName || 'supplier'} (${pendingReceipts[0].expectedDeliveryDate}).`,
      actionTab: 'purchase-orders',
    });
  }

  const rising = trends.filter((t) => t.direction === 'rising');
  if (rising.length > 0) {
    items.push({
      priority: 'info',
      title: `Rising demand on ${rising[0].name}`,
      description: rising[0].explanation,
      actionTab: 'reports',
      productId: rising[0].productId,
    });
  }

  if (items.length === 0) {
    items.push({
      priority: 'info',
      title: 'All catalog thresholds healthy',
      description: 'Every active product is above its reorder threshold with no pending stock interruptions.',
      actionTab: 'products',
    });
  }

  return items;
}
