<?php
// GET  roads-save.php?location=<loc>            → { roads: [...], nodes: [...], rivers: [...], lakes: [...], revision }   (public, players load this)
// POST roads-save.php { location, roads, nodes?, rivers?, lakes?, baseRevision? }                              (editors only)
//        200 { ok: true, revision }   409 { ok: false, conflict: true, revision } 4xx/5xx { error }
// Same idiom as rivers-save.php: whole-document replace, one document per location.
declare(strict_types=1);

require_once __DIR__ . '/roads-lib.php';

$docs = new RoadDocs(roads_db());

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $loc = $_GET['location'] ?? '';
    if (!roads_valid_location($loc)) {
        roads_respond(400, ['error' => 'invalid location']);
    }
    $row = $docs->load("roads:$loc");
    if ($row === null) {
        roads_respond(404, ['error' => 'not found']);
    }
    roads_respond(200, ['roads' => $row['doc']['roads'] ?? [], 'nodes' => $row['doc']['nodes'] ?? [], 'rivers' => $row['doc']['rivers'] ?? [], 'lakes' => $row['doc']['lakes'] ?? [], 'revision' => $row['revision']]);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $user = roads_require_editor();
    $body = roads_read_body();
    $loc = $body['location'] ?? '';
    if (!roads_valid_location($loc)) {
        roads_respond(400, ['error' => 'invalid location']);
    }
    $roads = $body['roads'] ?? null;
    if (!is_array($roads) || !array_is_list($roads)) {
        roads_respond(400, ['error' => 'roads must be a list']);
    }
    foreach ($roads as $r) {
        if (!is_array($r) || !isset($r['id'], $r['points']) || !is_string($r['id']) || !is_array($r['points'])) {
            roads_respond(400, ['error' => 'each road needs id (string) and points (array)']);
        }
    }
    $nodes = $body['nodes'] ?? [];
    if (!is_array($nodes) || !array_is_list($nodes)) {
        roads_respond(400, ['error' => 'nodes must be a list']);
    }
    foreach ($nodes as $n) {
        if (!is_array($n) || !isset($n['id'], $n['x'], $n['y'], $n['z']) || !is_string($n['id'])
            || !is_numeric($n['x']) || !is_numeric($n['y']) || !is_numeric($n['z'])) {
            roads_respond(400, ['error' => 'each node needs id (string) and numeric x, y, z']);
        }
    }
    $rivers = $body['rivers'] ?? [];
    if (!is_array($rivers) || !array_is_list($rivers)) {
        roads_respond(400, ['error' => 'rivers must be a list']);
    }
    foreach ($rivers as $r) {
        if (!is_array($r) || !isset($r['id'], $r['points']) || !is_string($r['id']) || !is_array($r['points'])) {
            roads_respond(400, ['error' => 'each river needs id (string) and points (array)']);
        }
    }
    $lakes = $body['lakes'] ?? [];
    if (!is_array($lakes) || !array_is_list($lakes)) {
        roads_respond(400, ['error' => 'lakes must be a list']);
    }
    foreach ($lakes as $l) {
        if (!is_array($l) || !isset($l['id'], $l['outline'], $l['level']) || !is_string($l['id']) || !is_array($l['outline']) || !is_numeric($l['level'])) {
            roads_respond(400, ['error' => 'each lake needs id (string), numeric level and outline (array)']);
        }
    }
    $res = $docs->save("roads:$loc", ['roads' => $roads, 'nodes' => $nodes, 'rivers' => $rivers, 'lakes' => $lakes], roads_base_revision($body), $user);
    if ($res['conflict']) {
        roads_respond(409, ['ok' => false, 'conflict' => true, 'revision' => $res['revision']]);
    }
    roads_respond(200, ['ok' => true, 'revision' => $res['revision']]);
}

roads_respond(405, ['error' => 'method not allowed']);
