-- RoadSystem persistence (MySQL / InnoDB). One row per document:
--   scope = 'roads:<location>'  → the road network of one location
--   scope = 'library'           → profile / bridge / material source code (shared by all locations)
-- `revision` is the optimistic-locking counter: a save names the revision it was based on and
-- only succeeds if the row is still at that revision.

CREATE TABLE IF NOT EXISTS road_docs (
  scope       VARCHAR(80)  NOT NULL,
  revision    INT UNSIGNED NOT NULL,
  doc         LONGTEXT     NOT NULL,
  updated_by  VARCHAR(64)  NULL,
  updated_at  DATETIME     NOT NULL,
  PRIMARY KEY (scope)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- every successful save, so any version can be restored
CREATE TABLE IF NOT EXISTS road_docs_history (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope       VARCHAR(80)  NOT NULL,
  revision    INT UNSIGNED NOT NULL,
  doc         LONGTEXT     NOT NULL,
  updated_by  VARCHAR(64)  NULL,
  created_at  DATETIME     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_scope_rev (scope, revision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
