-- Support the PATCH /agent-tasks text-protection guard (rest-api index.ts): add TEXT_REPLACED
-- to the agent_task_receipts.receipt_type allowed set so a forced title/body overwrite can
-- preserve the prior words verbatim in a receipt (mirrors the Ringer engine's guard). The
-- guard itself (refuse a destructive title/body PATCH unless allow_text_overwrite:true, then
-- receipt the prior text) lives in the rest-api code. Additive to the CHECK; rows unaffected.
-- Applied live via the Management API 2026-08-06.
ALTER TABLE public.agent_task_receipts DROP CONSTRAINT agent_task_receipts_receipt_type_check;
ALTER TABLE public.agent_task_receipts ADD CONSTRAINT agent_task_receipts_receipt_type_check
  CHECK (receipt_type = ANY (ARRAY['CLAIMED','DONE','BLOCKED','UNBLOCKED','HUMAN_HOLD',
    'HUMAN_ANSWERED','RESUMED','FAILED','APPLIED','FOLLOW_UP','TEXT_REPLACED']));
