-- Combo Locks fill-twin cleanup. Preview first, then run the DELETEs.
-- Do not run until combo-worker with persist/activity guards is deployed,
-- or the old process can re-insert the dropped rows.
-- Prefer keeping real Kalshi trades and poly-activity trade ids.

-- 1) Preview Kalshi live-runner stubs that share order_id with a real trade.
SELECT s.fill_id AS stub_fill_id, s.order_id, s.count AS stub_count,
       r.fill_id AS real_fill_id, r.count AS real_count, s.parlay_id, s.ticker
FROM combo_fills s
JOIN combo_fills r
  ON r.order_id = s.order_id
 AND r.fill_id IS DISTINCT FROM s.fill_id
WHERE (
        s.raw->>'source' = 'live-runner'
        OR (s.fill_id = s.order_id AND COALESCE(s.raw->>'source','') NOT LIKE 'poly-%')
      )
  AND COALESCE(s.raw->>'source','') NOT LIKE 'poly-%'
  AND s.raw->>'trade_id' IS NULL
  AND (
        r.raw ? 'trade_id'
        OR r.raw ? 'count_fp'
        OR (r.fill_id IS DISTINCT FROM r.order_id
            AND COALESCE(r.raw->>'source','') NOT IN ('live-runner')
            AND COALESCE(r.raw->>'source','') NOT LIKE 'poly-%')
      );

-- 2) Delete those Kalshi stubs (209 rows as of 2026-09-21).
DELETE FROM combo_fills s
WHERE (
        s.raw->>'source' = 'live-runner'
        OR (s.fill_id = s.order_id AND COALESCE(s.raw->>'source','') NOT LIKE 'poly-%')
      )
  AND COALESCE(s.raw->>'source','') NOT LIKE 'poly-%'
  AND s.raw->>'trade_id' IS NULL
  AND EXISTS (
    SELECT 1 FROM combo_fills r
    WHERE r.order_id = s.order_id
      AND r.fill_id IS DISTINCT FROM s.fill_id
      AND (
            r.raw ? 'trade_id'
            OR r.raw ? 'count_fp'
            OR (r.fill_id IS DISTINCT FROM r.order_id
                AND COALESCE(r.raw->>'source','') NOT IN ('live-runner')
                AND COALESCE(r.raw->>'source','') NOT LIKE 'poly-%')
          )
  );

-- 3) Preview the two remaining Poly same-size twins (keep poly-act, drop recon).
SELECT fill_id, parlay_id, ticker, count, recorded_at, raw->>'source' AS source
FROM combo_fills
WHERE fill_id IN (
  'poly-recon:DP9qb_kO-3EK-RNRaoBRybVoRsPoOOBWGANmHeGzBrw:629.82',
  'poly-act:CJDEG0BFCVAY',
  'poly-recon:GNESocXBvU9SGBMM3IS-n4O5rkSxza-dBdA5-bSsE2Y:83.57',
  'poly-act:CKHWA67BPW1E'
)
ORDER BY ticker, fill_id;

-- 4) Drop the two poly-reconcile twins. Keep the poly-act trade ids.
DELETE FROM combo_fills
WHERE fill_id IN (
  'poly-recon:DP9qb_kO-3EK-RNRaoBRybVoRsPoOOBWGANmHeGzBrw:629.82',
  'poly-recon:GNESocXBvU9SGBMM3IS-n4O5rkSxza-dBdA5-bSsE2Y:83.57'
);
