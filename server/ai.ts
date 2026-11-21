import { GoogleGenAI, Type } from '@google/genai';
import {
  analyzeDemandTrends,
  calculateInventoryValuation,
} from '../src/shared/inventoryLogic.js';
import type {
  AIInsightsPayload,
  ChatResponsePayload,
  Product,
  PurchaseOrder,
  StockTransaction,
} from '../src/shared/types.js';

function getConfiguredGeminiKey(): string | null {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || key === 'MY_GEMINI_API_KEY') return null;
  return key;
}

function classifyGeminiError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('PERMISSION_DENIED') || msg.includes('403') || msg.includes('API_KEY_INVALID')) {
    return 'Gemini API access was denied for the configured server key or billing tier (403). Verify GEMINI_API_KEY and billing setup in Settings > Secrets.';
  }
  if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('429')) {
    return 'Gemini API quota or rate limit was reached (429). Wait a moment or check your project quota in Settings > Secrets.';
  }
  if (msg.includes('NOT_FOUND') || msg.includes('404')) {
    return 'Configured Gemini model is unavailable for this API key (404).';
  }
  return 'Unable to reach Gemini AI right now. Try refreshing in a moment.';
}

export async function generateInventoryInsights(params: {
  products: Product[];
  transactions: StockTransaction[];
  purchaseOrders: PurchaseOrder[];
  periodDays: number;
}): Promise<AIInsightsPayload> {
  const activeProducts = params.products.filter((p) => !p.archived);
  const trends = analyzeDemandTrends(activeProducts, params.transactions, params.periodDays);
  const valuation = calculateInventoryValuation(activeProducts);
  const dataScopeLabel = `Last ${params.periodDays} days · ${activeProducts.length} active products · ${params.transactions.length} transactions`;
  const generatedAt = new Date().toISOString();

  if (activeProducts.length === 0) {
    return {
      status: 'empty',
      modelLabel: 'Gemini AI (gemini-4-hydrogen)',
      periodDays: params.periodDays,
      dataScopeLabel,
      generatedAt,
      summary: 'Add real products and stock movements to generate Gemini AI inventory insights.',
      highlights: [],
      trends: [],
    };
  }

  const apiKey = getConfiguredGeminiKey();
  if (!apiKey) {
    return {
      status: 'unavailable',
      modelLabel: 'Gemini AI unavailable',
      periodDays: params.periodDays,
      dataScopeLabel,
      generatedAt,
      summary: '',
      errorMessage:
        'Live AI insights require a server-configured GEMINI_API_KEY. Set GEMINI_API_KEY in your server environment to enable Gemini analysis.',
      highlights: [],
      trends,
    };
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    // Minimal non-PII operational context only
    const contextPayload = {
      periodDays: params.periodDays,
      valuation,
      products: activeProducts.slice(0, 120).map((p) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        category: p.category,
        quantity: p.quantity,
        reorderPoint: p.reorderPoint,
        unitCost: p.unitCost,
        sellingPrice: p.sellingPrice,
      })),
      trends: trends.slice(0, 20).map((t) => ({
        productId: t.productId,
        name: t.name,
        sku: t.sku,
        currentQty: t.currentQty,
        reorderPoint: t.reorderPoint,
        recentOutbound: t.recentOutbound,
        previousOutbound: t.previousOutbound,
        changePercent: t.changePercent,
        direction: t.direction,
      })),
      openOrders: params.purchaseOrders
        .filter((po) => po.status !== 'Received' && po.status !== 'Cancelled')
        .slice(0, 30)
        .map((po) => ({
          poNumber: po.poNumber,
          status: po.status,
          expectedDeliveryDate: po.expectedDeliveryDate,
        })),
    };

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Analyze this inventory snapshot and return a concise operational summary plus up to 6 actionable highlights grounded strictly in the provided JSON:\n${JSON.stringify(contextPayload)}`,
      config: {
        abortSignal: AbortSignal.timeout(15000),
        systemInstruction:
          'You are SmartStock AI, an inventory operations analyst. Cite exact product names, SKUs, quantities, and period metrics from the input JSON. Never invent products, trends, or numbers. Never claim you executed any order or stock change.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            highlights: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  type: { type: Type.STRING },
                  title: { type: Type.STRING },
                  detail: { type: Type.STRING },
                  productId: { type: Type.STRING },
                  productName: { type: Type.STRING },
                  recommendedQty: { type: Type.INTEGER },
                },
              },
            },
          },
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim()) as {
      summary?: string;
      highlights?: AIInsightsPayload['highlights'];
    };

    if (!parsed.summary || typeof parsed.summary !== 'string') {
      throw new Error('Gemini returned an empty insights response.');
    }

    const allowedTypes = new Set(['reorder', 'demand_rising', 'demand_falling', 'anomaly', 'overstock']);
    const normalizedHighlights = (parsed.highlights || [])
      .filter((h) => h && h.title && h.detail)
      .map((h) => {
        const matchedProd = activeProducts.find((p) => p.id === h.productId);
        return {
          type: (allowedTypes.has(h.type) ? h.type : 'reorder') as AIInsightsPayload['highlights'][number]['type'],
          title: h.title,
          detail: h.detail,
          productId: matchedProd?.id || h.productId,
          productName: matchedProd?.name || h.productName,
          recommendedQty: h.recommendedQty,
          supplierId: matchedProd?.supplierId,
        };
      });

    return {
      status: 'ready',
      modelLabel: 'AI-generated via Gemini (gemini-4-hydrogen)',
      periodDays: params.periodDays,
      dataScopeLabel,
      generatedAt,
      summary: parsed.summary,
      highlights: normalizedHighlights,
      trends,
    };
  } catch (err) {
    console.warn('Gemini insights error:', err instanceof Error ? err.message : String(err));
    return {
      status: 'error',
      modelLabel: 'Gemini AI error',
      periodDays: params.periodDays,
      dataScopeLabel,
      generatedAt,
      summary: '',
      errorMessage: classifyGeminiError(err),
      highlights: [],
      trends,
    };
  }
}

export async function answerInventoryChat(params: {
  question: string;
  products: Product[];
  transactions: StockTransaction[];
  purchaseOrders: PurchaseOrder[];
}): Promise<ChatResponsePayload> {
  const activeProducts = params.products.filter((p) => !p.archived);
  const dataUsed = `${activeProducts.length} active products, ${params.transactions.length} transactions, ${params.purchaseOrders.length} purchase orders`;

  if (activeProducts.length === 0) {
    return {
      status: 'empty',
      modelLabel: 'Gemini AI (gemini-4-hydrogen)',
      answer:
        'Your inventory catalog does not have any active products yet. Add products and stock movements first so Gemini can answer questions about your inventory.',
      dataUsed,
    };
  }

  const apiKey = getConfiguredGeminiKey();
  if (!apiKey) {
    return {
      status: 'unavailable',
      modelLabel: 'Gemini AI unavailable',
      answer: '',
      dataUsed,
      errorMessage:
        'Inventory Assistant is unavailable because GEMINI_API_KEY is not configured on the server.',
    };
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const valuation = calculateInventoryValuation(activeProducts);
    const trends = analyzeDemandTrends(activeProducts, params.transactions, 30);

    // Strictly minimal non-PII business snapshot
    const snapshot = {
      valuation,
      products: activeProducts.slice(0, 120).map((p) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        category: p.category,
        quantity: p.quantity,
        reorderPoint: p.reorderPoint,
        unitCost: p.unitCost,
        sellingPrice: p.sellingPrice,
      })),
      demand30d: trends.slice(0, 15).map((t) => ({
        name: t.name,
        sku: t.sku,
        recentOutbound: t.recentOutbound,
        previousOutbound: t.previousOutbound,
        changePercent: t.changePercent,
      })),
      purchaseOrders: params.purchaseOrders.slice(0, 40).map((po) => ({
        poNumber: po.poNumber,
        status: po.status,
        totalAmount: po.totalAmount,
        expectedDeliveryDate: po.expectedDeliveryDate,
      })),
    };

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `User question: "${params.question}"\n\nLive inventory snapshot:\n${JSON.stringify(snapshot)}`,
      config: {
        abortSignal: AbortSignal.timeout(15000),
        systemInstruction:
          'You are SmartStock AI Inventory Assistant. Answer concisely in 2-4 sentences using ONLY the live inventory JSON provided. Never invent products, quantities, or figures. If recommending a purchase order for a low/out-of-stock item, populate suggestedProductId and suggestedOrderQty so the UI can ask the user for confirmation before drafting. Never claim you already changed stock or placed an order.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            answer: { type: Type.STRING },
            suggestedProductId: { type: Type.STRING },
            suggestedOrderQty: { type: Type.INTEGER },
          },
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim()) as {
      answer?: string;
      suggestedProductId?: string;
      suggestedOrderQty?: number;
    };

    if (!parsed.answer || typeof parsed.answer !== 'string') {
      throw new Error('Gemini returned an empty answer.');
    }

    let suggestedAction: ChatResponsePayload['suggestedAction'] = null;
    if (parsed.suggestedProductId && parsed.suggestedOrderQty && parsed.suggestedOrderQty > 0) {
      const targetProd = activeProducts.find((p) => p.id === parsed.suggestedProductId);
      if (targetProd) {
        suggestedAction = {
          type: 'create_po',
          label: `Draft PO for ${targetProd.name} (${parsed.suggestedOrderQty} units)`,
          productId: targetProd.id,
          supplierId: targetProd.supplierId,
          quantity: parsed.suggestedOrderQty,
          requiresConfirmation: true,
        };
      }
    }

    return {
      status: 'ready',
      modelLabel: 'AI-generated via Gemini (gemini-4-hydrogen)',
      answer: parsed.answer,
      dataUsed,
      suggestedAction,
    };
  } catch (err) {
    console.warn('Gemini chat error:', err instanceof Error ? err.message : String(err));
    return {
      status: 'error',
      modelLabel: 'Gemini AI error',
      answer: '',
      dataUsed,
      errorMessage: classifyGeminiError(err),
    };
  }
}
