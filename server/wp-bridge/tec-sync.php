<?php
/**
 * The Events Calendar sync bridge — run by TeamHub via:
 *   wp eval-file tec-sync.php --path=/home/kindredv/public_html
 * Reads a JSON payload on STDIN, upserts/deletes a tribe_events event using
 * TEC's own API (so custom tables/meta stay consistent), optionally sets a
 * featured image from a local file, and prints a JSON result on STDOUT.
 *
 * Payload: { action:"upsert"|"delete", wp_event_id?, title, content, status,
 *            start, end, timezone, venue_name, category, cost, url, image_path }
 */

function out($a) { echo json_encode($a); exit; }

$raw = stream_get_contents(STDIN);
$in = json_decode($raw, true);
if (!is_array($in)) out(['ok' => false, 'error' => 'invalid JSON payload']);

$action = $in['action'] ?? 'upsert';

if ($action === 'delete') {
  if (!empty($in['wp_event_id']) && get_post((int)$in['wp_event_id'])) {
    wp_trash_post((int)$in['wp_event_id']);
  }
  out(['ok' => true]);
}

// Resolve venue by title
$venueId = 0;
if (!empty($in['venue_name'])) {
  $vq = get_posts(['post_type' => 'tribe_venue', 'title' => $in['venue_name'], 'numberposts' => 1, 'post_status' => 'publish']);
  if ($vq) $venueId = $vq[0]->ID;
}

// Resolve category by name
$catIds = [];
if (!empty($in['category'])) {
  $t = get_term_by('name', $in['category'], 'tribe_events_cat');
  if ($t) $catIds[] = (int)$t->term_id;
}

$args = [
  'title'      => $in['title'] ?? 'Event',
  'content'    => $in['content'] ?? '',
  'status'     => (($in['status'] ?? 'draft') === 'published') ? 'publish' : 'draft',
  'start_date' => $in['start'],
  'end_date'   => !empty($in['end']) ? $in['end'] : $in['start'],
  'timezone'   => $in['timezone'] ?? 'America/Denver',
];
if ($venueId) $args['venue'] = $venueId;
if ($catIds)  $args['category'] = $catIds;
if (isset($in['cost']) && $in['cost'] !== null && $in['cost'] !== '') $args['cost'] = (string)$in['cost'];
if (!empty($in['url'])) $args['url'] = $in['url'];

try {
  if (!empty($in['wp_event_id']) && get_post((int)$in['wp_event_id'])) {
    $id = (int)$in['wp_event_id'];
    tribe_events()->where('id', $id)->set_args($args)->save();
  } else {
    $ev = tribe_events()->set_args($args)->create();
    $id = $ev ? (int)$ev->ID : 0;
  }
  if (!$id) out(['ok' => false, 'error' => 'event create/update returned no id']);

  // Featured image from a local file (copied first — media_handle_sideload moves it)
  if (!empty($in['image_path']) && file_exists($in['image_path'])) {
    require_once ABSPATH . 'wp-admin/includes/media.php';
    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/image.php';
    $copy = wp_tempnam(basename($in['image_path']));
    if (@copy($in['image_path'], $copy)) {
      $att = media_handle_sideload(['name' => basename($in['image_path']), 'tmp_name' => $copy], $id);
      if (!is_wp_error($att)) set_post_thumbnail($id, $att);
      else @unlink($copy);
    }
  }
  out(['ok' => true, 'wp_event_id' => (string)$id]);
} catch (\Throwable $e) {
  out(['ok' => false, 'error' => $e->getMessage()]);
}
