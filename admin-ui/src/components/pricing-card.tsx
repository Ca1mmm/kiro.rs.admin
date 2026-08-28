import { useEffect, useState } from 'react'
import { Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { usePricingConfig, useSetPricingConfig } from '@/hooks/use-pricing'

/**
 * 费用单价设置卡
 *
 * Kiro 上游只按 credit 计费、不下发金额，所以费用需要按自己的套餐折算：
 * 例如「$20/月 含 1000 credits」→ 单价 0.02。单价为 0 时报表隐藏金额。
 */
export function PricingCard() {
  const { data, isLoading } = usePricingConfig()
  const { mutate: save, isPending } = useSetPricingConfig()

  const [price, setPrice] = useState('')
  const [currency, setCurrency] = useState('USD')

  // 服务端值到达/变化后同步到输入框
  useEffect(() => {
    if (data) {
      setPrice(data.creditUnitPrice > 0 ? String(data.creditUnitPrice) : '')
      setCurrency(data.currency || 'USD')
    }
  }, [data])

  const handleSave = () => {
    const parsed = price.trim() === '' ? 0 : Number(price)
    if (!Number.isFinite(parsed) || parsed < 0) {
      return
    }
    save({ creditUnitPrice: parsed, currency: currency.trim() || 'USD' })
  }

  const dirty =
    data != null &&
    (String(data.creditUnitPrice > 0 ? data.creditUnitPrice : '') !== price.trim() ||
      (data.currency || 'USD') !== currency.trim().toUpperCase())

  return (
    <Card className="mb-6">
      <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Wallet className="h-4 w-4" />
            费用单价
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground" htmlFor="credit-unit-price">
              每 credit 金额
            </label>
            <Input
              id="credit-unit-price"
              className="h-8 w-32"
              inputMode="decimal"
              placeholder="0 = 不展示"
              value={price}
              disabled={isLoading}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] text-muted-foreground" htmlFor="credit-currency">
              货币
            </label>
            <Input
              id="credit-currency"
              className="h-8 w-20"
              placeholder="USD"
              value={currency}
              disabled={isLoading}
              maxLength={8}
              onChange={(e) => setCurrency(e.target.value)}
            />
          </div>
          <Button size="sm" onClick={handleSave} disabled={isPending || isLoading || !dirty}>
            {isPending ? '保存中...' : '保存'}
          </Button>
        </div>
        <p className="max-w-md text-[11px] leading-relaxed text-muted-foreground">
          上游仅按 credit 计费、不返回金额。请按套餐折算单价，例如「$20/月 含 1000
          credits」填 <code>0.02</code>。留空或 0 表示不在报表中展示金额。
        </p>
      </CardContent>
    </Card>
  )
}
