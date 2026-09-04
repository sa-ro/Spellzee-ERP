-- 0005_identity_match.sql
-- Identity Match and Merge Event -- DD §7, Master §6.4.
--
-- DD §7 specifies:
--   Identity Match : candidate records, match signals, confidence, decision, reviewer
--   Merge Event    : source student, target student, reason, approver, date
--
-- Both are retained permanently. A "not a duplicate" decision is itself evidence:
-- it explains why two similar students legitimately coexist.

BEGIN;

CREATE TABLE identity_match (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What the user was trying to create, exactly as submitted. JSONB because the
  -- record does not exist yet and may never exist.
  attempted_record   jsonb NOT NULL,

  -- Denormalised search terms actually used, so a past decision stays explicable
  -- even after the matching algorithm changes.
  search_name        text,
  search_phones      text[] NOT NULL DEFAULT '{}',
  search_emails      text[] NOT NULL DEFAULT '{}',

  candidate_count    integer NOT NULL DEFAULT 0,
  -- [{ studentId, publicId, score, band, signals: [...] }, ...] ordered by score desc.
  candidates         jsonb  NOT NULL DEFAULT '[]'::jsonb,

  top_candidate_student_id uuid REFERENCES student(id),
  top_score          numeric(5,4),
  band               text NOT NULL,

  decision           text,
  decision_reason    text,
  decided_student_id uuid REFERENCES student(id),
  decided_by         uuid REFERENCES user_account(id),
  decided_at         timestamptz,

  -- rule 28 / DD §27 -- the thresholds in force when this decision was made.
  matching_ruleset_version text NOT NULL,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES user_account(id),
  updated_by         uuid NOT NULL REFERENCES user_account(id),
  source             text NOT NULL DEFAULT 'ui',

  CONSTRAINT identity_match_band_valid CHECK (band IN ('clear','review','block')),
  CONSTRAINT identity_match_decision_valid CHECK (
    decision IS NULL OR decision IN ('created_new','used_existing','abandoned','blocked')
  ),
  CONSTRAINT identity_match_score_range CHECK (
    top_score IS NULL OR (top_score >= 0 AND top_score <= 1)
  ),
  -- A recorded decision must say who made it and when.
  CONSTRAINT identity_match_decision_attributed CHECK (
    decision IS NULL
    OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)
  ),
  -- Choosing an existing student must name that student.
  CONSTRAINT identity_match_used_existing_target CHECK (
    decision <> 'used_existing' OR decided_student_id IS NOT NULL
  ),
  -- Master §6.4: a high-confidence duplicate must not simply be created.
  -- Overriding a 'block' requires an approval, recorded as the reason.
  CONSTRAINT identity_match_block_not_silently_created CHECK (
    NOT (band = 'block' AND decision = 'created_new' AND decision_reason IS NULL)
  )
);

COMMENT ON TABLE identity_match IS
  'One row per attempted student creation that ran duplicate detection. DD §7, Master §6.4. '
  'Retained even when no duplicate was found -- the negative decision is audit evidence.';
COMMENT ON COLUMN identity_match.band IS
  'clear = create freely; review = show matches and require a choice; block = requires approval to override.';

CREATE INDEX identity_match_top_candidate_idx ON identity_match (top_candidate_student_id)
  WHERE top_candidate_student_id IS NOT NULL;
CREATE INDEX identity_match_undecided_idx ON identity_match (created_at DESC) WHERE decision IS NULL;
CREATE INDEX identity_match_band_idx ON identity_match (band, created_at DESC);

-- ---------------------------------------------------------------------------
-- merge_event -- DD §7
-- "Merges must preserve source records and redirect relationships safely." (DD §6.3)
-- ---------------------------------------------------------------------------
CREATE TABLE merge_event (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  source_student_id   uuid NOT NULL REFERENCES student(id),
  target_student_id   uuid NOT NULL REFERENCES student(id),

  reason              text NOT NULL,
  identity_match_id   uuid REFERENCES identity_match(id),

  -- Maker-checker (rule 22 / Master §22.4: merge = request by staff, approve by manager).
  requested_by        uuid NOT NULL REFERENCES user_account(id),
  approved_by         uuid NOT NULL REFERENCES user_account(id),
  approval_id         uuid,
  approved_at         timestamptz NOT NULL DEFAULT now(),

  -- Manifest of what moved, so the merge is reversible in principle and
  -- explicable in practice: { "enrollment": [...ids], "subscription": [...], ... }
  relationships_moved jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL REFERENCES user_account(id),
  updated_by          uuid NOT NULL REFERENCES user_account(id),
  source              text NOT NULL DEFAULT 'ui',

  CONSTRAINT merge_event_distinct_students CHECK (source_student_id <> target_student_id),
  -- rule 22 -- the requester cannot approve their own merge.
  CONSTRAINT merge_event_no_self_approval CHECK (requested_by <> approved_by)
);

COMMENT ON TABLE merge_event IS
  'Permanent record of a duplicate resolution. DD §7. The source student row is retained '
  'with status=merged and merged_into_student_id set -- never deleted (rule 4).';
COMMENT ON CONSTRAINT merge_event_no_self_approval ON merge_event IS
  'Maker-checker: rule 22, Master §22.3. Enforced in the database, not only the UI.';

CREATE INDEX merge_event_source_idx ON merge_event (source_student_id);
CREATE INDEX merge_event_target_idx ON merge_event (target_student_id);

-- A student that has already been merged away cannot be a merge target: merging
-- into a tombstone would silently strand the relationships being moved.
CREATE OR REPLACE FUNCTION guard_merge_target_is_live()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_target_status text;
BEGIN
  SELECT status INTO v_target_status FROM student WHERE id = NEW.target_student_id;
  IF v_target_status = 'merged' THEN
    RAISE EXCEPTION
      'Cannot merge into student % : it has itself been merged away. Merge into the surviving record.',
      NEW.target_student_id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_merge_event_target_live
  BEFORE INSERT ON merge_event
  FOR EACH ROW EXECUTE FUNCTION guard_merge_target_is_live();

COMMIT;
