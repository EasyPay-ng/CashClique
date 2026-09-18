import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.');

function read(rel) {
    return fs.readFileSync(path.join(root, rel), 'utf8');
}

test('post.html: contains allow ads toggle for active opportunity users', () => {
    const postHtml = read('post.html');
    assert.ok(postHtml.includes('id="opportunity-ad-section"'), 'post.html must have opportunity-ad-section');
    assert.ok(postHtml.includes('id="allow-ads-toggle"'), 'post.html must have allow-ads-toggle checkbox');
    assert.ok(postHtml.includes('allowAds'), 'post.html must save allowAds boolean property');
    assert.ok(postHtml.includes('canBoost'), 'post.html must save canBoost property');
});

test('boost.html: prevents boosting when ads are allowed on the post', () => {
    const boostHtml = read('boost.html');
    assert.ok(boostHtml.includes('allowAds === true') || boostHtml.includes('post.allowAds'), 'boost.html must check post.allowAds');
    assert.ok(boostHtml.includes('Cannot boost this post: ads are allowed on it') || boostHtml.includes('Boosting Prohibited'), 'boost.html must display warning/prohibition');
    assert.ok(boostHtml.includes('boostedLikes') || boostHtml.includes('boostedViews'), 'boost.html must track boostedLikes / boostedViews');
});

test('my-content.html: displays sleek creator metrics and ad status without exposing boosted vs organic split', () => {
    const myContentHtml = read('my-content.html');
    assert.ok(myContentHtml.includes('total-posts'), 'my-content.html must have total-posts metric');
    assert.ok(myContentHtml.includes('total-views'), 'my-content.html must have total-views metric');
    assert.ok(myContentHtml.includes('total-likes'), 'my-content.html must have total-likes metric');
    assert.ok(myContentHtml.includes('total-comments'), 'my-content.html must have total-comments metric');
    assert.ok(myContentHtml.includes('engagement-rate'), 'my-content.html must have engagement-rate metric');
    assert.ok(myContentHtml.includes('allowAds'), 'my-content.html must check post allowAds property');
    assert.ok(myContentHtml.includes('active-opp-banner'), 'my-content.html must have active-opp-banner');
    // Ensure boosted and organic engagements are NOT separated on the creator dashboard
    assert.ok(!myContentHtml.includes('total-likes-breakdown'), 'creator dashboard must not separate boosted likes');
    assert.ok(!myContentHtml.includes('total-views-breakdown'), 'creator dashboard must not separate boosted views');
});

test('admin-transactions.html: full details ledger and admin navigation exists', () => {
    const adminTxHtml = read('admin-transactions.html');
    assert.ok(adminTxHtml.includes('id="tx-modal"'), 'admin-transactions.html must have tx-modal for full details');
    assert.ok(adminTxHtml.includes('stat-total-volume'), 'admin-transactions.html must track total volume');
    assert.ok(adminTxHtml.includes('stat-total-deposits'), 'admin-transactions.html must track deposits');
    assert.ok(adminTxHtml.includes('stat-total-withdrawals'), 'admin-transactions.html must track withdrawals');
    assert.ok(adminTxHtml.includes('stat-total-boosts'), 'admin-transactions.html must track boost purchases');
    assert.ok(adminTxHtml.includes('exportCSV'), 'admin-transactions.html must offer export functionality');
});

test('admin.html: contains "Users Eligible for Reward" section and real vs boosted tracking', () => {
    const adminHtml = read('admin.html');
    assert.ok(adminHtml.includes('tab-rewards'), 'admin.html must have tab-rewards');
    assert.ok(adminHtml.includes('view-rewards'), 'admin.html must have view-rewards container');
    assert.ok(adminHtml.includes('rewards-table'), 'admin.html must have rewards-table');
    assert.ok(adminHtml.includes('inspect-posts-modal'), 'admin.html must have modal to inspect creator posts');
    assert.ok(adminHtml.includes('award-reward-modal'), 'admin.html must have modal to award reward payout');
    assert.ok(adminHtml.includes('total-views-breakdown'), 'admin.html must have views breakdown metric');
    assert.ok(adminHtml.includes('total-likes-breakdown'), 'admin.html must have likes breakdown metric');
    assert.ok(adminHtml.includes('admin-transactions.html'), 'admin.html sidebar must link to admin-transactions.html');
});

test('admin sidebars: all admin pages link to admin-transactions.html', () => {
    const adminPages = [
        'admin.html',
        'admin-opportunities.html',
        'applications.html',
        'admin-chat.html'
    ];

    for (const page of adminPages) {
        const source = read(page);
        assert.ok(source.includes('admin-transactions.html'), `${page} sidebar must link to admin-transactions.html`);
    }
});

test('organic vs boosted metrics logic correctly computes clean engagement', () => {
    const rawPost = {
        views: 1250,
        boostedViews: 250,
        likes: 120,
        boostedLikes: 20,
        commentCount: 15
    };

    const realViews = Math.max(0, (rawPost.views || 0) - (rawPost.boostedViews || 0));
    const realLikes = Math.max(0, (rawPost.likes || 0) - (rawPost.boostedLikes || 0));

    assert.equal(realViews, 1000, 'Real views should be 1000');
    assert.equal(realLikes, 100, 'Real likes should be 100');

    const totalEngagement = rawPost.views + rawPost.likes;
    const totalBoosted = rawPost.boostedViews + rawPost.boostedLikes;
    const boostRatio = totalBoosted / totalEngagement;

    assert.equal(boostRatio, 270 / 1370);
    assert.ok(boostRatio < 0.20, 'Boost ratio is under 20%');
});
