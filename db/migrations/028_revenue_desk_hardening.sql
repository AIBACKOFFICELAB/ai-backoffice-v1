-- AIBO-RD-H001 PROPOSAL. Local disposable DB validation only.
-- Depends on 001-027, including canonical intake provenance and lease RPC.
-- Do not apply to hosted Preview/Production until M006 reconciliation and
-- separate Founder migration/integration approval. No credentials or routing.
BEGIN;

-- The old implementation could finalize an ambiguous write/cleanup as failed.
-- Do not silently treat historical rows as safe-to-retry or reopen unique
-- guards. Integration requires independent review if any such rows exist.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.revenue_desk_bookings WHERE status='failed'
    AND failure_category IN ('PROVIDER_ERROR','CONFLICT_CLEANUP_FAILED')) THEN
    RAISE EXCEPTION 'H001 requires review of legacy ambiguous bookings before migration';
  END IF;
END $$;

ALTER TABLE public.revenue_desk_calls
  ADD COLUMN intake_revision integer NOT NULL DEFAULT 0 CHECK (intake_revision >= 0),
  ADD COLUMN intake_digest text,
  ADD COLUMN intake_lead_snapshot jsonb,
  ADD COLUMN transfer_final boolean NOT NULL DEFAULT false,
  ADD COLUMN transfer_evidence text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.revenue_desk_calls DROP CONSTRAINT revenue_desk_calls_escalation_result_check;
ALTER TABLE public.revenue_desk_calls ADD CONSTRAINT revenue_desk_calls_escalation_result_check
  CHECK (escalation_result IN ('requested','initiated','transferred','transfer_failed','unknown','not_required'));

CREATE TABLE public.revenue_desk_intake_receipts (
  tenant_id uuid NOT NULL,
  call_id uuid NOT NULL,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 100),
  payload_digest text NOT NULL,
  revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, call_id, request_id),
  FOREIGN KEY (call_id, tenant_id) REFERENCES public.revenue_desk_calls(id, tenant_id) ON DELETE CASCADE
);
ALTER TABLE public.revenue_desk_intake_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY rd_intake_receipts_read ON public.revenue_desk_intake_receipts
  FOR SELECT USING (public.is_tenant_member(tenant_id));

-- Canonical validation runs in createCanonicalLeadFromIntake before this
-- service-only transaction. A call lock serializes corrections; a revision
-- check refuses stale writers. Receipts refuse old/rebound tool IDs even when
-- their webhook arrives after a newer correction. Lead lifecycle columns are
-- deliberately absent from UPDATE. No general website/manual upsert is added.
CREATE FUNCTION public.revenue_desk_save_intake(
  p_tenant_id uuid, p_call_id uuid, p_expected_revision integer, p_request_id text,
  p_lead jsonb, p_intake jsonb, p_priority text, p_signals text[], p_category text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  c public.revenue_desk_calls;
  l public.leads;
  receipt public.revenue_desk_intake_receipts;
  digest text;
  unchanged boolean;
  lead_snapshot jsonb;
BEGIN
  IF p_lead->>'source' IS DISTINCT FROM 'voice_receptionist'
    OR p_lead->>'source_ref' IS DISTINCT FROM p_call_id::text
    OR p_request_id IS NULL OR length(p_request_id) NOT BETWEEN 1 AND 100
    OR p_expected_revision IS NULL OR p_intake IS NULL THEN
    RAISE EXCEPTION 'invalid intake binding';
  END IF;
  SELECT * INTO STRICT c FROM public.revenue_desk_calls
    WHERE tenant_id=p_tenant_id AND id=p_call_id FOR UPDATE;
  digest := encode(sha256(convert_to(jsonb_build_object(
    'lead', p_lead - ARRAY['id','date','received_at','created_at','updated_at'],
    'intake', p_intake, 'priority', p_priority, 'signals', p_signals, 'category', p_category)::text, 'UTF8')), 'hex');
  SELECT * INTO receipt FROM public.revenue_desk_intake_receipts
    WHERE tenant_id=p_tenant_id AND call_id=p_call_id AND request_id=p_request_id;
  IF FOUND AND (receipt.payload_digest <> digest OR receipt.revision <> c.intake_revision) THEN
    RAISE EXCEPTION 'superseded or rebound intake replay';
  END IF;
  unchanged := c.intake_digest = digest;
  IF NOT coalesce(unchanged, false) AND c.intake_revision <> p_expected_revision THEN
    RAISE EXCEPTION 'stale intake revision';
  END IF;
  SELECT * INTO l FROM public.leads WHERE tenant_id=p_tenant_id
    AND source='voice_receptionist' AND source_ref=p_call_id::text FOR UPDATE;
  IF c.lead_id IS NOT NULL AND (l.id IS NULL OR c.lead_id <> l.id) THEN
    RAISE EXCEPTION 'lead provenance mismatch';
  END IF;
  -- Compare only fields owned by voice intake, not lifecycle/owner notes.
  -- Hold the lead lock through acknowledgement so an owner edit cannot race
  -- this check. Legacy rows lack an accepted snapshot: do not invent one from
  -- potentially divergent data or overwrite an owner's correction.
  IF l.id IS NOT NULL THEN
    lead_snapshot := jsonb_build_array(l.customer_name,l.phone,l.service_address,
      l.service_type,l.emergency,l.urgency,l.job_description,
      l.preferred_appointment_time,l.customer_notes);
    IF c.intake_lead_snapshot IS DISTINCT FROM lead_snapshot THEN
      RAISE EXCEPTION 'canonical intake drift or unverified legacy intake';
    END IF;
  ELSIF c.intake_lead_snapshot IS NOT NULL OR c.intake_revision <> 0 THEN
    RAISE EXCEPTION 'accepted intake lead missing';
  END IF;
  IF l.id IS NULL THEN
    INSERT INTO public.leads (id, tenant_id, date, customer_name, phone, email,
      service_address, property_type, service_type, emergency, urgency, job_description,
      photos_uploaded, preferred_appointment_time, customer_role, lead_source,
      customer_notes, status, estimate_amount, follow_up_date, review_request_status,
      internal_notes, source, source_ref, intake_schema_version, received_at)
    VALUES (p_lead->>'id', p_tenant_id, (p_lead->>'date')::timestamptz,
      p_lead->>'customer_name',p_lead->>'phone',p_lead->>'email',p_lead->>'service_address',
      p_lead->>'property_type',p_lead->>'service_type',p_lead->>'emergency',p_lead->>'urgency',
      p_lead->>'job_description','No',p_lead->>'preferred_appointment_time',
      p_lead->>'customer_role',p_lead->>'lead_source',p_lead->>'customer_notes',
      'New',0,'','Not Ready','','voice_receptionist',p_call_id::text,1,now()) RETURNING * INTO l;
  ELSIF NOT coalesce(unchanged, false) THEN
    UPDATE public.leads SET customer_name=p_lead->>'customer_name', phone=p_lead->>'phone',
      service_address=p_lead->>'service_address',service_type=p_lead->>'service_type',
      emergency=p_lead->>'emergency',urgency=p_lead->>'urgency',job_description=p_lead->>'job_description',
      preferred_appointment_time=p_lead->>'preferred_appointment_time',customer_notes=p_lead->>'customer_notes',
      updated_at=now()
      WHERE tenant_id=p_tenant_id AND id=l.id RETURNING * INTO l;
  END IF;
  IF NOT coalesce(unchanged, false) THEN
    UPDATE public.revenue_desk_calls SET lead_id=l.id, intake=p_intake,
      intake_revision=intake_revision+1, intake_digest=digest, priority=p_priority,
      intake_lead_snapshot=jsonb_build_array(l.customer_name,l.phone,l.service_address,
        l.service_type,l.emergency,l.urgency,l.job_description,
        l.preferred_appointment_time,l.customer_notes),
      urgency_signals=p_signals, service_category=p_category, updated_at=now(),
      status=CASE WHEN status IN ('in_progress','intake_captured') THEN 'intake_captured' ELSE status END
      WHERE tenant_id=p_tenant_id AND id=p_call_id RETURNING * INTO c;
  END IF;
  INSERT INTO public.revenue_desk_intake_receipts(tenant_id,call_id,request_id,payload_digest,revision)
    VALUES(p_tenant_id,p_call_id,p_request_id,digest,c.intake_revision) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('call',to_jsonb(c),'lead',to_jsonb(l),'deduped',coalesce(unchanged,false));
END;
$$;

-- Explicit evidence mapping agrees with transfer.ts. Generic call-end or
-- transfer-update never establishes forwarding or a human answer.
CREATE FUNCTION public.revenue_desk_transfer_observation(reason text) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=public AS $$
  SELECT CASE reason
    WHEN 'assistant-forwarded-call' THEN 'transferred'
    WHEN 'call.in-progress.error-transfer-failed' THEN 'transfer_failed'
    WHEN 'customer-ended-call-during-transfer' THEN 'interrupted'
    ELSE NULL END;
$$;

-- Historical outcomes came from a regex; only explicit end evidence can
-- substantiate them. Freeze ended calls even when their old status is booked
-- or escalated. Preserve unsupported old assertions as unverified, not success.
UPDATE public.revenue_desk_calls SET
  transfer_final=(ended_at IS NOT NULL OR ended_reason IS NOT NULL OR status IN ('completed','failed')
    OR coalesce(escalation_result IN ('transferred','transfer_failed'),false)),
  transfer_evidence=CASE
    WHEN public.revenue_desk_transfer_observation(ended_reason) IS NOT NULL
      THEN ARRAY[public.revenue_desk_transfer_observation(ended_reason)]
    WHEN escalation_result IN ('transferred','transfer_failed') THEN ARRAY['unverified_' || escalation_result]
    WHEN escalation_result='requested' THEN ARRAY['requested']
    ELSE ARRAY[]::text[] END;

-- A set of observations makes concurrent/reordered delivery commutative.
-- Never remove evidence: conflicting terminal observations stay unknown.
CREATE FUNCTION public.revenue_desk_transfer_result(evidence text[], final boolean) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=public AS $$
  SELECT CASE
    WHEN evidence && ARRAY['interrupted','unverified_transferred','unverified_transfer_failed']
      OR evidence @> ARRAY['transferred','transfer_failed'] THEN 'unknown'
    WHEN 'transferred'=ANY(evidence) THEN 'transferred'
    WHEN 'transfer_failed'=ANY(evidence) THEN 'transfer_failed'
    WHEN final THEN CASE WHEN cardinality(evidence)>0 THEN 'unknown' ELSE NULL END
    WHEN 'initiated'=ANY(evidence) THEN 'initiated'
    WHEN 'requested'=ANY(evidence) THEN 'requested'
    ELSE NULL END;
$$;
UPDATE public.revenue_desk_calls SET escalation_result=
  public.revenue_desk_transfer_result(transfer_evidence,transfer_final);

CREATE FUNCTION public.revenue_desk_transfer_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE
  observation text;
BEGIN
  NEW.transfer_final := OLD.transfer_final OR NEW.transfer_final;
  -- Ignore a supplied evidence array; observations enter via the existing
  -- service-only call-update boundary. Keep the database's durable prior set.
  NEW.transfer_evidence := OLD.transfer_evidence;
  IF NEW.escalation_result IN ('requested','initiated') THEN
    observation := NEW.escalation_result;
  ELSIF NEW.transfer_final THEN
    observation := public.revenue_desk_transfer_observation(NEW.ended_reason);
  END IF;
  IF observation IS NOT NULL THEN
    SELECT array_agg(DISTINCT e ORDER BY e) INTO NEW.transfer_evidence
      FROM unnest(OLD.transfer_evidence || ARRAY[observation]) AS e;
  END IF;
  NEW.escalation_result := public.revenue_desk_transfer_result(NEW.transfer_evidence,NEW.transfer_final);
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_rd_transfer_transition BEFORE UPDATE ON public.revenue_desk_calls
  FOR EACH ROW EXECUTE FUNCTION public.revenue_desk_transfer_transition();

-- Fence old workers after lease takeover. Expiry grants reconciliation only.
ALTER TABLE public.revenue_desk_bookings ADD COLUMN lease_token uuid NOT NULL DEFAULT gen_random_uuid();
CREATE OR REPLACE FUNCTION public.revenue_desk_claim_booking_lease(p_tenant_id uuid, p_booking_id uuid, p_lease_seconds integer)
RETURNS SETOF public.revenue_desk_bookings LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=public AS $$
  UPDATE public.revenue_desk_bookings SET updated_at=now(), lease_token=gen_random_uuid()
  WHERE tenant_id=p_tenant_id AND id=p_booking_id AND status='pending'
    AND p_lease_seconds BETWEEN 1 AND 3600
    AND updated_at <= now()-make_interval(secs=>p_lease_seconds) RETURNING *;
$$;

-- The booking row is authoritative. Owner reconciliation must update the
-- call summary in the SAME transaction, including after a voice worker died.
-- Keep any promised callback reason until an owner has actually handled it.
CREATE FUNCTION public.revenue_desk_confirmed_booking_call() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  IF NEW.status='confirmed' AND OLD.status IS DISTINCT FROM 'confirmed' THEN
    UPDATE public.revenue_desk_calls SET status='booked',booking_outcome='confirmed',updated_at=now()
      WHERE tenant_id=NEW.tenant_id AND id=NEW.call_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_rd_confirmed_booking_call AFTER UPDATE ON public.revenue_desk_bookings
  FOR EACH ROW EXECUTE FUNCTION public.revenue_desk_confirmed_booking_call();

REVOKE ALL ON FUNCTION public.revenue_desk_save_intake(uuid,uuid,integer,text,jsonb,jsonb,text,text[],text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.revenue_desk_save_intake(uuid,uuid,integer,text,jsonb,jsonb,text,text[],text) TO service_role,postgres;
REVOKE ALL ON FUNCTION public.revenue_desk_transfer_transition() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.revenue_desk_transfer_observation(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.revenue_desk_transfer_result(text[],boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.revenue_desk_transfer_observation(text), public.revenue_desk_transfer_result(text[],boolean) TO service_role,postgres;
REVOKE ALL ON FUNCTION public.revenue_desk_confirmed_booking_call() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.revenue_desk_claim_booking_lease(uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.revenue_desk_claim_booking_lease(uuid,uuid,integer) TO service_role,postgres;
NOTIFY pgrst, 'reload schema';
COMMIT;
