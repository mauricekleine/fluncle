#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";

import {
  CASCADE_TRACK_TABLES,
  type Catalogue,
  captureArtistCascadeRollback,
  countTrackRefs,
  deleteArtistCascade,
  entanglementHits,
  loadCatalogue,
} from "./lib";
import { listArg, parseArtistsFile } from "./purge-artists";

export type PurgeAlbumsPlan = {
  albumIds: string[];
  findingTrackIds: string[];
  orphanArtistIds: string[];
  trackIds: string[];
  unknownAlbumIds: string[];
  unknownTrackIds: string[];
};

export function planAlbumPurge(
  cat: Catalogue,
  albumIds: readonly string[],
  namedTrackIds: readonly string[] = [],
): PurgeAlbumsPlan {
  const named = new Set(albumIds);
  const namedTracks = new Set(namedTrackIds);
  const unknownAlbumIds = albumIds.filter((id) => !cat.albumName.has(id));
  const unknownTrackIds = namedTrackIds.filter((id) => !cat.trackById.has(id));
  const onAlbums = cat.tracks.filter(
    (t) => namedTracks.has(t.track_id) || (t.album_id !== null && named.has(t.album_id)),
  );
  const findingTrackIds = onAlbums
    .filter((t) => cat.findingTrackIds.has(t.track_id))
    .map((t) => t.track_id);
  const trackIds = onAlbums.map((t) => t.track_id);
  const deletable = new Set(trackIds);
  const emptiedAlbums = new Set(
    [...new Set(onAlbums.map((t) => t.album_id).filter((id): id is string => id !== null))].filter(
      (albumId) =>
        cat.tracks.filter((t) => t.album_id === albumId).every((t) => deletable.has(t.track_id)),
    ),
  );

  const touched = new Set<string>();
  const keepsTrack = new Set<string>();
  for (const edge of cat.edges) {
    if (deletable.has(edge.track_id)) {
      touched.add(edge.artist_id);
    } else {
      keepsTrack.add(edge.artist_id);
    }
  }

  return {
    albumIds: [...new Set([...albumIds.filter((id) => cat.albumName.has(id)), ...emptiedAlbums])],
    findingTrackIds,
    orphanArtistIds: [...touched].filter((id) => !keepsTrack.has(id)),
    trackIds,
    unknownAlbumIds,
    unknownTrackIds,
  };
}

async function report(cat: Catalogue, plan: PurgeAlbumsPlan): Promise<boolean> {
  const deletable = new Set(plan.trackIds);
  console.log(
    `albums ${plan.albumIds.length} · tracks ${plan.trackIds.length} · artists left with no track ${plan.orphanArtistIds.length}`,
  );

  const creditsByTrack = new Map<string, string[]>();
  for (const edge of cat.edges) {
    if (deletable.has(edge.track_id)) {
      const names = creditsByTrack.get(edge.track_id) ?? [];
      names.push(cat.artistById.get(edge.artist_id)?.name ?? edge.artist_id);
      creditsByTrack.set(edge.track_id, names);
    }
  }

  console.log(`\nalbums that would be deleted with every track (each must be off-genre):`);
  for (const albumId of plan.albumIds) {
    const tracks = cat.tracks.filter((t) => t.album_id === albumId);
    const label = tracks.find((t) => t.label)?.label ?? "(no label)";
    const artists = [...new Set(tracks.flatMap((t) => creditsByTrack.get(t.track_id) ?? []))];
    console.log(`  ${cat.albumName.get(albumId)}  [${label}]  ·  ${tracks.length} tracks`);
    console.log(`      credits: ${artists.slice(0, 8).join(", ") || "(none)"}`);
  }

  const loose = plan.trackIds.filter((id) => {
    const albumId = cat.trackById.get(id)?.album_id;
    return albumId === null || albumId === undefined || !plan.albumIds.includes(albumId);
  });
  if (loose.length > 0) {
    console.log(`\nnamed tracks deleted outside a whole album:`);
    for (const id of loose) {
      const t = cat.trackById.get(id);
      console.log(
        `  "${t?.title ?? id}"  [${t?.label ?? "(no label)"}]  ·  ${(creditsByTrack.get(id) ?? []).join(", ")}`,
      );
    }
  }

  console.log(`\nartists deleted because nothing of theirs survives:`);
  if (plan.orphanArtistIds.length === 0) {
    console.log(`  (none — every credited artist keeps a track elsewhere)`);
  }
  for (const id of plan.orphanArtistIds) {
    const artist = cat.artistById.get(id);
    console.log(`  ${artist?.name ?? id}  (${artist?.slug ?? "?"})`);
  }

  const tripped = await entanglementHits(cat.db, deletable);
  for (const { hits, table } of tripped) {
    console.log(`  ⚠ ENTANGLEMENT: ${table} has ${hits} of the deletable tracks`);
  }
  if (tripped.length > 0) {
    console.log(
      `\nABORTED — a deletable track is entangled in a real object (mixtape/save/post/edition).`,
    );
    return false;
  }
  console.log(`\nentanglement guard: clean (nothing in mixtapes / saves / posts / editions)`);
  for (const table of CASCADE_TRACK_TABLES) {
    console.log(`  cascade ${table}: ${await countTrackRefs(cat.db, table, deletable)} rows`);
  }

  return true;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  load: () => Promise<Catalogue> = loadCatalogue,
): Promise<number> {
  const confirm = argv.includes("--confirm");
  const out = process.env.PRUNE_OUT_DIR ?? ".";
  const fileIndex = argv.indexOf("--albums-file");
  const filePath = fileIndex >= 0 ? argv[fileIndex + 1] : undefined;
  const albumIds = [
    ...new Set([
      ...listArg(argv, "--albums"),
      ...(filePath ? parseArtistsFile(readFileSync(filePath, "utf8")) : []),
    ]),
  ];
  const trackFileIndex = argv.indexOf("--tracks-file");
  const trackFilePath = trackFileIndex >= 0 ? argv[trackFileIndex + 1] : undefined;
  const namedTrackIds = [
    ...new Set([
      ...listArg(argv, "--tracks"),
      ...(trackFilePath ? parseArtistsFile(readFileSync(trackFilePath, "utf8")) : []),
    ]),
  ];

  if (albumIds.length === 0 && namedTrackIds.length === 0) {
    console.log(
      "Nothing to do. Pass --albums / --albums-file (album ids) and/or --tracks / --tracks-file (track ids).",
    );

    return 0;
  }

  const cat = await load();
  const plan = planAlbumPurge(cat, albumIds, namedTrackIds);
  console.log(`\n===== TARGETED ALBUM PURGE (${confirm ? "WRITE" : "DRY RUN"}) =====`);

  if (plan.unknownAlbumIds.length > 0) {
    console.log(`\n  ⚠ no albums row for: ${plan.unknownAlbumIds.join(", ")}`);
    console.log(`\nABORTED — every named album id must resolve. Fix the list and re-run.`);

    return 1;
  }

  if (plan.unknownTrackIds.length > 0) {
    console.log(`\n  ⚠ no tracks row for: ${plan.unknownTrackIds.join(", ")}`);
    console.log(`\nABORTED — every named track id must resolve. Fix the list and re-run.`);

    return 1;
  }

  if (plan.findingTrackIds.length > 0) {
    console.log(`  ⚠ FINDING on a named album: ${plan.findingTrackIds.join(", ")}`);
    console.log(
      `\nABORTED — a findings track is never purged. Drop it (or its album) from the list.`,
    );

    return 1;
  }

  if (!(await report(cat, plan))) {
    return 1;
  }

  if (!confirm) {
    console.log(`\nDRY RUN — nothing written. Take a fresh backup, then re-run with --confirm.`);

    return 0;
  }

  const rollback = await captureArtistCascadeRollback(
    cat.db,
    plan.orphanArtistIds,
    plan.trackIds,
    plan.albumIds,
  );
  const path = `${out}/purge-albums-rollback.json`;
  writeFileSync(path, JSON.stringify(rollback, null, 2));
  console.log(
    `\nrollback → ${path} (albums ${rollback.albums.length}, tracks ${rollback.tracks.length})`,
  );

  await deleteArtistCascade(cat.db, plan.orphanArtistIds, plan.trackIds, plan.albumIds);
  console.log(`\nDONE. Rollback: ${path}`);

  return 0;
}

if (import.meta.main) {
  process.exit(await main());
}
