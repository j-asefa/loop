-- A follow-up review is run by the lead alone against an earlier review of the
-- same change. A review without a row here, including every review recorded by
-- earlier releases, is a full review. Kept out of code_reviews so status reads
-- never walk past its large snapshot column.
CREATE TABLE review_follow_ups (
  review_id TEXT PRIMARY KEY REFERENCES code_reviews(id),
  owner_id TEXT NOT NULL,
  previous_review_id TEXT NOT NULL REFERENCES code_reviews(id)
);
