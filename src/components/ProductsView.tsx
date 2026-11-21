import React, { useMemo, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  ArrowUpDown,
  Edit3,
  Eye,
  Package,
  Plus,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { getStockStatus, parseCsvRows, validateProductInput } from '../shared/inventoryLogic';
import { apiFetch, formatCurrency, formatShortDate } from '../utils/api';
import {
  ConfirmDialog,
  EmptyState,
  Modal,
  PaginationBar,
  ProductThumbnail,
  StockStatusLabel,
  TransactionTypeLabel,
} from './ui/Common';
import type { Product, StockTransaction, Supplier, UserRole } from '../shared/types';

const PAGE_SIZE = 12;

export function ProductsView({
  products,
  suppliers,
  currencySymbol,
  userRole,
  onDataChanged,
  onQuickStock,
  onNavigateSuppliers,
  onNotify,
}: {
  products: Product[];
  suppliers: Supplier[];
  currencySymbol: string;
  userRole: UserRole;
  onDataChanged: () => Promise<void>;
  onQuickStock: (productId: string) => void;
  onNavigateSuppliers: () => void;
  onNotify: (msg: string, tone?: 'success' | 'error') => void;
}) {
  const isAdmin = userRole === 'admin';
  const activeSuppliers = useMemo(() => suppliers.filter((s) => !s.archived), [suppliers]);

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [supplierFilter, setSupplierFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [archiveFilter, setArchiveFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [sortBy, setSortBy] = useState<'updated' | 'name' | 'quantity' | 'value'>('updated');
  const [page, setPage] = useState(1);

  // Product Form Modal State
  const [formOpen, setFormOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [form, setForm] = useState({
    name: '',
    sku: '',
    category: '',
    description: '',
    supplierId: '',
    unitCost: '0',
    sellingPrice: '0',
    quantity: '0',
    reorderPoint: '10',
    imageUrl: '',
    barcode: '',
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // CSV Import State
  const [importOpen, setImportOpen] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [importSupplierId, setImportSupplierId] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // Detail Panel State
  const [detailProduct, setDetailProduct] = useState<Product | null>(null);
  const [detailTransactions, setDetailTransactions] = useState<StockTransaction[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [thresholdInput, setThresholdInput] = useState('');
  const [savingThreshold, setSavingThreshold] = useState(false);

  // Delete Confirmation State
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState(false);

  const categories = useMemo(
    () => Array.from(new Set(products.map((p) => p.category))).sort(),
    [products]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products
      .filter((p) => {
        if (archiveFilter === 'active' && p.archived) return false;
        if (archiveFilter === 'archived' && !p.archived) return false;
        if (
          q &&
          !p.name.toLowerCase().includes(q) &&
          !p.sku.toLowerCase().includes(q) &&
          !(p.barcode || '').toLowerCase().includes(q)
        ) {
          return false;
        }
        if (categoryFilter !== 'all' && p.category !== categoryFilter) return false;
        if (supplierFilter !== 'all' && p.supplierId !== supplierFilter) return false;
        const status = getStockStatus(p.quantity, p.reorderPoint);
        if (statusFilter !== 'all' && status !== statusFilter) return false;
        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'name') return a.name.localeCompare(b.name);
        if (sortBy === 'quantity') return b.quantity - a.quantity;
        if (sortBy === 'value') return b.quantity * b.unitCost - a.quantity * a.unitCost;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
  }, [products, archiveFilter, search, categoryFilter, supplierFilter, statusFilter, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage]
  );

  const openCreateModal = () => {
    if (activeSuppliers.length === 0) {
      onNotify('Add an active supplier first before creating products.', 'error');
      onNavigateSuppliers();
      return;
    }
    setEditingProduct(null);
    setForm({
      name: '',
      sku: '',
      category: categories[0] || '',
      description: '',
      supplierId: activeSuppliers[0]?.id || '',
      unitCost: '',
      sellingPrice: '',
      quantity: '0',
      reorderPoint: '10',
      imageUrl: '',
      barcode: '',
    });
    setFieldErrors({});
    setFormError(null);
    setFormOpen(true);
  };

  const openEditModal = (product: Product) => {
    setEditingProduct(product);
    setForm({
      name: product.name,
      sku: product.sku,
      category: product.category,
      description: product.description,
      supplierId: product.supplierId,
      unitCost: String(product.unitCost),
      sellingPrice: String(product.sellingPrice),
      quantity: String(product.quantity),
      reorderPoint: String(product.reorderPoint),
      imageUrl: product.imageUrl || '',
      barcode: product.barcode || '',
    });
    setFieldErrors({});
    setFormError(null);
    setFormOpen(true);
  };

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const errors = validateProductInput(form, products, editingProduct?.id);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        sku: form.sku.trim(),
        category: form.category.trim(),
        description: form.description.trim(),
        supplierId: form.supplierId,
        unitCost: Number(form.unitCost),
        sellingPrice: Number(form.sellingPrice),
        quantity: Math.trunc(Number(form.quantity)),
        reorderPoint: Math.trunc(Number(form.reorderPoint)),
        imageUrl: form.imageUrl.trim(),
        barcode: form.barcode.trim(),
      };
      if (editingProduct) {
        await apiFetch(`/api/products/${editingProduct.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        onNotify(`Updated "${payload.name}"`);
      } else {
        await apiFetch('/api/products', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        onNotify(`Added "${payload.name}" to catalog`);
      }
      setFormOpen(false);
      await onDataChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to save product.';
      setFormError(msg);
      if (err && typeof err === 'object' && 'fieldErrors' in err && err.fieldErrors) {
        setFieldErrors(err.fieldErrors as Record<string, string>);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleToggleArchive = async (p: Product) => {
    try {
      await apiFetch(`/api/products/${p.id}/archive`, {
        method: 'PATCH',
        body: JSON.stringify({ archived: !p.archived }),
      });
      onNotify(`${p.archived ? 'Restored' : 'Archived'} "${p.name}"`);
      if (detailProduct?.id === p.id) setDetailProduct(null);
      await onDataChanged();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to update archive status.', 'error');
    }
  };

  const handleImportCsv = async (e: React.FormEvent) => {
    e.preventDefault();
    setImportError(null);
    const parsed = parseCsvRows(csvText);
    if (parsed.rows.length === 0) {
      setImportError('Paste or upload a valid CSV with a header row and at least one product row.');
      return;
    }
    setImporting(true);
    try {
      const res = await apiFetch<{ importedCount: number }>('/api/products/import', {
        method: 'POST',
        body: JSON.stringify({
          rows: parsed.rows,
          defaultSupplierId: importSupplierId || activeSuppliers[0]?.id || '',
        }),
      });
      setImportOpen(false);
      setCsvText('');
      onNotify(`Imported ${res.importedCount} product${res.importedCount === 1 ? '' : 's'}.`);
      await onDataChanged();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'CSV import failed.');
    } finally {
      setImporting(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setCsvText(reader.result);
    };
    reader.readAsText(file);
  };

  const openDetailModal = async (product: Product) => {
    setDetailProduct(product);
    setThresholdInput(String(product.reorderPoint));
    setDetailLoading(true);
    try {
      const res = await apiFetch<{ product: Product; transactions: StockTransaction[] }>(
        `/api/products/${product.id}`
      );
      setDetailProduct(res.product);
      setDetailTransactions(res.transactions);
    } catch {
      setDetailTransactions([]);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleSaveThreshold = async () => {
    if (!detailProduct) return;
    const val = Math.trunc(Number(thresholdInput));
    if (!Number.isFinite(val) || val < 0) {
      onNotify('Reorder point must be 0 or greater.', 'error');
      return;
    }
    setSavingThreshold(true);
    try {
      const res = await apiFetch<{ product: Product }>(`/api/alerts/product/${detailProduct.id}/threshold`, {
        method: 'PATCH',
        body: JSON.stringify({ reorderPoint: val }),
      });
      setDetailProduct(res.product);
      await onDataChanged();
      onNotify(`Reorder point updated to ${val} units`);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Failed to update threshold.', 'error');
    } finally {
      setSavingThreshold(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/products/${deleteTarget.id}`, { method: 'DELETE' });
      onNotify(`Deleted "${deleteTarget.name}"`);
      setDeleteTarget(null);
      if (detailProduct?.id === deleteTarget.id) setDetailProduct(null);
      await onDataChanged();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Unable to delete product.', 'error');
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 flex-1">
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
            <input
              type="search"
              aria-label="Search products by name, SKU, or barcode"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search name, SKU, barcode..."
              className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>

          <select
            aria-label="Filter by category"
            value={categoryFilter}
            onChange={(e) => {
              setCategoryFilter(e.target.value);
              setPage(1);
            }}
            className="px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
          >
            <option value="all">All Categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>

          <select
            aria-label="Filter by supplier"
            value={supplierFilter}
            onChange={(e) => {
              setSupplierFilter(e.target.value);
              setPage(1);
            }}
            className="px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
          >
            <option value="all">All Suppliers</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>{s.companyName}</option>
            ))}
          </select>

          <select
            aria-label="Filter by stock status"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
          >
            <option value="all">All Statuses</option>
            <option value="in_stock">In Stock</option>
            <option value="low_stock">Low Stock</option>
            <option value="out_of_stock">Out of Stock</option>
          </select>

          <select
            aria-label="Filter by archive status"
            value={archiveFilter}
            onChange={(e) => {
              setArchiveFilter(e.target.value as 'active' | 'archived' | 'all');
              setPage(1);
            }}
            className="px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
          >
            <option value="active">Active Catalog</option>
            <option value="archived">Archived Only</option>
            <option value="all">All Products</option>
          </select>

          <div className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-300 rounded-lg">
            <ArrowUpDown className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
            <select
              aria-label="Sort products"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              className="text-sm bg-transparent focus:outline-none"
            >
              <option value="updated">Recently Updated</option>
              <option value="name">Name (A–Z)</option>
              <option value="quantity">Quantity (High–Low)</option>
              <option value="value">Stock Value (High–Low)</option>
            </select>
          </div>
        </div>

        {isAdmin && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                setImportError(null);
                setImportSupplierId(activeSuppliers[0]?.id || '');
                setImportOpen(true);
              }}
              className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 whitespace-nowrap"
            >
              <Upload className="w-4 h-4" aria-hidden="true" />
              <span>Import CSV</span>
            </button>
            <button
              type="button"
              onClick={openCreateModal}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 whitespace-nowrap"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              <span>Add Product</span>
            </button>
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        products.length === 0 ? (
          activeSuppliers.length === 0 ? (
            <EmptyState
              icon={Package}
              title="Add your first supplier before adding products"
              description="Every product in your catalog links to a supplier. Add or import at least one supplier first, then add products manually or via CSV."
              actionLabel={isAdmin ? 'Go to Suppliers' : undefined}
              onAction={isAdmin ? onNavigateSuppliers : undefined}
            />
          ) : (
            <EmptyState
              icon={Package}
              title="Add your first product"
              description="Your product catalog is empty. Create a product record or import a CSV spreadsheet of your real inventory."
              actionLabel={isAdmin ? 'Add First Product' : undefined}
              onAction={isAdmin ? openCreateModal : undefined}
              secondaryActionLabel={isAdmin ? 'Import CSV' : undefined}
              onSecondaryAction={
                isAdmin
                  ? () => {
                      setImportSupplierId(activeSuppliers[0]?.id || '');
                      setImportOpen(true);
                    }
                  : undefined
              }
            />
          )
        ) : (
          <EmptyState
            icon={Package}
            title="No matching products"
            description="Try clearing one of your search, archive, or status filters."
          />
        )
      ) : (
        <>
          {/* Desktop Table */}
          <div className="hidden lg:block bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-semibold text-slate-600">
                    <th className="py-3 px-4">Product</th>
                    <th className="py-3 px-3">SKU</th>
                    <th className="py-3 px-3">Category</th>
                    <th className="py-3 px-3">Supplier</th>
                    <th className="py-3 px-3 text-right">Qty</th>
                    <th className="py-3 px-3 text-right">Reorder</th>
                    <th className="py-3 px-3 text-right">Cost</th>
                    <th className="py-3 px-3 text-right">Price</th>
                    <th className="py-3 px-3">Status</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {paginated.map((p) => {
                    const status = getStockStatus(p.quantity, p.reorderPoint);
                    return (
                      <tr key={p.id} className={`hover:bg-slate-50/80 transition-colors ${p.archived ? 'opacity-65' : ''}`}>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-3">
                            <ProductThumbnail src={p.imageUrl} alt={p.name} size="sm" />
                            <div>
                              <button
                                type="button"
                                onClick={() => openDetailModal(p)}
                                className="font-medium text-slate-900 hover:text-teal-700 text-left"
                              >
                                {p.name}
                              </button>
                              {p.archived && (
                                <span className="ml-2 text-[11px] font-mono text-slate-500">[Archived]</span>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-3 font-mono text-xs text-slate-600 whitespace-nowrap">{p.sku}</td>
                        <td className="py-3 px-3 text-slate-600">{p.category}</td>
                        <td className="py-3 px-3 text-slate-600">{p.supplierName}</td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums font-semibold text-slate-900">
                          {p.quantity}
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-500">
                          {p.reorderPoint}
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-600">
                          {formatCurrency(p.unitCost, currencySymbol)}
                        </td>
                        <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-900">
                          {formatCurrency(p.sellingPrice, currencySymbol)}
                        </td>
                        <td className="py-3 px-3">
                          <StockStatusLabel status={status} />
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="inline-flex items-center justify-end gap-1">
                            {!p.archived && (
                              <button
                                type="button"
                                onClick={() => onQuickStock(p.id)}
                                className="px-2.5 py-1 text-xs font-medium text-teal-700 bg-teal-50 border border-teal-200 rounded-md hover:bg-teal-100 whitespace-nowrap"
                              >
                                Stock
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => openDetailModal(p)}
                              aria-label={`View ${p.name}`}
                              className="p-1.5 text-slate-500 hover:text-slate-900 rounded-md hover:bg-slate-100"
                            >
                              <Eye className="w-4 h-4" />
                            </button>
                            {isAdmin && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => openEditModal(p)}
                                  aria-label={`Edit ${p.name}`}
                                  className="p-1.5 text-slate-500 hover:text-slate-900 rounded-md hover:bg-slate-100"
                                >
                                  <Edit3 className="w-4 h-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleToggleArchive(p)}
                                  aria-label={p.archived ? `Restore ${p.name}` : `Archive ${p.name}`}
                                  title={p.archived ? 'Restore product' : 'Archive product'}
                                  className="p-1.5 text-slate-500 hover:text-slate-900 rounded-md hover:bg-slate-100"
                                >
                                  {p.archived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDeleteTarget(p)}
                                  aria-label={`Delete ${p.name}`}
                                  className="p-1.5 text-slate-500 hover:text-red-700 rounded-md hover:bg-red-50"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile Cards */}
          <div className="lg:hidden space-y-3">
            {paginated.map((p) => {
              const status = getStockStatus(p.quantity, p.reorderPoint);
              return (
                <div key={p.id} className={`bg-white border border-slate-200 rounded-xl p-4 space-y-3 ${p.archived ? 'opacity-65' : ''}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <ProductThumbnail src={p.imageUrl} alt={p.name} size="md" />
                      <div className="min-w-0">
                        <button
                          type="button"
                          onClick={() => openDetailModal(p)}
                          className="text-sm font-semibold text-slate-900 hover:text-teal-700 text-left truncate block w-full"
                        >
                          {p.name}
                        </button>
                        <div className="text-xs text-slate-500 font-mono">
                          {p.sku} · {p.category}
                        </div>
                      </div>
                    </div>
                    <StockStatusLabel status={status} />
                  </div>

                  <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-100 text-xs">
                    <div>
                      <span className="text-slate-500 block">On Hand</span>
                      <span className="font-mono font-semibold text-slate-900 tabular-nums">
                        {p.quantity} (min {p.reorderPoint})
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">Cost / Price</span>
                      <span className="font-mono text-slate-900 tabular-nums">
                        {formatCurrency(p.unitCost, currencySymbol)} / {formatCurrency(p.sellingPrice, currencySymbol)}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500 block">Supplier</span>
                      <span className="text-slate-700 truncate block">{p.supplierName}</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-slate-100">
                    {!p.archived && (
                      <button
                        type="button"
                        onClick={() => onQuickStock(p.id)}
                        className="px-3 py-1.5 text-xs font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded-lg"
                      >
                        Record Stock
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => openDetailModal(p)}
                      className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg"
                    >
                      Details
                    </button>
                    {isAdmin && (
                      <>
                        <button
                          type="button"
                          onClick={() => openEditModal(p)}
                          aria-label={`Edit ${p.name}`}
                          className="p-2 text-slate-600 bg-slate-100 rounded-lg"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleArchive(p)}
                          aria-label={p.archived ? `Restore ${p.name}` : `Archive ${p.name}`}
                          className="p-2 text-slate-600 bg-slate-100 rounded-lg"
                        >
                          {p.archived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <PaginationBar
            page={safePage}
            totalPages={totalPages}
            totalItems={filtered.length}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
          />
        </>
      )}

      {/* Add / Edit Product Modal */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editingProduct ? `Edit ${editingProduct.name}` : 'Add New Product'}
        subtitle="All prices and stock quantities must be nonnegative. SKUs must be unique in your workspace."
        maxWidth="max-w-2xl"
      >
        <form onSubmit={handleSaveProduct} noValidate className="space-y-4">
          {formError && (
            <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
              {formError}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="prod-name" className="block text-xs font-medium text-slate-700 mb-1">
                Product Name *
              </label>
              <input
                id="prod-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
              {fieldErrors.name && <p className="mt-1 text-xs text-red-600">{fieldErrors.name}</p>}
            </div>

            <div>
              <label htmlFor="prod-sku" className="block text-xs font-medium text-slate-700 mb-1">
                SKU *
              </label>
              <input
                id="prod-sku"
                value={form.sku}
                onChange={(e) => setForm({ ...form, sku: e.target.value })}
                placeholder="e.g. SKU-1001"
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
              {fieldErrors.sku && <p className="mt-1 text-xs text-red-600">{fieldErrors.sku}</p>}
            </div>

            <div>
              <label htmlFor="prod-category" className="block text-xs font-medium text-slate-700 mb-1">
                Category *
              </label>
              <input
                id="prod-category"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                placeholder="e.g. Hardware"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
              {fieldErrors.category && <p className="mt-1 text-xs text-red-600">{fieldErrors.category}</p>}
            </div>

            <div>
              <label htmlFor="prod-supplier" className="block text-xs font-medium text-slate-700 mb-1">
                Supplier *
              </label>
              <select
                id="prod-supplier"
                value={form.supplierId}
                onChange={(e) => setForm({ ...form, supplierId: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              >
                <option value="">Select supplier...</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.companyName}{s.archived ? ' (Archived)' : ''}
                  </option>
                ))}
              </select>
              {fieldErrors.supplierId && <p className="mt-1 text-xs text-red-600">{fieldErrors.supplierId}</p>}
            </div>

            <div>
              <label htmlFor="prod-cost" className="block text-xs font-medium text-slate-700 mb-1">
                Unit Cost ({currencySymbol}) *
              </label>
              <input
                id="prod-cost"
                type="number"
                step="0.01"
                min="0"
                value={form.unitCost}
                onChange={(e) => setForm({ ...form, unitCost: e.target.value })}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
              {fieldErrors.unitCost && <p className="mt-1 text-xs text-red-600">{fieldErrors.unitCost}</p>}
            </div>

            <div>
              <label htmlFor="prod-price" className="block text-xs font-medium text-slate-700 mb-1">
                Selling Price ({currencySymbol}) *
              </label>
              <input
                id="prod-price"
                type="number"
                step="0.01"
                min="0"
                value={form.sellingPrice}
                onChange={(e) => setForm({ ...form, sellingPrice: e.target.value })}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
              {fieldErrors.sellingPrice && <p className="mt-1 text-xs text-red-600">{fieldErrors.sellingPrice}</p>}
            </div>

            <div>
              <label htmlFor="prod-qty" className="block text-xs font-medium text-slate-700 mb-1">
                Quantity on Hand *
              </label>
              <input
                id="prod-qty"
                type="number"
                step="1"
                min="0"
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
              {fieldErrors.quantity && <p className="mt-1 text-xs text-red-600">{fieldErrors.quantity}</p>}
            </div>

            <div>
              <label htmlFor="prod-reorder" className="block text-xs font-medium text-slate-700 mb-1">
                Reorder Point *
              </label>
              <input
                id="prod-reorder"
                type="number"
                step="1"
                min="0"
                value={form.reorderPoint}
                onChange={(e) => setForm({ ...form, reorderPoint: e.target.value })}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
              {fieldErrors.reorderPoint && <p className="mt-1 text-xs text-red-600">{fieldErrors.reorderPoint}</p>}
            </div>

            <div>
              <label htmlFor="prod-barcode" className="block text-xs font-medium text-slate-700 mb-1">
                Barcode (Optional)
              </label>
              <input
                id="prod-barcode"
                value={form.barcode}
                onChange={(e) => setForm({ ...form, barcode: e.target.value })}
                placeholder="UPC / EAN"
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
            </div>

            <div>
              <label htmlFor="prod-image-url" className="block text-xs font-medium text-slate-700 mb-1">
                Image URL (Optional)
              </label>
              <input
                id="prod-image-url"
                value={form.imageUrl}
                onChange={(e) => setForm({ ...form, imageUrl: e.target.value })}
                placeholder="https://..."
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
              />
              {fieldErrors.imageUrl && <p className="mt-1 text-xs text-red-600">{fieldErrors.imageUrl}</p>}
            </div>
          </div>

          <div>
            <label htmlFor="prod-desc" className="block text-xs font-medium text-slate-700 mb-1">
              Description
            </label>
            <textarea
              id="prod-desc"
              rows={2}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>

          <div className="pt-2 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-60"
            >
              {saving ? 'Saving...' : editingProduct ? 'Save Changes' : 'Save Product'}
            </button>
          </div>
        </form>
      </Modal>

      {/* CSV Import Modal */}
      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="Import Products via CSV"
        subtitle="Required columns: name, sku, category, unitCost, sellingPrice, quantity, reorderPoint. Optional: supplier, barcode, description."
        maxWidth="max-w-xl"
      >
        <form onSubmit={handleImportCsv} className="space-y-4">
          {importError && (
            <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
              {importError}
            </div>
          )}

          <div>
            <label htmlFor="import-default-sup" className="block text-xs font-medium text-slate-700 mb-1">
              Fallback Supplier (used if CSV row has no matching supplier column)
            </label>
            <select
              id="import-default-sup"
              value={importSupplierId}
              onChange={(e) => setImportSupplierId(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            >
              <option value="">Require exact supplier match in CSV</option>
              {activeSuppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.companyName}</option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="csv-file-upload" className="block text-xs font-medium text-slate-700 mb-1">
              Upload CSV File
            </label>
            <input
              id="csv-file-upload"
              type="file"
              accept=".csv,text/csv"
              onChange={handleFileUpload}
              className="block w-full text-xs text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border file:border-slate-300 file:text-xs file:font-medium file:bg-white file:text-slate-700 hover:file:bg-slate-50"
            />
          </div>

          <div>
            <label htmlFor="csv-paste-area" className="block text-xs font-medium text-slate-700 mb-1">
              Or Paste CSV Rows
            </label>
            <textarea
              id="csv-paste-area"
              rows={6}
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              placeholder={'name,sku,category,unitCost,sellingPrice,quantity,reorderPoint,barcode\nSteel Bolt Pack,BLT-10,Hardware,4.50,12.00,40,10,012345678901'}
              className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>

          <div className="pt-2 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={() => setImportOpen(false)}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={importing || !csvText.trim()}
              className="px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-60"
            >
              {importing ? 'Importing...' : 'Validate & Import'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Product Detail Modal */}
      <Modal
        open={Boolean(detailProduct)}
        onClose={() => setDetailProduct(null)}
        title={detailProduct?.name || 'Product Details'}
        subtitle={detailProduct ? `${detailProduct.sku} · ${detailProduct.category}` : undefined}
        maxWidth="max-w-2xl"
      >
        {detailProduct && (
          <div className="space-y-5">
            <div className="flex flex-col sm:flex-row gap-4 items-start">
              <ProductThumbnail src={detailProduct.imageUrl} alt={detailProduct.name} size="lg" />
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-3 flex-wrap">
                  <StockStatusLabel
                    status={getStockStatus(detailProduct.quantity, detailProduct.reorderPoint)}
                  />
                  {detailProduct.archived && (
                    <span className="text-xs font-mono text-slate-500">[Archived]</span>
                  )}
                  <span className="text-xs text-slate-500">
                    Supplier: <strong className="text-slate-800">{detailProduct.supplierName}</strong>
                  </span>
                </div>
                <p className="text-sm text-slate-600">
                  {detailProduct.description || 'No description provided.'}
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 text-xs">
                  <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200">
                    <span className="text-slate-500 block">On Hand</span>
                    <span className="text-base font-bold font-mono tabular-nums text-slate-900">
                      {detailProduct.quantity}
                    </span>
                  </div>
                  <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200">
                    <span className="text-slate-500 block">Unit Cost</span>
                    <span className="text-base font-bold font-mono tabular-nums text-slate-900">
                      {formatCurrency(detailProduct.unitCost, currencySymbol)}
                    </span>
                  </div>
                  <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200">
                    <span className="text-slate-500 block">Selling Price</span>
                    <span className="text-base font-bold font-mono tabular-nums text-slate-900">
                      {formatCurrency(detailProduct.sellingPrice, currencySymbol)}
                    </span>
                  </div>
                  <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200">
                    <span className="text-slate-500 block">Barcode</span>
                    <span className="text-xs font-mono text-slate-800 break-all">
                      {detailProduct.barcode || '-'}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {isAdmin && (
              <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 bg-slate-50 border border-slate-200 rounded-lg">
                <div>
                  <div className="text-xs font-semibold text-slate-800">Low-Stock Alert Threshold</div>
                  <div className="text-xs text-slate-500">
                    Triggers an active alert when quantity drops to or below this value.
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    aria-label="Product reorder threshold"
                    value={thresholdInput}
                    onChange={(e) => setThresholdInput(e.target.value)}
                    className="w-20 px-2.5 py-1.5 text-sm font-mono bg-white border border-slate-300 rounded-lg"
                  />
                  <button
                    type="button"
                    disabled={savingThreshold}
                    onClick={handleSaveThreshold}
                    className="px-3 py-1.5 text-xs font-medium text-white bg-teal-600 rounded-lg hover:bg-teal-700 disabled:opacity-60"
                  >
                    {savingThreshold ? 'Saving...' : 'Update Alert'}
                  </button>
                </div>
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-slate-900">Auditable Movement History</h3>
                {!detailProduct.archived && (
                  <button
                    type="button"
                    onClick={() => {
                      const pid = detailProduct.id;
                      setDetailProduct(null);
                      onQuickStock(pid);
                    }}
                    className="text-xs font-medium text-teal-700 hover:underline"
                  >
                    + Record Stock Movement
                  </button>
                )}
              </div>
              {detailLoading ? (
                <p className="text-xs text-slate-500 py-4">Loading movement history...</p>
              ) : detailTransactions.length === 0 ? (
                <p className="text-xs text-slate-500 py-4">No movements recorded yet for this product.</p>
              ) : (
                <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-60 overflow-y-auto">
                  {detailTransactions.map((tx) => (
                    <div key={tx.id} className="p-3 flex items-center justify-between gap-3 text-xs">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <TransactionTypeLabel type={tx.type} />
                          <span className="font-medium text-slate-800">{tx.party}</span>
                          <span className="font-mono text-slate-500">{tx.referenceNumber}</span>
                        </div>
                        <div className="mt-1 text-slate-500">
                          {formatShortDate(tx.transactionDate)} · {tx.userName}
                          {tx.reason ? ` · ${tx.reason}` : ''}
                          {tx.note ? ` · ${tx.note}` : ''}
                        </div>
                      </div>
                      <div className="text-right font-mono tabular-nums">
                        <div className={`font-semibold ${tx.quantityChange >= 0 ? 'text-emerald-700' : 'text-amber-700'}`}>
                          {tx.quantityChange > 0 ? `+${tx.quantityChange}` : tx.quantityChange}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {tx.previousQuantity} → {tx.resultingQuantity}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete Product"
        message={
          deleteTarget
            ? `Attempt to permanently delete "${deleteTarget.name}" (${deleteTarget.sku})? Products referenced by stock transactions or purchase orders cannot be deleted and should be archived instead.`
            : ''
        }
        confirmLabel="Delete Product"
        tone="danger"
        loading={deleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
