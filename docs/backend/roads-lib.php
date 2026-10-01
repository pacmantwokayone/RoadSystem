<?php
declare(strict_types=1);

require_once __DIR__ . '/roads-config.php';

const ROADS_MAX_BYTES = 8 * 1024 * 1024;   // whole roads document
const ROADS_MAX_PROFILE_BYTES = 64 * 1024; // one profile source
const ROADS_HISTORY_KEEP = 50;             // versions kept per scope

function roads_respond(int $status, array $body): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function roads_valid_location(mixed $l): bool
{
    return is_string($l) && preg_match('/^[A-Za-z0-9_-]{1,64}$/', $l) === 1;
}

/** Optimistic-locking document store on PDO (MySQL in production, SQLite in tests). */
final class RoadDocs
{
    public function __construct(private PDO $db) {}

    /** @return array{doc: array, revision: int}|null */
    public function load(string $scope): ?array
    {
        $st = $this->db->prepare('SELECT revision, doc FROM road_docs WHERE scope = ?');
        $st->execute([$scope]);
        $row = $st->fetch();
        if (!$row) {
            return null;
        }
        $doc = json_decode((string)$row['doc'], true);
        return ['doc' => is_array($doc) ? $doc : [], 'revision' => (int)$row['revision']];
    }

    /**
     * Save `$doc` if the stored revision still equals `$base` (null = overwrite whatever is there).
     * @return array{ok: bool, conflict: bool, revision: int}
     */
    public function save(string $scope, array $doc, ?int $base, string $user): array
    {
        // Two writers racing can make the database refuse one of them (SQLite: "database is locked" when a
        // read lock cannot be upgraded; MySQL/InnoDB: deadlock 1213 / lock wait timeout 1205). The loser simply
        // retries: it then sees the new revision and reports a clean conflict instead of an error.
        for ($attempt = 1; ; $attempt++) {
            try {
                return $this->saveOnce($scope, $doc, $base, $user);
            } catch (PDOException $e) {
                if ($this->db->inTransaction()) {
                    $this->db->rollBack();
                }
                $code = (int)($e->errorInfo[1] ?? 0);
                $transient = str_contains($e->getMessage(), 'locked') || in_array($code, [1205, 1213], true);
                if (!$transient || $attempt >= 8) {
                    throw $e;
                }
                usleep(random_int(2000, 25000) * $attempt);
            }
        }
    }

    private function saveOnce(string $scope, array $doc, ?int $base, string $user): array
    {
        $json = json_encode($doc, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        $now = gmdate('Y-m-d H:i:s');
        $this->db->beginTransaction();
        try {
            $st = $this->db->prepare('SELECT revision FROM road_docs WHERE scope = ?');
            $st->execute([$scope]);
            $cur = $st->fetchColumn();

            if ($cur === false) {
                $next = 1;
                $this->db->prepare('INSERT INTO road_docs (scope, revision, doc, updated_by, updated_at) VALUES (?,?,?,?,?)')
                    ->execute([$scope, $next, $json, $user, $now]);
            } else {
                $cur = (int)$cur;
                if ($base !== null && $base !== $cur) {
                    $this->db->rollBack();
                    return ['ok' => false, 'conflict' => true, 'revision' => $cur];
                }
                $next = $cur + 1;
                // compare-and-swap: only succeeds while nobody else bumped the revision
                $up = $this->db->prepare('UPDATE road_docs SET revision = ?, doc = ?, updated_by = ?, updated_at = ? WHERE scope = ? AND revision = ?');
                $up->execute([$next, $json, $user, $now, $scope, $cur]);
                if ($up->rowCount() !== 1) {
                    $this->db->rollBack();
                    return ['ok' => false, 'conflict' => true, 'revision' => $this->currentRevision($scope)];
                }
            }

            $this->db->prepare('INSERT INTO road_docs_history (scope, revision, doc, updated_by, created_at) VALUES (?,?,?,?,?)')
                ->execute([$scope, $next, $json, $user, $now]);
            $this->db->prepare('DELETE FROM road_docs_history WHERE scope = ? AND revision <= ?')
                ->execute([$scope, $next - ROADS_HISTORY_KEEP]);
            $this->db->commit();
            return ['ok' => true, 'conflict' => false, 'revision' => $next];
        } catch (PDOException $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            // two first-saves racing: the loser hits the primary key → report as conflict
            if (in_array($e->getCode(), ['23000', '23505'], true)) {
                return ['ok' => false, 'conflict' => true, 'revision' => $this->currentRevision($scope)];
            }
            throw $e;
        }
    }

    private function currentRevision(string $scope): int
    {
        $st = $this->db->prepare('SELECT revision FROM road_docs WHERE scope = ?');
        $st->execute([$scope]);
        return (int)$st->fetchColumn();
    }
}

/** Parse the JSON request body (size-capped); ends the request with 400/413 on bad input. */
function roads_read_body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || strlen($raw) > ROADS_MAX_BYTES) {
        roads_respond(413, ['error' => 'body too large']);
    }
    $body = json_decode($raw, true);
    if (!is_array($body)) {
        roads_respond(400, ['error' => 'invalid json']);
    }
    return $body;
}

function roads_base_revision(array $body): ?int
{
    return (isset($body['baseRevision']) && is_int($body['baseRevision']) && $body['baseRevision'] >= 0) ? $body['baseRevision'] : null;
}
