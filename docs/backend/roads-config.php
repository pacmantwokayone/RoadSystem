<?php
// Wiring points. Replace the two functions below with the game's own DB connection and auth.
// Both are SAFE BY DEFAULT: no database configured → 500, no editor check configured → 403.
declare(strict_types=1);

/** PDO connection for the road tables (see schema.mysql.sql). */
function roads_db(): PDO
{
    $dsn = getenv('ROADS_DB_DSN');          // e.g. 'mysql:host=localhost;dbname=userdata;charset=utf8mb4'
    if (!$dsn) {
        // TODO(integration): return the game's existing userdata PDO here instead.
        http_response_code(500);
        echo json_encode(['error' => 'roads: no database configured']);
        exit;
    }
    $pdo = new PDO($dsn, getenv('ROADS_DB_USER') ?: null, getenv('ROADS_DB_PASS') ?: null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    if (str_starts_with($dsn, 'sqlite:')) { // test convenience only: MySQL uses schema.mysql.sql
        $pdo->exec('PRAGMA busy_timeout = 5000');
        $pdo->exec('CREATE TABLE IF NOT EXISTS road_docs (scope TEXT PRIMARY KEY, revision INTEGER NOT NULL, doc TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL)');
        $pdo->exec('CREATE TABLE IF NOT EXISTS road_docs_history (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, revision INTEGER NOT NULL, doc TEXT NOT NULL, updated_by TEXT, created_at TEXT NOT NULL)');
    }
    return $pdo;
}

/**
 * Only editors/admins may write: profiles are EXECUTABLE CODE on every player's client.
 * Return a short user id for the history, or end the request with 403.
 */
function roads_require_editor(): string
{
    if (getenv('ROADS_ENV') === 'test' && getenv('ROADS_ALLOW_ALL') === '1') {
        return 'test';
    }
    // TODO(integration): check the game's session / admin flag here and return the user's id.
    http_response_code(403);
    echo json_encode(['error' => 'roads: editor rights required']);
    exit;
}
