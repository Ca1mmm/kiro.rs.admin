import axios from 'axios'
import { storage } from '@/lib/storage'
import type { PricingConfig, SetPricingConfigRequest } from '@/types/api'

// 与其它 api 模块一致：baseURL + x-api-key 拦截器
const api = axios.create({
  baseURL: '/api/admin',
  headers: { 'Content-Type': 'application/json' },
})

api.interceptors.request.use((config) => {
  const apiKey = storage.getApiKey()
  if (apiKey) {
    config.headers['x-api-key'] = apiKey
  }
  return config
})

/** 读取费用单价配置 */
export async function getPricingConfig(): Promise<PricingConfig> {
  const { data } = await api.get<PricingConfig>('/config/pricing')
  return data
}

/** 更新费用单价配置 */
export async function setPricingConfig(
  payload: SetPricingConfigRequest,
): Promise<PricingConfig> {
  const { data } = await api.put<PricingConfig>('/config/pricing', payload)
  return data
}
