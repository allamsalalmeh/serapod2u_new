// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EllbowBottomNavigation, EllbowLiveHome } from './EllbowLiveExperience'

afterEach(() => cleanup())

describe('EllbowLiveHome', () => {
    it('renders live campaign, points, actions, and rewards data', () => {
        const onCollect = vi.fn()
        const onViewRewards = vi.fn()
        const onRewardClick = vi.fn()

        render(
            <EllbowLiveHome
                campaignName="Test Campaign For Ellbow"
                accountManagerName="Edi"
                brandName="RoadTour"
                points={240}
                nextRewardPoints={260}
                nextRewardName="Ellbow Treat Pack"
                progressPercent={48}
                collectLabel="Collect Points"
                collectDisabled={false}
                collectLoading={false}
                collected={false}
                pointsEnabled
                rewards={[{ id: 'reward-1', name: 'Ellbow Treat Pack', points: 500, imageUrl: null }]}
                rewardsLoading={false}
                onCollect={onCollect}
                onViewRewards={onViewRewards}
                onRewardClick={onRewardClick}
            />,
        )

        expect(screen.getByText('Test Campaign For Ellbow')).toBeTruthy()
        expect(screen.getByText('Account Manager: Edi')).toBeTruthy()
        expect(screen.getByText('240')).toBeTruthy()
        expect(screen.getByText('260 pts away')).toBeTruthy()
        expect(screen.getByText('Featured Rewards')).toBeTruthy()

        fireEvent.click(screen.getByRole('button', { name: 'Collect Points' }))
        fireEvent.click(screen.getByRole('button', { name: 'View Rewards' }))
        fireEvent.click(screen.getByRole('button', { name: 'Ellbow Treat Pack 500 pts Ellbow Treat Pack' }))

        expect(onCollect).toHaveBeenCalledTimes(1)
        expect(onViewRewards).toHaveBeenCalledTimes(1)
        expect(onRewardClick).toHaveBeenCalledWith('reward-1')
    })

    it('uses the enhanced Ellbow mobile asset pack', () => {
        render(
            <EllbowLiveHome
                campaignName="Ellbow RoadTour"
                points={0}
                nextRewardPoints={100}
                progressPercent={0}
                collectLabel="Checking…"
                collectDisabled
                collectLoading
                collected={false}
                pointsEnabled
                rewards={[]}
                rewardsLoading={false}
                onCollect={() => {}}
                onViewRewards={() => {}}
                onRewardClick={() => {}}
            />,
        )

        const sources = Array.from(document.querySelectorAll('img')).map((image) => image.getAttribute('src') || '')
        expect(sources.some((source) => source.includes('ellbow-mobile-ready-assets/webp/04-ellbow-verified-shield-cat'))).toBe(true)
        expect(sources.some((source) => source.includes('ellbow-mobile-ready-assets/webp/01-ellbow-cat-mascot-full'))).toBe(true)
        expect(screen.getByRole('button', { name: 'Checking…' }).hasAttribute('disabled')).toBe(true)
    })

    it('shows the QR collection status under Collect Points only when points are enabled', () => {
        const props = {
            campaignName: 'Ellbow RoadTour',
            points: 0,
            nextRewardPoints: 100,
            progressPercent: 0,
            collectLabel: 'Points Collected',
            collectDisabled: true,
            collectLoading: false,
            collected: true,
            rewards: [],
            rewardsLoading: false,
            onCollect: () => {},
            onViewRewards: () => {},
            onRewardClick: () => {},
            collectionStatus: <div>Points for this QR code have already been collected</div>,
        }

        const { rerender } = render(<EllbowLiveHome {...props} pointsEnabled />)
        expect(screen.getByText('Points for this QR code have already been collected')).toBeTruthy()

        rerender(<EllbowLiveHome {...props} pointsEnabled={false} />)
        expect(screen.queryByText('Points for this QR code have already been collected')).toBeNull()
    })
})

describe('EllbowBottomNavigation', () => {
    it('uses Ellbow icons and preserves live navigation handlers', () => {
        const onSelect = vi.fn()
        const onScan = vi.fn()

        render(<EllbowBottomNavigation activeTab="home" onSelect={onSelect} onScan={onScan} />)

        expect(screen.getByRole('button', { name: 'Home' }).getAttribute('aria-current')).toBe('page')
        fireEvent.click(screen.getByRole('button', { name: 'Rewards' }))
        fireEvent.click(screen.getByRole('button', { name: 'Scan' }))

        expect(onSelect).toHaveBeenCalledWith('rewards')
        expect(onScan).toHaveBeenCalledTimes(1)
    })
})
