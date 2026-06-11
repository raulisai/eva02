-- 024_fix_billing_stats_rpc.sql
-- Fix get_billing_stats RPC function by using jsonb_agg instead of json_agg.

CREATE OR REPLACE FUNCTION public.get_billing_stats(p_org_id UUID)
RETURNS JSONB AS $$
DECLARE
  v_summary JSONB;
  v_by_model JSONB;
  v_by_type JSONB;
  v_by_day JSONB;
BEGIN
  -- 1. Summary card values
  SELECT json_build_object(
    'total_cost_usd', COALESCE(SUM(cost_usd), 0),
    'total_tokens', COALESCE(SUM(total_tokens), 0),
    'prompt_tokens', COALESCE(SUM(prompt_tokens), 0),
    'completion_tokens', COALESCE(SUM(completion_tokens), 0),
    'total_requests', COUNT(*)
  )::jsonb INTO v_summary
  FROM token_logs
  WHERE org_id = p_org_id;

  -- 2. Tokens/Cost by Model
  SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v_by_model
  FROM (
    SELECT
      model,
      COUNT(*) as request_count,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(cost_usd), 0) as cost_usd
    FROM token_logs
    WHERE org_id = p_org_id
    GROUP BY model
    ORDER BY cost_usd DESC
  ) t;

  -- 3. Tokens/Cost by Request Type
  SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v_by_type
  FROM (
    SELECT
      request_type,
      COUNT(*) as request_count,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(cost_usd), 0) as cost_usd
    FROM token_logs
    WHERE org_id = p_org_id
    GROUP BY request_type
    ORDER BY cost_usd DESC
  ) t;

  -- 4. Daily spent for the last 30 days (inclusive of today)
  SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v_by_day
  FROM (
    SELECT
      created_at::date::text as date,
      COALESCE(SUM(total_tokens), 0) as total_tokens,
      COALESCE(SUM(cost_usd), 0) as cost_usd
    FROM token_logs
    WHERE org_id = p_org_id AND created_at >= CURRENT_DATE - INTERVAL '29 days'
    GROUP BY created_at::date
    ORDER BY date ASC
  ) t;

  RETURN json_build_object(
    'summary', v_summary,
    'by_model', v_by_model,
    'by_type', v_by_type,
    'by_day', v_by_day
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.get_billing_stats(UUID) TO authenticated;
