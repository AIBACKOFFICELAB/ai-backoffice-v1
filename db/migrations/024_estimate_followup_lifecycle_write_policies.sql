-- Authenticated Estimate Follow-up lifecycle writes. No production data repair.
-- Preserve RLS and SELECT policies. No anonymous writes or general event writes.
-- Related rows must belong to the same tenant, not merely have a valid FK ID.
DROP POLICY IF EXISTS ef_sequences_insert_tenant ON public.estimate_followup_sequences;
CREATE POLICY ef_sequences_insert_tenant ON public.estimate_followup_sequences
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_tenant_member(tenant_id)
    AND EXISTS (SELECT 1 FROM public.leads l
                WHERE l.id = lead_id AND l.tenant_id = estimate_followup_sequences.tenant_id)
  );

DROP POLICY IF EXISTS ef_sequences_update_tenant ON public.estimate_followup_sequences;
CREATE POLICY ef_sequences_update_tenant ON public.estimate_followup_sequences
  FOR UPDATE TO authenticated
  USING (public.is_tenant_member(tenant_id))
  WITH CHECK (
    public.is_tenant_member(tenant_id)
    AND EXISTS (SELECT 1 FROM public.leads l
                WHERE l.id = lead_id AND l.tenant_id = estimate_followup_sequences.tenant_id)
  );

DROP POLICY IF EXISTS ef_history_insert_tenant ON public.estimate_followup_history;
CREATE POLICY ef_history_insert_tenant ON public.estimate_followup_history
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_tenant_member(tenant_id)
    AND EXISTS (SELECT 1 FROM public.estimate_followup_sequences s
                WHERE s.id = sequence_id
                  AND s.tenant_id = estimate_followup_history.tenant_id
                  AND s.lead_id = estimate_followup_history.lead_id)
  );
