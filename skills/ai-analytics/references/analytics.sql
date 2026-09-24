-- ai-analytics · dashboard queries (Postgres). :from / :to are timestamptz params; money is micro-dollars.
-- The admin AI console runs these; `ai-report` prints the same numbers in the terminal.

-- name: spend_by_task_model
SELECT task, ref, served_by, count(*) AS calls,
       sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
       round(sum(cost_micros) / 1e6, 4) AS usd,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms,
       round(100.0 * count(*) FILTER (WHERE error IS NOT NULL) / count(*), 2) AS error_pct
FROM ai_calls WHERE created_at >= :from AND created_at < :to
GROUP BY 1, 2, 3 ORDER BY usd DESC NULLS LAST;

-- name: spend_daily
SELECT date_trunc('day', created_at) AS day, task, round(sum(cost_micros) / 1e6, 4) AS usd, count(*) AS calls
FROM ai_calls WHERE created_at >= :from AND created_at < :to GROUP BY 1, 2 ORDER BY 1, 2;

-- name: conversations_by_channel  (volume, resolution, handoff, turns, CSAT — feedback pre-aggregated: one row per conversation)
WITH f AS (SELECT conversation_id, avg(rating) FILTER (WHERE kind = 'csat') AS csat,
                  count(*) FILTER (WHERE kind = 'thumbs' AND rating > 0) AS up, count(*) FILTER (WHERE kind = 'thumbs') AS thumbs
           FROM ai_feedback GROUP BY 1)
SELECT c.channel, count(*) AS conversations,
       round(100.0 * count(*) FILTER (WHERE outcome IN ('resolved_by_ai', 'action_done')) / nullif(count(*), 0), 1) AS ai_resolution_pct,
       round(100.0 * count(*) FILTER (WHERE outcome = 'handed_off') / nullif(count(*), 0), 1) AS handoff_pct,
       round(avg(turns), 1) AS avg_turns,
       round(avg(f.csat), 2) AS csat,
       round(100.0 * sum(f.up) / nullif(sum(f.thumbs), 0), 1) AS thumbs_up_pct
FROM ai_conversations c LEFT JOIN f ON f.conversation_id = c.id
WHERE c.started_at >= :from AND c.started_at < :to GROUP BY 1 ORDER BY 2 DESC;

-- name: top_intents
SELECT coalesce(intent, 'unlabeled') AS intent, count(*) AS n,
       round(100.0 * count(*) FILTER (WHERE outcome IN ('resolved_by_ai', 'action_done')) / count(*), 1) AS resolved_pct
FROM ai_conversations WHERE started_at >= :from AND started_at < :to GROUP BY 1 ORDER BY 2 DESC LIMIT 25;

-- name: actions  (what the bots DID, and how often customers accepted the confirm card)
SELECT action, channel,
       count(*) FILTER (WHERE status = 'proposed') AS proposed,
       count(*) FILTER (WHERE status = 'executed') AS executed,
       count(*) FILTER (WHERE status = 'failed') AS failed,
       round(100.0 * count(*) FILTER (WHERE status = 'executed') / nullif(count(*) FILTER (WHERE status = 'proposed'), 0), 1) AS acceptance_pct
FROM ai_actions WHERE created_at >= :from AND created_at < :to GROUP BY 1, 2 ORDER BY executed DESC;

-- name: ai_revenue  (orders credited to an AI conversation within the attribution window)
-- adjust `orders` / `total_cents` to the app's order table.
SELECT c.channel, count(o.id) AS orders, round(sum(o.total_cents) / 100.0, 2) AS revenue_usd,
       round(sum(o.total_cents) / 100.0 / nullif((SELECT sum(cost_micros) / 1e6 FROM ai_calls WHERE created_at >= :from AND created_at < :to), 0), 1) AS revenue_per_ai_dollar
FROM ai_conversations c JOIN orders o ON o.id = c.attributed_order_id
WHERE c.started_at >= :from AND c.started_at < :to GROUP BY 1;

-- name: cost_per_resolution
SELECT round((SELECT sum(cost_micros) FROM ai_calls WHERE created_at >= :from AND created_at < :to AND conversation_id IS NOT NULL) / 1e6
       / nullif((SELECT count(*) FROM ai_conversations WHERE started_at >= :from AND started_at < :to AND outcome IN ('resolved_by_ai', 'action_done')), 0), 4) AS usd_per_resolution;

-- name: automations  (cost per run from ai_calls — one writer; aggregated per run first so joins never double-count)
WITH r AS (SELECT * FROM ai_automation_runs WHERE started_at >= :from AND started_at < :to),
     c AS (SELECT automation_run_id, sum(cost_micros) AS micros FROM ai_calls WHERE automation_run_id IN (SELECT id FROM r) GROUP BY 1)
SELECT r.automation_id, count(*) AS runs, count(*) FILTER (WHERE r.status = 'failed') AS failed,
       count(*) FILTER (WHERE r.status = 'dry_run') AS dry_runs, sum(r.actions) AS actions,
       round(coalesce(sum(c.micros), 0) / 1e6, 4) AS usd,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.ended_at - r.started_at)) AS p50_sec
FROM r LEFT JOIN c ON c.automation_run_id = r.id GROUP BY 1 ORDER BY runs DESC;

-- name: guard  (identity probes / injections / off-topic stopped before the model — logged as task='guard')
SELECT finish_reason AS verdict, count(*) FROM ai_calls
WHERE task = 'guard' AND created_at >= :from AND created_at < :to GROUP BY 1;

-- name: decisions  (typed decisions — Jev or an LLM adapter: volume, fallback rate, latency, cost per purpose)
SELECT purpose, ref, count(*) AS calls,
       round(avg((finish_reason = 'fallback')::int)::numeric, 3) AS fallback_rate,
       round(avg((error IS NOT NULL)::int)::numeric, 3) AS error_rate,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50_ms,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms,
       round(coalesce(sum(cost_micros), 0) / 1e6, 6) AS usd
FROM ai_calls WHERE purpose IS NOT NULL AND created_at >= :from AND created_at < :to
GROUP BY 1, 2 ORDER BY calls DESC;

-- name: anomalies  (hour buckets where spend > 3× the trailing 7-day hourly mean — ml-lab alerts on this)
WITH h AS (SELECT date_trunc('hour', created_at) AS hr, sum(cost_micros) AS c FROM ai_calls WHERE created_at > now() - interval '8 days' GROUP BY 1)
SELECT hr, c / 1e6 AS usd, avg(c) OVER (ORDER BY hr ROWS BETWEEN 168 PRECEDING AND 1 PRECEDING) / 1e6 AS trailing_mean_usd
FROM h ORDER BY hr DESC LIMIT 48;
