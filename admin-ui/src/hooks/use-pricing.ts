import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getPricingConfig, setPricingConfig } from '@/api/pricing'
import type { SetPricingConfigRequest } from '@/types/api'

/** 读取费用单价配置（变动极少，缓存久一些） */
export function usePricingConfig() {
  return useQuery({
    queryKey: ['config', 'pricing'],
    queryFn: getPricingConfig,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })
}

/** 更新费用单价配置 */
export function useSetPricingConfig() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (payload: SetPricingConfigRequest) => setPricingConfig(payload),
    onSuccess: () => {
      toast.success('费用单价已保存')
      queryClient.invalidateQueries({ queryKey: ['config', 'pricing'] })
    },
    onError: (error: unknown) => {
      const message =
        (error as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error
          ?.message ?? '保存费用单价失败'
      toast.error(message)
    },
  })
}
