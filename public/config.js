/*
 * RunnersHub Release Config
 * -------------------------
 * ONE MASTER SWITCH controls the points economy:
 *
 *   points.enabled = true  -> Rewards/Points navigation + wallet + rewards ON
 *   points.enabled = false -> Points UI/rewards disappear
 *
 * Download behavior:
 *   - Points ON: 15 points OR verified Share unlock
 *   - Points OFF: verified Share unlock (and Ad when a verified rewarded-ad flow exists)
 *
 * 3D Flyover:
 *   - Preview is always free when threeD.enabled=true.
 *   - Final export costs 40 points when points are enabled.
 *   - If points are enabled but the user has insufficient points, verified Share can
 *     be used as the fallback unlock for one flyover export.
 *
 * IMPORTANT: this is public UI/product configuration only. Never put secrets here.
 */
const RUNNERSHUB_CONFIG = Object.freeze({
  // Points economy. One source of truth: the `rewards` block below mirrors it
  // through getters, so the UI and the server can never disagree on a value.
  points: Object.freeze({
    enabled: true,
    costs: Object.freeze({
      download: 15,          // GPX download (still requires a verified share first)
      threeDFlyover: 40
    }),
    earn: Object.freeze({
      upload: Object.freeze({ enabled: true, points: 70, dailyLimit: 2 }),
      share: Object.freeze({ enabled: true, points: 15, dailyLimit: 3 }),
      like: Object.freeze({ enabled: true, points: 2, dailyLimit: 10 }),
      comment: Object.freeze({ enabled: true, points: 5, dailyLimit: 5 }),
      rewardedAd: Object.freeze({ enabled: false, points: 20, dailyLimit: 3 })
    })
  }),

  rewards: Object.freeze({
    get enabled() { return RUNNERSHUB_CONFIG.points.enabled; },
    upload: Object.freeze({
      get enabled() { return RUNNERSHUB_CONFIG.points.earn.upload.enabled; },
      get points() { return RUNNERSHUB_CONFIG.points.earn.upload.points; },
      get dailyLimit() { return RUNNERSHUB_CONFIG.points.earn.upload.dailyLimit; }
    }),
    share: Object.freeze({
      get enabled() { return RUNNERSHUB_CONFIG.points.earn.share.enabled; },
      get points() { return RUNNERSHUB_CONFIG.points.earn.share.points; },
      get dailyLimit() { return RUNNERSHUB_CONFIG.points.earn.share.dailyLimit; }
    }),
    like: Object.freeze({
      get enabled() { return RUNNERSHUB_CONFIG.points.earn.like.enabled; },
      get points() { return RUNNERSHUB_CONFIG.points.earn.like.points; },
      get dailyLimit() { return RUNNERSHUB_CONFIG.points.earn.like.dailyLimit; }
    }),
    comment: Object.freeze({
      get enabled() { return RUNNERSHUB_CONFIG.points.earn.comment.enabled; },
      get points() { return RUNNERSHUB_CONFIG.points.earn.comment.points; },
      get dailyLimit() { return RUNNERSHUB_CONFIG.points.earn.comment.dailyLimit; }
    }),
    rewardedAd: Object.freeze({
      get enabled() { return RUNNERSHUB_CONFIG.points.earn.rewardedAd.enabled; },
      get points() { return RUNNERSHUB_CONFIG.points.earn.rewardedAd.points; },
      get dailyLimit() { return RUNNERSHUB_CONFIG.points.earn.rewardedAd.dailyLimit; }
    })
  }),

  download: Object.freeze({
    // "auto" = points first when available, otherwise Share/Ad fallback.
    unlockMode: "auto",
    // Sharing is MANDATORY: a verified share must exist for that route before
    // points can be spent on the GPX. Keeps the growth loop, adds the price.
    requireShareBeforePoints: true,
    fallbackModes: Object.freeze([]),
    oneUnlockPerRoute: true
  }),

  shareUnlock: Object.freeze({
    enabled: true,
    dailyLimit: 3,
    requirePostLink: true
  }),

  ads: Object.freeze({
    display: true,
    rewarded: false
  }),

  stravaImport: Object.freeze({
    mode: "public-first",
    allowPublicActivityScrape: true,
    gpxFallback: true,
    requireOAuthForPublicImport: false
  }),

  threeD: Object.freeze({
    enabled: true,
    preview: true,
    export: Object.freeze({ enabled: true, pointsCost: 0 }),
    exportEnabled: true,
    pointsCost: 0,
    width: 1080,
    height: 1920,
    fps: 30,
    durationSeconds: 20,
    // Recording bitrate in bits/s. MediaRecorder ALWAYS compresses (there is no
    // raw/uncompressed mode in the browser), but at a high bitrate H.264 High is
    // visually lossless: 40 Mbps ≈ 0.6 bit/pixel/frame at 1080×1920×30
    // (~150 MB per 30 s). Set 0 for auto (0.25 bppf), raise to 60000000+ if you
    // want even less compression and do not care about file size.
    videoBitrate: 40000000,
    // Fraction of the frame height kept clear at the bottom of the video, so the
    // elevation HUD is never hidden behind Instagram/TikTok captions, buttons or
    // the comment bar. 0 = no offset, 0.10 = default safe area.
    hudBottomOffset: 0.10,
    // How long the statistics card stays on screen at the end of an export (ms).
    finishCardMs: 1500,
    // Fallback pace (sec/km) used ONLY when a GPX carries no <time> data — i.e.
    // route files with coordinates but no movement data. The estimate is
    // grade-adjusted and every derived value is shown with "≈".
    assumedPaceSecPerKm: 360,
    watermark: "RunnersHub",
    // camera.easeMs: 0 = apply the damped camera state every frame (recommended,
    // no stutter). Set 90 to restore the older "easeTo every frame" behaviour.
    camera: Object.freeze({ headingResponse: 3.2, maxTurnPerSecond: 50, positionResponse: 10.0, lookAheadMeters: 110, lookBehindMeters: 35, zoomStart: 15.2, zoomEnd: 12.0, zoomMin: 11.6, zoomMax: 15.6, pitchStart: 64, pitchEnd: 42, pitchMin: 38, pitchMax: 74, easeMs: 0, tailSeconds: 1.5 }),
    map: Object.freeze({
      terrainUrl: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
      exaggeration: 1.15
    }),
    fallbackModes: Object.freeze([])
  })
});

if (typeof window !== 'undefined') window.RUNNERSHUB_CONFIG = RUNNERSHUB_CONFIG;
if (typeof module !== 'undefined' && module.exports) module.exports = RUNNERSHUB_CONFIG;
