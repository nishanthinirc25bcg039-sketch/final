import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeDemandTrends,
  calculateInventoryValuation,
  calculateStockHealthScore,
  getStockStatus,
  parseCsvRows,
  validateProductInput,
  validateStockMovement,
} from './inventoryLogic.ts';
import type { Product, StockTransaction } from './types.ts';

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    businessId: 'biz-1',
    name: 'Stainless Kettle',
    sku: 'KT-100',
    category: 'Hardware',
    description: '',
    supplierId: 'sup-1',
    unitCost: 20,
    sellingPrice: 50,
    quantity: 15,
    reorderPoint: 10,
    archived: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeTx(overrides: Partial<StockTransaction> = {}): StockTransaction {
  return {
    id: 'tx-1',
    businessId: 'biz-1',
    productId: 'p1',
    type: 'stock_out',
    quantityChange: -5,
    previousQuantity: 20,
    resultingQuantity: 15,
    party: 'Storefront',
    referenceNumber: 'SO-1',
    reason: '',
    note: '',
    userId: 'u1',
    userName: 'Alice',
    transactionDate: '2026-02-01',
    createdAt: '2026-02-01T12:00:00Z',
    ...overrides,
  };
}

describe('inventoryLogic production behavior', () => {
  it('excludes archived products from inventory valuation and stock health', () => {
    const products = [
      makeProduct({ id: 'p1', quantity: 10, unitCost: 10, sellingPrice: 25, archived: false }),
      makeProduct({ id: 'p2', sku: 'OLD-1', quantity: 100, unitCost: 50, sellingPrice: 90, archived: true }),
    ];
    const valuation = calculateInventoryValuation(products);
    assert.equal(valuation.totalProducts, 1);
    assert.equal(valuation.archivedProducts, 1);
    assert.equal(valuation.totalUnits, 10);
    assert.equal(valuation.inventoryCostValue, 100);
    assert.equal(valuation.inventoryRetailValue, 250);
  });

  it('returns null health score and No Data when catalog is empty', () => {
    const health = calculateStockHealthScore([], []);
    assert.equal(health.score, null);
    assert.equal(health.label, 'No Data');
  });

  it('prevents normal stock-out below zero and restricts adjustments to admins with reason', () => {
    const badOut = validateStockMovement({ currentQty: 4, type: 'stock_out', quantity: 5 });
    assert.equal(badOut.valid, false);

    const staffAdj = validateStockMovement({
      currentQty: 10,
      type: 'adjustment',
      quantity: -2,
      reason: 'Cycle count',
      isAdmin: false,
    });
    assert.equal(staffAdj.valid, false);

    const noReasonAdj = validateStockMovement({
      currentQty: 10,
      type: 'adjustment',
      quantity: -2,
      reason: '',
      isAdmin: true,
    });
    assert.equal(noReasonAdj.valid, false);

    const validAdj = validateStockMovement({
      currentQty: 10,
      type: 'adjustment',
      quantity: -3,
      reason: 'Damaged items written off',
      isAdmin: true,
    });
    assert.equal(validAdj.valid, true);
    assert.equal(validAdj.expectedQty, 7);
  });

  it('returns null changePercent instead of +100% when prior period has no real outbound data', () => {
    const now = new Date('2026-03-10T12:00:00Z').getTime();
    const product = makeProduct({ id: 'p1' });
    const recentOnly = [makeTx({ transactionDate: '2026-03-05', quantityChange: -8 })];
    const trends = analyzeDemandTrends([product], recentOnly, 30, now);
    assert.equal(trends[0].changePercent, null);
    assert.equal(trends[0].direction, 'insufficient_data');

    const bothPeriods = [
      makeTx({ id: 't1', transactionDate: '2026-03-05', quantityChange: -15 }),
      makeTx({ id: 't2', transactionDate: '2026-02-01', quantityChange: -10 }),
    ];
    const trendsWithBaseline = analyzeDemandTrends([product], bothPeriods, 30, now);
    assert.equal(trendsWithBaseline[0].changePercent, 50);
    assert.equal(trendsWithBaseline[0].direction, 'rising');
  });

  it('validates unique SKUs, nonnegative prices, and safe image URLs', () => {
    const errs = validateProductInput(
      {
        name: 'Test',
        sku: 'KT-100',
        category: 'Gear',
        supplierId: 'sup-1',
        unitCost: -1,
        sellingPrice: 10,
        quantity: 5,
        reorderPoint: 2,
        imageUrl: 'javascript:alert(1)',
      },
      [{ id: 'other', sku: 'kt-100' }]
    );
    assert.ok(errs.sku);
    assert.ok(errs.unitCost);
    assert.ok(errs.imageUrl);
  });

  it('parses quoted CSV rows cleanly and determines stock status', () => {
    const csv = `name,sku,category,quantity,unitCost\n"Kettle, 1L",KT-01,Brew,12,42.50`;
    const parsed = parseCsvRows(csv);
    assert.equal(parsed.rows.length, 1);
    assert.equal(parsed.rows[0].name, 'Kettle, 1L');
    assert.equal(parsed.rows[0].sku, 'KT-01');
    assert.equal(getStockStatus(0, 5), 'out_of_stock');
    assert.equal(getStockStatus(5, 5), 'low_stock');
    assert.equal(getStockStatus(6, 5), 'in_stock');
  });
});
