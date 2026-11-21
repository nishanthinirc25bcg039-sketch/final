import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  BarChart3,
  Bell,
  Building2,
  ClipboardList,
  Layers,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Package,
  Plus,
  Search,
  Settings,
  Sparkles,
  X,
} from 'lucide-react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { apiFetch, setAuthToken } from './utils/api';
import { LoginView } from './components/LoginView';
import { OverviewView } from './components/OverviewView';
import { ProductsView } from './components/ProductsView';
import {
  StockMovementModal,
  TransactionsView,
  type StockAdjustmentSeed,
} from './components/TransactionsView';
import { SuppliersView } from './components/SuppliersView';
import { PurchaseOrdersView, type PODraftSeed } from './components/PurchaseOrdersView';
import { ReportsView } from './components/ReportsView';
import { AIInsightsView } from './components/AIInsightsView';
import { SettingsView } from './components/SettingsView';
import { InventoryChatbot } from './components/InventoryChatbot';
import { StockStatusLabel } from './components/ui/Common';
import type {
  AIInsightsPayload,
  AppSettings,
  ChatSuggestedAction,
  DashboardData,
  LowStockAlert,
  Product,
  PurchaseOrder,
  StockTransaction,
  Supplier,
  User,
} from './shared/types';

type NavId =
  | 'overview'
  | 'products'
  | 'transactions'
  | 'suppliers'
  | 'purchase-orders'
  | 'reports'
  | 'ai-insights'
  | 'settings';

const NAV_ITEMS: Array<{
  id: NavId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'products', label: 'Products', icon: Package },
  { id: 'transactions', label: 'Transactions', icon: ArrowLeftRight },
  { id: 'suppliers', label: 'Suppliers', icon: Building2 },
  { id: 'purchase-orders', label: 'Purchase Orders', icon: ClipboardList },
  { id: 'reports', label: 'Reports', icon: BarChart3 },
  { id: 'ai-insights', label: 'AI Insights', icon: Sparkles },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const INITIAL_SETTINGS: AppSettings = {
  businessId: '',
  businessName: 'SmartStock Workspace',
  currencySymbol: '$',
  timezone: 'UTC',
  defaultReorderMultiplier: 2,
  lowStockBannerEnabled: true,
  lowStockDigestEnabled: false,
  poStatusAlertsEnabled: true,
};

interface WorkspaceErrorBoundaryState {
  hasError: boolean;
  message: string;
}

class WorkspaceErrorBoundary extends React.Component<
  { children: React.ReactNode; onSignOut?: () => void },
  WorkspaceErrorBoundaryState
> {
  state: WorkspaceErrorBoundaryState = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error): WorkspaceErrorBoundaryState {
    return {
      hasError: true,
      message: error?.message || 'An unexpected rendering error occurred.',
    };
  }

  componentDidCatch(error: Error) {
    console.error('SmartStock UI render error:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white border border-red-200 rounded-xl p-6 space-y-4 shadow-xs">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-red-50 border border-red-200 flex items-center justify-center text-red-600 shrink-0">
                <AlertTriangle className="w-5 h-5" aria-hidden="true" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-slate-900">Unable to render workspace view</h2>
                <p className="mt-1 text-sm text-slate-600 leading-relaxed">{this.state.message}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="px-4 py-2 text-sm font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700"
              >
                Reload Page
              </button>
              {this.props.onSignOut && (
                <button
                  type="button"
                  onClick={() => {
                    this.setState({ hasError: false, message: '' });
                    this.props.onSignOut?.();
                  }}
                  className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  Sign Out
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

interface WorkspaceBootstrapResponse {
  dashboard: DashboardData;
  products: Product[];
  transactions: StockTransaction[];
  suppliers: Supplier[];
  purchaseOrders: PurchaseOrder[];
  alerts: LowStockAlert[];
}

export default function App() {
  const [authChecking, setAuthChecking] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [activeNav, setActiveNav] = useState<NavId>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Core App Data (loaded strictly per authenticated business workspace)
  const [dashboardDays, setDashboardDays] = useState(14);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [transactions, setTransactions] = useState<StockTransaction[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [alerts, setAlerts] = useState<LowStockAlert[]>([]);
  const [settings, setSettings] = useState<AppSettings>(INITIAL_SETTINGS);

  // AI Insights
  const [aiPeriodDays, setAiPeriodDays] = useState(30);
  const [insights, setInsights] = useState<AIInsightsPayload | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);

  // Global UI Overlays
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const justSignedInRef = useRef(false);
  const [globalSearch, setGlobalSearch] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [stockModalOpen, setStockModalOpen] = useState(false);
  const [stockModalProductId, setStockModalProductId] = useState<string | undefined>(undefined);
  const [stockAdjustmentSeed, setStockAdjustmentSeed] = useState<StockAdjustmentSeed | null>(null);
  const [poDraftSeed, setPoDraftSeed] = useState<PODraftSeed | null>(null);
  const [chatDrawerOpen, setChatDrawerOpen] = useState(false);

  const [toast, setToast] = useState<{ message: string; tone: 'success' | 'error' } | null>(null);

  const notify = useCallback((message: string, tone: 'success' | 'error' = 'success') => {
    setToast({ message, tone });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const clearWorkspaceState = useCallback(() => {
    setDashboard(null);
    setProducts([]);
    setTransactions([]);
    setSuppliers([]);
    setPurchaseOrders([]);
    setAlerts([]);
    setSettings(INITIAL_SETTINGS);
    setInsights(null);
    setWorkspaceError(null);
    setGlobalSearch('');
    setStockModalOpen(false);
    setStockModalProductId(undefined);
    setStockAdjustmentSeed(null);
    setPoDraftSeed(null);
    setChatDrawerOpen(false);
    setNotificationsOpen(false);
    setProfileOpen(false);
  }, []);

  const loadInsights = useCallback(async (period: number) => {
    setInsightsLoading(true);
    try {
      const res = await apiFetch<{ insights: AIInsightsPayload }>('/api/ai/insights', {
        method: 'POST',
        body: JSON.stringify({ periodDays: period }),
      });
      if (!res?.insights) {
        throw new Error('Unexpected AI insights response format.');
      }
      setInsights(res.insights);
    } catch (err) {
      setInsights({
        status: 'error',
        modelLabel: 'Gemini AI error',
        periodDays: period,
        dataScopeLabel: `Last ${period} days`,
        generatedAt: new Date().toISOString(),
        summary: '',
        errorMessage: err instanceof Error ? err.message : 'Unable to fetch Gemini insights.',
        highlights: [],
        trends: [],
      });
    } finally {
      setInsightsLoading(false);
    }
  }, []);

  const loadWorkspaceData = useCallback(
    async (daysOverride?: number): Promise<boolean> => {
      const d = daysOverride ?? dashboardDays;
      setLoadingWorkspace(true);
      setWorkspaceError(null);
      try {
        const bootRes = await apiFetch<WorkspaceBootstrapResponse>(`/api/workspace/bootstrap?days=${d}`);
        if (!bootRes?.dashboard?.metrics || !bootRes?.dashboard?.settings) {
          throw new Error('Server returned an incomplete workspace snapshot.');
        }
        setDashboard(bootRes.dashboard);
        setSettings(bootRes.dashboard.settings);
        setProducts(Array.isArray(bootRes.products) ? bootRes.products : []);
        setTransactions(Array.isArray(bootRes.transactions) ? bootRes.transactions : []);
        setSuppliers(Array.isArray(bootRes.suppliers) ? bootRes.suppliers : []);
        setPurchaseOrders(Array.isArray(bootRes.purchaseOrders) ? bootRes.purchaseOrders : []);
        setAlerts(Array.isArray(bootRes.alerts) ? bootRes.alerts : []);
        justSignedInRef.current = false;
        return true;
      } catch (err) {
        const status = (err as Error & { status?: number })?.status;
        if (status === 401) {
          const message = justSignedInRef.current
            ? 'Signed in, but the workspace request returned 401 (session could not be verified across requests). On Vercel serverless previews, ephemeral /tmp SQLite is not shared across concurrent serverless instances or cold starts. Deploy on a persistent Node host or configure a shared database and SESSION_SECRET.'
            : 'Your workspace session expired. Please sign in again.';
          justSignedInRef.current = false;
          setAuthToken(null);
          setAuthError(message);
          setUser(null);
          clearWorkspaceState();
          return false;
        }
        justSignedInRef.current = false;
        const message = err instanceof Error ? err.message : 'Unable to load inventory workspace.';
        setWorkspaceError(message);
        notify(message, 'error');
        return false;
      } finally {
        setLoadingWorkspace(false);
      }
    },
    [dashboardDays, notify, clearWorkspaceState]
  );

  // Restore session via HttpOnly cookie or tab session token
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ user: User | null }>('/api/auth/me')
      .then((res) => {
        if (!cancelled && res?.user?.id) {
          setUser(res.user);
        }
      })
      .catch(() => {
        // Not signed in or endpoint temporarily unavailable
      })
      .finally(() => {
        if (!cancelled) setAuthChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    loadWorkspaceData(dashboardDays).then((ok) => {
      if (ok && !cancelled) {
        loadInsights(aiPeriodDays);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [user, dashboardDays, aiPeriodDays, loadWorkspaceData, loadInsights]);

  const handleLogout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore
    }
    justSignedInRef.current = false;
    setAuthToken(null);
    setAuthError(null);
    setUser(null);
    clearWorkspaceState();
  };

  const handleWorkspaceDeleted = () => {
    justSignedInRef.current = false;
    setAuthToken(null);
    setAuthError(null);
    setUser(null);
    clearWorkspaceState();
    notify('Workspace and all business data permanently deleted.');
  };

  const handleOpenStockModal = (productId?: string) => {
    setStockAdjustmentSeed(null);
    setStockModalProductId(productId);
    setStockModalOpen(true);
  };

  const handleOpenReversalModal = (seed: StockAdjustmentSeed) => {
    setStockModalProductId(undefined);
    setStockAdjustmentSeed(seed);
    setStockModalOpen(true);
  };

  const handleDraftPOFromAlert = (alert: LowStockAlert) => {
    setPoDraftSeed({
      supplierId: alert.supplierId,
      productId: alert.productId,
      quantity: alert.recommendedQty || 10,
      note: `Replenishment for ${alert.alertType === 'out_of_stock' ? 'out-of-stock' : 'low-stock'} alert (${alert.productName}).`,
    });
    setActiveNav('purchase-orders');
    setNotificationsOpen(false);
  };

  const handleChatDrawerAction = (action: ChatSuggestedAction) => {
    if (action.type === 'create_po' && action.productId && action.supplierId) {
      setPoDraftSeed({
        productId: action.productId,
        supplierId: action.supplierId,
        quantity: action.quantity || 10,
        note: 'Prepared from Gemini Inventory Assistant.',
      });
      setChatDrawerOpen(false);
      setActiveNav('purchase-orders');
    }
  };

  // Global search results scoped to authenticated workspace records
  const searchResults = useMemo(() => {
    const q = globalSearch.trim().toLowerCase();
    if (!q) return [];
    const matchedProducts = products
      .filter((p) => p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q))
      .slice(0, 4)
      .map((p) => ({
        id: `p-${p.id}`,
        title: p.name,
        meta: `Product · ${p.sku} · ${p.quantity} on hand`,
        nav: 'products' as NavId,
      }));
    const matchedSuppliers = suppliers
      .filter((s) => s.companyName.toLowerCase().includes(q) || s.contactPerson.toLowerCase().includes(q))
      .slice(0, 2)
      .map((s) => ({
        id: `s-${s.id}`,
        title: s.companyName,
        meta: `Supplier · ${s.contactPerson}`,
        nav: 'suppliers' as NavId,
      }));
    const matchedPOs = purchaseOrders
      .filter((po) => po.poNumber.toLowerCase().includes(q))
      .slice(0, 2)
      .map((po) => ({
        id: `po-${po.id}`,
        title: po.poNumber,
        meta: `Purchase Order · ${po.supplierName} · ${po.status}`,
        nav: 'purchase-orders' as NavId,
      }));
    return [...matchedProducts, ...matchedSuppliers, ...matchedPOs];
  }, [globalSearch, products, suppliers, purchaseOrders]);

  if (authChecking) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-500">
        Loading SmartStock AI...
      </div>
    );
  }

  if (!user) {
    return (
      <WorkspaceErrorBoundary>
        <MotionConfig reducedMotion="user">
          <LoginView
            externalError={authError}
            onLoginSuccess={(loggedInUser) => {
              justSignedInRef.current = true;
              setAuthError(null);
              clearWorkspaceState();
              setUser(loggedInUser);
              setActiveNav('overview');
            }}
          />
        </MotionConfig>
      </WorkspaceErrorBoundary>
    );
  }

  const currentNavMeta = NAV_ITEMS.find((n) => n.id === activeNav) || NAV_ITEMS[0];

  return (
    <WorkspaceErrorBoundary onSignOut={handleLogout}>
      <MotionConfig reducedMotion="user">
        <div className="min-h-screen bg-slate-50 text-slate-900 flex">
        {/* Desktop Sidebar */}
        <aside className="hidden lg:flex lg:w-[248px] lg:flex-col lg:fixed lg:inset-y-0 bg-white border-r border-slate-200 z-30 no-print">
          <div className="h-16 px-5 border-b border-slate-200 flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-teal-600 flex items-center justify-center text-white shrink-0">
              <Layers className="w-4 h-4" aria-hidden="true" />
            </div>
            <span className="text-base font-bold tracking-tight text-slate-900 font-display whitespace-nowrap">
              SmartStock AI
            </span>
          </div>

          <nav className="flex-1 p-3 space-y-1 overflow-y-auto" aria-label="Main navigation">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activeNav === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveNav(item.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`w-full flex items-center justify-between gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-teal-50 text-teal-800'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/70'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <Icon
                      className={`w-4 h-4 shrink-0 ${isActive ? 'text-teal-700' : 'text-slate-400'}`}
                      aria-hidden="true"
                    />
                    <span>{item.label}</span>
                  </span>
                  {item.id === 'products' && alerts.length > 0 && (
                    <span className="text-[11px] font-mono font-semibold text-amber-700">
                      {alerts.length}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="p-3 border-t border-slate-200 space-y-2">
            <button
              type="button"
              onClick={() => setChatDrawerOpen(true)}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold text-teal-800 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100 transition-colors"
            >
              <MessageSquare className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>Ask Inventory AI</span>
            </button>
            <div className="px-2 py-1 text-xs text-slate-500 truncate">
              {settings.businessName}
            </div>
          </div>
        </aside>

        {/* Mobile Drawer Navigation */}
        <AnimatePresence>
          {mobileMenuOpen && (
            <div className="fixed inset-0 z-50 lg:hidden flex">
              <div
                className="fixed inset-0 bg-slate-900/40"
                onClick={() => setMobileMenuOpen(false)}
              />
              <motion.aside
                initial={{ x: -260 }}
                animate={{ x: 0 }}
                exit={{ x: -260 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                className="relative w-64 max-w-[80vw] bg-white h-full border-r border-slate-200 flex flex-col z-10"
              >
                <div className="h-14 px-4 border-b border-slate-200 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-md bg-teal-600 flex items-center justify-center text-white">
                      <Layers className="w-4 h-4" aria-hidden="true" />
                    </div>
                    <span className="text-sm font-bold font-display text-slate-900">SmartStock AI</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setMobileMenuOpen(false)}
                    aria-label="Close navigation menu"
                    className="p-2 rounded-lg text-slate-500 hover:bg-slate-100"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <nav className="flex-1 p-3 space-y-1 overflow-y-auto" aria-label="Mobile navigation">
                  {NAV_ITEMS.map((item) => {
                    const Icon = item.icon;
                    const isActive = activeNav === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          setActiveNav(item.id);
                          setMobileMenuOpen(false);
                        }}
                        className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium ${
                          isActive
                            ? 'bg-teal-50 text-teal-800'
                            : 'text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                        <span>{item.label}</span>
                      </button>
                    );
                  })}
                </nav>

                <div className="p-3 border-t border-slate-200">
                  <button
                    type="button"
                    onClick={() => {
                      setMobileMenuOpen(false);
                      setChatDrawerOpen(true);
                    }}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-semibold text-teal-800 bg-teal-50 border border-teal-200 rounded-lg"
                  >
                    <MessageSquare className="w-4 h-4" aria-hidden="true" />
                    <span>Ask Inventory AI</span>
                  </button>
                </div>
              </motion.aside>
            </div>
          )}
        </AnimatePresence>

        {/* Main Content Shell */}
        <div className="flex-1 lg:pl-[248px] flex flex-col min-w-0">
          {/* Top Bar */}
          <header className="sticky top-0 z-20 h-14 lg:h-16 bg-white border-b border-slate-200 px-4 lg:px-6 flex items-center justify-between gap-4 no-print">
            {/* Zone 1: Menu toggle (mobile) + Page Context */}
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(true)}
                aria-label="Open navigation menu"
                className="lg:hidden p-2 -ml-2 rounded-lg text-slate-600 hover:bg-slate-100"
              >
                <Menu className="w-5 h-5" />
              </button>
              <div className="min-w-0">
                <h1 className="text-base lg:text-lg font-semibold text-slate-900 truncate">
                  {currentNavMeta.label}
                </h1>
              </div>
            </div>

            {/* Zone 2: Global Search (Desktop/Tablet) */}
            <div className="relative hidden md:block flex-1 max-w-sm">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true" />
              <input
                type="search"
                aria-label="Global search across products, suppliers, and purchase orders"
                value={globalSearch}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setTimeout(() => setSearchFocused(false), 160)}
                onChange={(e) => setGlobalSearch(e.target.value)}
                placeholder="Search products, SKU, supplier, PO..."
                className="w-full pl-9 pr-3 py-1.5 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:ring-2 focus:ring-teal-600"
              />
              {searchFocused && globalSearch.trim() && (
                <div className="absolute left-0 right-0 mt-1.5 bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden z-30">
                  {searchResults.length === 0 ? (
                    <div className="p-3 text-xs text-slate-500">No matching records found.</div>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {searchResults.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onMouseDown={() => {
                            setActiveNav(r.nav);
                            setGlobalSearch('');
                          }}
                          className="w-full text-left px-3.5 py-2.5 hover:bg-slate-50 transition-colors"
                        >
                          <div className="text-sm font-medium text-slate-900">{r.title}</div>
                          <div className="text-xs text-slate-500">{r.meta}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Zone 3: Quick Stock CTA, Alerts Bell, Profile */}
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => handleOpenStockModal()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 lg:px-3.5 lg:py-2 text-xs font-semibold text-white bg-teal-600 rounded-lg hover:bg-teal-700 transition-colors whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Record Stock</span>
              </button>

              {/* Notifications Popover */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setNotificationsOpen((v) => !v);
                    setProfileOpen(false);
                  }}
                  aria-label={`Low stock notifications (${alerts.length})`}
                  className="relative p-2 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors"
                >
                  <Bell className="w-4 h-4" />
                  {alerts.length > 0 && settings.lowStockBannerEnabled && (
                    <span className="absolute top-1 right-1 min-w-[15px] h-[15px] px-1 rounded-full bg-amber-600 text-white text-[10px] font-mono font-bold flex items-center justify-center">
                      {alerts.length}
                    </span>
                  )}
                </button>

                {notificationsOpen && (
                  <div className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-2rem)] bg-white border border-slate-200 rounded-xl shadow-lg z-40 overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-900">
                        Active Stock Alerts ({alerts.length})
                      </span>
                      <button
                        type="button"
                        onClick={() => setNotificationsOpen(false)}
                        aria-label="Close notifications"
                        className="text-slate-400 hover:text-slate-700"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="max-h-80 overflow-y-auto divide-y divide-slate-100">
                      {alerts.length === 0 ? (
                        <p className="p-4 text-xs text-slate-500">All active products exceed reorder points.</p>
                      ) : (
                        alerts.map((a) => (
                          <div key={a.id} className="p-3.5 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-semibold text-slate-900 truncate">
                                {a.productName}
                              </span>
                              <StockStatusLabel
                                status={a.alertType === 'out_of_stock' ? 'out_of_stock' : 'low_stock'}
                              />
                            </div>
                            <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono">
                              <span>
                                {a.quantity} / min {a.reorderPoint}
                              </span>
                              <button
                                type="button"
                                onClick={() => handleDraftPOFromAlert(a)}
                                className="font-sans font-semibold text-teal-700 hover:underline"
                              >
                                Draft PO (+{a.recommendedQty})
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Profile Menu */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setProfileOpen((v) => !v);
                    setNotificationsOpen(false);
                  }}
                  aria-label="User profile menu"
                  className="flex items-center gap-2 p-1 pr-2 rounded-lg hover:bg-slate-100 transition-colors"
                >
                  <div className="w-7 h-7 rounded-full bg-slate-800 text-white text-xs font-semibold flex items-center justify-center shrink-0">
                    {user.name.slice(0, 1).toUpperCase()}
                  </div>
                  <span className="hidden sm:inline text-xs font-medium text-slate-800 whitespace-nowrap">
                    {user.name}
                  </span>
                </button>

                {profileOpen && (
                  <div className="absolute right-0 mt-2 w-56 bg-white border border-slate-200 rounded-xl shadow-lg z-40 overflow-hidden">
                    <div className="px-4 py-3 border-b border-slate-100">
                      <div className="text-sm font-semibold text-slate-900">{user.name}</div>
                      <div className="text-xs text-slate-500 truncate">{user.email}</div>
                      <div className="mt-1 text-[11px] font-mono uppercase text-teal-700">
                        Role: {user.role}
                      </div>
                    </div>
                    <div className="p-1.5 space-y-0.5">
                      <button
                        type="button"
                        onClick={() => {
                          setActiveNav('settings');
                          setProfileOpen(false);
                        }}
                        className="w-full text-left px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 rounded-lg flex items-center gap-2"
                      >
                        <Settings className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Settings</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleLogout}
                        className="w-full text-left px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-50 rounded-lg flex items-center gap-2"
                      >
                        <LogOut className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Sign Out</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </header>

          {/* Main Workspace Viewport */}
          <main className="flex-1 p-4 lg:p-6 max-w-[1400px] w-full mx-auto">
            {workspaceError && activeNav !== 'overview' && (
              <div
                role="alert"
                className="mb-4 flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-800"
              >
                <span>{workspaceError}</span>
                <button
                  type="button"
                  onClick={() => loadWorkspaceData(dashboardDays)}
                  className="px-3 py-1.5 font-semibold text-red-800 bg-white border border-red-300 rounded-md hover:bg-red-100"
                >
                  Retry Load
                </button>
              </div>
            )}

            {activeNav === 'overview' && (
              <OverviewView
                data={dashboard}
                insights={insights}
                days={dashboardDays}
                onDaysChange={(d) => setDashboardDays(d)}
                onNavigate={(tab) => setActiveNav(tab as NavId)}
                onDraftPOFromAlert={handleDraftPOFromAlert}
                onOpenChatbot={() => setChatDrawerOpen(true)}
                loading={loadingWorkspace && !dashboard}
                error={workspaceError}
                onRetry={() => loadWorkspaceData(dashboardDays)}
                onSignOut={handleLogout}
              />
            )}

            {activeNav === 'products' && (
              <ProductsView
                products={products}
                suppliers={suppliers}
                currencySymbol={settings.currencySymbol}
                userRole={user.role}
                onDataChanged={async () => {
                  await loadWorkspaceData();
                  loadInsights(aiPeriodDays);
                }}
                onQuickStock={handleOpenStockModal}
                onNavigateSuppliers={() => setActiveNav('suppliers')}
                onNotify={notify}
              />
            )}

            {activeNav === 'transactions' && (
              <TransactionsView
                transactions={transactions}
                products={products}
                userRole={user.role}
                onOpenStockModal={() => handleOpenStockModal()}
                onOpenReversalModal={handleOpenReversalModal}
              />
            )}

            {activeNav === 'suppliers' && (
              <SuppliersView
                suppliers={suppliers}
                currencySymbol={settings.currencySymbol}
                userRole={user.role}
                onDataChanged={async () => {
                  await loadWorkspaceData();
                  loadInsights(aiPeriodDays);
                }}
                onNotify={notify}
              />
            )}

            {activeNav === 'purchase-orders' && (
              <PurchaseOrdersView
                purchaseOrders={purchaseOrders}
                suppliers={suppliers}
                products={products}
                currencySymbol={settings.currencySymbol}
                draftSeed={poDraftSeed}
                onClearDraftSeed={() => setPoDraftSeed(null)}
                onDataChanged={async () => {
                  await loadWorkspaceData();
                  loadInsights(aiPeriodDays);
                }}
                onNotify={notify}
              />
            )}

            {activeNav === 'reports' && (
              <ReportsView currencySymbol={settings.currencySymbol} />
            )}

            {activeNav === 'ai-insights' && (
              <AIInsightsView
                insights={insights}
                periodDays={aiPeriodDays}
                loading={insightsLoading}
                onPeriodChange={(d) => setAiPeriodDays(d)}
                onRefresh={() => loadInsights(aiPeriodDays)}
                onDraftPO={(seed) => {
                  setPoDraftSeed(seed);
                  setActiveNav('purchase-orders');
                }}
              />
            )}

            {activeNav === 'settings' && (
              <SettingsView
                currentUser={user}
                settings={settings}
                onDataChanged={async () => {
                  await loadWorkspaceData();
                  loadInsights(aiPeriodDays);
                }}
                onWorkspaceDeleted={handleWorkspaceDeleted}
                onNotify={notify}
              />
            )}
          </main>
        </div>

        {/* Quick Stock Movement Modal */}
        <StockMovementModal
          open={stockModalOpen}
          onClose={() => {
            setStockModalOpen(false);
            setStockAdjustmentSeed(null);
          }}
          products={products}
          userRole={user.role}
          initialProductId={stockModalProductId}
          initialSeed={stockAdjustmentSeed}
          onSuccess={async (msg) => {
            notify(msg);
            await loadWorkspaceData();
            loadInsights(aiPeriodDays);
          }}
        />

        {/* Slide-over Chatbot Drawer */}
        <AnimatePresence>
          {chatDrawerOpen && (
            <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/35">
              <div
                className="flex-1"
                onClick={() => setChatDrawerOpen(false)}
              />
              <motion.div
                initial={{ x: 420 }}
                animate={{ x: 0 }}
                exit={{ x: 420 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                className="w-full max-w-md bg-white h-full border-l border-slate-200 p-4 flex flex-col justify-between shadow-xl"
              >
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-slate-900">SmartStock AI Assistant</h2>
                  <button
                    type="button"
                    onClick={() => setChatDrawerOpen(false)}
                    aria-label="Close inventory assistant"
                    className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex-1 min-h-0">
                  <InventoryChatbot onConfirmAction={handleChatDrawerAction} compact />
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Feedback Toast */}
        <AnimatePresence>
          {toast && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 12 }}
              role="status"
              className={`fixed bottom-4 right-4 z-50 px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium border ${
                toast.tone === 'error'
                  ? 'bg-red-50 border-red-200 text-red-800'
                  : 'bg-slate-900 border-slate-800 text-white'
              }`}
            >
              {toast.message}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      </MotionConfig>
    </WorkspaceErrorBoundary>
  );
}
