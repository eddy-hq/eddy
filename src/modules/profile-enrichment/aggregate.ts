// Per-(user, person) watched / dismissed counts, shared by the behavioural
// snapshot (index.ts) and the affinity digest (affinities.ts). Its own file so
// neither has to import the other.
//
// `@exclude_parent_picks`: the snapshot is watch weight and counts every play,
// parent picks included. The affinity digest is interest inference, which a
// parent pick (#217) must not feed — the parent chose the video — so it reads
// the same aggregate with parent picks left out.
import { WATCHED_RATIO, WATCHED_TIME_FLOOR_S } from '../watch-events';

export const PERSON_AGGREGATE_SQL = `
  WITH user_watch_events AS (
    SELECT we.event_id, we.video_id, we.reason, we.position_s, we.duration_s,
           po.person_id
    FROM watch_events we
    INNER JOIN requests r ON r.request_id = we.request_id
    INNER JOIN person_outputs po
      ON po.external_id = r.youtube_channel_id
     AND po.output_type = 'youtube'
    WHERE we.user_id = @user_id
      AND r.youtube_channel_id IS NOT NULL
      AND (@exclude_parent_picks = 0 OR r.source != 'parent_pick')
  ),
  watched AS (
    SELECT person_id, COUNT(*) AS n
    FROM user_watch_events
    WHERE reason = 'ended'
       OR (duration_s > 0 AND CAST(position_s AS REAL) / duration_s >= @watched_ratio)
       OR position_s >= @watched_floor
    GROUP BY person_id
  ),
  dismissed_keys AS (
    -- Mid-play bailouts: watch_events.reason='dismissed'
    SELECT DISTINCT person_id, video_id
    FROM user_watch_events
    WHERE reason = 'dismissed'
    UNION
    -- Pre-play swipe-dismisses: candidate_pool.status='dismissed'
    SELECT DISTINCT person_id, external_id AS video_id
    FROM candidate_pool
    WHERE user_id = @user_id
      AND status = 'dismissed'
      AND person_id IS NOT NULL
      AND external_id IS NOT NULL
    UNION
    -- Player-side deletes: requests.status='deleted'. Source-agnostic
    -- (share-sheet, follow, pick all count) — the act of deleting after
    -- arrival is the signal, regardless of how the video got into the feed.
    SELECT DISTINCT po.person_id, r.youtube_id AS video_id
    FROM requests r
    INNER JOIN person_outputs po
      ON po.external_id = r.youtube_channel_id
     AND po.output_type = 'youtube'
    WHERE r.user_id = @user_id
      AND r.status = 'deleted'
      AND r.youtube_channel_id IS NOT NULL
      AND r.youtube_id IS NOT NULL
      AND (@exclude_parent_picks = 0 OR r.source != 'parent_pick')
  ),
  dismissed AS (
    SELECT person_id, COUNT(*) AS n
    FROM dismissed_keys
    GROUP BY person_id
  )
  SELECT
    COALESCE(w.person_id, d.person_id) AS person_id,
    COALESCE(w.n, 0) AS watched_count,
    COALESCE(d.n, 0) AS dismissed_count
  FROM watched w
  FULL OUTER JOIN dismissed d ON d.person_id = w.person_id
  WHERE COALESCE(w.person_id, d.person_id) IS NOT NULL
`;

export function personAggregateParams(
  userId: string,
  opts: { excludeParentPicks: boolean },
): Record<string, string | number> {
  return {
    user_id: userId,
    watched_ratio: WATCHED_RATIO,
    watched_floor: WATCHED_TIME_FLOOR_S,
    exclude_parent_picks: opts.excludeParentPicks ? 1 : 0,
  };
}
