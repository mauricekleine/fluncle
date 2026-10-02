from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "merge-round.py"


def verdict(slug, bucket="dnb", **fields):
    return {"slug": slug, "name": slug.title(), "verdict": bucket, "confidence": "high", "evidence": "catalogue evidence", **fields}


def task(key, label, verdicts):
    return [{"type": "started", "key": key, "label": label}, {"type": "result", "key": key, "result": {"verdicts": verdicts}}]


class MergeRoundTests(unittest.TestCase):
    def run_merge(self, scope, journals, *args):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scope_path = root / "labels.json"
            scope_path.write_text(json.dumps(scope))
            command = [sys.executable, str(SCRIPT), "--scope", str(scope_path)]
            for index, entries in enumerate(journals):
                path = root / f"journal-{index}.jsonl"
                path.write_text("\n".join(json.dumps(entry) for entry in entries) + "\n\n")
                command.extend(["--journal", str(path)])
            return subprocess.run(command + list(args), capture_output=True, text=True)

    def test_census_replaces_provisional_read_and_counts_final_rules(self):
        scope = [{"slug": "mixed", "name": "Mixed"}, {"slug": "clean", "name": "Clean"}]
        research = task("shared-key", "labels 0-1", [verdict("mixed", needsCensus=True), verdict("clean")])
        census_row = verdict("mixed", "dnb_partial", rules=[{"artistMbid": "artist-id", "verdict": "allow"}])
        result = self.run_merge(scope, [research, task("shared-key", "census mixed", [census_row])], "--round", "42")
        self.assertEqual(result.returncode, 0, result.stderr)
        merged = json.loads(result.stdout)
        self.assertEqual(merged["dnb_partial"], [census_row])
        self.assertEqual([row["slug"] for row in merged["dnb"]], ["clean"])
        self.assertEqual(merged["counts"], {"dnb": 1, "dnb_partial": 1, "not_dnb": 0, "unclear": 0, "total": 2, "censused": 1, "rules": 1})
        self.assertEqual(merged["round"], 42)

    def test_slug_drift_in_both_phases_resolves_before_census_replacement(self):
        scope = [{"slug": "3xp-50und-b4t", "name": "3XP 50UND B4T"}]
        research = task("r", "labels 0-0", [verdict("3xp50und-b4t", needsCensus=True)])
        census = task("c", "census 3xp50und-b4t", [verdict("another-spelling", "not_dnb", name="3XP 50UND B4T")])
        result = self.run_merge(scope, [research + census])
        self.assertEqual(result.returncode, 0, result.stderr)
        merged = json.loads(result.stdout)
        self.assertEqual(merged["not_dnb"][0]["slug"], "3xp-50und-b4t")
        self.assertEqual(merged["not_dnb"][0]["_slugFixedFrom"], "another-spelling")
        self.assertEqual(merged["counts"]["total"], 1)
        self.assertEqual(merged["dnb"], [])
        self.assertNotIn("MISSING", result.stderr)
        self.assertNotIn("pending census", result.stderr)

    def test_missing_research_and_pending_census_are_reported(self):
        scope = [{"slug": slug, "name": slug.title()} for slug in ["mixed", "missing"]]
        result = self.run_merge(scope, [task("r", "labels 0-1", [verdict("mixed", needsCensus=True)])])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("MISSING research: missing", result.stderr)
        self.assertIn("pending census: mixed", result.stderr)
        self.assertEqual(json.loads(result.stdout)["counts"]["total"], 1)

    def test_ambiguous_or_conflicting_identity_never_overwrites_output(self):
        scope = [{"slug": "re-load", "name": "First"}, {"slug": "reload", "name": "Second"}]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "triage.json"
            output.write_text("existing round")
            for row in [verdict("re_load", name="Unknown"), verdict("re-load", name="Second"), verdict("absent", name="Unknown")]:
                with self.subTest(row=row):
                    result = self.run_merge(scope, [task("r", "labels 0-1", [row])], "--out", str(output))
                    self.assertEqual(result.returncode, 1)
                    self.assertEqual(result.stdout, "")
                    self.assertEqual(output.read_text(), "existing round")

    def test_latest_result_for_a_replayed_task_is_used_once(self):
        entries = task("r", "labels 0-0", [verdict("label")])
        entries.extend(task("r", "labels 0-0", [verdict("label", "not_dnb")]))
        result = self.run_merge([{"slug": "label", "name": "Label"}], [entries])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["counts"]["not_dnb"], 1)

    def test_invalid_journals_are_refused(self):
        scope = [{"slug": "label", "name": "Label"}]
        for entries in [
            [],
            task("r", "verify", [verdict("label", agrees=True)]),
            task("r", "labels", [verdict("label", "unsupported")]),
            task("r", "labels", [verdict("label"), verdict("label")]),
            [{"type": "result", "key": "r", "result": {"verdicts": [verdict("label")]}}],
        ]:
            with self.subTest(entries=entries):
                result = self.run_merge(scope, [entries])
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, "")

    def test_output_file_and_round_argument_work_outside_the_round_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "round.json"
            result = self.run_merge([{"slug": "label", "name": "Label"}], [task("r", "labels", [verdict("label")])], "--out", str(output))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "")
            self.assertEqual(json.loads(output.read_text())["counts"]["total"], 1)
            result = self.run_merge([], [[]], "--round", "0")
            self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
