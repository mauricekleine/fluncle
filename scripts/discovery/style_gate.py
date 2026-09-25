"""Bounded, SELECT-only anchor-probe style ranking measurement.

All output belongs outside the repository. The existing style-spike files supply
weak labels; newly ranked track IDs get a bounded metadata refresh.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import subprocess
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

from style_spike import artist_votes

STYLES = {
    "liquid": ("liquid", "liquid funk", "liquid dnb", "liquid drum and bass"),
    "neurofunk": ("neuro", "neurofunk", "neuro dnb", "neuro drum and bass"),
    "jungle": ("jungle", "jungle dnb", "ragga jungle", "ragga"),
    "jump-up": ("jump up", "jump-up", "jumpup", "jump up dnb"),
    "dancefloor": ("dancefloor", "dancefloor dnb", "dancefloor drum and bass"),
    "halftime": ("halftime", "half-time", "half time", "halftime dnb"),
    "minimal": (
        "minimal",
        "minimal dnb",
        "deep dnb",
        "minimal drum and bass",
        "deep drum and bass",
    ),
    "rollers": ("rollers", "roller", "dnb rollers", "drum and bass rollers"),
    "techstep": ("techstep", "tech step", "techstep dnb"),
    "darkstep": ("darkstep", "dark step", "darkstep dnb"),
    "atmospheric": (
        "atmospheric",
        "atmospheric dnb",
        "atmospheric jungle",
        "intelligent dnb",
    ),
    "drumfunk": ("drumfunk", "drum funk", "drumfunk dnb"),
    "ragga-jungle": ("ragga jungle", "ragga", "ragga dnb"),
}

MB_NAMES = {
    "liquid": (
        "liquid funk",
        "liquid drum and bass",
        "liquid drum & bass",
        "liquid drum n bass",
        "liquid dnb",
        "liquid",
    ),
    "neurofunk": (
        "neurofunk",
        "neuro funk",
        "neuro drum and bass",
        "neuro dnb",
        "neuro",
    ),
    "jungle": ("jungle", "jungle music", "jungle drum and bass", "ragga jungle"),
    "jump-up": (
        "jump up",
        "jump-up",
        "jump up drum and bass",
        "jump-up drum and bass",
        "jump up dnb",
    ),
    "dancefloor": (
        "dancefloor drum and bass",
        "dancefloor drum & bass",
        "dancefloor drum n bass",
        "dancefloor dnb",
        "dancefloor",
    ),
    "halftime": (
        "halftime",
        "half-time",
        "half time",
        "halftime drum and bass",
        "half-time drum and bass",
    ),
    "minimal": (
        "minimal drum and bass",
        "minimal drum & bass",
        "minimal drum n bass",
        "minimal dnb",
        "minimal",
        "deep drum and bass",
        "deep dnb",
    ),
    "rollers": ("rollers", "roller", "drum and bass rollers", "dnb rollers"),
    "techstep": ("techstep", "tech step"),
    "darkstep": ("darkstep", "dark step"),
    "atmospheric": (
        "atmospheric drum and bass",
        "atmospheric dnb",
        "atmospheric jungle",
        "intelligent drum and bass",
    ),
    "drumfunk": ("drumfunk", "drum funk"),
    "ragga-jungle": ("ragga jungle", "ragga drum and bass", "ragga dnb"),
}
DISCOGS = {
    "Liquid Funk": "liquid",
    "Liquid": "liquid",
    "Neurofunk": "neurofunk",
    "Jungle": "jungle",
    "Ragga Jungle": "jungle",
    "Ragga": "jungle",
    "Jump Up": "jump-up",
    "Dancefloor": "dancefloor",
    "Halftime": "halftime",
    "Minimal": "minimal",
    "Rollers": "rollers",
    "Techstep": "techstep",
    "Darkstep": "darkstep",
    "Atmospheric": "atmospheric",
    "Drumfunk": "drumfunk",
}


def discogs_labels(names: list[str]) -> set[str]:
    normalized = {name.strip().casefold() for name in names}
    parent = "drum n bass" in normalized or "jungle" in normalized
    labels = set()
    for name in names:
        key = DISCOGS.get(name.strip().title())
        if key and (name.strip().casefold() != "minimal" or parent):
            labels.add(key)
    if "ragga jungle" in normalized or ("jungle" in labels and "ragga" in normalized):
        labels.add("ragga-jungle")
    return labels


def mb_labels(votes: dict[str, int]) -> dict[str, int]:
    out = {}
    for style, names in MB_NAMES.items():
        strength = max((votes.get(name, 0) for name in names), default=0)
        if strength >= 1:
            out[style] = strength
    if "ragga-jungle" in out:
        out["jungle"] = max(out.get("jungle", 0), out["ragga-jungle"])
    return out


def track_label(style: str, labels: set[str]) -> str:
    if style in labels:
        return "positive"
    return "negative" if labels else "unlabelled"


def wilson_lower(positive: int, total: int, z: float = 1.96) -> float:
    """The Wilson score interval's lower bound for a share of `positive` in `total`."""
    if total == 0:
        return 0.0
    share = positive / total
    denominator = 1 + z * z / total
    centre = share + z * z / (2 * total)
    margin = z * math.sqrt(share * (1 - share) / total + z * z / (4 * total * total))
    return (centre - margin) / denominator


def labelled_view(labels: list[str], depth: int) -> dict:
    """Precision among the labelled rows of the top `depth`, with its Wilson lower bound."""
    if len(labels) < depth:
        raise ValueError(f"at least {depth} ranked labels required")
    top = labels[:depth]
    positive = top.count("positive")
    labelled = positive + top.count("negative")
    return {
        "depth": depth,
        "labelled": labelled,
        "positive": positive,
        "precision": positive / labelled if labelled else 0.0,
        "lower": wilson_lower(positive, labelled),
    }


# THE BAR. The weak labels (Discogs release styles, MusicBrainz artist tags) reach only about a
# quarter to a third of any probe's top 50, and they are just as sparse in a uniform random sample,
# so an unlabelled row is missing evidence rather than evidence of another style. "Mostly that
# style" is therefore measured where evidence exists: among the labelled non-anchor rows, the style
# must be the majority with 95% confidence (Wilson lower bound above one half), with enough labelled
# rows to say so, at the top 50 and again at the top 100 so a lucky head does not carry it, and at
# a clear lift over the style's share of labelled tracks in the random sample.
EVIDENCE_BAR = {
    "minimumLabelled": 10,
    "lowerBoundAbove": 0.5,
    "depths": [50, 100],
    "minimumLabelledLift": 1.5,
}


def passes_evidence_bar(views: list[dict], labelled_base_rate: float) -> bool:
    if labelled_base_rate <= 0:
        return False
    return all(
        view["labelled"] >= EVIDENCE_BAR["minimumLabelled"]
        and view["lower"] > EVIDENCE_BAR["lowerBoundAbove"]
        and view["precision"] / labelled_base_rate
        >= EVIDENCE_BAR["minimumLabelledLift"]
        for view in views
    )


def metrics(labels: list[str]) -> dict:
    if len(labels) < 50:
        raise ValueError("at least 50 ranked labels required")
    top20, top50 = labels[:20], labels[:50]
    positive = top50.count("positive")
    negative = top50.count("negative")
    labelled = positive + negative
    return {
        "p20": top20.count("positive") / 20,
        "p50": positive / 50,
        "p50Labelled": positive / labelled if labelled else 0,
        "coverage": labelled / 50,
        "counts": {
            "positive": positive,
            "negative": negative,
            "unlabelled": 50 - labelled,
        },
    }


def passes_bar(general: dict, base_rate: float) -> bool:
    return (
        general["p50"] >= 0.52
        and general["p50Labelled"] >= 0.75
        and general["coverage"] >= 0.6
        and base_rate > 0
        and general["p50"] / base_rate >= 3
    )


def rows(db: str, sql: str) -> list[dict]:
    if not sql.lstrip().lower().startswith("select") or ";" in sql:
        raise ValueError("SELECT only; semicolons are forbidden")
    process = subprocess.run(
        ["turso", "db", "shell", db, sql], capture_output=True, text=True, check=True
    )
    return [
        json.loads(line.strip())
        for line in process.stdout.splitlines()
        if line.lstrip().startswith("{")
    ]


def literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def save_jsonl(path: Path, values: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in values)
    )


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def array_value(value: str | list | None) -> list:
    if value is None:
        return []
    return value if isinstance(value, list) else json.loads(value)


def pull_centroids(db: str, output: Path, limit: int) -> None:
    count = rows(
        db, "select json_object('count',count(*)) as ROW from artist_centroids"
    )[0]["count"]
    if count > limit:
        raise ValueError(f"centroid count {count} exceeds cap {limit}")
    sql = f"select json_object('id',a.id,'slug',a.slug,'name',a.name,'mbid',a.mbid,'vector_count',ac.vector_count) as ROW from artist_centroids ac join artists a on a.id=ac.artist_id order by ac.vector_count desc limit {limit}"
    save_jsonl(output, rows(db, sql))


def rank(db: str, centroids: Path, anchors: Path, output: Path, limit: int) -> None:
    if not 100 <= limit <= 300:
        raise ValueError("rank limit must be 100..300")
    catalogue = {row["slug"]: row for row in read_jsonl(centroids)}
    spec = json.loads(anchors.read_text())
    slugs = spec["anchors"]
    if not 3 <= len(slugs) <= 8 or len(slugs) != len(set(slugs)):
        raise ValueError("each attempt needs 3..8 unique anchors")
    chosen = [catalogue[slug] for slug in slugs]
    ids = ",".join(literal(row["id"]) for row in chosen)
    vector_count = rows(
        db,
        f"select json_object('count',count(*)) as ROW from artist_centroids where artist_id in ({ids})",
    )[0]["count"]
    if vector_count != len(chosen):
        raise ValueError("some chosen anchors have no centroid")
    vector_rows = rows(
        db,
        f"select json_object('id',artist_id,'vector',json(vector_extract(centroid_blob))) as ROW from artist_centroids where artist_id in ({ids}) limit 8",
    )
    vectors = {
        row["id"]: np.asarray(array_value(row["vector"]), dtype=np.float32)
        for row in vector_rows
    }
    if len(vectors) != len(chosen) or {len(vector) for vector in vectors.values()} != {
        1024
    }:
        raise ValueError("missing or invalid centroid")
    probe = np.stack([vectors[row["id"]] for row in chosen]).mean(axis=0)
    probe_json = json.dumps(probe.tolist(), separators=(",", ":"))
    count = rows(
        db, "select json_object('count',count(*)) as ROW from track_embeddings"
    )[0]["count"]
    started = time.monotonic()
    ranked = rows(
        db,
        f"select json_object('track_id',track_id,'d',vector_distance_cos(embedding_blob,vector32({literal(probe_json)}))) as ROW from track_embeddings order by vector_distance_cos(embedding_blob,vector32({literal(probe_json)})) asc limit {limit}",
    )
    elapsed = round((time.monotonic() - started) * 1000)
    if len(ranked) != limit:
        raise ValueError(f"expected {limit} ranked rows, got {len(ranked)}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(
            {
                "style": spec["style"],
                "anchors": chosen,
                "ranked": ranked,
                "scanMs": elapsed,
                "embeddedCount": count,
                "probe": probe.tolist(),
            },
            separators=(",", ":"),
        )
    )


def pull_metadata(db: str, ids: list[str], output: Path, chunk: int = 90) -> None:
    if len(ids) > 5000 or chunk > 100:
        raise ValueError("metadata pull exceeds cap")
    unique = sorted(set(ids))
    collected = []
    for offset in range(0, len(unique), chunk):
        part = unique[offset : offset + chunk]
        quoted = ",".join(literal(value) for value in part)
        count = rows(
            db,
            f"select json_object('count',count(*)) as ROW from tracks where track_id in ({quoted})",
        )[0]["count"]
        if count > len(part):
            raise ValueError("metadata count exceeds requested IDs")
        sql = f"select json_object('track_id',t.track_id,'album_id',t.album_id,'styles',a.discogs_styles,'credits',(select json_group_array(json_object('artist_id',ta.artist_id,'name',ar.name,'mbid',ar.mbid)) from track_artists ta join artists ar on ar.id=ta.artist_id where ta.track_id=t.track_id),'title',t.title,'bpm',t.bpm,'key',t.key,'release_date',t.release_date) as ROW from tracks t left join albums a on a.id=t.album_id where t.track_id in ({quoted}) limit {len(part)}"
        collected.extend(rows(db, sql))
    save_jsonl(output, collected)


def local_labels(
    albums: Path,
    tracks: Path,
    sample: Path,
    artist_map: Path,
    links: Path,
    mb_dump: Path,
    fresh: Path,
) -> tuple[dict, dict, list[str]]:
    album_styles = {
        row["album_id"]: json.loads(row["discogs_styles"] or "[]")
        for row in csv.DictReader(albums.open())
    }
    track_album = {
        row["track_id"]: row["album_id"] for row in csv.DictReader(tracks.open())
    }
    samples = read_jsonl(sample)
    track_album.update({row["track_id"]: row.get("album_id") for row in samples})
    artist_mbid = {
        row["artist_id"]: row["mbid"] for row in csv.DictReader(artist_map.open())
    }
    credit_map: dict[str, set[str]] = defaultdict(set)
    for row in csv.DictReader(links.open()):
        credit_map[row["track_id"]].add(row["artist_id"])
    mb_votes = {row["id"]: mb_labels(artist_votes(row)) for row in read_jsonl(mb_dump)}
    fresh_rows = read_jsonl(fresh) if fresh.exists() else []
    for row in fresh_rows:
        track_album[row["track_id"]] = row["album_id"]
        if row["album_id"] and row["styles"] is not None:
            album_styles[row["album_id"]] = array_value(row["styles"])
        for credit in array_value(row["credits"]):
            credit_map[row["track_id"]].add(credit["artist_id"])
            if credit.get("mbid"):
                artist_mbid[credit["artist_id"]] = credit["mbid"]
    label_map = {}
    evidence = {}
    for track_id, album_id in track_album.items():
        discogs = discogs_labels(album_styles.get(album_id, []))
        votes = {}
        for artist_id in credit_map.get(track_id, set()):
            for style, strength in mb_votes.get(artist_mbid.get(artist_id), {}).items():
                votes[style] = max(votes.get(style, 0), strength)
        label_map[track_id] = discogs | set(votes)
        evidence[track_id] = {
            "discogs": sorted(discogs),
            "mbVotes": votes,
            "credits": sorted(credit_map.get(track_id, set())),
        }
    return label_map, evidence, [row["track_id"] for row in samples]


def quantile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    pos = (len(ordered) - 1) * q
    low = math.floor(pos)
    high = math.ceil(pos)
    return round(ordered[low] + (ordered[high] - ordered[low]) * (pos - low), 1)


def galaxy_profiles(
    galaxies: list[dict],
    findings: list[dict],
    labels: dict,
    probes: dict[str, np.ndarray],
) -> list[dict]:
    by_galaxy: dict[str, list[dict]] = defaultdict(list)
    for finding in findings:
        by_galaxy[finding["galaxy_id"]].append(finding)
    profiles = []
    for galaxy in galaxies:
        group = by_galaxy[galaxy["id"]]
        bpms = [float(row["bpm"]) for row in group if row["bpm"] is not None]
        keys = [row["key"].casefold() for row in group if row["key"]]
        years = [
            int(row["release_date"][:4])
            for row in group
            if row["release_date"] and row["release_date"][:4].isdigit()
        ]
        artists = Counter()
        styles = Counter()
        for row in group:
            artists.update({credit["name"] for credit in row.get("credits", [])})
            styles.update(labels.get(row["track_id"], set()))
        centroid = np.asarray(array_value(galaxy["centroid"]), dtype=np.float32)
        nearest = None
        if len(centroid) == 1024 and probes:
            nearest = min(
                probes,
                key=lambda style: float(
                    1
                    - np.dot(centroid, probes[style])
                    / (np.linalg.norm(centroid) * np.linalg.norm(probes[style]))
                ),
            )
        profiles.append(
            {
                "slug": galaxy["slug"],
                "name": galaxy["name"],
                "count": len(group),
                "bpmMedian": quantile(bpms, 0.5),
                "bpmIqr": [quantile(bpms, 0.25), quantile(bpms, 0.75)],
                "bpmCoverage": len(bpms),
                "minorShare": sum("minor" in key or key.endswith("m") for key in keys)
                / len(keys)
                if keys
                else None,
                "keyCoverage": len(keys),
                "topArtists": artists.most_common(10),
                "weakStyles": dict(styles.most_common()),
                "releaseYearMedian": quantile(years, 0.5),
                "releaseYearCoverage": len(years),
                "examples": [row["title"] for row in group[:3]],
                "nearestShippingStyle": nearest,
            }
        )
    return profiles


def report(args: argparse.Namespace) -> None:
    ranked_paths = sorted(
        args.rank_dir.glob("*.json"),
        key=lambda path: (path.stem.removesuffix("-b"), path.stem.endswith("-b")),
    )
    ranked = [json.loads(path.read_text()) for path in ranked_paths]
    ids = {row["track_id"] for attempt in ranked for row in attempt["ranked"]}
    labels, evidence, sample_ids = local_labels(
        args.albums,
        args.tracks,
        args.sample,
        args.artist_map,
        args.links,
        args.mb_dump,
        args.fresh,
    )
    missing = sorted(ids - labels.keys())
    if missing:
        raise ValueError(
            f"{len(missing)} ranked tracks have no metadata; run pull-metadata"
        )
    output = {
        "bar": {
            "evidence": EVIDENCE_BAR,
            "conservative": {
                "generalisationP50": 0.52,
                "generalisationLabelled": 0.75,
                "minimumCoverage": 0.6,
                "minimumLift": 3,
            },
        },
        "styles": [],
        "galaxies": [],
    }
    collisions = read_jsonl(args.collisions) if args.collisions else []
    grouped: dict[str, list[dict]] = defaultdict(list)
    for attempt in ranked:
        grouped[attempt["style"]].append(attempt)
    probes = {}
    for style, aliases in STYLES.items():
        attempts = []
        sample_positive = sum(
            style in labels.get(track_id, set()) for track_id in sample_ids
        )
        base_rate = sample_positive / len(sample_ids)
        sample_labelled = [t for t in sample_ids if labels.get(t)]
        labelled_base_rate = (
            sum(style in labels[t] for t in sample_labelled) / len(sample_labelled)
            if sample_labelled
            else 0.0
        )
        for item in grouped.get(style, []):
            anchor_ids = {anchor["id"] for anchor in item["anchors"]}
            shown = [
                track_label(style, labels[row["track_id"]])
                for row in item["ranked"][:50]
            ]
            general = [
                track_label(style, labels[row["track_id"]])
                for row in item["ranked"]
                if not anchor_ids.intersection(evidence[row["track_id"]]["credits"])
            ][: max(EVIDENCE_BAR["depths"])]
            if len(general) < max(EVIDENCE_BAR["depths"]):
                raise ValueError(
                    f"{style} needs a deeper scan for {max(EVIDENCE_BAR['depths'])} non-anchor tracks"
                )
            evidence_views = [
                labelled_view(general, depth) for depth in EVIDENCE_BAR["depths"]
            ]
            top_evidence = [
                {
                    "trackId": row["track_id"],
                    "distance": row["d"],
                    "label": track_label(style, labels[row["track_id"]]),
                    **evidence[row["track_id"]],
                }
                for row in item["ranked"][:50]
            ]
            attempts.append(
                {
                    "anchors": [
                        {key: anchor[key] for key in ("slug", "name", "vector_count")}
                        for anchor in item["anchors"]
                    ],
                    "metrics": {
                        "asShown": metrics(shown),
                        "generalisation": metrics(general),
                        "evidence": evidence_views,
                    },
                    "passesEvidence": passes_evidence_bar(
                        evidence_views, labelled_base_rate
                    ),
                    "scanMs": item["scanMs"],
                    "ranked": item,
                    "top50Evidence": top_evidence,
                }
            )
        if attempts:
            # Every attempt is reported; the one that ships is the passing attempt with the most
            # confident top-50 majority, else the last attempt is shown as the closest miss.
            passing = [attempt for attempt in attempts if attempt["passesEvidence"]]
            chosen = (
                max(
                    passing,
                    key=lambda attempt: attempt["metrics"]["evidence"][0]["lower"],
                )
                if passing
                else attempts[-1]
            )
            general = chosen["metrics"]["generalisation"]
            lift = general["p50"] / base_rate if base_rate else None
            ships = chosen["passesEvidence"]
            if ships:
                probes[style] = np.asarray(chosen["ranked"]["probe"], dtype=np.float32)
            item = {
                "slug": style,
                "label": style.replace("-", " ").title(),
                "aliases": aliases,
                "aliasCollisions": [
                    row for row in collisions if row["alias"] in aliases
                ],
                "anchors": chosen["anchors"],
                "attempts": [
                    {
                        "anchors": attempt["anchors"],
                        "metrics": attempt["metrics"],
                        "passesEvidence": attempt["passesEvidence"],
                        "scanMs": attempt["scanMs"],
                        "top50Evidence": attempt["top50Evidence"],
                    }
                    for attempt in attempts
                ],
                "labelledBaseRate": labelled_base_rate,
                "metrics": chosen["metrics"],
                "baseRate": base_rate,
                "lift": lift,
                "ships": ships,
                "scanMs": chosen["scanMs"],
            }
        else:
            item = {
                "slug": style,
                "label": style.replace("-", " ").title(),
                "aliases": aliases,
                "aliasCollisions": [
                    row for row in collisions if row["alias"] in aliases
                ],
                "anchors": [],
                "attempts": [],
                "metrics": None,
                "baseRate": base_rate,
                "labelledBaseRate": labelled_base_rate,
                "lift": None,
                "ships": False,
                "scanMs": None,
                "unmeasured": "No defensible set of three centroid-bearing anchors",
            }
        output["styles"].append(item)
    if args.galaxies.exists() and args.findings.exists():
        output["galaxies"] = galaxy_profiles(
            read_jsonl(args.galaxies), read_jsonl(args.findings), labels, probes
        )
    args.output.write_text(json.dumps(output, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    centroids = commands.add_parser("pull-centroids")
    centroids.add_argument("--db", required=True)
    centroids.add_argument("--output", type=Path, required=True)
    centroids.add_argument("--limit", type=int, default=1200)
    ranking = commands.add_parser("rank")
    ranking.add_argument("--db", required=True)
    ranking.add_argument("--centroids", type=Path, required=True)
    ranking.add_argument("--anchors", type=Path, required=True)
    ranking.add_argument("--output", type=Path, required=True)
    ranking.add_argument("--limit", type=int, default=300)
    metadata = commands.add_parser("pull-metadata")
    metadata.add_argument("--db", required=True)
    metadata.add_argument("--rank-dir", type=Path, required=True)
    metadata.add_argument("--sample", type=Path, required=True)
    metadata.add_argument("--findings", type=Path)
    metadata.add_argument("--output", type=Path, required=True)
    metadata.add_argument("--existing", type=Path)
    metadata.add_argument("--max-tracks", type=int, default=5000)
    galaxies = commands.add_parser("pull-galaxies")
    galaxies.add_argument("--db", required=True)
    galaxies.add_argument("--output-dir", type=Path, required=True)
    galaxies.add_argument("--max-galaxies", type=int, default=50)
    galaxies.add_argument("--max-findings", type=int, default=5000)
    labelling = commands.add_parser("label")
    for flag in (
        "albums",
        "tracks",
        "sample",
        "artist-map",
        "links",
        "mb-dump",
        "fresh",
        "output",
    ):
        labelling.add_argument("--" + flag, type=Path, required=True)
    collisions = commands.add_parser("pull-collisions")
    collisions.add_argument("--db", required=True)
    collisions.add_argument("--output", type=Path, required=True)
    analysis = commands.add_parser("report")
    for flag in (
        "albums",
        "tracks",
        "sample",
        "artist-map",
        "links",
        "mb-dump",
        "fresh",
        "rank-dir",
        "galaxies",
        "findings",
        "output",
    ):
        analysis.add_argument("--" + flag, type=Path, required=True)
    analysis.add_argument("--collisions", type=Path)
    args = parser.parse_args()
    if args.command == "pull-centroids":
        pull_centroids(args.db, args.output, args.limit)
    elif args.command == "rank":
        rank(args.db, args.centroids, args.anchors, args.output, args.limit)
    elif args.command == "pull-metadata":
        ids = {
            row["track_id"]
            for path in args.rank_dir.glob("*.json")
            for row in json.loads(path.read_text())["ranked"]
        }
        ids.update(row["track_id"] for row in read_jsonl(args.sample))
        if args.findings:
            ids.update(row["track_id"] for row in read_jsonl(args.findings))
        if len(ids) > args.max_tracks:
            raise ValueError("metadata pull exceeds --max-tracks")
        prior = read_jsonl(args.existing) if args.existing else []
        missing = sorted(ids - {row["track_id"] for row in prior})
        pull_metadata(args.db, missing, args.output)
        if prior:
            save_jsonl(args.output, prior + read_jsonl(args.output))
    elif args.command == "pull-galaxies":
        count = rows(
            args.db,
            "select json_object('count',count(*)) as ROW from galaxies where name is not null and retired_at is null",
        )[0]["count"]
        finding_count = rows(
            args.db,
            "select json_object('count',count(*)) as ROW from findings f join galaxies g on g.id=f.galaxy_id where g.name is not null and g.retired_at is null",
        )[0]["count"]
        if count > args.max_galaxies or finding_count > args.max_findings:
            raise ValueError("galaxy pull exceeds cap")
        gal = rows(
            args.db,
            f"select json_object('id',id,'slug',slug,'name',name,'centroid',centroid_json) as ROW from galaxies where name is not null and retired_at is null order by id limit {args.max_galaxies}",
        )
        found = rows(
            args.db,
            f"select json_object('galaxy_id',f.galaxy_id,'track_id',f.track_id,'title',t.title,'bpm',t.bpm,'key',t.key,'release_date',t.release_date,'credits',(select json_group_array(json_object('artist_id',ta.artist_id,'name',a.name)) from track_artists ta join artists a on a.id=ta.artist_id where ta.track_id=f.track_id)) as ROW from findings f join galaxies g on g.id=f.galaxy_id join tracks t on t.track_id=f.track_id where g.name is not null and g.retired_at is null order by f.galaxy_id,f.track_id limit {args.max_findings}",
        )
        for row in found:
            row["credits"] = array_value(row["credits"])
        save_jsonl(args.output_dir / "galaxies.jsonl", gal)
        save_jsonl(args.output_dir / "findings.jsonl", found)
    elif args.command == "pull-collisions":
        aliases = sorted({alias for names in STYLES.values() for alias in names})
        found = []
        for alias in aliases:
            for table in ("artists", "labels"):
                count = rows(
                    args.db,
                    f"select json_object('count',count(*)) as ROW from {table} where name={literal(alias)} collate nocase",
                )[0]["count"]
                if count > 10:
                    raise ValueError(f"{table} alias collision count exceeds cap")
                sql = f"select json_object('alias',{literal(alias)},'entity',{literal(table)},'name',name) as ROW from {table} where name={literal(alias)} collate nocase limit 10"
                found.extend(rows(args.db, sql))
        save_jsonl(args.output, found)
    elif args.command == "label":
        labels, evidence, sample_ids = local_labels(
            args.albums,
            args.tracks,
            args.sample,
            args.artist_map,
            args.links,
            args.mb_dump,
            args.fresh,
        )
        sample_set = set(sample_ids)
        save_jsonl(
            args.output,
            [
                {
                    "track_id": track_id,
                    "labels": sorted(styles),
                    "sample": track_id in sample_set,
                    **evidence[track_id],
                }
                for track_id, styles in labels.items()
            ],
        )
    else:
        report(args)


if __name__ == "__main__":
    main()
