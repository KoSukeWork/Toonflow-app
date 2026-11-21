import axios from "axios";
import { customProviders, settings } from "@/stores/settings";

type TfRequestOptions = { apiKey?: string; signal?: AbortSignal };

export type TfPayment = { orderNumber: string; payUrl?: string };
type TfOrder = { orderNumber: string; status: string | number };
export type TfRechargeSku = { id: number; price: number; integral: number; describe: string };
type TfResponse<T> = { code: number; data: T; message?: string };

export type TfPayParams = {
  comboId: number;
  customMoney?: number;
  payType: "wechat" | "alipay";
};

export function isTfRouterProvider(provider: { id: string; apiUrl: string }) {
  return provider.id.toLowerCase() === "tfrouter" && URL.canParse(provider.apiUrl)
    && new URL(provider.apiUrl).origin === "https://api.toonflow.net";
}

const client = axios.create({ baseURL: "https://api.toonflow.net" });

export function getTfApiKey() {
  const provider = customProviders.value.find(isTfRouterProvider);
  const mediaConfigs = settings.value.mediaProviderConfigs as Record<string, { apiKey?: unknown }> | undefined;
  return [provider?.apiKey, mediaConfigs?.tfRouter?.apiKey]
    .map(key => typeof key === "string" ? key.trim().replace(/^Bearer(?:\s+|$)/i, "").trim() : "")
    .find(Boolean) ?? "";
}

function requestOptions({ apiKey, signal }: TfRequestOptions = {}) {
  const key = (apiKey ?? getTfApiKey()).trim().replace(/^Bearer(?:\s+|$)/i, "").trim();
  if (!key) throw new Error("请先配置 TF-Router API Key");
  return { signal, timeout: 20000, headers: { Authorization: `Bearer ${key}` } };
}

function responseData<T>(response: TfResponse<T>, fallback = "TF-Router 请求失败"): T {
  if (!response || typeof response !== "object" || typeof response.code !== "number") throw new Error("TF-Router 响应格式不正确");
  if (response.code !== 200) throw new Error(response.message || fallback);
  return response.data;
}

export default {
  async queryOrder(orderNumber: string, options?: TfRequestOptions): Promise<TfOrder> {
    if (!orderNumber.trim()) throw new Error("订单号不能为空");
    const { data } = await client.get<TfResponse<TfOrder>>("/v1/recharge/queryOrder", { ...requestOptions(options), params: { orderNumber: orderNumber.trim() } });
    const order = responseData(data);
    if (!order || order.orderNumber !== orderNumber.trim() || !["string", "number"].includes(typeof order.status)) throw new Error("订单查询响应格式不正确");
    return order;
  },

  async getRechargeData(options?: TfRequestOptions): Promise<TfRechargeSku[]> {
    const { data } = await client.get<TfResponse<unknown>>("/v1/recharge/getRechargeData", requestOptions(options));
    const skus = responseData(data);
    if (!Array.isArray(skus)) throw new Error("充值套餐响应格式不正确");
    return skus.map(sku => {
      const price = typeof sku?.price === "string" && sku.price.trim() ? Number(sku.price) : sku?.price;
      const integral = typeof sku?.integral === "string" && sku.integral.trim() ? Number(sku.integral) : sku?.integral;
      if (!sku || !Number.isSafeInteger(sku.id) || sku.id < 1 || typeof price !== "number" || !Number.isFinite(price) || price <= 0
        || typeof integral !== "number" || !Number.isFinite(integral) || integral < 0 || typeof sku.describe !== "string") throw new Error("充值套餐响应格式不正确");
      return { id: sku.id, price, integral, describe: sku.describe };
    });
  },

  async pay({ comboId, customMoney, payType }: TfPayParams, options?: TfRequestOptions): Promise<TfPayment> {
    if (!Number.isSafeInteger(comboId) || (comboId !== -1 && comboId < 1)) throw new Error("充值套餐 ID 必须为正整数或 -1");
    if (payType !== "wechat" && payType !== "alipay") throw new Error("请选择微信或支付宝支付");
    if (comboId === -1 && (typeof customMoney !== "number" || !Number.isFinite(customMoney) || customMoney < 0.01 || customMoney > 50000)) {
      throw new Error("自定义充值金额必须在 0.01 至 50000 之间");
    }
    const { data } = await client.post<TfResponse<TfPayment>>("/v1/recharge/pay", {
      comboId,
      ...(comboId === -1 ? { customMoney } : {}),
      payType,
    }, requestOptions(options));
    const payment = responseData(data);
    if (!payment || typeof payment.orderNumber !== "string" || !payment.orderNumber.trim()
      || (payment.payUrl !== undefined && typeof payment.payUrl !== "string")) throw new Error("支付响应格式不正确");
    return payment;
  },
};
