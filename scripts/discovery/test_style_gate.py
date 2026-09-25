"""Pure style-gate label and ranking checks."""

import pytest

from style_gate import (
    discogs_labels,
    labelled_view,
    mb_labels,
    metrics,
    passes_bar,
    passes_evidence_bar,
    track_label,
    wilson_lower,
)


def test_discogs_parent_and_style_mapping():
    assert discogs_labels(["Drum n Bass", "Jungle", "Ragga"]) == {
        "jungle",
        "ragga-jungle",
    }
    assert discogs_labels(["Ragga Jungle"]) == {"jungle", "ragga-jungle"}
    assert discogs_labels(["Minimal"]) == set()
    assert discogs_labels(["Drum n Bass", "Minimal"]) == {"minimal"}
    assert discogs_labels(["House", "Liquid Funk", "Neurofunk"]) == {
        "liquid",
        "neurofunk",
    }


def test_mb_exact_style_terms_keep_vote_strength():
    assert mb_labels({"liquid": 3}) == {"liquid": 3}
    assert mb_labels({"liquid": 3, "drum and bass": 1}) == {"liquid": 3}
    assert mb_labels({"neurofunk": 2, "jungle": 1}) == {"neurofunk": 2, "jungle": 1}
    assert mb_labels({"ragga jungle": 1}) == {"ragga-jungle": 1, "jungle": 1}


def test_label_priority_and_conservative_metrics():
    assert track_label("liquid", {"liquid", "jungle"}) == "positive"
    assert track_label("liquid", {"jungle"}) == "negative"
    assert track_label("liquid", set()) == "unlabelled"
    result = metrics(["positive"] * 12 + ["negative"] * 8 + ["unlabelled"] * 30)
    assert result == {
        "p20": 0.6,
        "p50": 0.24,
        "p50Labelled": 0.6,
        "coverage": 0.4,
        "counts": {"positive": 12, "negative": 8, "unlabelled": 30},
    }
    with pytest.raises(ValueError):
        metrics(["positive"] * 49)


def test_majority_and_coverage_are_required_for_shipping():
    passing = metrics(["positive"] * 26 + ["negative"] * 4 + ["unlabelled"] * 20)
    assert passes_bar(passing, 0.10)
    tied = metrics(["positive"] * 25 + ["negative"] * 5 + ["unlabelled"] * 20)
    assert not passes_bar(tied, 0.10)
    thin = metrics(["positive"] * 26 + ["unlabelled"] * 24)
    assert not passes_bar(thin, 0.10)
    assert not passes_bar(passing, 0.20)


def test_wilson_lower_bound_is_conservative():
    assert wilson_lower(0, 0) == 0.0
    assert 0.5 < wilson_lower(14, 15) < 0.93
    assert wilson_lower(10, 20) < 0.5


def test_evidence_bar_needs_a_confident_majority_at_both_depths():
    head = ["positive"] * 12 + ["negative"] + ["unlabelled"] * 37
    tail = ["positive"] * 11 + ["negative"] * 2 + ["unlabelled"] * 37
    views = [labelled_view(head + tail, 50), labelled_view(head + tail, 100)]
    assert passes_evidence_bar(views, 0.3)
    # A strong head with a weak tail fails at the deeper cut.
    weak_tail = ["negative"] * 12 + ["unlabelled"] * 38
    assert not passes_evidence_bar(
        [labelled_view(head + weak_tail, 50), labelled_view(head + weak_tail, 100)], 0.3
    )
    # A majority that only matches the labelled base rate is no lift.
    assert not passes_evidence_bar(views, 0.7)
    # Too few labelled rows cannot carry a claim.
    thin = ["positive"] * 8 + ["unlabelled"] * 92
    assert not passes_evidence_bar(
        [labelled_view(thin, 50), labelled_view(thin, 100)], 0.2
    )
