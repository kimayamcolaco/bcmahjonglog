-- Run separately from schema.sql; existing analytics tables are unchanged.
CREATE TABLE IF NOT EXISTS public.mahjong_bookings (
    id text PRIMARY KEY,
    data jsonb NOT NULL,
    booking_date date NOT NULL,
    slot text GENERATED ALWAYS AS (data->>'slot') STORED NOT NULL,
    table_number integer GENERATED ALWAYS AS ((data->>'table')::integer) STORED NOT NULL,
    seat integer GENERATED ALWAYS AS ((data->>'seat')::integer) STORED NOT NULL,
    CONSTRAINT booking_id_matches CHECK (data->>'id' = id),
    CONSTRAINT booking_date_matches CHECK ((data->>'date')::date = booking_date),
    CONSTRAINT booking_slot_valid CHECK (slot IN ('Morning', 'Afternoon')),
    CONSTRAINT booking_table_valid CHECK (table_number BETWEEN 1 AND 9),
    CONSTRAINT booking_seat_valid CHECK (seat BETWEEN 1 AND 4),
    CONSTRAINT one_booking_per_seat UNIQUE (booking_date, slot, table_number, seat)
);

CREATE INDEX IF NOT EXISTS mahjong_bookings_date_idx ON public.mahjong_bookings (booking_date);
ALTER TABLE public.mahjong_bookings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mahjong_bookings FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mahjong_bookings TO service_role;

CREATE OR REPLACE FUNCTION public.apply_mahjong_booking_changes(p_before jsonb, p_after jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    old_booking jsonb;
BEGIN
    IF jsonb_typeof(p_before) IS DISTINCT FROM 'array'
        OR jsonb_typeof(p_after) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Booking changes must be arrays' USING ERRCODE = '23514';
    END IF;

    -- Serialize changes so seat, table-time, and set-limit checks remain atomic.
    PERFORM pg_advisory_xact_lock(721405);
    FOR old_booking IN SELECT value FROM jsonb_array_elements(p_before) LOOP
        IF NOT EXISTS (
            SELECT 1 FROM public.mahjong_bookings
            WHERE id = old_booking->>'id' AND data = old_booking
        ) THEN
            RAISE EXCEPTION 'Booking changed; refresh before retrying' USING ERRCODE = '40001';
        END IF;
    END LOOP;

    DELETE FROM public.mahjong_bookings
    WHERE id IN (SELECT value->>'id' FROM jsonb_array_elements(p_before));
    INSERT INTO public.mahjong_bookings (id, booking_date, data)
    SELECT value->>'id', (value->>'date')::date, value FROM jsonb_array_elements(p_after);

    IF EXISTS (
        SELECT 1 FROM public.mahjong_bookings b
        WHERE (booking_date, slot, table_number) IN (
            SELECT (value->>'date')::date, value->>'slot', (value->>'table')::integer
            FROM jsonb_array_elements(p_after)
        )
        GROUP BY booking_date, slot, table_number
        HAVING count(DISTINCT data->>'timeStart') > 1
            OR count(DISTINCT data->>'gameType') > 1
    ) THEN
        RAISE EXCEPTION 'Table start time and Mahjong type must match' USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.mahjong_bookings b
        WHERE (booking_date, slot) IN (
            SELECT (value->>'date')::date, value->>'slot'
            FROM jsonb_array_elements(p_after)
        ) AND (data->>'needSet')::boolean
        GROUP BY booking_date, slot
        HAVING count(DISTINCT table_number) > 4
    ) THEN
        RAISE EXCEPTION 'All four Club Sets are already claimed' USING ERRCODE = '23514';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_mahjong_booking_changes(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_mahjong_booking_changes(jsonb, jsonb) TO service_role;
