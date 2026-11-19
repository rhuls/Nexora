-- The decision trail of a played hand: at each point, the cards held, what the solver valued every
-- available action at, what it recommended, and what was actually chosen. Nullable because hands
-- recorded before this existed have no trail, and simulated hands have no one choosing.
ALTER TABLE "BlackjackObservation" ADD COLUMN "decisions" JSONB;
