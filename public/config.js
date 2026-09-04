/*
 * RunnersHub Release Config
 * -------------------------
 * Change these flags to switch product/reward modes without rewriting the UI.
 *
 * INITIAL RELEASE:
 *   - Download unlock = share verification
 *   - Points/rewards UI = OFF
 *   - Rewarded ads = OFF
 *   - Normal AdSense display ads = ON
 *
 * Future examples:
 *   download.unlockMode = 'free'
 *   download.unlockMode = 'points'
 *   download.unlockMode = 'share_or_points'
 *   rewards.enabled = true
 *
 * IMPORTANT: this file contains public feature flags only. Never put secrets,
 * API keys, private tokens, or service-account credentials here.
 */
window.RUNNERSHUB_CONFIG = Object.freeze({
  download: Object.freeze({
    unlockMode: 'share'
  }),
  rewards: Object.freeze({
    enabled: false
  }),
  shareUnlock: Object.freeze({
    enabled: true,
    dailyLimit: 3,
    oneUnlockPerRoute: true
  }),
  ads: Object.freeze({
    display: true,
    rewarded: false
  })
});
