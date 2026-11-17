import { randomUUID } from 'crypto'
import { URLs } from '../../../constants/urls'
import { BING_APP_USER_AGENT } from '../../../constants/userAgents'
import type { MicrosoftRewardsBot } from '../../../index'

/**
 * UrlReward 的备用上报通道。
 *
 * 2026-11-16 起国区 rewards.bing.com 的 reportActivity server action 回 200 但不认账（Issue #79），
 * 这里提供两条不依赖 Next.js server action 的上报路径：
 *   1. Bing flyout：www.bing.com/msrewards/api/v1/reportactivity（移植自上游 TheNetsky v5 的 FlyoutActivityReport）
 *   2. 移动端 dapi：prod.rewardsplatform.microsoft.com/dapi/me/activities（与 ReadToEarn/AppReward 同一接口）
 * 调用方必须用余额变化来判断是否到账，不能只看这里的 accepted。
 */

export interface FallbackResult {
    channel: 'flyout' | 'dapi'
    accepted: boolean
    // 接口直接返回的新余额（dapi 有，flyout 没有）
    balance: number | null
    detail: string
}

interface FlyoutCard {
    offerId?: string
    hash?: string
    activityType?: unknown
    promotionSubtype?: unknown
}

interface FlyoutViewModel {
    userId?: unknown
    channel?: unknown
    partnerId?: unknown
    flyoutResult?: {
        dailySetPromotions?: Record<string, FlyoutCard[]>
        morePromotions?: FlyoutCard[]
        morePromotionsWithoutPromotionalItems?: FlyoutCard[]
    }
}

const text = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value && value !== '$undefined' ? value : fallback

export class UrlRewardFallback {
    constructor(private readonly bot: MicrosoftRewardsBot) {}

    async reportViaFlyout(offerId: string): Promise<FallbackResult> {
        const acceptLanguage = this.bot.accountLocale.acceptLanguage

        const page = await this.bot.browser.func.requestWithSessionCookies<string>({
            url: URLs.bing.rewardsFlyoutPage,
            method: 'GET',
            headers: {
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': acceptLanguage,
                Referer: `${URLs.bing.origin}/`
            },
            responseType: 'text',
            retries: 0
        })
        if (typeof page.data !== 'string') {
            return { channel: 'flyout', accepted: false, balance: null, detail: 'flyout 页面不是文本' }
        }

        const model = extractFlyoutViewModel(page.data)
        if (!model) {
            return {
                channel: 'flyout',
                accepted: false,
                balance: null,
                detail: 'flyout 页面缺少 window.flyoutViewModel'
            }
        }

        const result = model.flyoutResult
        const cards: FlyoutCard[] = [
            ...Object.values(result?.dailySetPromotions ?? {}).flat(),
            ...(result?.morePromotions ?? []),
            ...(result?.morePromotionsWithoutPromotionalItems ?? [])
        ]
        const card = cards.find(c => c?.offerId === offerId)
        const userId = typeof model.userId === 'string' ? model.userId : ''

        if (!userId || !card?.hash) {
            return {
                channel: 'flyout',
                accepted: false,
                balance: null,
                detail: `flyout 中没有可上报的卡片 | card=${Boolean(card)} | hash=${Boolean(card?.hash)} | userId=${Boolean(userId)}`
            }
        }

        const response = await this.bot.browser.func.requestWithSessionCookies<unknown>({
            url: URLs.bing.rewardsFlyoutReportActivity,
            method: 'POST',
            headers: {
                Accept: '*/*',
                'Accept-Language': acceptLanguage,
                'Content-Type': 'application/json',
                Origin: URLs.bing.origin,
                Referer: URLs.bing.rewardsFlyoutPage
            },
            data: JSON.stringify({
                ActivityType: text(card.activityType, 'bingredirect'),
                ActivitySubType: text(card.promotionSubtype, ''),
                OfferId: offerId,
                Channel: text(model.channel, 'BingFlyout'),
                PartnerId: text(model.partnerId, 'BingRewards'),
                UserId: userId,
                AuthKey: card.hash,
                ActivityCount: 1
            }),
            responseType: 'json',
            retries: 0
        })

        const body = (typeof response.data === 'object' && response.data !== null ? response.data : {}) as {
            ErrorDetail?: { ErrorCode?: number; Description?: string }
            OfferComplete?: boolean
            EarnedCredits?: number
        }
        const errorCode = body.ErrorDetail?.ErrorCode

        return {
            channel: 'flyout',
            accepted: errorCode === 0,
            balance: null,
            detail: `status=${response.status} | errorCode=${errorCode ?? 'none'} | offerComplete=${body.OfferComplete ?? 'unknown'} | earnedCredits=${body.EarnedCredits ?? 'unknown'}`
        }
    }

    async reportViaDapi(offerId: string): Promise<FallbackResult> {
        if (!this.bot.accessToken) {
            return { channel: 'dapi', accepted: false, balance: null, detail: '没有移动端访问令牌' }
        }

        const response = await this.bot.http.request<{ response?: { balance?: number } }>({
            url: URLs.platform.activities,
            method: 'POST',
            headers: {
                Authorization: `Bearer ${this.bot.accessToken}`,
                'User-Agent': BING_APP_USER_AGENT,
                'Content-Type': 'application/json',
                'X-Rewards-Country': this.bot.userData.geoLocale,
                'X-Rewards-Language': this.bot.userData.langCode,
                'X-Rewards-ismobile': 'true'
            },
            data: JSON.stringify({
                id: randomUUID(),
                amount: 1,
                type: 101,
                attributes: { offerid: offerId },
                country: this.bot.userData.geoLocale
            }),
            retries: 0
        })

        const balance = Number(response.data?.response?.balance)
        return {
            channel: 'dapi',
            accepted: response.status >= 200 && response.status < 300,
            balance: Number.isSafeInteger(balance) && balance >= 0 ? balance : null,
            detail: `status=${response.status} | balance=${Number.isFinite(balance) ? balance : 'unknown'}`
        }
    }
}

function extractFlyoutViewModel(html: string): FlyoutViewModel | null {
    const marker = /window\.flyoutViewModel\s*=\s*/.exec(html)
    if (!marker) return null

    const start = html.indexOf('{', marker.index + marker[0].length)
    if (start < 0) return null

    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < html.length; i++) {
        const c = html[i]
        if (escaped) {
            escaped = false
            continue
        }
        if (inString && c === '\\') {
            escaped = true
            continue
        }
        if (c === '"') {
            inString = !inString
            continue
        }
        if (inString) continue
        if (c === '{') depth++
        else if (c === '}' && --depth === 0) {
            try {
                const parsed = JSON.parse(html.slice(start, i + 1)) as unknown
                return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                    ? (parsed as FlyoutViewModel)
                    : null
            } catch {
                return null
            }
        }
    }
    return null
}
