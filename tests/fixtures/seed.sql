-- AI Kit test fixture: a small, fully hand-computed week of AI activity (all inside the last 7 days).
-- Expected answers are asserted in tests/run.sh; change a number here → change it there.
CREATE TABLE IF NOT EXISTS orders (id uuid PRIMARY KEY, total_cents integer NOT NULL);
INSERT INTO orders VALUES ('00000000-0000-0000-0000-00000000000a', 5000);

INSERT INTO ai_conversations (id, channel, visitor_id, status, intent, outcome, attributed_order_id, turns, started_at, last_at) VALUES
 ('00000000-0000-0000-0000-0000000000c1', 'web', 'fp-1', 'resolved', 'order_status',   'resolved_by_ai', NULL, 2, now() - interval '2 days', now() - interval '2 days'),
 ('00000000-0000-0000-0000-0000000000c2', 'web', 'fp-2', 'handoff',  'complaint',      'handed_off',     NULL, 4, now() - interval '2 days', now() - interval '2 days'),
 ('00000000-0000-0000-0000-0000000000c3', 'web', 'fp-3', 'resolved', 'address_change', 'action_done',    '00000000-0000-0000-0000-00000000000a', 3, now() - interval '1 day', now() - interval '1 day'),
 ('00000000-0000-0000-0000-0000000000c4', 'sms', NULL,   'resolved', 'order_status',   'resolved_by_ai', NULL, 1, now() - interval '1 day', now() - interval '1 day');

-- c1 has TWO thumbs + a CSAT (a join that doesn't pre-aggregate feedback would count c1 three times)
INSERT INTO ai_feedback (conversation_id, rating, kind) VALUES
 ('00000000-0000-0000-0000-0000000000c1', 5, 'csat'), ('00000000-0000-0000-0000-0000000000c1', 1, 'thumbs'),
 ('00000000-0000-0000-0000-0000000000c1', 1, 'thumbs'), ('00000000-0000-0000-0000-0000000000c2', -1, 'thumbs');

-- conversation spend: 10k + 10k + 20k + 30k + 10k = 80,000 µ$ ; automation spend: 5k + 5k + 5k = 15,000 µ$
INSERT INTO ai_calls (task, ref, provider, model_id, served_by, conversation_id, channel, input_tokens, output_tokens, cost_micros, latency_ms, steps, tool_calls, finish_reason, created_at) VALUES
 ('chat', 'anthropic:m1', 'anthropic', 'm1', 'openrouter', '00000000-0000-0000-0000-0000000000c1', 'web', 100, 50, 10000, 900, 1, 0, 'stop', now() - interval '2 days'),
 ('chat', 'anthropic:m1', 'anthropic', 'm1', 'openrouter', '00000000-0000-0000-0000-0000000000c1', 'web', 100, 50, 10000, 1100, 1, 0, 'stop', now() - interval '2 days'),
 ('chat', 'anthropic:m1', 'anthropic', 'm1', 'openrouter', '00000000-0000-0000-0000-0000000000c2', 'web', 200, 90, 20000, 1500, 2, 1, 'stop', now() - interval '2 days'),
 ('chat', 'anthropic:m1', 'anthropic', 'm1', 'openrouter', '00000000-0000-0000-0000-0000000000c3', 'web', 300, 80, 30000, 2000, 3, 2, 'stop', now() - interval '1 day'),
 ('channel_reply', 'openai:m2', 'openai', 'm2', 'native', '00000000-0000-0000-0000-0000000000c4', 'sms', 80, 20, 10000, 700, 1, 1, 'stop', now() - interval '1 day'),
 ('guard', 'guard:preflight', 'guard', 'preflight', 'guard', NULL, 'web', NULL, NULL, NULL, 1, 0, 0, 'identity',  now() - interval '1 day'),
 ('guard', 'guard:preflight', 'guard', 'preflight', 'guard', NULL, 'web', NULL, NULL, NULL, 1, 0, 0, 'identity',  now() - interval '1 day'),
 ('guard', 'guard:preflight', 'guard', 'preflight', 'guard', NULL, 'sms', NULL, NULL, NULL, 1, 0, 0, 'off_topic', now() - interval '1 day');

INSERT INTO ai_actions (conversation_id, action, actor_kind, channel, input, status, correlation_id, created_at) VALUES
 ('00000000-0000-0000-0000-0000000000c3', 'update_shipping_address', 'customer', 'web', '{}', 'proposed', 'k1', now() - interval '1 day'),
 ('00000000-0000-0000-0000-0000000000c3', 'update_shipping_address', 'customer', 'web', '{}', 'executed', 'k1', now() - interval '1 day'),
 ('00000000-0000-0000-0000-0000000000c2', 'update_shipping_address', 'customer', 'web', '{}', 'proposed', 'k2', now() - interval '2 days');

-- vip-tag: two live runs with 1 action each (equal counts — sum(DISTINCT) would say 1) + one dry run
INSERT INTO ai_automation_runs (id, automation_id, event_id, status, actions, started_at, ended_at) VALUES
 ('00000000-0000-0000-0000-0000000000a1', 'vip-tag', 'e1', 'done',    1, now() - interval '1 day', now() - interval '1 day' + interval '4 seconds'),
 ('00000000-0000-0000-0000-0000000000a2', 'vip-tag', 'e2', 'done',    1, now() - interval '1 day', now() - interval '1 day' + interval '6 seconds'),
 ('00000000-0000-0000-0000-0000000000a3', 'vip-tag', 'e3', 'dry_run', 0, now() - interval '1 day', now() - interval '1 day' + interval '2 seconds');
-- typed decisions (purpose set, no conversation: never a turn, never in cost per resolution)
INSERT INTO ai_calls (task, purpose, ref, provider, model_id, served_by, channel, input_tokens, output_tokens, cost_micros, latency_ms, steps, tool_calls, finish_reason, error, created_at) VALUES
 ('decide', 'guard',  'typesafe-ai:jev-1.13.0', 'typesafe-ai', 'jev-1.13.0', 'native', 'web',   60, 0,   5, 100, 0, 0, 'decision', NULL, now() - interval '1 day'),
 ('decide', 'guard',  'typesafe-ai:jev-1.13.0', 'typesafe-ai', 'jev-1.13.0', 'native', 'web',   60, 0,   5, 300, 0, 0, 'decision', NULL, now() - interval '1 day'),
 ('decide', 'guard',  'openai:mini',            'openai',      'mini',       'native', 'web',   60, 5, 100, 900, 0, 0, 'fallback', NULL, now() - interval '1 day'),
 ('decide', 'triage', 'typesafe-ai:jev-1.13.0', 'typesafe-ai', 'jev-1.13.0', 'native', 'email', NULL, NULL, NULL, 50, 0, 0, 'error', 'APICallError: 503', now() - interval '1 day');

INSERT INTO ai_calls (task, ref, provider, model_id, served_by, automation_run_id, channel, cost_micros, latency_ms, steps, tool_calls, created_at) VALUES
 ('automation', 'openai:m3', 'openai', 'm3', 'native', '00000000-0000-0000-0000-0000000000a1', 'automation', 5000, 1200, 2, 1, now() - interval '1 day'),
 ('automation', 'openai:m3', 'openai', 'm3', 'native', '00000000-0000-0000-0000-0000000000a1', 'automation', 5000, 1300, 1, 0, now() - interval '1 day'),
 ('automation', 'openai:m3', 'openai', 'm3', 'native', '00000000-0000-0000-0000-0000000000a2', 'automation', 5000, 1100, 2, 1, now() - interval '1 day');
