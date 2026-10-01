<?php
// GET  roadlib-save.php                       → { profiles, materials, bridges: { name: source }, revision }   (public)
// POST roadlib-save.php { profiles, materials?, bridges?, baseRevision? }                                     (editors only)
// The sources are EXECUTABLE JAVASCRIPT on every client: writes are editor-only (see roads-config.php).
declare(strict_types=1);

require_once __DIR__ . '/roads-lib.php';

$docs = new RoadDocs(roads_db());

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $row = $docs->load('library');
    if ($row === null) {
        roads_respond(404, ['error' => 'not found']);
    }
    roads_respond(200, ['profiles' => (object)($row['doc']['profiles'] ?? []), 'materials' => (object)($row['doc']['materials'] ?? []), 'bridges' => (object)($row['doc']['bridges'] ?? []), 'revision' => $row['revision']]);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $user = roads_require_editor();
    $body = roads_read_body();
    $profiles = $body['profiles'] ?? null;
    if (!is_array($profiles)) {
        roads_respond(400, ['error' => 'profiles must be an object']);
    }
    foreach ($profiles as $name => $src) {
        if (!is_string($name) || preg_match('/^[A-Za-z][A-Za-z0-9_-]{0,63}$/', $name) !== 1) {
            roads_respond(400, ['error' => 'invalid profile name']);
        }
        if (!is_string($src) || strlen($src) > ROADS_MAX_PROFILE_BYTES) {
            roads_respond(400, ['error' => "profile '$name': source missing or too large"]);
        }
    }
    $materials = $body['materials'] ?? [];
    if (!is_array($materials)) {
        roads_respond(400, ['error' => 'materials must be an object']);
    }
    foreach ($materials as $name => $src) {
        if (!is_string($name) || preg_match('/^[A-Za-z][A-Za-z0-9_-]{0,63}$/', $name) !== 1) {
            roads_respond(400, ['error' => 'invalid material name']);
        }
        if (!is_string($src) || strlen($src) > ROADS_MAX_PROFILE_BYTES) {
            roads_respond(400, ['error' => "material '$name': source missing or too large"]);
        }
    }
    $bridges = $body['bridges'] ?? [];
    if (!is_array($bridges)) {
        roads_respond(400, ['error' => 'bridges must be an object']);
    }
    foreach ($bridges as $name => $src) {
        if (!is_string($name) || preg_match('/^[A-Za-z][A-Za-z0-9_-]{0,63}$/', $name) !== 1) {
            roads_respond(400, ['error' => 'invalid bridge name']);
        }
        if (!is_string($src) || strlen($src) > ROADS_MAX_PROFILE_BYTES) {
            roads_respond(400, ['error' => "bridge '$name': source missing or too large"]);
        }
    }
    $res = $docs->save('library', ['profiles' => (object)$profiles, 'materials' => (object)$materials, 'bridges' => (object)$bridges], roads_base_revision($body), $user);
    if ($res['conflict']) {
        roads_respond(409, ['ok' => false, 'conflict' => true, 'revision' => $res['revision']]);
    }
    roads_respond(200, ['ok' => true, 'revision' => $res['revision']]);
}

roads_respond(405, ['error' => 'method not allowed']);
