"""Synthetic checks for the offline style analysis; no database or network access."""

import csv
from contextlib import redirect_stderr
from io import BytesIO, StringIO
import json
from pathlib import Path
import tempfile
import tarfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

from style_spike import (
    analyze, analyze_artists, artist_group_folds, artist_votes, capped_candidates, centroid,
    classify_artist, extract_mb_artists, group_folds, open_score_threshold,
    open_set_evaluate, pull,
    pull_artist_links, pull_artist_vectors, read_artist_inputs, read_tracks, turso_rows,
    verify_artist_credits,
)


class StyleSpikeTest(unittest.TestCase):
    def test_trimmed_centroid_discards_a_remote_outlier(self):
        vectors = np.asarray([[1.0, 0.0]] * 9 + [[0.0, 1.0]], dtype=np.float32)
        result = centroid(vectors, 0.1)
        self.assertAlmostEqual(float(result[0]), 1.0)
        self.assertAlmostEqual(float(result[1]), 0.0)

    def test_album_groups_never_cross_training_and_holdout(self):
        labels = ["jungle"] * 4 + ["halftime"] * 4
        groups = ["j1", "j1", "j2", "j2", "h1", "h1", "h2", "h2"]
        folds, styles = group_folds(labels, groups, 2)
        self.assertEqual(styles, ["halftime", "jungle"])
        self.assertEqual(len(folds), 2)
        for held in folds:
            held_groups = {groups[index] for index in held}
            train_groups = {group for index, group in enumerate(groups) if index not in set(held)}
            self.assertFalse(held_groups & train_groups)

    def test_local_csv_report_has_gates_projection_and_costs(self):
        with tempfile.TemporaryDirectory() as directory:
            album_path = Path(directory) / "albums.csv"
            track_path = Path(directory) / "tracks.csv"
            with album_path.open("w", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(("album_id", "discogs_state", "discogs_styles", "track_count", "embedded_count"))
                for style, prefix in (("Jungle", "j"), ("Halftime", "h")):
                    for album in range(3):
                        writer.writerow((f"{prefix}{album}", "resolved", json.dumps(["Drum n Bass", style]), 8, 8))
                writer.writerow(("other", "pending", "", 4, 4))
            with track_path.open("w", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(("track_id", "album_id", "embedding", "sample"))
                for style, prefix, vector in (("Jungle", "j", [1, 0]), ("Halftime", "h", [0, 1])):
                    for album in range(3):
                        for track in range(8):
                            writer.writerow((f"{prefix}{album}-{track}", f"{prefix}{album}", json.dumps(vector), 0))
                for track in range(4):
                    writer.writerow((f"other-{track}", "other", json.dumps([1, 0]), 1))
            (Path(directory) / "census.json").write_text(json.dumps({
                "total_albums": 7, "total_embedded_tracks": 52,
            }))
            args = type("Args", (), {
                "albums": album_path, "tracks": track_path,
                "total_albums": None, "total_embedded_tracks": None,
                "trim_fraction": 0.1, "folds": 3, "knn_k": 3,
                "minimum_seeds": 20, "minimum_accuracy": 0.75,
                "print_target": 0.9, "nightly_new_embeds": 2,
            })()
            report = analyze(args)
        self.assertEqual(report["evaluation"]["held_out_tracks"], 48)
        self.assertEqual(report["input"]["total_embedded_tracks"], 52)
        self.assertEqual(report["evaluation"]["held_out_albums"], 6)
        self.assertEqual(report["evaluation"]["accuracy"], 1)
        self.assertEqual(report["evaluation"]["knn_accuracy"], 1)
        self.assertEqual(report["projection"]["sample_tracks"], 4)
        self.assertEqual(report["projection"]["thresholds"]["print"]["sample_coverage"], 1)
        self.assertEqual(report["write_cost"]["first_run_assigned_estimate"]["print"], 52)
        self.assertTrue(next(style for style in report["styles"] if style["style"] == "jungle")["passes_seed_and_accuracy_gate"])

    def test_turso_parser_only_accepts_json_rows_from_select(self):
        completed = type("Completed", (), {"stdout": 'ROW\n{"album_id":"a"}   \n'})()
        with patch("style_spike.subprocess.run", return_value=completed) as run:
            self.assertEqual(turso_rows("example", "SELECT json_object('album_id','a') AS ROW"), [{"album_id": "a"}])
        self.assertEqual(run.call_args.args[0][:4], ["turso", "db", "shell", "example"])
        with self.assertRaisesRegex(ValueError, "SELECT"):
            turso_rows("example", "DELETE FROM albums")

    def test_sample_overlap_is_one_seed_with_a_sample_flag(self):
        with tempfile.TemporaryDirectory() as directory:
            track_path = Path(directory) / "tracks.csv"
            with track_path.open("w", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(("track_id", "album_id", "embedding", "sample"))
                writer.writerow(("one", "album", "[1,0]", 0))
                writer.writerow(("one", "album", "[1,0]", 1))
            tracks, explicit, dimension = read_tracks(track_path, {
                "album": {"substyles": ["jungle"]}
            })
        self.assertEqual(len(tracks), 1)
        self.assertTrue(tracks[0]["sample"])
        self.assertTrue(explicit)
        self.assertEqual(dimension, 2)

    def test_pull_rejects_oversize_seed_corpus_before_vectors(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "unmade"
            args = SimpleNamespace(
                db="example", seed_style=["jungle"], output_dir=destination,
                max_seed_vectors=3, sample_limit=2,
            )
            with patch("style_spike.turso_rows", return_value=[{
                "albums": 10, "embedded_tracks": 8, "seed_vectors": 4,
            }]) as query:
                with redirect_stderr(StringIO()):
                    with self.assertRaisesRegex(ValueError, "exceeds"):
                        pull(args)
            self.assertEqual(query.call_count, 1)
            self.assertIn("count(*)", query.call_args.args[1])
            self.assertNotIn("vector_extract", query.call_args.args[1])
            self.assertFalse(destination.exists())

    def test_mb_votes_are_deduplicated_and_bare_words_need_parent_evidence(self):
        votes = artist_votes({
            "genres": [{"name": "Liquid Funk", "count": 2}],
            "tags": [{"name": "liquid funk", "count": 2},
                     {"name": "jungle", "count": 2}],
        })
        self.assertEqual(votes["liquid funk"], 2)
        self.assertEqual(classify_artist(votes)["kind"], "ambiguous")
        self.assertEqual(classify_artist({"liquid": 4})["kind"], "weak_background")
        self.assertEqual(classify_artist({"liquid": 4, "drum and bass": 2})["style"], "liquid")

    def test_artist_component_folds_keep_agreeing_collaborators_together(self):
        rows = [
            {"artists": ["a", "c"], "actual": "jungle"},
            {"artists": ["c"], "actual": "jungle"},
            {"artists": ["b"], "actual": "jungle"},
            {"artists": ["x"], "actual": "neuro"},
            {"artists": ["y"], "actual": "neuro"},
        ]
        folds, groups = artist_group_folds(rows, ["jungle", "neuro"], 2)
        self.assertEqual(groups, {"jungle": 2, "neuro": 2})
        self.assertEqual(len(folds), 2)
        self.assertTrue(any({0, 1}.issubset(set(fold)) for fold in folds))
        for fold in folds:
            self.assertFalse(({0, 1} & set(fold)) and ({0, 1} - set(fold)))

    def test_background_false_positives_prevent_print_threshold(self):
        outcomes = [
            {"predicted": "liquid", "actual": "liquid", "score": 0.8, "track_id": f"p{i}"}
            for i in range(25)
        ] + [
            {"predicted": "liquid", "actual": "parent_background", "score": 0.9, "track_id": f"b{i}"}
            for i in range(10)
        ]
        self.assertIsNone(open_score_threshold(outcomes, "liquid", 0.9, 20))

    def test_nested_threshold_needs_separate_fit_calibration_and_test_groups(self):
        rows = []
        for style, vector in (("jungle", [1.0, 0.0]), ("neuro", [0.0, 1.0])):
            for artist in range(2):
                for track in range(12):
                    rows.append({"actual": style, "kind": "seed", "artists": [f"{style}{artist}"],
                                 "positive_artists": [f"{style}{artist}"],
                                 "track_id": f"{style}{artist}-{track}",
                                 "vector": np.asarray(vector, dtype=np.float32)})
        report = open_set_evaluate(rows, 0.1, 5, 3, 0.9, 0.75, 20, 2)
        self.assertEqual(report["folds"], 2)
        self.assertEqual(report["styles"]["jungle"]["accuracy"], 1)
        self.assertEqual(report["styles"]["jungle"]["crossfit_print"]["calibrated_folds"], 0)
        self.assertFalse(report["styles"]["jungle"]["crossfit_print"]["passes_target"])

    def test_singleton_binary_gate_includes_other_known_style_seeds_as_negatives(self):
        rows = []
        for style, kind, vector in (
            ("liquid", "seed", [1.0, 0.0]),
            ("neuro", "seed", [1.0, 0.0]),
            ("parent_background", "parent_background", [0.0, 1.0]),
        ):
            for artist in range(3):
                for track in range(10):
                    rows.append({"actual": style, "kind": kind,
                                 "artists": [f"{style}{artist}"],
                                 "positive_artists": [f"{style}{artist}"] if kind == "seed" else [],
                                 "track_id": f"{style}{artist}-{track}",
                                 "vector": np.asarray(vector, dtype=np.float32)})
        report = open_set_evaluate(rows, 0.1, 3, 3, 0.9, 0.75, 20, 3, ["liquid"])
        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["styles"]["liquid"]["accuracy_measure"],
                         "nested_binary_balanced_accuracy")
        self.assertFalse(report["styles"]["liquid"]["crossfit_print"]["passes_target"])
        self.assertIsNone(report["styles"]["liquid"]["crossfit_print"]["deployment_score_floor"])
        clear = [row for row in rows if row["actual"] != "neuro"]
        control_report = open_set_evaluate(clear, 0.1, 3, 3, 0.9, 0.75, 20, 3, ["liquid"])
        self.assertEqual(control_report["styles"]["liquid"]["accuracy"], 1)
        self.assertTrue(control_report["styles"]["liquid"]["crossfit_print"]["passes_target"])
        self.assertEqual(control_report["styles"]["liquid"]["crossfit_print"]
                         ["deployment_score_floor"], 1)

    def test_artist_cap_applies_across_local_ids_with_one_mbid(self):
        artists = {
            "one": {"kind": "seed", "style": "jungle", "group_id": "same-mbid"},
            "two": {"kind": "seed", "style": "jungle", "group_id": "same-mbid"},
        }
        selected, counts = capped_candidates(
            {"a": ["one"], "b": ["two"]}, artists, 1, 2, 2, 2)
        self.assertEqual(len(selected), 1)
        self.assertEqual(counts["seed"], 2)

    def test_artist_vector_pull_rejects_cap_before_query(self):
        with tempfile.TemporaryDirectory() as directory:
            selected = Path(directory) / "selected.csv"
            selected.write_text("track_id\na\nb\nc\n")
            prior = Path(directory) / "tracks.csv"
            prior.write_text("track_id,album_id,embedding\n")
            args = SimpleNamespace(db="example", selected_track_ids=selected,
                                   tracks=prior, output=Path(directory) / "new.csv",
                                   max_vectors=2, chunk_size=2)
            with patch("style_spike.turso_rows") as query:
                with self.assertRaisesRegex(ValueError, "exceeds"):
                    pull_artist_vectors(args)
            query.assert_not_called()

    def test_artist_link_pull_counts_before_any_full_transfer(self):
        with tempfile.TemporaryDirectory() as directory:
            args = SimpleNamespace(db="example", output_dir=Path(directory) / "unmade",
                                   max_artists=2, max_performer_edges=3)
            with patch("style_spike.turso_rows", return_value=[{
                "artists": 3, "performer_edges": 1,
            }]) as query:
                with redirect_stderr(StringIO()):
                    with self.assertRaisesRegex(ValueError, "exceeds"):
                        pull_artist_links(args)
            self.assertEqual(query.call_count, 1)
            self.assertFalse(args.output_dir.exists())

    def test_artist_credit_completeness_requires_expected_edge_count(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "map.csv").write_text("artist_id,mbid\na,mb-a\n")
            (root / "links.csv").write_text("track_id,artist_id\nt,a\n")
            (root / "artists.jsonl").write_text(
                '{"id":"mb-a","genres":[{"name":"jungle","count":2}],"tags":[]}\n')
            with self.assertRaisesRegex(ValueError, "differs from expected"):
                read_artist_inputs(root / "map.csv", root / "links.csv",
                                   root / "artists.jsonl", expected_credit_edges=2)

    def test_mb_artist_extract_streams_only_requested_record(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mbid = "11111111-1111-1111-1111-111111111111"
            other = "22222222-2222-2222-2222-222222222222"
            (root / "map.csv").write_text(f"artist_id,mbid\na,{mbid}\n")
            source = (json.dumps({"id": other, "genres": []}) + "\n" +
                      json.dumps({"id": mbid, "genres": [{"name": "jungle", "count": 2}],
                                  "tags": []}) + "\n").encode()
            archive = root / "artist.tar.xz"
            with tarfile.open(archive, "w:xz") as tar:
                info = tarfile.TarInfo("mbdump/artist")
                info.size = len(source)
                tar.addfile(info, BytesIO(source))
            output = root / "artists.jsonl"
            report = extract_mb_artists(SimpleNamespace(
                dump=archive, artist_map=root / "map.csv", output=output))
            self.assertEqual(report["matched_mbids"], 1)
            self.assertEqual([json.loads(line)["id"] for line in output.read_text().splitlines()], [mbid])

    def test_selected_track_credit_check_detects_an_omitted_collaborator(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "selected.csv").write_text("track_id\nt\n")
            (root / "links.csv").write_text("track_id,artist_id\nt,a\n")
            args = SimpleNamespace(db="example", track_ids=[root / "selected.csv"],
                                   track_artists=root / "links.csv", max_tracks=2, chunk_size=2)
            with patch("style_spike.turso_rows", return_value=[{
                "track_id": "t", "performer_edges": 2,
            }]):
                with self.assertRaisesRegex(ValueError, "mismatched performer credits"):
                    verify_artist_credits(args)

    def test_artist_analysis_reports_grouped_styles_and_strict_background(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "albums.csv").write_text(
                "album_id,discogs_state,discogs_styles,track_count,embedded_count\n"
                "other,pending,,1,1\n")
            (root / "tracks.csv").write_text(
                'track_id,album_id,embedding,sample\nsample,other,"[0.7,0.7]",1\n')
            (root / "census.json").write_text(json.dumps({"total_embedded_tracks": 77}))
            with (root / "artist-map.csv").open("w", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(("artist_id", "mbid"))
                for style in ("jungle", "neuro", "parent"):
                    for artist in range(3):
                        writer.writerow((f"{style}{artist}", f"mb-{style}{artist}"))
            with (root / "artists.jsonl").open("w") as handle:
                for style, tag in (("jungle", "jungle"), ("neuro", "neurofunk"),
                                   ("parent", "drum and bass")):
                    for artist in range(3):
                        handle.write(json.dumps({"id": f"mb-{style}{artist}",
                                                 "genres": [{"name": tag, "count": 3}],
                                                 "tags": []}) + "\n")
            with (root / "track-artists.csv").open("w", newline="") as links, \
                 (root / "new-vectors.csv").open("w", newline="") as vectors:
                link_writer, vector_writer = csv.writer(links), csv.writer(vectors)
                link_writer.writerow(("track_id", "artist_id"))
                vector_writer.writerow(("track_id", "embedding"))
                for style, vector, tracks_per_artist in (
                    ("jungle", [1, 0], 10), ("neuro", [0, 1], 10),
                    ("parent", [0.7, 0.7], 5),
                ):
                    for artist in range(3):
                        for track in range(tracks_per_artist):
                            track_id = f"{style}{artist}-{track}"
                            link_writer.writerow((track_id, f"{style}{artist}"))
                            vector_writer.writerow((track_id, json.dumps(vector)))
            args = SimpleNamespace(
                albums=root / "albums.csv", tracks=root / "tracks.csv",
                new_vectors=root / "new-vectors.csv", census=root / "census.json",
                artist_map=root / "artist-map.csv", track_artists=root / "track-artists.csv",
                mb_artists=root / "artists.jsonl", vote_share=0.6,
                max_tracks_per_artist=40, max_parent_background=1500,
                max_weak_background=500, max_seed_tracks=12000,
                trim_fraction=0.1, folds=3, knn_k=3, print_target=0.9,
                minimum_accuracy=0.75, minimum_seeds=20, minimum_artists=3,
                total_embedded_tracks=None, nightly_new_embeds=10,
            )
            report = analyze_artists(args)
        self.assertEqual(report["evaluation"]["status"], "ok")
        self.assertEqual(report["evaluation"]["folds"], 3)
        self.assertEqual(report["background"]["parent_only_tracks"], 15)
        self.assertEqual(report["seeds"]["style_inventory"]["jungle"]["seed_artists"], 3)
        self.assertEqual(report["input"]["artist_metadata"]["vote_share_sensitivity"]["0.6"]
                         ["candidate_linked_tracks_by_style"]["neuro"], 30)
        self.assertEqual(report["recommended_sets"]["rank"], ["jungle", "neuro"])
        self.assertEqual(report["projection"]["rank"]["deployment_score_floors"],
                         {"jungle": 1, "neuro": 1})
        self.assertEqual(report["projection"]["rank"]["retained"], 0)


if __name__ == "__main__":
    unittest.main()
