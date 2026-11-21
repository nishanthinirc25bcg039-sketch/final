export type UserRole = 'admin' | 'staff';

export interface Business {
  id: string;
  name: string;
  createdAt: string;
}

export interface User {
  id: string;
  businessId: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
}

export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock';

export interface Supplier {
  id: string;
  businessId: string;
  companyName: string;
  contactPerson: string;
  email: string;
  phone: string;
  address: string;
  notes: string;
  deliveryStatus: 'On Schedule' | 'Transit Delay' | 'Inactive' | 'Preferred';
  archived: boolean;
  productCount?: number;
  openOrderCount?: number;
  lastActivityAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  businessId: string;
  name: string;
  sku: string;
  category: string;
  description: string;
  supplierId: string;
  supplierName?: string;
  unitCost: number;
  sellingPrice: number;
  quantity: number;
  reorderPoint: number;
  imageUrl?: string;
  barcode?: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export type TransactionType = 'stock_in' | 'stock_out' | 'adjustment';

export interface StockTransaction {
  id: string;
  businessId: string;
  productId: string;
  productName?: string;
  productSku?: string;
  type: TransactionType;
  quantityChange: number;
  previousQuantity: number;
  resultingQuantity: number;
  party: string;
  referenceNumber: string;
  reason: string;
  note: string;
  userId: string;
  userName: string;
  transactionDate: string;
  createdAt: string;
}

export type PurchaseOrderStatus =
  | 'Draft'
  | 'Ordered'
  | 'Partially Received'
  | 'Received'
  | 'Cancelled';

export interface PurchaseOrderItem {
  id: string;
  poId: string;
  productId: string;
  productName?: string;
  productSku?: string;
  quantityOrdered: number;
  quantityReceived: number;
  unitCost: number;
}

export interface PurchaseOrderEvent {
  id: string;
  poId: string;
  eventType: string;
  description: string;
  userName: string;
  createdAt: string;
}

export interface PurchaseOrder {
  id: string;
  businessId: string;
  poNumber: string;
  supplierId: string;
  supplierName?: string;
  status: PurchaseOrderStatus;
  orderDate: string;
  expectedDeliveryDate: string;
  totalAmount: number;
  notes: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  items: PurchaseOrderItem[];
  events?: PurchaseOrderEvent[];
}

export interface LowStockAlert {
  id: string;
  businessId: string;
  productId: string;
  productName: string;
  sku: string;
  category: string;
  supplierId: string;
  supplierName: string;
  quantity: number;
  reorderPoint: number;
  alertType: 'low_stock' | 'out_of_stock';
  recommendedQty: number;
  status: 'active' | 'resolved';
  createdAt: string;
  resolvedAt?: string | null;
}

export interface AppSettings {
  businessId: string;
  businessName: string;
  currencySymbol: string;
  timezone: string;
  defaultReorderMultiplier: number;
  lowStockBannerEnabled: boolean;
  lowStockDigestEnabled: boolean;
  poStatusAlertsEnabled: boolean;
}

export interface StockHealthBreakdown {
  score: number | null;
  label: 'Healthy' | 'Needs Attention' | 'At Risk' | 'No Data';
  inputs: {
    totalProducts: number;
    healthyCount: number;
    lowStockCount: number;
    outOfStockCount: number;
    incomingCoverageCount: number;
  };
  factors: Array<{
    name: string;
    impact: string;
    detail: string;
  }>;
}

export interface DemandTrendItem {
  productId: string;
  name: string;
  sku: string;
  category: string;
  currentQty: number;
  reorderPoint: number;
  recentOutbound: number;
  previousOutbound: number;
  changePercent: number | null;
  direction: 'rising' | 'falling' | 'steady' | 'insufficient_data';
  explanation: string;
  recommendedReorderQty: number;
  overstockRisk: boolean;
  unusualActivity: boolean;
}

export interface AIInsightsPayload {
  status: 'ready' | 'empty' | 'unavailable' | 'error';
  modelLabel: string;
  periodDays: number;
  dataScopeLabel: string;
  generatedAt: string;
  summary: string;
  errorMessage?: string;
  highlights: Array<{
    type: 'reorder' | 'demand_rising' | 'demand_falling' | 'anomaly' | 'overstock';
    title: string;
    detail: string;
    productId?: string;
    productName?: string;
    recommendedQty?: number;
    supplierId?: string;
  }>;
  trends: DemandTrendItem[];
}

export interface ChatSuggestedAction {
  type: 'create_po';
  label: string;
  productId?: string;
  supplierId?: string;
  quantity?: number;
  requiresConfirmation: true;
}

export interface ChatResponsePayload {
  status: 'ready' | 'empty' | 'unavailable' | 'error';
  modelLabel: string;
  answer: string;
  dataUsed: string;
  errorMessage?: string;
  suggestedAction?: ChatSuggestedAction | null;
}

export interface DashboardData {
  metrics: {
    totalProducts: number;
    archivedProducts: number;
    totalUnits: number;
    inventoryCostValue: number;
    inventoryRetailValue: number;
    lowStockCount: number;
    outOfStockCount: number;
    openPurchaseOrders: number;
    incomingUnits: number;
  };
  healthScore: StockHealthBreakdown;
  briefing: Array<{
    priority: 'urgent' | 'warning' | 'info';
    title: string;
    description: string;
    actionTab: string;
    productId?: string;
  }>;
  movementSeries: Array<{
    date: string;
    stockIn: number;
    stockOut: number;
  }>;
  lowStockItems: LowStockAlert[];
  recentTransactions: StockTransaction[];
  upcomingDeliveries: PurchaseOrder[];
  settings: AppSettings;
}
