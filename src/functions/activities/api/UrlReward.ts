import { URLs } from '../../../constants/urls'
import type { BasePromotion } from '../../../interface/DashboardData'
import { BaseActivity } from '../BaseActivity'
import { UrlRewardFallback } from './UrlRewardFallback'

export class UrlReward extends BaseActivity {
    public async doUrlReward(promotion: BasePromotion) {
        await this.runUrlReward(promotion, true)
    }

    private async runUrlReward(promotion: BasePromotion, allowSessionRepair: boolean) {
        const offerId = promotion.offerId

        const actionId = this.bot.nextActions.reportActivity
        if (!actionId) {
            this.bot.logger.warn(this.bot.isMobile, 'URL-REWARD', `跳过 ${offerId}：bundle 中未发现 "reportActivity"`)
            return
        }

        const live = await this.bot.browser.func.ensureOffer(offerId)
        if (!live) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'URL-REWARD',
                `跳过 ${offerId}：页面快照中不存在，即使重新获取 /earn 和 /dashboard 后也没有`
            )
            return
        }
        if (!live.reportable) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'URL-REWARD',
                `跳过 ${offerId}：不可上报（已完成/已锁定/无 hash/未到期）`
            )
            return
        }

        if (this.bot.config.skipNonPointTasks && live.points === 0) {
            this.bot.logger.info(
                this.bot.isMobile,
                'URL-REWARD',
                `跳过 ${offerId}：不产生积分（points=${live.points}${live.promotionSubtype ? ` subtype=${live.promotionSubtype}` : ''}）- 可能是免费试用/不计分优惠。设置 skipNonPointTasks=false 可强制尝试。`
            )
            return
        }

        const oldBalance = this.bot.userData.currentPoints
        const expectedPoints = live.points

        const dashboardActivityType = Number(promotion.activityType)
        const activityType =
            live.activityType ??
            (Number.isInteger(dashboardActivityType) && dashboardActivityType > 0 ? dashboardActivityType : 11)

        this.bot.logger.info(
            this.bot.isMobile,
            'URL-REWARD',
            `开始处理 UrlReward | offerId=${offerId} | geo=${this.bot.userData.geoLocale} | currentBalance=${oldBalance}`
        )

        this.bot.logger.debug(
            this.bot.isMobile,
            'URL-REWARD',
            `[诊断] 上报参数 | offerId=${offerId} | Next-Action=${actionId} | hash=${live.hash?.slice(0, 12) ?? 'null'}… | activityType=${activityType} | isPromotional=${live.isPromotional} | timezoneOffset=${this.bot.userData.timezoneOffset}`
        )

        try {
            this.markExecuted()
            const { status, acknowledged, availablePoints, bodyExcerpt } =
                await this.bot.browser.func.reportServerAction(
                    actionId,
                    [
                        live.hash,
                        activityType,
                        {
                            offerid: offerId,
                            isPromotional: live.isPromotional ? true : '$undefined',
                            timezoneOffset: this.bot.userData.timezoneOffset
                        }
                    ],
                    {
                        url: URLs.rewards.dashboard,
                        referer: URLs.rewards.dashboard,
                        routerStateTree: this.bot.browser.react.routerStateTree('dashboard')
                    }
                )

            if (!acknowledged) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `UrlReward 请求未被确认 | offerId=${offerId} | status=${status}`
                )
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `[诊断] 未确认响应原文（前 200 字符） | offerId=${offerId} | body=${bodyExcerpt}`
                )
            }

            let newBalance = availablePoints ?? (await this.bot.browser.func.getCurrentPoints())
            let gainedPoints = newBalance - oldBalance
            let via = 'reportActivity'

            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD',
                `响应 | offerId=${offerId} | status=${status} | acknowledged=${acknowledged} | pointsGained=${gainedPoints} | currentBalance=${newBalance}`
            )

            // 2026-11-16 起国区 reportActivity 回 200 但不给分（Issue #79），只在首轮尝试备用通道，避免重复上报
            const zeroPointByDesign = acknowledged && expectedPoints === 0
            if (gainedPoints <= 0 && !zeroPointByDesign && allowSessionRepair) {
                const fallback = await this.tryFallbacks(offerId, oldBalance)
                if (fallback) {
                    newBalance = fallback.balance
                    gainedPoints = newBalance - oldBalance
                    via = fallback.channel
                }
            }

            if (gainedPoints <= 0 && !acknowledged) {
                if (await this.retryAfterRequestFailure(promotion, allowSessionRepair)) return
            }

            if (gainedPoints > 0) {
                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints

                const shortfall = expectedPoints > 0 && gainedPoints < expectedPoints
                this.bot.logger.info(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `UrlReward 完成 | offerId=${offerId} | via=${via} | pointsGained=${gainedPoints} | currentBalance=${newBalance}${shortfall ? ' | WARNING: credited less than advertised' : ''}`,
                    'green'
                )
            } else if (acknowledged && expectedPoints === 0) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `UrlReward 完成（设计上无积分） | offerId=${offerId} | acknowledged=true | pointsGained=0 | currentBalance=${newBalance}`,
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `UrlReward 未获得积分 | offerId=${offerId} | acknowledged=${acknowledged} | expected=${expectedPoints} | pointsGained=0 | currentBalance=${newBalance}`
                )
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'URL-REWARD',
                `doUrlReward 出错 | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
            await this.retryAfterRequestFailure(promotion, allowSessionRepair)
        }
    }

    // 依次尝试 Bing flyout 和 dapi，用余额变化判定是否到账；到账则返回新余额
    private async tryFallbacks(
        offerId: string,
        oldBalance: number
    ): Promise<{ channel: 'flyout' | 'dapi'; balance: number } | null> {
        const fallback = new UrlRewardFallback(this.bot)
        const channels = [
            { name: 'flyout' as const, run: () => fallback.reportViaFlyout(offerId) },
            { name: 'dapi' as const, run: () => fallback.reportViaDapi(offerId) }
        ]

        for (const channel of channels) {
            try {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `reportActivity 未到账，改走备用通道 | offerId=${offerId} | channel=${channel.name}`
                )
                const result = await channel.run()
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `备用通道响应 | offerId=${offerId} | channel=${channel.name} | accepted=${result.accepted} | ${result.detail}`
                )
                if (!result.accepted) continue

                let balance = result.balance
                if (balance === null || balance <= oldBalance) {
                    // 服务端入账可能有延迟，稍等再查余额
                    await this.bot.utils.wait(2000)
                    balance = await this.bot.browser.func.getCurrentPoints()
                }

                if (balance > oldBalance) return { channel: channel.name, balance }

                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `备用通道已接受但余额未变 | offerId=${offerId} | channel=${channel.name} | currentBalance=${balance}`
                )
            } catch (error) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `备用通道出错 | offerId=${offerId} | channel=${channel.name} | message=${error instanceof Error ? error.message : String(error)}`
                )
            }
        }

        return null
    }

    private async retryAfterRequestFailure(promotion: BasePromotion, allowSessionRepair: boolean): Promise<boolean> {
        if (!allowSessionRepair) return false

        const refreshed = await this.bot.refreshCurrentRewardsContext(`URL-REWARD:${promotion.offerId}`)
        if (!refreshed) return false

        this.bot.logger.info(
            this.bot.isMobile,
            'URL-REWARD',
            `使用刷新后的 cookie 和引导数据重试一次 UrlReward | offerId=${promotion.offerId}`
        )
        await this.runUrlReward(promotion, false)
        return true
    }
}
