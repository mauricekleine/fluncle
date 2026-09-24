#!/usr/bin/env python3
"""Read-only Discogs/MuQ style spike. Run with `uv run --with numpy`.

`pull` uses only SELECT statements through the authenticated Turso CLI and writes
local CSVs. `analyze` never connects to a database and emits aggregate JSON.
The input CSVs are deliberately excluded from the repository.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
from itertools import combinations
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
from collections import Counter, defaultdict
from typing import Any

import numpy as np


# Discogs styles independently verified as DnB-specific. "Drum n Bass" is the
# parent; generic "Minimal" is ambiguous without independent DnB evidence.
DISCOGS_STYLE_NAMES = {
    "halftime": ("Halftime",),
    "jungle": ("Jungle",),
}
PARENT_STYLE = "drum n bass"
STYLE_LOOKUP = {
    name.casefold(): style
    for style, names in DISCOGS_STYLE_NAMES.items()
    for name in names
}
FAN_VOCABULARY = {
    "liquid": None,
    "rollers": None,
    "jungle": "jungle",
    "neuro": None,
    "jump up": None,
    "dancefloor": None,
    "minimal": None,
    "halftime": "halftime",
    "dark": None,
}
ALBUM_COLUMNS = ("album_id", "discogs_state", "discogs_styles", "track_count", "embedded_count")
TRACK_COLUMNS = ("track_id", "album_id", "embedding")
ARTIST_COLUMNS = ("artist_id", "mbid")
LINK_COLUMNS = ("track_id", "artist_id")
VECTOR_COLUMNS = ("track_id", "embedding")
MB_STYLE_ALIASES = {
    "jungle": "jungle",
    "jungle music": "jungle",
    "jungle drum and bass": "jungle",
    "ragga jungle": "jungle",
    "halftime": "halftime",
    "half-time": "halftime",
    "half time": "halftime",
    "halftime drum and bass": "halftime",
    "half-time drum and bass": "halftime",
    "liquid funk": "liquid",
    "liquid drum and bass": "liquid",
    "liquid drum & bass": "liquid",
    "liquid drum n bass": "liquid",
    "liquid dnb": "liquid",
    "liquid": "liquid",
    "neurofunk": "neuro",
    "neuro funk": "neuro",
    "neuro drum and bass": "neuro",
    "neuro dnb": "neuro",
    "neuro": "neuro",
    "jump up": "jump up",
    "jump-up": "jump up",
    "jump up drum and bass": "jump up",
    "jump-up drum and bass": "jump up",
    "jump up dnb": "jump up",
    "dancefloor drum and bass": "dancefloor",
    "dancefloor drum & bass": "dancefloor",
    "dancefloor drum n bass": "dancefloor",
    "dancefloor dnb": "dancefloor",
    "dancefloor": "dancefloor",
    "minimal drum and bass": "minimal",
    "minimal drum & bass": "minimal",
    "minimal drum n bass": "minimal",
    "minimal dnb": "minimal",
    "minimal": "minimal",
    "darkstep": "darkstep",
    "dark step": "darkstep",
    "techstep": "techstep",
    "tech step": "techstep",
    "drumfunk": "drumfunk",
    "drum funk": "drumfunk",
    "rollers": "rollers",
    "roller": "rollers",
    "drum and bass rollers": "rollers",
    "dnb rollers": "rollers",
    "atmospheric drum and bass": "atmospheric",
    "atmospheric dnb": "atmospheric",
    "atmospheric jungle": "atmospheric",
    "intelligent drum and bass": "atmospheric",
    "hardstep": "hardstep",
    "hard step": "hardstep",
    "sambass": "sambass",
    "samba bass": "sambass",
}
BARE_MB_ALIASES = {"liquid", "neuro", "dancefloor", "minimal", "roller", "rollers"}
MB_PARENT_ALIASES = {
    "drum and bass", "drum & bass", "drum n bass", "drum'n'bass", "dnb", "drum & bass music",
}


def csv_rows(path: Path, required: tuple[str, ...]) -> tuple[list[dict[str, str]], list[str]]:
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        columns = reader.fieldnames or []
        missing = set(required) - set(columns)
        if missing:
            raise ValueError(f"{path}: missing columns: {', '.join(sorted(missing))}")
        return list(reader), columns


def integer(value: str, field: str, row_id: str) -> int:
    try:
        result = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{row_id}: invalid {field}: {value!r}") from error
    if result < 0:
        raise ValueError(f"{row_id}: negative {field}")
    return result


def read_albums(path: Path) -> dict[str, dict[str, Any]]:
    rows, _ = csv_rows(path, ALBUM_COLUMNS)
    albums = {}
    for row in rows:
        album_id = row["album_id"]
        if not album_id or album_id in albums:
            raise ValueError(f"{path}: blank or repeated album_id {album_id!r}")
        raw = row["discogs_styles"]
        try:
            styles = json.loads(raw) if raw else []
        except json.JSONDecodeError as error:
            raise ValueError(f"{album_id}: invalid discogs_styles JSON") from error
        if not isinstance(styles, list) or any(not isinstance(item, str) for item in styles):
            raise ValueError(f"{album_id}: discogs_styles must be a string array")
        normalized = {item.strip().casefold() for item in styles}
        substyles = sorted({STYLE_LOOKUP[item] for item in normalized if item in STYLE_LOOKUP})
        albums[album_id] = {
            "state": row["discogs_state"],
            "styles": styles,
            "substyles": substyles,
            "track_count": integer(row["track_count"], "track_count", album_id),
            "embedded_count": integer(row["embedded_count"], "embedded_count", album_id),
        }
    return albums


def read_tracks(path: Path, albums: dict[str, dict[str, Any]]) -> tuple[list[dict[str, Any]], bool, int]:
    rows, columns = csv_rows(path, TRACK_COLUMNS)
    explicit_sample = "sample" in columns
    tracks = {}
    dimension = 0
    for row in rows:
        track_id = row["track_id"]
        album_id = row["album_id"]
        if not track_id:
            raise ValueError(f"{path}: blank track_id")
        try:
            parsed = json.loads(row["embedding"])
            vector = np.asarray(parsed, dtype=np.float32)
        except (json.JSONDecodeError, TypeError, ValueError) as error:
            raise ValueError(f"{track_id}: invalid embedding JSON") from error
        if vector.ndim != 1 or not len(vector) or not np.isfinite(vector).all():
            raise ValueError(f"{track_id}: embedding must be a finite nonempty numeric array")
        norm = float(np.linalg.norm(vector))
        if norm <= 0:
            raise ValueError(f"{track_id}: embedding has zero norm")
        if dimension and dimension != len(vector):
            raise ValueError(f"{track_id}: dimension {len(vector)} differs from {dimension}")
        dimension = len(vector)
        if explicit_sample:
            sample = row["sample"].strip().casefold() in {"1", "true", "yes"}
        else:
            sample = len(albums.get(album_id, {}).get("substyles", [])) != 1
        prior = tracks.get(track_id)
        if prior is not None:
            if prior["album_id"] != album_id or not np.array_equal(prior["vector"], vector / norm):
                raise ValueError(f"{path}: conflicting duplicate track_id {track_id!r}")
            prior["sample"] = prior["sample"] or sample
            continue
        tracks[track_id] = {
            "album_id": album_id,
            "sample": sample,
            "track_id": track_id,
            "vector": vector / norm,
        }
    return list(tracks.values()), explicit_sample, dimension


def centroid(vectors: np.ndarray, trim_fraction: float) -> np.ndarray:
    mean = vectors.mean(axis=0)
    mean_norm = float(np.linalg.norm(mean))
    if mean_norm <= 0:
        raise ValueError("seed vectors cancel to a zero centroid")
    mean /= mean_norm
    trim_count = min(int(len(vectors) * trim_fraction), len(vectors) - 1)
    if trim_count:
        keep = np.argpartition(vectors @ mean, trim_count)[trim_count:]
        mean = vectors[keep].mean(axis=0)
        mean /= np.linalg.norm(mean)
    return mean.astype(np.float32)


def make_centroids(
    vectors: np.ndarray, labels: list[str], trim_fraction: float
) -> tuple[list[str], np.ndarray]:
    names = sorted(set(labels))
    return names, np.stack([
        centroid(vectors[np.asarray([label == name for label in labels])], trim_fraction)
        for name in names
    ])


def predict(
    vectors: np.ndarray, names: list[str], centroids: np.ndarray
) -> tuple[list[str], np.ndarray]:
    scores = vectors @ centroids.T
    order = np.argsort(-scores, axis=1)
    best = order[:, 0]
    if len(names) > 1:
        margin = scores[np.arange(len(scores)), best] - scores[np.arange(len(scores)), order[:, 1]]
    else:
        margin = np.full(len(scores), np.nan)
    return [names[index] for index in best], margin


def group_folds(labels: list[str], groups: list[str], requested_folds: int) -> tuple[list[np.ndarray], list[str]]:
    per_style = defaultdict(lambda: defaultdict(list))
    for index, (label, group) in enumerate(zip(labels, groups)):
        per_style[label][group].append(index)
    evaluable = sorted(style for style, albums in per_style.items() if len(albums) >= 2)
    if len(evaluable) < 2:
        return [], evaluable
    fold_count = min(requested_folds, min(len(per_style[style]) for style in evaluable))
    folds = [[] for _ in range(fold_count)]
    # Largest albums first, with stable album-id tie breaking.
    for style in evaluable:
        buckets = [[] for _ in range(fold_count)]
        sizes = [0] * fold_count
        album_groups = sorted(
            per_style[style].items(),
            key=lambda pair: (-len(pair[1]), pair[0]),
        )
        for album_id, indices in album_groups:
            slot = min(range(fold_count), key=lambda index: (sizes[index], index))
            buckets[slot].extend(indices)
            sizes[slot] += len(indices)
        for slot, indices in enumerate(buckets):
            folds[slot].extend(indices)
    return [np.asarray(fold, dtype=np.int64) for fold in folds], evaluable


def knn_predict(
    test_vectors: np.ndarray,
    train_vectors: np.ndarray,
    train_labels: list[str],
    k: int,
) -> list[str]:
    count = min(k, len(train_labels))
    predicted = []
    for start in range(0, len(test_vectors), 64):
        scores = test_vectors[start:start + 64] @ train_vectors.T
        nearest = np.argpartition(-scores, count - 1, axis=1)[:, :count]
        for row, neighbors in enumerate(nearest):
            votes = Counter(train_labels[index] for index in neighbors)
            similarity = defaultdict(float)
            for index in neighbors:
                similarity[train_labels[index]] += float(scores[row, index])
            predicted.append(min(votes, key=lambda label: (-votes[label], -similarity[label], label)))
    return predicted


def margin_curve(
    actual: list[str], predicted: list[str], margins: np.ndarray, target: float,
    minimum_support: int,
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    if not actual:
        return None, []
    order = np.argsort(-margins, kind="stable")
    correct = np.asarray([actual[i] == predicted[i] for i in order], dtype=np.int32)
    sorted_margins = margins[order]
    cumulative = np.cumsum(correct)
    points = []
    for index in range(len(order)):
        if index + 1 < len(order) and sorted_margins[index] == sorted_margins[index + 1]:
            continue
        count = index + 1
        points.append({
            "margin": float(sorted_margins[index]),
            "count": count,
            "coverage": count / len(order),
            "precision": int(cumulative[index]) / count,
        })
    selected = next(
        (point for point in reversed(points)
         if point["precision"] >= target and point["count"] >= minimum_support),
        None,
    )
    if selected is not None and selected["count"] == len(order) and selected["margin"] >= 0:
        selected = {**selected, "margin": 0.0}
    # The full exact curve can be large; keep a stable 21-point summary plus any
    # chosen threshold. Selection itself always uses every observed margin.
    positions = sorted({round(i * (len(points) - 1) / 20) for i in range(21)})
    summary = [points[index] for index in positions]
    if selected is not None and selected not in summary:
        summary.append(selected)
        summary.sort(key=lambda point: -point["margin"])
    return selected, summary


def evaluate(
    seeds: list[dict[str, Any]], trim_fraction: float, folds_requested: int, k: int,
    print_target: float,
) -> dict[str, Any]:
    labels = [seed["style"] for seed in seeds]
    groups = [seed["album_id"] for seed in seeds]
    folds, evaluable = group_folds(labels, groups, folds_requested)
    if not folds:
        return {
            "status": "insufficient_album_groups_or_classes",
            "evaluable_styles": evaluable,
            "held_out_tracks": 0,
            "thresholds": {"rank": None, "print": None},
        }
    matrix = np.stack([seed["vector"] for seed in seeds])
    outcomes = []
    for held_indices in folds:
        held_set = set(held_indices)
        train_indices = np.asarray([
            index for index, label in enumerate(labels)
            if label in evaluable and index not in held_set
        ], dtype=np.int64)
        train_labels = [labels[index] for index in train_indices]
        names, centers = make_centroids(matrix[train_indices], train_labels, trim_fraction)
        predicted, margins = predict(matrix[held_indices], names, centers)
        neighbor_predictions = knn_predict(matrix[held_indices], matrix[train_indices], train_labels, k)
        for row, index in enumerate(held_indices):
            outcomes.append({
                "actual": labels[index],
                "album_id": groups[index],
                "margin": float(margins[row]),
                "predicted": predicted[row],
                "knn": neighbor_predictions[row],
            })
    actual = [row["actual"] for row in outcomes]
    predicted = [row["predicted"] for row in outcomes]
    margins = np.asarray([row["margin"] for row in outcomes])
    minimum_support = max(20, math.ceil(len(outcomes) * 0.05))
    rank, curve = margin_curve(actual, predicted, margins, 0.75, minimum_support)
    printable, _ = margin_curve(actual, predicted, margins, print_target, minimum_support)
    confusion = {
        style: dict(sorted(Counter(row["predicted"] for row in outcomes if row["actual"] == style).items()))
        for style in evaluable
    }
    per_style = {
        style: {
            "held_out_tracks": sum(row["actual"] == style for row in outcomes),
            "accuracy": sum(row["actual"] == style and row["predicted"] == style for row in outcomes)
            / sum(row["actual"] == style for row in outcomes),
            "knn_accuracy": sum(row["actual"] == style and row["knn"] == style for row in outcomes)
            / sum(row["actual"] == style for row in outcomes),
        }
        for style in evaluable
    }
    per_predicted_style = {}
    for style in evaluable:
        assigned = [row for row in outcomes if row["predicted"] == style]
        assigned_actual = [row["actual"] for row in assigned]
        assigned_margins = np.asarray([row["margin"] for row in assigned])
        style_support = max(20, math.ceil(len(assigned) * 0.05))
        rank_style, _ = margin_curve(
            assigned_actual, [style] * len(assigned), assigned_margins, 0.75, style_support,
        )
        print_style, _ = margin_curve(
            assigned_actual, [style] * len(assigned), assigned_margins,
            print_target, style_support,
        )
        at_global_thresholds = {}
        for purpose, threshold in (("rank", rank), ("print", printable)):
            if threshold is None:
                at_global_thresholds[purpose] = None
                continue
            kept = [row for row in assigned if row["margin"] >= threshold["margin"]]
            right = sum(row["actual"] == style for row in kept)
            actual_total = sum(row["actual"] == style for row in outcomes)
            at_global_thresholds[purpose] = {
                "predictions": len(kept),
                "correct": right,
                "precision": right / len(kept) if kept else None,
                "recall": right / actual_total if actual_total else None,
            }
        per_predicted_style[style] = {
            "predictions": len(assigned),
            "minimum_threshold_support": style_support,
            "at_global_thresholds": at_global_thresholds,
            "thresholds": {"rank": rank_style, "print": print_style},
        }
    return {
        "status": "ok",
        "folds": len(folds),
        "held_out_tracks": len(outcomes),
        "held_out_albums": len(set(row["album_id"] for row in outcomes)),
        "evaluable_styles": evaluable,
        "accuracy": sum(left == right for left, right in zip(actual, predicted)) / len(outcomes),
        "knn_accuracy": sum(row["actual"] == row["knn"] for row in outcomes) / len(outcomes),
        "per_style": per_style,
        "per_predicted_style": per_predicted_style,
        "recommended_thresholds_closed_set_only": {
            style: per_predicted_style[style]["thresholds"] for style in evaluable
        },
        "confusion": confusion,
        "margin_curve": curve,
        "minimum_threshold_support": minimum_support,
        "thresholds": {"rank": rank, "print": printable},
        "caveat": "Candidate thresholds are diagnostic only: closed-set Jungle/Halftime held-out precision does not estimate open-set public chip precision.",
    }


def projection(
    tracks: list[dict[str, Any]], seeds: list[dict[str, Any]], evaluation: dict[str, Any],
    trim_fraction: float, explicit_sample: bool,
) -> dict[str, Any]:
    sample = [track for track in tracks if track["sample"]]
    if not sample or not seeds:
        return {"sample_tracks": len(sample), "status": "no_sample_or_seeds"}
    names, centers = make_centroids(
        np.stack([seed["vector"] for seed in seeds]),
        [seed["style"] for seed in seeds], trim_fraction,
    )
    predicted, margins = predict(np.stack([track["vector"] for track in sample]), names, centers)
    seed_ids = {seed["track_id"] for seed in seeds}
    nonseed_indices = [index for index, track in enumerate(sample) if track["track_id"] not in seed_ids]
    thresholds = {}
    for purpose in ("rank", "print"):
        chosen = evaluation["thresholds"][purpose]
        if chosen is None:
            thresholds[purpose] = None
            continue
        retained = [style for style, margin in zip(predicted, margins) if margin >= chosen["margin"]]
        counts = Counter(retained)
        nonseed_retained = sum(bool(margins[index] >= chosen["margin"]) for index in nonseed_indices)
        thresholds[purpose] = {
            "margin": chosen["margin"],
            "assigned_tracks": len(retained),
            "sample_coverage": len(retained) / len(sample),
            "nonseed_sample_tracks": len(nonseed_indices),
            "nonseed_above_margin": nonseed_retained,
            "nonseed_sample_coverage": (
                nonseed_retained / len(nonseed_indices) if nonseed_indices else None
            ),
            "share_of_all_sample_by_style": {
                style: counts[style] / len(sample) for style in names
            },
            "share_of_assigned_by_style": {
                style: counts[style] / len(retained) if retained else 0.0 for style in names
            },
        }
    style_specific = {}
    for purpose in ("rank", "print"):
        chosen_by_style = {
            style: evaluation.get("per_predicted_style", {}).get(style, {})
            .get("thresholds", {}).get(purpose)
            for style in names
        }
        retained_indices = [
            index for index, (style, margin) in enumerate(zip(predicted, margins))
            if chosen_by_style[style] is not None
            and margin >= chosen_by_style[style]["margin"]
        ]
        retained_set = set(retained_indices)
        nonseed_retained = sum(index in retained_set for index in nonseed_indices)
        counts = Counter(predicted[index] for index in retained_indices)
        style_specific[purpose] = {
            "margins_by_style": {
                style: chosen_by_style[style]["margin"] if chosen_by_style[style] is not None else None
                for style in names
            },
            "assigned_tracks": len(retained_indices),
            "sample_coverage": len(retained_indices) / len(sample),
            "nonseed_sample_tracks": len(nonseed_indices),
            "nonseed_above_margin": nonseed_retained,
            "nonseed_sample_coverage": (
                nonseed_retained / len(nonseed_indices) if nonseed_indices else None
            ),
            "share_of_all_sample_by_style": {
                style: counts[style] / len(sample) for style in names
            },
        }
    return {
        "status": "ok",
        "sample_tracks": len(sample),
        "sample_source": "explicit_sample_flag" if explicit_sample else "inferred_nonexclusive_album_rows",
        "thresholds": thresholds,
        "style_specific_thresholds": style_specific,
        "caveat": "The sample has no trusted style labels. Two-class nearest-centroid assignment is forced, so rank coverage of 100% does not establish public style coverage or precision.",
    }


def analyze(args: argparse.Namespace) -> dict[str, Any]:
    census_path = getattr(args, "census", None) or args.albums.parent / "census.json"
    census = json.loads(census_path.read_text(encoding="utf-8")) if census_path.exists() else {}
    total_albums = args.total_albums or census.get("total_albums")
    total_embedded_tracks = args.total_embedded_tracks or census.get("total_embedded_tracks")
    if total_albums is None or total_embedded_tracks is None:
        raise ValueError(
            "catalogue totals required: pass --total-albums and --total-embedded-tracks, "
            "or supply census.json beside albums.csv (or --census)"
        )
    total_albums = integer(str(total_albums), "total_albums", "census")
    total_embedded_tracks = integer(str(total_embedded_tracks), "total_embedded_tracks", "census")
    albums = read_albums(args.albums)
    tracks, explicit_sample, dimension = read_tracks(args.tracks, albums)
    raw_distribution = defaultdict(lambda: [0, 0, 0])
    substyle_albums = Counter()
    embedded_by_substyle_count = Counter()
    resolved_substyle_albums = Counter()
    resolved_embedded_by_substyle_count = Counter()
    eligible_albums_by_style = Counter()
    eligible_embedded_by_style = Counter()
    unknown_styles = Counter()
    for album in albums.values():
        substyle_albums[len(album["substyles"])] += 1
        embedded_by_substyle_count[len(album["substyles"])] += album["embedded_count"]
        if album["state"] == "resolved":
            resolved_substyle_albums[len(album["substyles"])] += 1
            resolved_embedded_by_substyle_count[len(album["substyles"])] += album["embedded_count"]
            if len(album["substyles"]) == 1:
                eligible_albums_by_style[album["substyles"][0]] += 1
                eligible_embedded_by_style[album["substyles"][0]] += album["embedded_count"]
        for name in set(album["styles"]):
            values = raw_distribution[name]
            values[0] += 1
            values[1] += album["track_count"]
            values[2] += album["embedded_count"]
            if name.casefold() not in STYLE_LOOKUP and name.casefold() != PARENT_STYLE:
                unknown_styles[name] += 1
    seeds = []
    for track in tracks:
        substyles = albums.get(track["album_id"], {}).get("substyles", [])
        if len(substyles) == 1 and albums[track["album_id"]]["state"] == "resolved":
            seeds.append({**track, "style": substyles[0]})
    seed_counts = Counter(seed["style"] for seed in seeds)
    seed_albums = defaultdict(set)
    for seed in seeds:
        seed_albums[seed["style"]].add(seed["album_id"])
    evaluation = evaluate(seeds, args.trim_fraction, args.folds, args.knn_k, args.print_target)
    projected = projection(tracks, seeds, evaluation, args.trim_fraction, explicit_sample)
    total_embedded = total_embedded_tracks
    direct_seed_population = sum(
        album["embedded_count"] for album in albums.values()
        if album["state"] == "resolved" and len(album["substyles"]) == 1
        and seed_counts[album["substyles"][0]] > 0
    )
    projected_cost = {}
    projected_style_specific_cost = {}
    for purpose in ("rank", "print"):
        estimate = projected.get("thresholds", {}).get(purpose)
        projected_cost[purpose] = (
            round(direct_seed_population + max(0, total_embedded - direct_seed_population)
                  * estimate["nonseed_sample_coverage"])
            if estimate is not None and estimate["nonseed_sample_coverage"] is not None else None
        )
        style_estimate = projected.get("style_specific_thresholds", {}).get(purpose)
        projected_style_specific_cost[purpose] = (
            round(direct_seed_population + max(0, total_embedded - direct_seed_population)
                  * style_estimate["nonseed_sample_coverage"])
            if style_estimate is not None
            and style_estimate["nonseed_sample_coverage"] is not None else None
        )
    write_cost = {
        "embedded_population": total_embedded,
        "direct_seed_population": direct_seed_population,
        "first_run_assigned_estimate": projected_cost,
        "first_run_assigned_estimate_style_specific": projected_style_specific_cost,
        "nightly_scenarios": {
            "assumptions": "Illustrative only: writes equal new assignments plus changed or cleared existing assignments; unchanged rows cost zero writes.",
            "new_embeds_per_night": args.nightly_new_embeds,
            "existing_assignment_change_rates": [0.001, 0.01, 0.05],
            "style_specific_rank_writes": [
                None if projected_style_specific_cost["rank"] is None else
                round(args.nightly_new_embeds
                      * projected["style_specific_thresholds"]["rank"]["nonseed_sample_coverage"]
                      + projected_style_specific_cost["rank"] * rate)
                for rate in (0.001, 0.01, 0.05)
            ],
            "style_specific_print_writes": [
                None if projected_style_specific_cost["print"] is None else
                round(args.nightly_new_embeds
                      * projected["style_specific_thresholds"]["print"]["nonseed_sample_coverage"]
                      + projected_style_specific_cost["print"] * rate)
                for rate in (0.001, 0.01, 0.05)
            ],
            "caveat": "Scenario assumptions, not a measured diff; a second snapshot is required to estimate actual churn.",
        },
    }
    heldout = evaluation.get("per_style", {})
    styles = []
    for style in sorted(DISCOGS_STYLE_NAMES):
        accuracy = heldout.get(style, {}).get("accuracy")
        styles.append({
            "style": style,
            "discogs_names": DISCOGS_STYLE_NAMES[style],
            "seed_tracks": seed_counts[style],
            "seed_albums": len(seed_albums[style]),
            "eligible_exclusive_albums": eligible_albums_by_style[style],
            "eligible_exclusive_embedded_tracks": eligible_embedded_by_style[style],
            "held_out_accuracy": accuracy,
            "passes_seed_and_accuracy_gate": seed_counts[style] >= args.minimum_seeds
            and accuracy is not None and accuracy >= args.minimum_accuracy,
        })
    fan_map = {
        word: {
            "candidate": style,
            "seed_tracks": seed_counts[style] if style else 0,
            "discogs_seedable": bool(style and seed_counts[style]),
        }
        for word, style in FAN_VOCABULARY.items()
    }
    return {
        "method": {
            "dimension": dimension,
            "trim_fraction": args.trim_fraction,
            "folds_requested": args.folds,
            "knn_k": args.knn_k,
            "minimum_seeds": args.minimum_seeds,
            "minimum_accuracy": args.minimum_accuracy,
            "print_precision_target": args.print_target,
            "vectors_l2_normalized": True,
        },
        "input": {
            "album_rows": len(albums),
            "embedded_track_rows": len(tracks),
            "seed_track_rows": len(seeds),
            "total_albums": total_albums,
            "total_embedded_tracks": total_embedded,
        },
        "coverage": {
            "resolved_albums_in_input": sum(album["state"] == "resolved" for album in albums.values()),
            "albums_with_styles_in_input": sum(bool(album["styles"]) for album in albums.values()),
            "nonresolved_albums_with_styles": sum(
                album["state"] != "resolved" and bool(album["styles"])
                for album in albums.values()
            ),
            "album_count_by_dnb_substyle_count": dict(sorted(substyle_albums.items())),
            "embedded_count_by_dnb_substyle_count": dict(sorted(embedded_by_substyle_count.items())),
            "resolved_album_count_by_dnb_substyle_count": dict(sorted(resolved_substyle_albums.items())),
            "resolved_embedded_count_by_dnb_substyle_count": dict(sorted(resolved_embedded_by_substyle_count.items())),
            "raw_discogs_style_distribution": [
                {"style": name, "albums": values[0], "tracks": values[1], "embedded_tracks": values[2]}
                for name, values in sorted(raw_distribution.items(), key=lambda pair: (-pair[1][0], pair[0]))
            ],
            "unmapped_nonparent_styles": dict(unknown_styles.most_common()),
        },
        "styles": styles,
        "fan_vocabulary": fan_map,
        "evaluation": evaluation,
        "projection": projected,
        "write_cost": write_cost,
    }


def turso_rows(database: str, sql: str) -> list[dict[str, Any]]:
    if not sql.lstrip().casefold().startswith("select "):
        raise ValueError("pull only accepts SELECT statements")
    completed = subprocess.run(
        ["turso", "db", "shell", database, sql],
        check=True, capture_output=True, text=True,
    )
    rows = []
    for line in completed.stdout.splitlines():
        stripped = line.strip()
        if not stripped or stripped.upper() == "ROW":
            continue
        if not (stripped.startswith("{") and stripped.endswith("}")):
            raise ValueError(f"unexpected Turso shell row: {stripped[:120]}")
        parsed = json.loads(stripped)
        if not isinstance(parsed, dict):
            raise ValueError("Turso shell returned a non-object JSON row")
        rows.append(parsed)
    return rows


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def pull(args: argparse.Namespace) -> dict[str, Any]:
    database = args.db or os.environ.get("FLUNCLE_TURSO_DB")
    if not database:
        raise ValueError("pass --db or set FLUNCLE_TURSO_DB")
    wanted = [style.casefold() for style in args.seed_style]
    if not wanted or any(style not in DISCOGS_STYLE_NAMES for style in wanted):
        raise ValueError("--seed-style must name one or more known canonical styles")
    names = [name.casefold() for style in wanted for name in DISCOGS_STYLE_NAMES[style]]
    all_dnb_names = [name.casefold() for group in DISCOGS_STYLE_NAMES.values() for name in group]
    requested_sql = ",".join(sql_literal(name) for name in names)
    dnb_sql = ",".join(sql_literal(name) for name in all_dnb_names)
    candidate_where = f"""a.discogs_state='resolved' AND a.discogs_styles IS NOT NULL
      AND (SELECT count(DISTINCT lower(value)) FROM json_each(a.discogs_styles)
           WHERE lower(value) IN ({dnb_sql})) = 1
      AND EXISTS (SELECT 1 FROM json_each(a.discogs_styles)
                  WHERE lower(value) IN ({requested_sql}))"""
    candidate_sql = f"(SELECT id FROM albums a WHERE {candidate_where}) candidates"
    count_sql = f"""SELECT json_object(
      'albums',(SELECT count(*) FROM albums),
      'embedded_tracks',(SELECT count(*) FROM track_embeddings),
      'seed_vectors',(SELECT count(*) FROM {candidate_sql}
        JOIN tracks t ON t.album_id=candidates.id
        JOIN track_embeddings e ON e.track_id=t.track_id)) AS ROW"""
    count_rows = turso_rows(database, count_sql)
    if len(count_rows) != 1:
        raise ValueError("count query did not return exactly one row")
    counts = count_rows[0]
    seed_count = integer(str(counts["seed_vectors"]), "seed_vectors", "count query")
    embedded_count = integer(str(counts["embedded_tracks"]), "embedded_tracks", "count query")
    album_count = integer(str(counts["albums"]), "albums", "count query")
    sample_count = min(args.sample_limit, embedded_count)
    estimate = {
        "albums": album_count,
        "embedded_tracks": embedded_count,
        "seed_vectors": seed_count,
        "sample_vectors": sample_count,
        "vector_payload_bytes_lower_bound": (seed_count + sample_count) * 1024 * 4,
        "vector_json_transfer_bytes_rough": (seed_count + sample_count) * 1024 * 12,
    }
    print(json.dumps({"preflight_estimate": estimate}, sort_keys=True), file=sys.stderr)
    if seed_count > args.max_seed_vectors:
        raise ValueError(
            f"estimated {seed_count} seed vectors exceeds --max-seed-vectors={args.max_seed_vectors}"
        )
    args.output_dir.mkdir(parents=True, exist_ok=True)
    album_sql = """
SELECT json_object('album_id',a.id,'discogs_state',a.discogs_state,
  'discogs_styles',a.discogs_styles,
  'track_count',(SELECT count(*) FROM tracks t WHERE t.album_id=a.id),
  'embedded_count',(SELECT count(*) FROM tracks t WHERE t.album_id=a.id AND t.has_embedding=1)) AS ROW
FROM albums a ORDER BY a.id
""".strip()
    albums = turso_rows(database, album_sql)
    album_path = args.output_dir / "albums.csv"
    with album_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=ALBUM_COLUMNS)
        writer.writeheader()
        for row in albums:
            writer.writerow({**row, "discogs_styles": row.get("discogs_styles") or ""})
    # The seed corpus is limited to unambiguous Discogs substyles. The count
    # query has bounded the transfer before any vector_extract is evaluated.
    seed_sql = f"""SELECT json_object('track_id',e.track_id,'album_id',t.album_id,
      'embedding',json(vector_extract(e.embedding_blob)),'sample',0) AS ROW
      FROM {candidate_sql} JOIN tracks t ON t.album_id=candidates.id
      JOIN track_embeddings e ON e.track_id=t.track_id
      ORDER BY e.track_id LIMIT {args.max_seed_vectors + 1}"""
    seed_rows = turso_rows(database, seed_sql)
    if len(seed_rows) > args.max_seed_vectors:
        raise ValueError(f"seed query returned {len(seed_rows)} vectors above --max-seed-vectors={args.max_seed_vectors}")
    # Sample globally, including seed albums, so coverage represents the
    # embedded catalogue. Only track IDs enter the random sort; vectors are
    # extracted after LIMIT has bounded the sampled set.
    sample_sql = f"""SELECT json_object('track_id',e.track_id,'album_id',t.album_id,
      'embedding',json(vector_extract(e.embedding_blob)),'sample',1) AS ROW
      FROM (SELECT track_id FROM track_embeddings ORDER BY random()
            LIMIT {args.sample_limit}) picked
      JOIN track_embeddings e ON e.track_id=picked.track_id
      JOIN tracks t ON t.track_id=e.track_id"""
    sample_rows = turso_rows(database, sample_sql)
    by_id = {row["track_id"]: row for row in seed_rows}
    for row in sample_rows:
        by_id[row["track_id"]] = row
    track_path = args.output_dir / "tracks.csv"
    with track_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=(*TRACK_COLUMNS, "sample"))
        writer.writeheader()
        writer.writerows(by_id.values())
    census_path = args.output_dir / "census.json"
    census_path.write_text(json.dumps({
        "total_albums": album_count,
        "total_embedded_tracks": embedded_count,
    }, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return {
        "albums_csv": str(album_path),
        "tracks_csv": str(track_path),
        "census_json": str(census_path),
        "preflight_estimate": estimate,
        "album_rows": len(albums),
        "seed_vectors": len(seed_rows),
        "sample_vectors": len(sample_rows),
        "unique_track_rows": len(by_id),
        "note": "SELECT-only pull; the local CSVs contain track-level vectors and must stay uncommitted.",
    }


def artist_votes(record: dict[str, Any]) -> dict[str, int]:
    """Use the highest MB count when one term occurs in both genres and tags."""
    votes: dict[str, int] = {}
    for field in ("genres", "tags"):
        for tag in record.get(field) or []:
            if not isinstance(tag, dict) or not isinstance(tag.get("name"), str):
                continue
            name = " ".join(tag["name"].strip().casefold().split())
            try:
                count = int(tag.get("count", 0))
            except (ValueError, TypeError):
                continue
            votes[name] = max(votes.get(name, 0), count)
    return votes


def classify_artist(votes: dict[str, int], share: float = 0.6, minimum_votes: int = 2) -> dict[str, Any]:
    styles: dict[str, int] = {}
    parent_votes = max((votes.get(name, 0) for name in MB_PARENT_ALIASES), default=0)
    for name, count in votes.items():
        style = MB_STYLE_ALIASES.get(name)
        if style is not None and (name not in BARE_MB_ALIASES or parent_votes >= minimum_votes):
            styles[style] = max(styles.get(style, 0), count)
    total = sum(styles.values())
    top = max(styles.values(), default=0)
    winners = [style for style, count in styles.items() if count == top]
    dominant = winners[0] if len(winners) == 1 and top >= minimum_votes and top / total >= share else None
    if dominant is not None:
        kind = "seed"
    elif total:
        kind = "ambiguous"
    elif parent_votes >= minimum_votes:
        kind = "parent_background"
    else:
        kind = "weak_background"
    return {"kind": kind, "style": dominant, "style_votes": styles,
            "parent_votes": parent_votes, "top_share": top / total if total else None}


def read_artist_inputs(artist_map: Path, links: Path, mb_artists: Path,
                       vote_share: float = 0.6,
                       expected_credit_edges: int | None = None) -> tuple[dict[str, dict[str, Any]], dict[str, list[str]], dict[str, Any]]:
    artist_rows, _ = csv_rows(artist_map, ARTIST_COLUMNS)
    mbid_by_artist: dict[str, str] = {}
    for row in artist_rows:
        artist_id = row["artist_id"]
        if not artist_id or artist_id in mbid_by_artist:
            raise ValueError(f"{artist_map}: blank or duplicate artist_id {artist_id!r}")
        mbid_by_artist[artist_id] = row["mbid"].strip()
    wanted_mbids = {mbid for mbid in mbid_by_artist.values() if mbid}
    records: dict[str, dict[str, Any]] = {}
    with mb_artists.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            record = json.loads(line)
            mbid = record.get("id")
            if mbid in wanted_mbids:
                if mbid in records:
                    raise ValueError(f"{mb_artists}: duplicate MBID {mbid}")
                records[mbid] = record
    artists = {
        artist_id: {**(classify_artist(artist_votes(records[mbid]), vote_share)
                       if mbid in records else {"kind": "missing_mb", "style": None,
                                                "style_votes": {}, "parent_votes": 0, "top_share": None}),
                    "group_id": mbid or f"local:{artist_id}"}
        for artist_id, mbid in mbid_by_artist.items()
    }
    link_rows, _ = csv_rows(links, LINK_COLUMNS)
    track_artists: dict[str, set[str]] = defaultdict(set)
    for row in link_rows:
        track_id, artist_id = row["track_id"], row["artist_id"]
        if not track_id or artist_id not in artists:
            raise ValueError(f"{links}: invalid track or artist ID {track_id!r}/{artist_id!r}")
        track_artists[track_id].add(artist_id)
    if expected_credit_edges is not None and sum(map(len, track_artists.values())) != expected_credit_edges:
        raise ValueError(f"{links}: performer credit count differs from expected {expected_credit_edges}")
    sensitivity = {}
    for share in (0.5, 0.6, 0.7):
        classified = {
            artist_id: {**(classify_artist(artist_votes(records[mbid]), share)
                           if mbid in records else {"kind": "missing_mb", "style": None}),
                        "group_id": mbid or f"local:{artist_id}"}
            for artist_id, mbid in mbid_by_artist.items()
        }
        candidate_tracks = Counter()
        for ids in track_artists.values():
            kind, style = credit_label(sorted(ids), classified)
            if kind == "seed" and style:
                candidate_tracks[style] += 1
        sensitivity[str(share)] = {
            "dominant_artists_by_style": dict(Counter(
                row["style"] for row in classified.values() if row["style"])),
            "candidate_linked_tracks_by_style": dict(candidate_tracks),
        }
    alias_artists = Counter()
    alias_votes = Counter()
    unmapped_dnb_terms = Counter()
    for record in records.values():
        for name, count in artist_votes(record).items():
            if name in MB_STYLE_ALIASES:
                alias_artists[name] += 1
                alias_votes[name] += count
            elif name not in MB_PARENT_ALIASES and any(
                hint in name for hint in ("drum and bass", "drum & bass", "dnb", "jungle",
                                        "neuro", "liquid", "halftime", "jump up", "techstep",
                                        "darkstep", "drumfunk", "roller")
            ):
                unmapped_dnb_terms[name] += 1
    summary = {
        "artist_rows": len(artists), "matched_mbid_artists": sum(bool(mbid) and mbid in records for mbid in mbid_by_artist.values()),
        "linked_tracks": len(track_artists), "credit_edges": sum(map(len, track_artists.values())),
        "credit_edge_completeness": "matched_expected_count" if expected_credit_edges is not None else "unverified",
        "artist_kinds": dict(Counter(row["kind"] for row in artists.values())),
        "artist_styles": dict(Counter(row["style"] for row in artists.values() if row["style"])),
        "vote_share_sensitivity": sensitivity,
        "alias_evidence": {name: {"artists": alias_artists[name], "votes": alias_votes[name]}
                           for name in sorted(alias_artists)},
        "unmapped_dnb_looking_tags": dict(unmapped_dnb_terms.most_common(30)),
    }
    return artists, {track: sorted(ids) for track, ids in track_artists.items()}, summary


def credit_label(artist_ids: list[str], artists: dict[str, dict[str, Any]]) -> tuple[str, str | None]:
    kinds = {artists[artist_id]["kind"] for artist_id in artist_ids}
    styles = {artists[artist_id]["style"] for artist_id in artist_ids if artists[artist_id]["style"]}
    if "ambiguous" in kinds or len(styles) > 1:
        return "ambiguous", None
    if styles:
        # A collaborator tagged only with the parent (or no substyle) does not
        # independently confirm that the recording has the positive style.
        if kinds - {"seed", "missing_mb"}:
            return "mixed_credit", None
        return "seed", next(iter(styles))
    if "parent_background" in kinds and not kinds.intersection({"weak_background", "missing_mb"}):
        return "parent_background", None
    if kinds == {"weak_background"}:
        return "weak_background", None
    return "mixed_credit", None


def capped_candidates(track_artists: dict[str, list[str]], artists: dict[str, dict[str, Any]],
                      maximum_per_artist: int, maximum_parent_background: int,
                      maximum_weak_background: int,
                      maximum_seeds: int) -> tuple[list[dict[str, str]], dict[str, int]]:
    candidates: dict[str, list[tuple[str, list[str], str | None]]] = defaultdict(list)
    counts = Counter()
    for track_id, ids in track_artists.items():
        kind, style = credit_label(ids, artists)
        counts[kind] += 1
        if kind in {"seed", "parent_background", "weak_background"}:
            candidates[kind].append((track_id, ids, style))
    selected = []
    for kind in ("seed", "parent_background", "weak_background"):
        artist_counts = Counter()
        selected_count = 0
        rows = candidates[kind]
        if kind == "seed":
            rows.sort(key=lambda row: row[0])
            cap = maximum_seeds
        else:
            rows.sort(key=lambda row: (hashlib.sha256(row[0].encode()).hexdigest(), row[0]))
            cap = maximum_parent_background if kind == "parent_background" else maximum_weak_background
        for track_id, ids, style in rows:
            if selected_count >= cap:
                break
            group_ids = set(artists[artist_id]["group_id"] for artist_id in ids)
            if any(artist_counts[group_id] >= maximum_per_artist for group_id in group_ids):
                continue
            selected.append({"track_id": track_id, "kind": kind,
                             "style": style or ""})
            artist_counts.update(group_ids)
            selected_count += 1
    counts.update({f"selected_{kind}": sum(row["kind"] == kind for row in selected)
                   for kind in ("seed", "parent_background", "weak_background")})
    return selected, dict(counts)


def select_artist_tracks(args: argparse.Namespace) -> dict[str, Any]:
    artists, track_artists, summary = read_artist_inputs(
        args.artist_map, args.track_artists, args.mb_artists, args.vote_share,
        getattr(args, "expected_credit_edges", None))
    selected, counts = capped_candidates(track_artists, artists, args.max_tracks_per_artist,
                                         args.max_parent_background, args.max_weak_background,
                                         args.max_seed_tracks)
    round1_rows, _ = csv_rows(args.tracks, TRACK_COLUMNS)
    already = {row["track_id"] for row in round1_rows}
    needed = [row for row in selected if row["track_id"] not in already]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=("track_id", "kind", "style"))
        writer.writeheader()
        writer.writerows(needed)
    return {"artist_input": summary, "candidate_counts": counts,
            "already_in_round1": len(selected) - len(needed), "new_vector_ids": len(needed),
            "selected_track_ids_csv": str(args.output)}


def pull_artist_vectors(args: argparse.Namespace) -> dict[str, Any]:
    database = args.db or os.environ.get("FLUNCLE_TURSO_DB")
    if not database:
        raise ValueError("pass --db or set FLUNCLE_TURSO_DB")
    rows, _ = csv_rows(args.selected_track_ids, ("track_id",))
    ids = sorted({row["track_id"] for row in rows if row["track_id"]})
    if len(ids) != len(rows):
        raise ValueError("selected track IDs must be nonblank and unique")
    prior_rows, _ = csv_rows(args.tracks, TRACK_COLUMNS)
    prior = {row["track_id"] for row in prior_rows}
    ids = [track_id for track_id in ids if track_id not in prior]
    if len(ids) > args.max_vectors:
        raise ValueError(f"{len(ids)} new vectors exceeds --max-vectors={args.max_vectors}")
    print(json.dumps({"preflight_estimate": {"requested_vectors": len(ids),
          "vector_json_transfer_bytes_rough": len(ids) * 1024 * 12}}, sort_keys=True), file=sys.stderr)
    result = []
    for start in range(0, len(ids), args.chunk_size):
        chunk = ids[start:start + args.chunk_size]
        literals = ",".join(sql_literal(track_id) for track_id in chunk)
        sql = f"""SELECT json_object('track_id',e.track_id,
          'embedding',json(vector_extract(e.embedding_blob))) AS ROW
          FROM track_embeddings e WHERE e.track_id IN ({literals}) ORDER BY e.track_id"""
        result.extend(turso_rows(database, sql))
    returned = {row["track_id"] for row in result}
    missing = sorted(set(ids) - returned)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=VECTOR_COLUMNS)
        writer.writeheader()
        writer.writerows(result)
    return {"requested_vectors": len(ids), "returned_vectors": len(result),
            "missing_vectors": len(missing), "new_vectors_csv": str(args.output)}


def pull_artist_links(args: argparse.Namespace) -> dict[str, Any]:
    database = args.db or os.environ.get("FLUNCLE_TURSO_DB")
    if not database:
        raise ValueError("pass --db or set FLUNCLE_TURSO_DB")
    count_sql = """SELECT json_object(
      'artists',(SELECT count(*) FROM artists),
      'performer_edges',(SELECT count(*) FROM track_artists ta
        JOIN track_embeddings e ON e.track_id=ta.track_id WHERE ta.role IS NULL)) AS ROW"""
    counted = turso_rows(database, count_sql)
    if len(counted) != 1:
        raise ValueError("artist/edge count query did not return one row")
    artist_count = integer(str(counted[0]["artists"]), "artists", "count query")
    edge_count = integer(str(counted[0]["performer_edges"]), "performer_edges", "count query")
    print(json.dumps({"preflight_estimate": {"artists": artist_count,
          "performer_edges": edge_count}}, sort_keys=True), file=sys.stderr)
    if artist_count > args.max_artists or edge_count > args.max_performer_edges:
        raise ValueError("artist or performer-edge count exceeds the configured pull cap")
    artist_sql = """SELECT json_object('artist_id',id,'mbid',mbid) AS ROW
      FROM artists ORDER BY id"""
    edge_sql = """SELECT json_object('track_id',ta.track_id,'artist_id',ta.artist_id) AS ROW
      FROM track_artists ta JOIN track_embeddings e ON e.track_id=ta.track_id
      WHERE ta.role IS NULL ORDER BY ta.track_id,ta.artist_id"""
    artists = turso_rows(database, artist_sql)
    edges = turso_rows(database, edge_sql)
    if len(artists) != artist_count or len(edges) != edge_count:
        raise ValueError("artist/edge rows changed or truncated after the count preflight")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name, columns, rows in (("artist-map.csv", ARTIST_COLUMNS, artists),
                                ("track-artists.csv", LINK_COLUMNS, edges)):
        with (args.output_dir / name).open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=columns)
            writer.writeheader()
            writer.writerows(rows)
    manifest = {"artists": artist_count, "performer_edges": edge_count,
                "linked_tracks": len({row["track_id"] for row in edges}),
                "query_scope": "embedded tracks; performer credits only; SELECT statements"}
    (args.output_dir / "artist-edge-counts.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return {"artist_map_csv": str(args.output_dir / "artist-map.csv"),
            "track_artists_csv": str(args.output_dir / "track-artists.csv"),
            "counts_json": str(args.output_dir / "artist-edge-counts.json"), **manifest}


def verify_artist_credits(args: argparse.Namespace) -> dict[str, Any]:
    database = args.db or os.environ.get("FLUNCLE_TURSO_DB")
    if not database:
        raise ValueError("pass --db or set FLUNCLE_TURSO_DB")
    requested: set[str] = set()
    for path in args.track_ids:
        rows, _ = csv_rows(path, ("track_id",))
        requested.update(row["track_id"] for row in rows if row["track_id"])
    if len(requested) > args.max_tracks:
        raise ValueError(f"{len(requested)} credit checks exceeds --max-tracks={args.max_tracks}")
    link_rows, _ = csv_rows(args.track_artists, LINK_COLUMNS)
    local = Counter()
    for row in link_rows:
        if row["track_id"] in requested:
            local[row["track_id"]] += 1
    ids = sorted(requested)
    observed: dict[str, int] = {}
    for start in range(0, len(ids), args.chunk_size):
        literals = ",".join(sql_literal(track_id) for track_id in ids[start:start + args.chunk_size])
        sql = f"""SELECT json_object('track_id',e.track_id,
          'performer_edges',(SELECT count(*) FROM track_artists ta
            WHERE ta.track_id=e.track_id AND ta.role IS NULL)) AS ROW
          FROM track_embeddings e WHERE e.track_id IN ({literals}) ORDER BY e.track_id"""
        for row in turso_rows(database, sql):
            observed[row["track_id"]] = integer(str(row["performer_edges"]),
                                                "performer_edges", row["track_id"])
    mismatches = [track_id for track_id in ids if observed.get(track_id) != local[track_id]]
    if mismatches:
        raise ValueError(f"{len(mismatches)} selected tracks have missing or mismatched performer credits")
    return {"checked_tracks": len(ids), "matched_credits": sum(local.values()),
            "status": "all_selected_track_credit_counts_match"}


def extract_mb_artists(args: argparse.Namespace) -> dict[str, Any]:
    rows, _ = csv_rows(args.artist_map, ARTIST_COLUMNS)
    wanted = {row["mbid"].strip().casefold() for row in rows if row["mbid"].strip()}
    id_pattern = re.compile(rb'"id"\s*:\s*"([0-9a-fA-F-]{36})"')
    matched: set[str] = set()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(args.dump, mode="r|xz") as archive:
        member = next((item for item in archive if item.name == "mbdump/artist"), None)
        if member is None:
            raise ValueError("mbdump/artist is absent from the archive")
        source = archive.extractfile(member)
        if source is None:
            raise ValueError("mbdump/artist could not be opened")
        with args.output.open("w", encoding="utf-8") as output:
            for raw in source:
                possible = id_pattern.search(raw)
                if possible is None or possible.group(1).decode("ascii").casefold() not in wanted:
                    continue
                record = json.loads(raw)
                mbid = record.get("id", "").casefold()
                if mbid not in wanted:
                    continue
                if mbid in matched:
                    raise ValueError(f"duplicate MB artist {mbid} in archive")
                matched.add(mbid)
                output.write(json.dumps({"id": mbid, "genres": record.get("genres") or [],
                                         "tags": record.get("tags") or []}, separators=(",", ":")) + "\n")
    return {"requested_mbids": len(wanted), "matched_mbids": len(matched),
            "missing_mbids": len(wanted - matched), "artist_jsonl": str(args.output)}


def read_new_vectors(path: Path, dimension: int) -> dict[str, np.ndarray]:
    rows, _ = csv_rows(path, VECTOR_COLUMNS)
    vectors = {}
    for row in rows:
        track_id = row["track_id"]
        if not track_id or track_id in vectors:
            raise ValueError(f"{path}: blank or duplicate vector track ID {track_id!r}")
        try:
            vector = np.asarray(json.loads(row["embedding"]), dtype=np.float32)
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            raise ValueError(f"{track_id}: invalid embedding JSON") from error
        if vector.ndim != 1 or len(vector) != dimension or not np.isfinite(vector).all():
            raise ValueError(f"{track_id}: invalid vector dimension or value")
        norm = float(np.linalg.norm(vector))
        if norm <= 0:
            raise ValueError(f"{track_id}: embedding has zero norm")
        vectors[track_id] = vector / norm
    return vectors


def artist_group_folds(rows: list[dict[str, Any]], styles: list[str], requested: int) -> tuple[list[list[int]], dict[str, int]]:
    """Union every credited artist on a track before assigning held-out folds."""
    parent: dict[str, str] = {}

    def root(item: str) -> str:
        parent.setdefault(item, item)
        if parent[item] != item:
            parent[item] = root(parent[item])
        return parent[item]

    for row in rows:
        credits = row["artists"]
        for artist_id in credits[1:]:
            parent[root(artist_id)] = root(credits[0])
    by_group: dict[str, list[int]] = defaultdict(list)
    for index, row in enumerate(rows):
        by_group[root(row["artists"][0])].append(index)
    style_groups = {
        style: len({group for group, indices in by_group.items()
                    if any(rows[index]["actual"] == style for index in indices)})
        for style in styles
    }
    evaluable = [style for style in styles if style_groups[style] >= 2]
    if not evaluable:
        return [], style_groups
    fold_count = min(requested, min(style_groups[style] for style in evaluable))
    folds: list[list[int]] = [[] for _ in range(fold_count)]
    loads: list[Counter[str]] = [Counter() for _ in range(fold_count)]
    groups = sorted(by_group.items(), key=lambda pair: (-len(pair[1]), pair[0]))
    for _, indices in groups:
        counts = Counter(rows[index]["actual"] for index in indices)
        largest_style = min(counts, key=lambda style: (-counts[style], style))
        slot = min(range(fold_count), key=lambda i: (loads[i][largest_style],
                                                    sum(loads[i].values()), i))
        folds[slot].extend(indices)
        loads[slot].update(counts)
    return folds, style_groups


def open_score_threshold(outcomes: list[dict[str, Any]], style: str, target: float,
                         minimum_support: int) -> dict[str, Any] | None:
    predicted = sorted((row for row in outcomes if row["predicted"] == style),
                       key=lambda row: (-row["score"], row["track_id"]))
    correct = 0
    chosen = None
    for index, row in enumerate(predicted):
        correct += row["actual"] == style
        if index + 1 < len(predicted) and row["score"] == predicted[index + 1]["score"]:
            continue
        count = index + 1
        if count >= minimum_support and correct / count >= target:
            chosen = {"score": row["score"], "predictions": count,
                      "correct": correct, "precision": correct / count}
    return chosen


def open_set_evaluate(rows: list[dict[str, Any]], trim_fraction: float,
                      folds_requested: int, k: int, target: float,
                      minimum_accuracy: float, minimum_seeds: int,
                      minimum_artists: int,
                      candidate_styles: list[str] | None = None) -> dict[str, Any]:
    styles = sorted(candidate_styles if candidate_styles is not None else
                    {row["actual"] for row in rows if row["kind"] == "seed"})
    folds, style_groups = artist_group_folds(rows, styles, folds_requested)
    if not folds:
        return {"status": "insufficient_artist_groups", "style_groups": style_groups,
                "folds": 0, "held_out_tracks": 0, "styles": {}}
    evaluable = sorted(style for style in styles if style_groups[style] >= 2)
    vectors = np.stack([row["vector"] for row in rows])
    outcomes = []
    for fold_index, held in enumerate(folds):
        held_set = set(held)
        train = [i for i, row in enumerate(rows)
                 if i not in held_set and row["kind"] == "seed" and row["actual"] in evaluable]
        if set(rows[i]["actual"] for i in train) != set(evaluable):
            return {"status": "insufficient_fold_training_groups", "style_groups": style_groups,
                    "folds": len(folds), "held_out_tracks": 0, "styles": {}}
        names, centers = make_centroids(vectors[train], [rows[i]["actual"] for i in train], trim_fraction)
        test = held
        if not test:
            continue
        scores = vectors[test] @ centers.T
        predicted, margins = predict(vectors[test], names, centers)
        knn = knn_predict(vectors[test], vectors[train], [rows[i]["actual"] for i in train], k)
        for position, index in enumerate(test):
            best = names.index(predicted[position])
            outcomes.append({"actual": rows[index]["actual"], "predicted": predicted[position],
                             "knn": knn[position], "score": float(scores[position, best]),
                             "margin": float(margins[position]), "fold": fold_index,
                             "track_id": rows[index]["track_id"], "kind": rows[index]["kind"]})
    # For each outer test fold, reserve another artist fold for threshold
    # calibration and fit centroids on the remaining folds. Neither held-out
    # partition affects that fold's centroids or threshold.
    nested: dict[int, tuple[list[dict[str, Any]], list[dict[str, Any]]]] = {}
    for outer in range(len(folds)):
        calibration_fold = (outer + 1) % len(folds)
        reserved = set(folds[outer]) | set(folds[calibration_fold])
        fit = [i for i, row in enumerate(rows) if i not in reserved
               and row["kind"] == "seed" and row["actual"] in evaluable]
        if set(rows[i]["actual"] for i in fit) != set(evaluable):
            continue
        nested_names, nested_centers = make_centroids(
            vectors[fit], [rows[i]["actual"] for i in fit], trim_fraction)
        partitions = []
        for fold_index in (calibration_fold, outer):
            indices = folds[fold_index]
            score_matrix = vectors[indices] @ nested_centers.T
            predictions = np.argmax(score_matrix, axis=1)
            partitions.append([
                {"actual": rows[index]["actual"], "kind": rows[index]["kind"],
                 "predicted": nested_names[int(predictions[position])],
                 "score": float(score_matrix[position, predictions[position]]),
                 "track_id": rows[index]["track_id"]}
                for position, index in enumerate(indices)
            ])
        nested[outer] = (partitions[0], partitions[1])
    style_reports = {}
    all_background = [row for row in outcomes if row["kind"] != "seed"]
    for style in evaluable:
        held = [row for row in outcomes if row["actual"] == style]
        predicted = [row for row in outcomes if row["predicted"] == style]
        minimum_support = max(20, math.ceil(len(held) * 0.05))
        rank_threshold = open_score_threshold(outcomes, style, 0.75, minimum_support)
        threshold = open_score_threshold(outcomes, style, target, minimum_support)
        def nested_threshold_result(goal: float) -> dict[str, Any]:
            # Each outer test fold is disjoint from fitting and calibration.
            accepted = []
            calibrations = []
            tested = []
            for fold_index in range(len(folds)):
                partitions = nested.get(fold_index)
                if partitions is None:
                    continue
                calibration, test = partitions
                fold_threshold = open_score_threshold(calibration, style, goal, 5)
                if fold_threshold is None:
                    continue
                calibrations.append(fold_threshold["score"])
                tested.extend(test)
                accepted.extend(row for row in test if row["predicted"] == style
                                and row["score"] >= fold_threshold["score"])
            true_positive = sum(row["actual"] == style for row in accepted)
            strict_fp = sum(row["kind"] == "parent_background" for row in accepted)
            weak_fp = sum(row["kind"] == "weak_background" for row in accepted)
            other_fp = len(accepted) - true_positive - strict_fp - weak_fp
            strict_background = sum(row["kind"] == "parent_background" for row in tested)
            weak_background = sum(row["kind"] == "weak_background" for row in tested)
            positives = sum(row["actual"] == style for row in tested)
            negatives = len(tested) - positives
            false_negative = positives - true_positive
            false_positive = len(accepted) - true_positive
            true_negative = negatives - false_positive
            precision = true_positive / len(accepted) if accepted else None
            recall = true_positive / positives if positives else None
            specificity = true_negative / negatives if negatives else None
            balanced_accuracy = (recall + specificity) / 2 if recall is not None and specificity is not None else None
            return {"calibrated_folds": len(calibrations),
                    "threshold_range": [min(calibrations), max(calibrations)] if calibrations else None,
                    "deployment_score_floor": max(calibrations) if len(calibrations) == len(folds) else None,
                    "predictions": len(accepted), "true_positive": true_positive,
                    "false_negative": false_negative, "true_negative": true_negative,
                    "test_positives": positives, "test_negatives": negatives,
                    "recall": recall, "specificity": specificity,
                    "binary_balanced_accuracy": balanced_accuracy,
                    "other_style_false_positive": other_fp,
                    "parent_background_false_positive": strict_fp,
                    "weak_background_false_positive": weak_fp,
                    "precision_including_all_background": precision,
                    "precision_including_parent_background":
                        true_positive / (true_positive + other_fp + strict_fp)
                        if true_positive + other_fp + strict_fp else None,
                    "parent_background_fpr": strict_fp / strict_background if strict_background else None,
                    "weak_background_fpr": weak_fp / weak_background if weak_background else None,
                    "passes_target": len(calibrations) == len(folds) and len(accepted) >= minimum_support
                    and precision is not None and precision >= goal}
        nested_rank = nested_threshold_result(0.75)
        nested_print = nested_threshold_result(target)
        accuracy = (nested_rank["binary_balanced_accuracy"]
                    if len(evaluable) == 1 and nested_rank["calibrated_folds"] == len(folds)
                    else sum(row["predicted"] == style for row in held) / len(held) if held and len(evaluable) > 1
                    else None)
        seed_artists = {artist for row in rows if row["kind"] == "seed" and row["actual"] == style
                        for artist in row["positive_artists"]}
        gate = (len(held) >= minimum_seeds and len(seed_artists) >= minimum_artists
                and accuracy is not None and accuracy >= minimum_accuracy)
        style_reports[style] = {
            "seed_tracks": sum(row["kind"] == "seed" and row["actual"] == style for row in rows),
            "seed_artists": len(seed_artists), "held_out_tracks": len(held),
            "accuracy": accuracy,
            "accuracy_measure": "nested_binary_balanced_accuracy" if len(evaluable) == 1 else "heldout_multiclass_accuracy",
            "knn_accuracy": sum(row["knn"] == style for row in held) / len(held) if held else None,
            "forced_choice_precision_including_background":
                sum(row["actual"] == style for row in predicted) / len(predicted) if predicted else None,
            "forced_choice_parent_background_assignment_rate":
                sum(row["predicted"] == style and row["kind"] == "parent_background" for row in outcomes)
                / sum(row["kind"] == "parent_background" for row in outcomes)
                if any(row["kind"] == "parent_background" for row in outcomes) else None,
            "forced_choice_weak_background_assignment_rate":
                sum(row["predicted"] == style and row["kind"] == "weak_background" for row in outcomes)
                / sum(row["kind"] == "weak_background" for row in outcomes)
                if any(row["kind"] == "weak_background" for row in outcomes) else None,
            "passes_seed_artist_accuracy_gate": gate,
            "all_oof_rank_threshold": rank_threshold,
            "all_oof_calibrated_threshold": threshold,
            "crossfit_rank": nested_rank,
            "crossfit_print": nested_print,
        }
    confusion = {
        style: dict(sorted(Counter(row["predicted"] for row in outcomes if row["actual"] == style).items()))
        for style in evaluable + ["parent_background", "weak_background"]
    }
    return {"status": "ok", "folds": len(folds), "held_out_tracks": len(outcomes),
            "style_groups": style_groups, "evaluable_styles": evaluable,
            "background_tracks": dict(Counter(row["kind"] for row in all_background)),
            "styles": style_reports, "confusion": confusion,
            "caveat": "Artist tags are recording-label proxies. Strict parent-only and weak untagged controls form a capped case-control mixture, so measured precision does not estimate catalogue prevalence. Independent human-labelled recordings are required before printing."}


def analyze_artists(args: argparse.Namespace) -> dict[str, Any]:
    albums = read_albums(args.albums)
    round1, explicit_sample, dimension = read_tracks(args.tracks, albums)
    vectors = {row["track_id"]: row["vector"] for row in round1}
    new_vectors = read_new_vectors(args.new_vectors, dimension)
    for track_id, vector in new_vectors.items():
        if track_id in vectors and not np.allclose(vectors[track_id], vector, atol=1e-6):
            raise ValueError(f"{track_id}: new vector conflicts with round-1 vector")
        vectors[track_id] = vector
    artists, track_artists, artist_summary = read_artist_inputs(
        args.artist_map, args.track_artists, args.mb_artists, args.vote_share,
        getattr(args, "expected_credit_edges", None))
    selected, selection_counts = capped_candidates(
        track_artists, artists, args.max_tracks_per_artist,
        args.max_parent_background, args.max_weak_background, args.max_seed_tracks)
    old_tracks = {row["track_id"]: row for row in round1}
    def discogs_style(track_id: str) -> str | None:
        track = old_tracks.get(track_id)
        if track is None:
            return None
        album = albums.get(track["album_id"])
        return album["substyles"][0] if album and album["state"] == "resolved" and len(album["substyles"]) == 1 else None

    candidate_ids = {row["track_id"] for row in selected}
    # Discogs seeds from the supplied album corpus remain available when MB
    # tags do not nominate them for the bounded vector pull.
    candidate_ids.update(track_id for track_id in old_tracks if discogs_style(track_id))
    seed_candidates = []
    background_candidates = []
    exclusions = Counter()
    overlaps = Counter()
    for track_id in sorted(candidate_ids):
        if track_id not in vectors:
            exclusions["missing_vector"] += 1
            continue
        credit_ids = track_artists.get(track_id, [])
        if not credit_ids:
            exclusions["no_artist_credit"] += 1
            continue
        kind, mb_style = credit_label(credit_ids, artists)
        dg_style = discogs_style(track_id)
        if kind in {"ambiguous", "mixed_credit"}:
            exclusions[kind] += 1
            continue
        if mb_style and dg_style:
            overlaps["agree" if mb_style == dg_style else "disagree"] += 1
            if mb_style != dg_style:
                exclusions["mb_discogs_disagreement"] += 1
                continue
        source = "both" if mb_style and dg_style else "musicbrainz" if mb_style else "discogs" if dg_style else "background"
        actual = mb_style or dg_style
        group_ids = sorted({artists[artist_id]["group_id"] for artist_id in credit_ids})
        positive_artists = sorted({artists[artist_id]["group_id"] for artist_id in credit_ids
                                   if artists[artist_id]["style"] == actual})
        gate_artists = group_ids if source == "discogs" else positive_artists
        row = {"track_id": track_id, "artists": group_ids, "kind": "seed" if actual else kind,
               "actual": actual or kind, "source": source, "vector": vectors[track_id],
               "positive_artists": gate_artists, "mb_confirmed_artists": positive_artists}
        if actual:
            seed_candidates.append(row)
        elif kind in {"parent_background", "weak_background"}:
            background_candidates.append(row)
    # Apply the artist cap across both seed sources, including collaborations.
    seed_candidates.sort(key=lambda row: ({"both": 0, "musicbrainz": 1, "discogs": 2}[row["source"]], row["track_id"]))
    artist_counts = Counter()
    seeds = []
    for row in seed_candidates:
        if any(artist_counts[artist_id] >= args.max_tracks_per_artist for artist_id in row["artists"]):
            exclusions["artist_cap"] += 1
            continue
        seeds.append(row)
        artist_counts.update(row["artists"])
    # A credit component can appear in background and positive tracks. The
    # fold builder unions the entire component, so those credits never leak.
    rows = seeds + background_candidates
    def measure(styles: list[str]) -> dict[str, Any]:
        return open_set_evaluate(rows, args.trim_fraction, args.folds, args.knn_k,
                                 args.print_target, args.minimum_accuracy,
                                 args.minimum_seeds, args.minimum_artists, styles)
    initial_styles = sorted(style for style in {row["actual"] for row in seeds}
                            if sum(row["actual"] == style for row in seeds) >= args.minimum_seeds
                            and len({artist for row in seeds if row["actual"] == style
                                     for artist in row["positive_artists"]}) >= args.minimum_artists)
    experiments = []
    measured_sets: dict[tuple[str, ...], dict[str, Any]] = {}
    for count in range(1, len(initial_styles) + 1):
        for group in combinations(initial_styles, count):
            measured = measure(list(group))
            measured_sets[group] = measured
            style_results = measured.get("styles", {})
            rank_pass = measured["status"] == "ok" and all(
                style_results[style]["passes_seed_artist_accuracy_gate"]
                and style_results[style]["crossfit_rank"]["deployment_score_floor"] is not None
                and style_results[style]["crossfit_rank"]["passes_target"]
                for style in group)
            print_pass = rank_pass and all(
                style_results[style]["crossfit_print"]["deployment_score_floor"] is not None
                and style_results[style]["crossfit_print"]["passes_target"]
                for style in group)
            experiments.append({"styles": list(group), "status": measured["status"],
                                "rank_pass": rank_pass, "print_pass": print_pass,
                                "accuracy": {style: style_results[style]["accuracy"]
                                             for style in group if style in style_results},
                                "accuracy_measure": {style: style_results[style]["accuracy_measure"]
                                                     for style in group if style in style_results},
                                "rank_precision": {style: style_results[style]["crossfit_rank"]
                                                   ["precision_including_all_background"]
                                                   for style in group if style in style_results},
                                "print_precision": {style: style_results[style]["crossfit_print"]
                                                    ["precision_including_all_background"]
                                                    for style in group if style in style_results}})
    def best_set(gate: str) -> list[str]:
        passing = [item for item in experiments if item[gate]]
        if not passing:
            return []
        winner = max(passing, key=lambda item: (len(item["styles"]),
                     sum(row["actual"] in item["styles"] for row in seeds),
                     tuple(item["styles"])))
        return winner["styles"]
    rank_styles = best_set("rank_pass")
    print_styles = best_set("print_pass")
    initial_evaluation = measured_sets[tuple(initial_styles)] if tuple(initial_styles) in measured_sets else measure(initial_styles)
    evaluation = measured_sets[tuple(rank_styles)] if tuple(rank_styles) in measured_sets else measure(rank_styles)
    print_evaluation = measured_sets[tuple(print_styles)] if tuple(print_styles) in measured_sets else measure(print_styles)
    inventory = {}
    for style in sorted({row["actual"] for row in seeds}
                        | set(artist_summary["artist_styles"])):
        style_seeds = [row for row in seeds if row["actual"] == style]
        dominant_artists = {artist for row in style_seeds for artist in row["positive_artists"]}
        mb_confirmed_artists = {artist for row in style_seeds for artist in row["mb_confirmed_artists"]}
        measured = initial_evaluation.get("styles", {}).get(style)
        subset_accuracies = [item["accuracy"][style] for item in experiments
                             if style in item["accuracy"] and item["accuracy"][style] is not None]
        best_subset_accuracy = max(subset_accuracies, default=None)
        failures = []
        if len(style_seeds) < args.minimum_seeds:
            failures.append("below_minimum_seed_tracks")
        if len(dominant_artists) < args.minimum_artists:
            failures.append("below_minimum_seed_artists")
        if measured is None and best_subset_accuracy is None:
            failures.append("insufficient_artist_group_evaluation")
        elif best_subset_accuracy is None or best_subset_accuracy < args.minimum_accuracy:
            failures.append("below_minimum_heldout_accuracy_in_candidate_sets")
        if style not in rank_styles:
            failures.append("no_supported_open_set_rank_floor")
        if style not in print_styles:
            failures.append("no_supported_open_set_print_threshold")
        inventory[style] = {"seed_tracks": len(style_seeds),
                            "seed_artists": len(dominant_artists),
                            "mb_confirmed_artists": len(mb_confirmed_artists),
                            "all_style_accuracy": measured["accuracy"] if measured else None,
                            "best_subset_accuracy_exploratory": best_subset_accuracy,
                            "sources": dict(Counter(row["source"] for row in style_seeds)),
                            "failure_reasons": failures}
    sample = [row for row in round1 if row["sample"]]
    seed_ids = {row["track_id"] for row in seeds}
    sample_nonseed = [row for row in sample if row["track_id"] not in seed_ids]
    def coverage(styles: list[str], purpose: str, measured: dict[str, Any]) -> dict[str, Any]:
        fitting = [row for row in seeds if row["actual"] in styles]
        if not fitting or not sample_nonseed:
            return {"styles": styles, "nonseed_sample": len(sample_nonseed),
                    "retained": 0, "nonseed_coverage": 0.0,
                    "mb_only_seed_tracks": 0, "mb_only_seed_retained": 0,
                    "deployment_score_floors": {}}
        names, centers = make_centroids(np.stack([row["vector"] for row in fitting]),
                                        [row["actual"] for row in fitting], args.trim_fraction)
        floors = {style: measured["styles"][style][f"crossfit_{purpose}"]["deployment_score_floor"]
                  for style in names}
        def retained_counts(items: list[dict[str, Any]]) -> Counter[str]:
            counts: Counter[str] = Counter()
            if not items:
                return counts
            score_matrix = np.stack([row["vector"] for row in items]) @ centers.T
            for scores in score_matrix:
                winner_index = int(np.argmax(scores))
                style = names[winner_index]
                threshold = floors[style]
                if threshold is not None and float(scores[winner_index]) >= threshold:
                    counts[style] += 1
            return counts
        retained = retained_counts(sample_nonseed)
        mb_only = [row for row in fitting if row["source"] == "musicbrainz"]
        mb_retained = retained_counts(mb_only)
        count = sum(retained.values())
        return {"styles": styles, "nonseed_sample": len(sample_nonseed),
                "retained": count, "nonseed_coverage": count / len(sample_nonseed),
                "by_style": dict(retained), "mb_only_seed_tracks": len(mb_only),
                "mb_only_seed_retained": sum(mb_retained.values()),
                "deployment_score_floors": floors,
                "threshold_basis": "maximum independently calibrated artist-fold score; final-fit centroid scores can shift"}
    rank_coverage = coverage(rank_styles, "rank", evaluation)
    print_coverage = coverage(print_styles, "print", print_evaluation)
    census_path = args.census or args.albums.parent / "census.json"
    census = json.loads(census_path.read_text(encoding="utf-8")) if census_path.exists() else {}
    total_embedded = args.total_embedded_tracks or census.get("total_embedded_tracks")
    if total_embedded is None:
        raise ValueError("pass --total-embedded-tracks or provide census.json")
    total_embedded = integer(str(total_embedded), "total_embedded_tracks", "census")
    def write_cost(coverage_row: dict[str, Any]) -> dict[str, Any]:
        direct = sum(row["actual"] in coverage_row["styles"] and row["source"] in {"discogs", "both"}
                     for row in seeds)
        mb_only = coverage_row["mb_only_seed_tracks"]
        first = round(direct + coverage_row["mb_only_seed_retained"]
                      + max(0, total_embedded - direct - mb_only) * coverage_row["nonseed_coverage"])
        return {"direct_discogs_seed_rows": direct,
                "mb_only_seed_rows_above_threshold": coverage_row["mb_only_seed_retained"],
                "first_run_assignment_estimate": first,
                "nightly_scenarios_at_change_rates_0_1_1_5_percent": [
                    round(args.nightly_new_embeds * coverage_row["nonseed_coverage"] + first * rate)
                    for rate in (0.001, 0.01, 0.05)],
                "assumption": "Illustrative row writes; unchanged assignments cost zero and actual churn needs a second snapshot."}
    return {
        "method": {"vote_share": args.vote_share, "minimum_style_votes": 2,
                   "max_tracks_per_artist": args.max_tracks_per_artist,
                   "trim_fraction": args.trim_fraction, "folds_requested": args.folds,
                   "knn_k": args.knn_k, "grouping": "connected credited-MBID artist components",
                   "print_precision_target": args.print_target},
        "input": {"round1_vector_rows": len(round1), "new_vector_rows": len(new_vectors),
                  "unique_vector_rows": len(vectors), "total_embedded_tracks": total_embedded,
                  "artist_metadata": artist_summary, "selection": selection_counts,
                  "explicit_round1_sample": explicit_sample},
        "seeds": {"tracks": len(seeds), "by_style": dict(Counter(row["actual"] for row in seeds)),
                  "by_source": dict(Counter(row["source"] for row in seeds)),
                  "mb_discogs_overlap": dict(overlaps), "exclusions": dict(exclusions),
                  "style_inventory": inventory},
        "background": {"parent_only_tracks": sum(row["kind"] == "parent_background" for row in background_candidates),
                       "weak_untagged_tracks": sum(row["kind"] == "weak_background" for row in background_candidates)},
        "evaluation": evaluation,
        "initial_eligible_evaluation": initial_evaluation,
        "print_evaluation": print_evaluation,
        "singleton_evaluations": {style: measured_sets[(style,)] for style in initial_styles},
        "candidate_set_experiments": experiments,
        "candidate_set_selection_caveat": "Choosing the strongest subset on these same held-out tracks is exploratory and may overstate its measured accuracy or precision.",
        "recommended_sets": {"rank": rank_styles, "print_candidate": print_styles,
                             "print_status": "provisional artist-tag proxy; independently labelled recordings needed"},
        "projection": {"rank": rank_coverage, "print": print_coverage,
                       "caveat": "The catalogue sample is unlabelled and final-fit centroid scores can differ from fold-fit scores; these are coverage scenarios, not validated deployment rates."},
        "write_cost": {"rank": write_cost(rank_coverage), "print": write_cost(print_coverage)},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    pull_parser = sub.add_parser("pull", help="bounded read-only Turso pull to local CSVs")
    pull_parser.add_argument("--db", help="database name; or FLUNCLE_TURSO_DB")
    pull_parser.add_argument("--output-dir", type=Path, required=True)
    pull_parser.add_argument("--seed-style", action="append", required=True,
                             help="canonical style to pull, repeatable")
    pull_parser.add_argument("--max-seed-vectors", type=int, default=5000)
    pull_parser.add_argument("--sample-limit", type=int, default=2000)
    analyze_parser = sub.add_parser("analyze", help="analyze two local CSVs without DB access")
    analyze_parser.add_argument("--albums", type=Path, required=True)
    analyze_parser.add_argument("--tracks", type=Path, required=True)
    analyze_parser.add_argument("--census", type=Path,
                                help="census.json; defaults to file beside albums CSV")
    analyze_parser.add_argument("--output", type=Path, help="write report JSON; default stdout")
    analyze_parser.add_argument("--total-albums", type=int)
    analyze_parser.add_argument("--total-embedded-tracks", type=int)
    analyze_parser.add_argument("--nightly-new-embeds", type=int, default=100,
                                help="illustrative new embeddings per night (default: 100)")
    analyze_parser.add_argument("--trim-fraction", type=float, default=0.10)
    analyze_parser.add_argument("--folds", type=int, default=5)
    analyze_parser.add_argument("--knn-k", type=int, default=5)
    analyze_parser.add_argument("--minimum-seeds", type=int, default=150)
    analyze_parser.add_argument("--minimum-accuracy", type=float, default=0.75)
    analyze_parser.add_argument("--print-target", type=float, default=0.90)
    select_parser = sub.add_parser("select-artist-tracks", help="choose bounded local MB artist candidates")
    select_parser.add_argument("--artist-map", type=Path, required=True)
    select_parser.add_argument("--track-artists", type=Path, required=True)
    select_parser.add_argument("--mb-artists", type=Path, required=True)
    select_parser.add_argument("--tracks", type=Path, required=True, help="round-1 tracks CSV")
    select_parser.add_argument("--output", type=Path, required=True)
    select_parser.add_argument("--vote-share", type=float, default=0.6)
    select_parser.add_argument("--max-tracks-per-artist", type=int, default=40)
    select_parser.add_argument("--max-parent-background", type=int, default=1500)
    select_parser.add_argument("--max-weak-background", type=int, default=500)
    select_parser.add_argument("--max-seed-tracks", type=int, default=12000)
    select_parser.add_argument("--expected-credit-edges", type=int,
                               help="compare supplied edges with a same-snapshot SELECT count")
    links_parser = sub.add_parser("pull-artist-links", help="bounded SELECT-only artist and embedded performer edges")
    links_parser.add_argument("--db", help="database name; or FLUNCLE_TURSO_DB")
    links_parser.add_argument("--output-dir", type=Path, required=True)
    links_parser.add_argument("--max-artists", type=int, default=25000)
    links_parser.add_argument("--max-performer-edges", type=int, default=80000)
    verify_parser = sub.add_parser("verify-artist-credits", help="SELECT-only per-track performer edge count check")
    verify_parser.add_argument("--db", help="database name; or FLUNCLE_TURSO_DB")
    verify_parser.add_argument("--track-ids", type=Path, action="append", required=True,
                               help="CSV with track_id; repeatable")
    verify_parser.add_argument("--track-artists", type=Path, required=True)
    verify_parser.add_argument("--max-tracks", type=int, default=10000)
    verify_parser.add_argument("--chunk-size", type=int, default=100)
    extract_parser = sub.add_parser("extract-mb-artists", help="stream selected artist tags from local MB tar.xz")
    extract_parser.add_argument("--dump", type=Path, required=True)
    extract_parser.add_argument("--artist-map", type=Path, required=True)
    extract_parser.add_argument("--output", type=Path, required=True)
    vector_parser = sub.add_parser("pull-artist-vectors", help="bounded SELECT-only vectors for selected IDs")
    vector_parser.add_argument("--db", help="database name; or FLUNCLE_TURSO_DB")
    vector_parser.add_argument("--selected-track-ids", type=Path, required=True)
    vector_parser.add_argument("--tracks", type=Path, required=True, help="round-1 tracks CSV")
    vector_parser.add_argument("--output", type=Path, required=True)
    vector_parser.add_argument("--max-vectors", type=int, default=12000)
    vector_parser.add_argument("--chunk-size", type=int, default=100)
    artist_parser = sub.add_parser("analyze-artists", help="offline MB artist seed and open-set analysis")
    artist_parser.add_argument("--artist-map", type=Path, required=True)
    artist_parser.add_argument("--track-artists", type=Path, required=True)
    artist_parser.add_argument("--mb-artists", type=Path, required=True)
    artist_parser.add_argument("--albums", type=Path, required=True)
    artist_parser.add_argument("--tracks", type=Path, required=True)
    artist_parser.add_argument("--new-vectors", type=Path, required=True)
    artist_parser.add_argument("--census", type=Path)
    artist_parser.add_argument("--output", type=Path)
    artist_parser.add_argument("--total-embedded-tracks", type=int)
    artist_parser.add_argument("--nightly-new-embeds", type=int, default=100)
    artist_parser.add_argument("--vote-share", type=float, default=0.6)
    artist_parser.add_argument("--max-tracks-per-artist", type=int, default=40)
    artist_parser.add_argument("--max-parent-background", type=int, default=1500)
    artist_parser.add_argument("--max-weak-background", type=int, default=500)
    artist_parser.add_argument("--max-seed-tracks", type=int, default=12000)
    artist_parser.add_argument("--expected-credit-edges", type=int,
                               help="compare supplied edges with a same-snapshot SELECT count")
    artist_parser.add_argument("--trim-fraction", type=float, default=0.10)
    artist_parser.add_argument("--folds", type=int, default=5)
    artist_parser.add_argument("--knn-k", type=int, default=5)
    artist_parser.add_argument("--minimum-seeds", type=int, default=150)
    artist_parser.add_argument("--minimum-artists", type=int, default=10)
    artist_parser.add_argument("--minimum-accuracy", type=float, default=0.75)
    artist_parser.add_argument("--print-target", type=float, default=0.90)
    args = parser.parse_args()
    if args.command == "pull":
        if args.sample_limit <= 0 or args.max_seed_vectors <= 0:
            parser.error("sample limit and max seed vectors must be positive")
        report = pull(args)
    elif args.command == "pull-artist-vectors":
        if args.max_vectors <= 0 or not 1 <= args.chunk_size <= 200:
            parser.error("max vectors must be positive and chunk size must be 1..200")
        report = pull_artist_vectors(args)
    elif args.command == "pull-artist-links":
        if args.max_artists <= 0 or args.max_performer_edges <= 0:
            parser.error("artist and performer-edge caps must be positive")
        report = pull_artist_links(args)
    elif args.command == "verify-artist-credits":
        if args.max_tracks <= 0 or not 1 <= args.chunk_size <= 200:
            parser.error("max tracks must be positive and chunk size must be 1..200")
        report = verify_artist_credits(args)
    elif args.command == "extract-mb-artists":
        report = extract_mb_artists(args)
    elif args.command == "select-artist-tracks":
        if not 0 < args.vote_share <= 1 or min(args.max_tracks_per_artist,
            args.max_parent_background, args.max_weak_background, args.max_seed_tracks) < 1:
            parser.error("vote share must be in (0,1] and selection caps must be positive")
        report = select_artist_tracks(args)
    else:
        if not 0 <= args.trim_fraction < 1 or args.folds < 2 or args.knn_k < 1:
            parser.error("trim fraction must be in [0,1), folds >= 2 and kNN k >= 1")
        if not 0 <= args.minimum_accuracy <= 1 or not 0 <= args.print_target <= 1:
            parser.error("accuracy and precision targets must be in [0,1]")
        if args.nightly_new_embeds < 0:
            parser.error("nightly new embeddings cannot be negative")
        if args.command == "analyze-artists":
            if not 0 < args.vote_share <= 1 or args.minimum_artists < 1 or min(
                args.max_tracks_per_artist, args.max_parent_background,
                args.max_weak_background, args.max_seed_tracks) < 1:
                parser.error("artist vote share, minimum artists and caps must be positive")
            report = analyze_artists(args)
        else:
            report = analyze(args)
    payload = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.command in {"analyze", "analyze-artists"} and args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload, encoding="utf-8")
    else:
        sys.stdout.write(payload)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(f"style_spike: {error}")
